#!/usr/bin/env node
"use strict";

import { CASES, RESET_SERVICES, SMOKE } from "./cases.mjs";

const BASE_URL = process.env.COBRI_EVAL_BASE_URL || "http://127.0.0.1:5180";
const EMAIL = process.env.COBRI_EVAL_EMAIL || "pm@cobri-demo.com";
const PASSWORD = process.env.COBRI_EVAL_PASSWORD;
const ORIGIN = new URL(BASE_URL).origin;
const RUN_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function usage() {
  return `Cobri demo evals

Usage:
  node demo-evals/run.mjs --list
  node demo-evals/run.mjs --dry-run [--case 01]
  node demo-evals/run.mjs --smoke
  node demo-evals/run.mjs --case 01
  node demo-evals/run.mjs --all

Flags:
  --list       List the 12 task cases.
  --dry-run    Print resets, APIs, tools and assertions; send nothing.
  --case <id>  Run one case (01-12) or "smoke".
  --smoke      Login, reset fixtures, read Gmail/Calendar state; no model.
  --all        Run all 12 cases.
  --help       Show this help.

Environment:
  COBRI_EVAL_BASE_URL  default ${BASE_URL}
  COBRI_EVAL_EMAIL     default ${EMAIL}
  COBRI_EVAL_PASSWORD  required; run with node --env-file=.env

Model policy:
  Cases 01-12 require a model. With no configured model they are reported as
  unqualified/model_not_configured and never counted as pass. The smoke case
  does not use a model.
`;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    list: false,
    dryRun: false,
    caseId: null,
    all: false,
    smoke: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const equals = raw.indexOf("=");
    const name = equals >= 0 ? raw.slice(0, equals) : raw;
    const inline = equals >= 0 ? raw.slice(equals + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) fail(`${name} needs a value`);
      index += 1;
      return next;
    };
    switch (name) {
      case "--list":
        options.list = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--case":
        options.caseId = value();
        break;
      case "--all":
        options.all = true;
        break;
      case "--smoke":
        options.smoke = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        fail(`unknown option: ${raw}`);
    }
  }
  if (options.help) return options;
  if (options.all && options.caseId) fail("--all and --case cannot be combined");
  if (options.smoke && (options.all || options.caseId)) fail("--smoke cannot be combined with --all or --case");
  return options;
}

function targetLabel(target) {
  return target.kind === "group"
    ? `群「${target.name}」${target.mentions?.length ? ` @${target.mentions.join(" @")}` : ""}`
    : `Bot「${target.name}」`;
}

function listCases() {
  console.log("Cobri 12 条任务评测");
  for (const item of CASES) {
    console.log(
      `${item.id}  ${item.category.padEnd(6, " ")}  ${item.title}  |  ${targetLabel(item.target)}  |  model=${item.requiresModel ? "required" : "no"}`,
    );
  }
  console.log("\n共 12 条。无模型用例用 --smoke 验证夹具，不发送群消息。");
}

function printResetPlan() {
  console.log("  reset:");
  for (const service of RESET_SERVICES) {
    console.log(`    POST ${service.baseUrl}${service.resetPath}  (${service.name})`);
  }
}

function printCasePlan(item) {
  console.log(`\n[${item.id}] ${item.category} | ${item.title}`);
  console.log(`  输入: ${item.input}`);
  if (item.turns?.length) console.log(`  后续轮次: ${item.turns.slice(1).join(" | ")}`);
  console.log(`  目标: ${targetLabel(item.target)}`);
  console.log(`  auth: POST ${BASE_URL}/api/auth/sign-in/email`);
  printResetPlan();
  console.log("  apis:");
  for (const api of item.apis) console.log(`    ${api}`);
  console.log(`  tools: ${item.tools.join(", ")}`);
  console.log(`  model: ${item.requiresModel ? "required; 无模型时 unqualified/model_not_configured" : "not required"}`);
  console.log("  assertions:");
  for (const assertion of item.assertions) {
    console.log(`    [${assertion.kind}] ${assertion.description}`);
  }
  if (item.blockers?.length) {
    console.log("  blockers:");
    for (const blocker of item.blockers) console.log(`    - ${blocker}`);
  }
}

function printSmokePlan() {
  console.log(`\n[smoke] ${SMOKE.title}`);
  console.log(`  输入: ${SMOKE.input}`);
  console.log(`  auth: POST ${BASE_URL}/api/auth/sign-in/email`);
  printResetPlan();
  console.log("  apis:");
  console.log("    POST /rpc/bots/list");
  console.log("    POST /rpc/groups/list");
  console.log("    GET http://127.0.0.1:4312/__state");
  console.log("    GET http://127.0.0.1:4313/__state");
  console.log("    GET http://127.0.0.1:4310/pricing.json");
  console.log("    GET http://127.0.0.1:4311/");
  console.log("    GET http://127.0.0.1:4311/inbox");
  console.log("  model: not required");
  console.log("  assertions:");
  for (const assertion of SMOKE.assertions) {
    console.log(`    [${assertion.kind}] ${assertion.description}`);
  }
}

async function login() {
  if (!PASSWORD) {
    throw new Error(
      "COBRI_EVAL_PASSWORD is required; run with: node --env-file=.env demo-evals/run.mjs --smoke",
    );
  }
  const response = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
    },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`login HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  const cookie = setCookies.map((value) => value.split(";")[0]).join("; ");
  if (!cookie) throw new Error("login returned no session cookie");
  return cookie;
}

async function rpc(cookie, procedure, input = {}) {
  const response = await fetch(`${BASE_URL}/rpc/${procedure}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      origin: ORIGIN,
    },
    body: JSON.stringify({ json: input }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${procedure}: HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || (payload && payload.error)) {
    const detail =
      payload?.error?.message ??
      (typeof payload?.error === "string" ? payload.error : text.slice(0, 300));
    throw new Error(`${procedure}: HTTP ${response.status}: ${detail}`);
  }
  return payload?.json ?? payload;
}

async function getText(url, options = {}) {
  const response = await fetch(url, {
    redirect: "manual",
    ...options,
  });
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
}

async function getJson(url) {
  const result = await getText(url);
  let json = null;
  try {
    json = JSON.parse(result.text);
  } catch {
    // Keep null; the caller reports the shape failure.
  }
  return { ...result, json };
}

async function checkClean(service) {
  if (service.cleanFallback === "pricing.json") {
    const state = await getJson(`${service.baseUrl}/pricing.json`);
    const clean =
      state.status === 200 &&
      state.json?.teamPrice === 199 &&
      state.json?.enterprisePrice === 399 &&
      Array.isArray(state.json?.changelog) &&
      state.json.changelog.length === 3;
    return { clean, note: clean ? "already clean (199/3 logs)" : "not clean and no reset endpoint" };
  }
  if (service.cleanFallback === "login-page") {
    const root = await getText(`${service.baseUrl}/`);
    const inbox = await getText(`${service.baseUrl}/inbox`);
    const clean = root.status === 200 && root.text.includes("Sign in") && inbox.status === 302;
    return { clean, note: clean ? "no server state; login page and 302 /inbox" : "portal is not in clean state" };
  }
  if (service.key === "gmail") {
    const state = await getJson(`${service.baseUrl}/__state`);
    const clean =
      state.status === 200 &&
      state.json?.messages?.length === 5 &&
      state.json?.sent?.length === 0 &&
      state.json?.nextSentId === 1;
    return { clean, note: clean ? "already clean (5 messages, 0 sent)" : "gmail state is not clean" };
  }
  if (service.key === "calendar") {
    const state = await getJson(`${service.baseUrl}/__state`);
    const clean =
      state.status === 200 &&
      state.json?.events?.length === 1 &&
      state.json.events[0]?.id === "evt-1" &&
      state.json?.nextEventId === 2;
    return { clean, note: clean ? "already clean (evt-1)" : "calendar state is not clean" };
  }
  return { clean: false, note: "no fallback" };
}

async function resetFixtures() {
  const results = [];
  for (const service of RESET_SERVICES) {
    let status = 0;
    let note = "";
    try {
      const response = await fetch(`${service.baseUrl}${service.resetPath}`, {
        method: "POST",
        redirect: "manual",
      });
      status = response.status;
      note = `HTTP ${status}`;
    } catch (error) {
      note = `request error: ${error.message}`;
    }
    if (status >= 200 && status < 300) {
      results.push({ key: service.key, name: service.name, status, clean: true, note });
      continue;
    }
    const fallback = await checkClean(service).catch((error) => ({
      clean: false,
      note: `fallback error: ${error.message}`,
    }));
    results.push({
      key: service.key,
      name: service.name,
      status,
      clean: fallback.clean,
      note: `${note}; ${fallback.note}`,
    });
  }
  return results;
}

function printReset(reset) {
  for (const item of reset) {
    const mark = item.clean ? "OK" : "FAIL";
    console.log(`  reset ${item.name}: ${mark} (${item.note})`);
  }
}

async function detectModel(cookie) {
  const credentials = await rpc(cookie, "models/credentials");
  const role = await rpc(cookie, "models/role", { role: "main" });
  return {
    configured: credentials.length > 0 || Boolean(role?.primary) || Boolean(role?.deploymentPrimary),
    credentialCount: credentials.length,
    primary: role?.primary ?? null,
    deploymentPrimary: role?.deploymentPrimary ?? null,
  };
}

async function resolveTarget(cookie, item) {
  if (item.target.kind === "group") {
    const groups = await rpc(cookie, "groups/list");
    const group = groups.find((candidate) => candidate.name === item.target.name);
    if (!group) throw new Error(`group not found: ${item.target.name}`);
    const mentionIds = (item.target.mentions ?? []).map((name) => {
      const member = group.members?.find((candidate) => candidate.name === name);
      if (!member) throw new Error(`group member not found: ${name}`);
      return member.botId;
    });
    return { kind: "group", groupId: group.id, threadId: group.threadId, mentionIds };
  }
  const bots = await rpc(cookie, "bots/list");
  const bot = bots.find((candidate) => candidate.name === item.target.name);
  if (!bot) throw new Error(`bot not found: ${item.target.name}`);
  return { kind: "bot", botId: bot.id, threadId: bot.threadId };
}

async function sendCase(cookie, item, target) {
  const payload =
    target.kind === "group"
      ? {
          groupId: target.groupId,
          text: item.input,
          ...(target.mentionIds.length > 0 ? { mentions: target.mentionIds } : {}),
        }
      : { botId: target.botId, text: item.input };
  const sent = await rpc(cookie, "threads/send", payload);
  const runIds = Array.isArray(sent.runIds) && sent.runIds.length > 0
    ? sent.runIds
    : [sent.runId].filter(Boolean);
  return { sent, runIds };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRuns(cookie, runIds) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let last = [];
  while (Date.now() < deadline) {
    const result = await rpc(cookie, "runs/list", { filter: "recent" });
    const rows = Array.isArray(result) ? result : result.runs ?? [];
    last = runIds.map((id) => rows.find((row) => row.runId === id)).filter(Boolean);
    if (last.length === runIds.length && last.every((row) => TERMINAL.has(row.status))) {
      return { timedOut: false, runs: last };
    }
    if (last.length > 0 && last.every((row) => row.status === "waiting_input")) {
      return { timedOut: false, runs: last };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { timedOut: true, runs: last };
}

async function runModelCase(cookie, item) {
  const reset = await resetFixtures();
  console.log(`\n[${item.id}] ${item.title}`);
  printReset(reset);
  if (!reset.every((entry) => entry.clean)) {
    console.log("  result: UNQUALIFIED (fixture_reset_failed)");
    return { id: item.id, status: "UNQUALIFIED", reason: "fixture_reset_failed", reset };
  }

  const modelState = await detectModel(cookie);
  console.log(
    `  model: ${modelState.configured ? "configured" : "not configured"} (credentials=${modelState.credentialCount})`,
  );
  if (item.requiresModel && !modelState.configured) {
    console.log("  result: UNQUALIFIED (model_not_configured)");
    return {
      id: item.id,
      status: "UNQUALIFIED",
      reason: "model_not_configured",
      reset,
      model: modelState,
    };
  }

  const target = await resolveTarget(cookie, item);
  const sent = await sendCase(cookie, item, target);
  console.log(`  target: ${target.kind} ${target.threadId}`);
  console.log(`  runIds: ${sent.runIds.join(", ")}`);
  const waited = await waitForRuns(cookie, sent.runIds);
  for (const run of waited.runs) {
    console.log(`  run ${run.runId}: ${run.status} (${run.trigger})`);
  }
  if (waited.timedOut) {
    console.log("  result: UNQUALIFIED (run_timeout)");
    return {
      id: item.id,
      status: "UNQUALIFIED",
      reason: "run_timeout",
      reset,
      model: modelState,
      runIds: sent.runIds,
      runs: waited.runs,
    };
  }
  if (waited.runs.some((run) => run.status === "failed")) {
    console.log("  result: FAIL (run_failed)");
    return {
      id: item.id,
      status: "FAIL",
      reason: "run_failed",
      reset,
      model: modelState,
      runIds: sent.runIds,
      runs: waited.runs,
    };
  }
  if (waited.runs.some((run) => run.status === "waiting_input")) {
    console.log("  result: UNQUALIFIED (approval_required)");
    return {
      id: item.id,
      status: "UNQUALIFIED",
      reason: "approval_required",
      reset,
      model: modelState,
      runIds: sent.runIds,
      runs: waited.runs,
    };
  }
  console.log("  result: UNQUALIFIED (assertions_not_implemented)");
  return {
    id: item.id,
    status: "UNQUALIFIED",
    reason: "assertions_not_implemented",
    reset,
    model: modelState,
    runIds: sent.runIds,
    runs: waited.runs,
  };
}

async function runSmoke(cookie) {
  console.log(`\n[smoke] ${SMOKE.title}`);
  const reset = await resetFixtures();
  printReset(reset);
  const checks = [];

  function check(name, pass, detail) {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  }

  const bots = await rpc(cookie, "bots/list");
  const botNames = bots.map((bot) => bot.name);
  const wantedBots = ["总管", "研究", "收件箱", "日程"];
  check(
    "login/session",
    wantedBots.every((name) => botNames.includes(name)),
    `bots=${wantedBots.map((name) => (botNames.includes(name) ? name : `missing:${name}`)).join(",")}`,
  );

  const groups = await rpc(cookie, "groups/list");
  const group = groups.find((candidate) => candidate.name === "工作助理团队");
  check(
    "group",
    Boolean(group) && group.members?.length === 4,
    group ? `id=${group.id}, members=${group.members.length}` : "missing 工作助理团队",
  );

  const gmail = await getJson("http://127.0.0.1:4312/__state");
  const gmailIds = (gmail.json?.messages ?? []).map((message) => message.id);
  check(
    "gmail",
    gmail.status === 200 &&
      gmailIds.join(",") === "m1,m2,m3,m4,m5" &&
      gmail.json?.sent?.length === 0,
    `HTTP ${gmail.status}, messages=${gmailIds.join(",")}, sent=${gmail.json?.sent?.length ?? "?"}`,
  );

  const calendar = await getJson("http://127.0.0.1:4313/__state");
  const calendarEvent = calendar.json?.events?.[0];
  check(
    "calendar",
    calendar.status === 200 &&
      calendar.json?.events?.length === 1 &&
      calendarEvent?.id === "evt-1" &&
      calendarEvent?.summary === "产品评审",
    `HTTP ${calendar.status}, events=${calendar.json?.events?.length ?? "?"}, first=${calendarEvent?.id ?? "?"}`,
  );

  const pricing = await getJson("http://127.0.0.1:4310/pricing.json");
  check(
    "competitor",
    pricing.status === 200 &&
      pricing.json?.teamPrice === 199 &&
      pricing.json?.changelog?.length === 3,
    `HTTP ${pricing.status}, teamPrice=${pricing.json?.teamPrice ?? "?"}, logs=${pricing.json?.changelog?.length ?? "?"}`,
  );

  const competitorState = await getJson("http://127.0.0.1:4310/__state");
  check(
    "competitor-reset",
    competitorState.status === 200 &&
      competitorState.json?.teamPrice === 199 &&
      competitorState.json?.changelogCount === 3,
    `HTTP ${competitorState.status}, teamPrice=${competitorState.json?.teamPrice ?? "?"}, changelogCount=${competitorState.json?.changelogCount ?? "?"}`,
  );

  const portalRoot = await getText("http://127.0.0.1:4311/");
  const portalInbox = await getText("http://127.0.0.1:4311/inbox");
  check(
    "portal",
    portalRoot.status === 200 && portalRoot.text.includes("Sign in") && portalInbox.status === 302,
    `root=${portalRoot.status}, inbox=${portalInbox.status}`,
  );

  const portalState = await getJson("http://127.0.0.1:4311/__state");
  check(
    "portal-reset",
    portalState.status === 200 &&
      portalState.json?.sessions === 0 &&
      portalState.json?.unread === 3,
    `HTTP ${portalState.status}, sessions=${portalState.json?.sessions ?? "?"}, unread=${portalState.json?.unread ?? "?"}`,
  );

  const passed = checks.every((entry) => entry.pass);
  console.log(`  SMOKE ${passed ? "PASS" : "FAIL"}`);
  return { id: "smoke", status: passed ? "PASS" : "FAIL", reset, checks };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.list) {
    listCases();
    return;
  }
  if (options.dryRun) {
    if (options.smoke) {
      printSmokePlan();
      return;
    }
    if (options.caseId) {
      const item = CASES.find((candidate) => candidate.id === options.caseId.padStart(2, "0"));
      if (!item) fail(`unknown case: ${options.caseId}`);
      printCasePlan(item);
      return;
    }
    for (const item of CASES) printCasePlan(item);
    return;
  }

  const cookie = await login();
  console.log(`logged in to ${BASE_URL}`);

  if (options.smoke || options.caseId === "smoke") {
    const result = await runSmoke(cookie);
    process.exitCode = result.status === "PASS" ? 0 : 1;
    return;
  }

  if (options.caseId) {
    const item = CASES.find((candidate) => candidate.id === options.caseId.padStart(2, "0"));
    if (!item) fail(`unknown case: ${options.caseId}`);
    const result = await runModelCase(cookie, item);
    process.exitCode = result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2;
    return;
  }

  if (options.all) {
    const results = [];
    for (const item of CASES) results.push(await runModelCase(cookie, item));
    const count = (status) => results.filter((result) => result.status === status).length;
    console.log(
      `\nSUMMARY total=${results.length} pass=${count("PASS")} fail=${count("FAIL")} unqualified=${count("UNQUALIFIED")}`,
    );
    process.exitCode = count("FAIL") > 0 ? 1 : count("UNQUALIFIED") > 0 ? 2 : 0;
    return;
  }

  console.log(usage());
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
