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

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Keep null; the caller reports the shape failure.
  }
  return { status: response.status, text, json };
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
  const bots = await rpc(cookie, "bots/list");
  const botByName = new Map(bots.map((candidate) => [candidate.name, candidate]));
  if (item.target.kind === "group") {
    const memberNames = ["总管", "研究", "收件箱", "日程"];
    const botIds = memberNames.map((name) => {
      const member = botByName.get(name);
      if (!member) throw new Error(`group member not found: ${name}`);
      return member.id;
    });
    const group = await rpc(cookie, "groups/create", {
      name: `${item.target.name} · eval ${item.id} ${Date.now()}`,
      botIds,
    });
    const mentionIds = (item.target.mentions ?? []).map((name) => {
      const member = group.members?.find((candidate) => candidate.name === name);
      if (!member) throw new Error(`group member not found: ${name}`);
      return member.botId;
    });
    return {
      kind: "group",
      groupId: group.id,
      threadId: group.threadId,
      mentionIds,
      members: group.members ?? [],
    };
  }
  const bot = botByName.get(item.target.name);
  if (!bot) throw new Error(`bot not found: ${item.target.name}`);
  await rpc(cookie, "threads/clear", { botId: bot.id });
  return {
    kind: "bot",
    botId: bot.id,
    threadId: bot.threadId,
    members: [{ botId: bot.id, name: bot.name }],
  };
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

async function waitForRuns(cookie, runIds, timeoutMs = RUN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    const [active, recent] = await Promise.all([
      rpc(cookie, "runs/list", { filter: "active" }),
      rpc(cookie, "runs/list", { filter: "recent" }),
    ]);
    const rowsById = new Map();
    for (const row of [...(recent.runs ?? []), ...(active.runs ?? [])]) {
      rowsById.set(row.runId, row);
    }
    last = runIds
      .map((id) => rowsById.get(id))
      .filter(Boolean);
    const settled =
      last.length === runIds.length &&
      last.every((row) => TERMINAL.has(row.status) || row.status === "waiting_input");
    if (settled) {
      return { timedOut: false, runs: last };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { timedOut: true, runs: last };
}

function normalizeForMatch(value) {
  return String(value ?? "")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function messageText(message) {
  if (!message) return "";
  return (message.blocks ?? [])
    .filter((block) => block?.kind === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function messageStepLabels(message) {
  if (!message) return [];
  return (message.blocks ?? [])
    .filter((block) => block?.kind === "steps")
    .flatMap((block) => block.steps ?? [])
    .map((step) => step.label ?? "")
    .filter(Boolean);
}

async function recentThreadRunIds(cookie, threadId) {
  const result = await rpc(cookie, "runs/list", { filter: "recent" });
  return new Set(
    (result.runs ?? []).filter((row) => row.threadId === threadId).map((row) => row.runId),
  );
}

async function evaluateCase01(cookie, target, sent, waited, beforeRunIds) {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  add(
    "send returns exactly two runs",
    sent.runIds.length === 2,
    `runIds=${sent.runIds.join(", ") || "none"}`,
  );

  const runSummary = waited.runs.map((run) => `${run.botName}:${run.status}/${run.trigger}`);
  const botNames = new Set(waited.runs.map((run) => run.botName));
  add(
    "runs belong to 日程 and 研究",
    waited.runs.length === 2 && botNames.has("日程") && botNames.has("研究"),
    runSummary.join(", "),
  );
  add(
    "runs are user-triggered and completed",
    waited.runs.every((run) => run.trigger === "user" && run.status === "completed"),
    runSummary.join(", "),
  );

  const recent = await rpc(cookie, "runs/list", { filter: "recent" });
  const newRuns = (recent.runs ?? []).filter(
    (row) => row.threadId === target.threadId && !beforeRunIds.has(row.runId),
  );
  const managerRuns = newRuns.filter((row) => row.botName === "总管");
  add(
    "manager did not reply",
    managerRuns.length === 0,
    managerRuns.length > 0
      ? `unexpected runs=${managerRuns.map((row) => row.runId).join(", ")}`
      : `new runs=${newRuns.map((row) => `${row.botName}:${row.runId}`).join(", ") || "none"}`,
  );

  const snapshot = await rpc(
    cookie,
    "threads/get",
    target.kind === "group" ? { groupId: target.groupId } : { botId: target.botId },
  );
  const replies = (snapshot.messages ?? []).filter(
    (message) => message.role === "bot" && sent.runIds.includes(message.runId),
  );
  const expectedBotId = (name) =>
    target.members.find((member) => member.name === name)?.botId;
  const scheduleReply = replies.find((message) => message.botId === expectedBotId("日程"));
  const researchReply = replies.find((message) => message.botId === expectedBotId("研究"));
  add(
    "two bot replies with correct botIds",
    replies.length === 2 && Boolean(scheduleReply) && Boolean(researchReply),
    `replies=${replies.map((message) => message.botId).join(", ") || "none"}`,
  );

  const scheduleText = normalizeForMatch(messageText(scheduleReply));
  add(
    "schedule reply states conflict and slot",
    scheduleText.includes("产品评审") && scheduleText.includes("15:00-16:00"),
    scheduleText ? scheduleText.slice(0, 160) : "missing schedule reply",
  );

  const researchText = normalizeForMatch(messageText(researchReply));
  const researchFacts = [
    ["B 轮", /b\s*轮/],
    ["2.4 亿元", /2\.4\s*亿/],
    ["2026-09-18", /2026-09-18/],
    ["海岚资本", /海岚资本/],
    ["远山智脑 2.0", /远山智脑\s*2\.0/],
    ["2026-10-12", /2026-10-12/],
    ["合同审阅", /合同审阅/],
    ["报价单", /报价单/],
  ];
  const missingFacts = researchFacts
    .filter(([, pattern]) => !pattern.test(researchText))
    .map(([label]) => label);
  add(
    "research reply carries fixture facts",
    missingFacts.length === 0,
    missingFacts.length > 0
      ? `missing=${missingFacts.join(", ")}; text=${researchText.slice(0, 200)}`
      : "all fixture facts present",
  );

  const scheduleSteps = messageStepLabels(scheduleReply);
  add(
    "schedule run read the calendar",
    scheduleSteps.some((label) => /calendar/i.test(label)),
    `steps=${scheduleSteps.join(" | ") || "none"}`,
  );

  const researchSteps = messageStepLabels(researchReply);
  add(
    "research run read the competitor fixture",
    researchSteps.some((label) => /web\s*fetch|browser|shell/i.test(label)),
    `steps=${researchSteps.join(" | ") || "none"}`,
  );

  return { checks };
}

async function gmailSentState() {
  const state = await getJson("http://127.0.0.1:4312/__state");
  return {
    status: state.status,
    sent: Array.isArray(state.json?.sent) ? state.json.sent : [],
  };
}

function findPendingApproval(snapshot, runId, pattern) {
  for (const message of snapshot.messages ?? []) {
    if (message.role !== "bot" || message.runId !== runId) continue;
    for (const block of message.blocks ?? []) {
      if (
        block?.kind === "ask" &&
        block.approvalEffectId &&
        block.status === "pending" &&
        pattern.test(`${block.text ?? ""} ${block.detail ?? ""}`) &&
        block.actions?.some((action) => action.id === "allow") &&
        block.actions?.some((action) => action.id === "deny")
      ) {
        return { message, block };
      }
    }
  }
  return null;
}

function findPendingEmailApproval(snapshot, runId) {
  return findPendingApproval(snapshot, runId, /GMAIL_SEND_EMAIL|send email/i);
}

function findPendingCalendarApproval(snapshot, runId) {
  return findPendingApproval(snapshot, runId, /GOOGLECALENDAR_CREATE_EVENT|create event/i);
}

async function botSnapshot(cookie, botId) {
  return rpc(cookie, "threads/get", { botId });
}

function runEvidence(snapshot, runId) {
  const messages = (snapshot.messages ?? []).filter(
    (message) => message.role === "bot" && message.runId === runId,
  );
  if (messages.length === 0) return "no bot message";
  return messages
    .map((message) => {
      const steps = messageStepLabels(message).join(" | ") || "none";
      const text = messageText(message).replace(/\s+/g, " ").slice(0, 300) || "none";
      return `steps=${steps}; text=${text}`;
    })
    .join(" || ");
}

async function recentRunIds(cookie) {
  const result = await rpc(cookie, "runs/list", { filter: "recent" });
  return new Set((result.runs ?? []).map((row) => row.runId));
}

async function waitForNewRun(cookie, beforeRunIds, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [active, recent] = await Promise.all([
      rpc(cookie, "runs/list", { filter: "active" }),
      rpc(cookie, "runs/list", { filter: "recent" }),
    ]);
    const rows = [...(recent.runs ?? []), ...(active.runs ?? [])];
    const match = rows.find((row) => !beforeRunIds.has(row.runId) && predicate(row));
    if (match) return match;
    await sleep(1_000);
  }
  return null;
}

async function runCase07(cookie, item, reset, modelState) {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const bots = await rpc(cookie, "bots/list");
  const chief = bots.find((bot) => bot.name === "总管");
  const inbox = bots.find((bot) => bot.name === "收件箱");
  add(
    "总管 and 收件箱 exist",
    Boolean(chief && inbox),
    `chief=${chief?.id ?? "missing"}, inbox=${inbox?.id ?? "missing"}`,
  );
  if (!chief || !inbox) {
    return { id: item.id, status: "FAIL", reason: "missing_bots", reset, model: modelState, assertions: checks };
  }

  const clearThreads = async () => {
    await rpc(cookie, "threads/clear", { botId: chief.id });
    await rpc(cookie, "threads/clear", { botId: inbox.id });
  };
  const beforeGmail = await gmailSentState();
  add("gmail starts with sent=0", beforeGmail.sent.length === 0, `sent=${beforeGmail.sent.length}`);

  async function attempt(answer) {
    await clearThreads();
    const beforeRunIds = await recentRunIds(cookie);
    const sent = await rpc(cookie, "threads/send", { botId: chief.id, text: item.input });
    const runIds = Array.isArray(sent.runIds) && sent.runIds.length > 0 ? sent.runIds : [sent.runId];
    const chiefWait = await waitForRuns(cookie, runIds);
    let owner = {
      name: "总管",
      botId: chief.id,
      runId: runIds[0],
      wait: chiefWait,
      snapshot: await botSnapshot(cookie, chief.id),
    };
    let pending = findPendingEmailApproval(owner.snapshot, owner.runId);

    if (!pending) {
      const inboxRun = await waitForNewRun(
        cookie,
        beforeRunIds,
        (row) => row.botName === "收件箱" && row.trigger === "bot_message",
      );
      if (!inboxRun) {
        const gmailNow = await gmailSentState();
        console.log(
          `  evidence no approval: chief=${runIds[0]} status=${chiefWait.runs?.[0]?.status ?? "?"}; ${runEvidence(owner.snapshot, owner.runId)}; gmailSent=${gmailNow.sent.length}`,
        );
        add(`[${answer}] approval card exists`, false, "no pending GMAIL_SEND_EMAIL card and no inbox bot_message run");
        return { ok: false };
      }
      const inboxWait = await waitForRuns(cookie, [inboxRun.runId]);
      owner = {
        name: "收件箱",
        botId: inbox.id,
        runId: inboxRun.runId,
        wait: inboxWait,
        snapshot: await botSnapshot(cookie, inbox.id),
      };
      pending = findPendingEmailApproval(owner.snapshot, owner.runId);
    }

    if (!pending) {
      const gmailNow = await gmailSentState();
      console.log(
        `  evidence no approval: owner=${owner.name} run=${owner.runId} status=${owner.wait.runs?.[0]?.status ?? "?"}; ${runEvidence(owner.snapshot, owner.runId)}; gmailSent=${gmailNow.sent.length}`,
      );
      add(`[${answer}] approval card exists`, false, `no pending GMAIL_SEND_EMAIL card in ${owner.name}`);
      return { ok: false };
    }

    const gmailBefore = await gmailSentState();
    add(`[${answer}] approval card exists (${owner.name})`, true, `run=${owner.runId}, message=${pending.message.id}`);
    add(
      `[${answer}] run waits for approval`,
      owner.wait.runs?.[0]?.status === "waiting_input",
      `status=${owner.wait.runs?.[0]?.status ?? "?"}`,
    );
    add(`[${answer}] sent=0 before decision`, gmailBefore.sent.length === 0, `sent=${gmailBefore.sent.length}`);
    if (gmailBefore.sent.length !== 0) return { ok: false };

    await rpc(cookie, "threads/answer", {
      botId: owner.botId,
      runId: owner.runId,
      messageId: pending.message.id,
      answer,
    });
    const afterWait = await waitForRuns(cookie, [owner.runId]);
    const afterStatus = afterWait.runs?.[0]?.status;
    add(`[${answer}] run terminal after answer`, TERMINAL.has(afterStatus), `status=${afterStatus ?? "?"}`);
    const afterSnapshot = await botSnapshot(cookie, owner.botId);
    const answeredMessage = (afterSnapshot.messages ?? []).find(
      (message) => message.id === pending.message.id,
    );
    const answeredAsk = (answeredMessage?.blocks ?? []).find(
      (block) => block.kind === "ask" && block.approvalEffectId === pending.block.approvalEffectId,
    );
    add(
      `[${answer}] card answered ${answer}`,
      answeredAsk?.status === "answered" && answeredAsk?.answer === answer,
      `status=${answeredAsk?.status ?? "?"}, answer=${answeredAsk?.answer ?? "?"}`,
    );
    const gmailAfter = await gmailSentState();

    if (answer === "deny") {
      add("[deny] sent stays 0", gmailAfter.sent.length === 0, `sent=${gmailAfter.sent.length}`);
      return { ok: gmailAfter.sent.length === 0 && TERMINAL.has(afterStatus) };
    }

    add("[allow] sent exactly 1", gmailAfter.sent.length === 1, `sent=${gmailAfter.sent.length}`);
    if (gmailAfter.sent.length === 1) {
      const record = gmailAfter.sent[0];
      const subject = normalizeForMatch(record.subject);
      const body = normalizeForMatch(record.body);
      add(
        "[allow] recipient matches 李总",
        /li@yuanshan\.example|李总/i.test(String(record.to ?? "")),
        `to=${record.to ?? "?"}`,
      );
      add(
        "[allow] cc matches 王总",
        /wang@demo\.test|王总/i.test(String(record.cc ?? "")),
        `cc=${record.cc ?? "?"}`,
      );
      add(
        "[allow] subject matches meeting + 续约",
        subject.includes("会议") && subject.includes("续约"),
        `subject=${record.subject ?? "?"}`,
      );
      add(
        "[allow] body carries 2026-11-05 16:00",
        body.includes("16:00") && /2026-11-05|2026年11月5日|11月5日|11-05/.test(body),
        `body=${String(record.body ?? "").replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
    return { ok: checks.every((check) => check.pass) };
  }

  const deny = await attempt("deny");
  if (deny.ok) await attempt("allow");
  const passed = checks.every((check) => check.pass);
  console.log(`  result: ${passed ? "PASS" : "FAIL"}`);
  return {
    id: item.id,
    status: passed ? "PASS" : "FAIL",
    reason: passed ? "assertions_passed" : "assertions_failed",
    reset,
    model: modelState,
    assertions: checks,
  };
}

async function calendarEventsState() {
  const state = await getJson("http://127.0.0.1:4313/__state");
  return {
    status: state.status,
    events: Array.isArray(state.json?.events) ? state.json.events : [],
  };
}

function runAskPayloads(snapshot, runId) {
  return (
    (snapshot.messages ?? [])
      .filter((message) => message.role === "bot" && message.runId === runId)
      .flatMap((message) =>
        (message.blocks ?? [])
          .filter((block) => block.kind === "ask")
          .map((block) => JSON.stringify(block)),
      )
      .join("\n") || "none"
  );
}

async function runCase08(cookie, item, reset, modelState) {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const bots = await rpc(cookie, "bots/list");
  const calendarBot = bots.find((bot) => bot.name === "日程");
  add("日程 exists", Boolean(calendarBot), `bot=${calendarBot?.id ?? "missing"}`);
  if (!calendarBot) {
    return { id: item.id, status: "FAIL", reason: "missing_bot", reset, model: modelState, assertions: checks };
  }

  await rpc(cookie, "threads/clear", { botId: calendarBot.id });
  const beforeCalendar = await calendarEventsState();
  const beforeGmail = await gmailSentState();
  const beforeEvents = JSON.stringify(beforeCalendar.events);
  add(
    "calendar starts with only evt-1",
    beforeCalendar.events.length === 1 && beforeCalendar.events[0]?.id === "evt-1",
    `events=${beforeCalendar.events.map((event) => event.id).join(",") || "none"}`,
  );
  add("gmail starts with sent=0", beforeGmail.sent.length === 0, `sent=${beforeGmail.sent.length}`);

  const sent = await rpc(cookie, "threads/send", { botId: calendarBot.id, text: item.input });
  const runIds = Array.isArray(sent.runIds) && sent.runIds.length > 0 ? sent.runIds : [sent.runId];
  const waited = await waitForRuns(cookie, runIds);
  const runId = runIds[0];
  const status = waited.runs?.[0]?.status;
  const snapshot = await botSnapshot(cookie, calendarBot.id);
  const pending = status === "waiting_input" ? findPendingCalendarApproval(snapshot, runId) : null;

  if (!pending) {
    const calendarNow = await calendarEventsState();
    const gmailNow = await gmailSentState();
    console.log(
      `  evidence no approval: run=${runId} status=${status ?? "?"}; ${runEvidence(snapshot, runId)}; ask=${runAskPayloads(snapshot, runId)}; calendarEvents=${calendarNow.events.length}; gmailSent=${gmailNow.sent.length}`,
    );
    add("calendar approval card exists", false, "no pending GOOGLECALENDAR_CREATE_EVENT card");
    const passed = checks.every((check) => check.pass);
    console.log(`  result: ${passed ? "PASS" : "FAIL"}`);
    return {
      id: item.id,
      status: passed ? "PASS" : "FAIL",
      reason: "assertions_failed",
      reset,
      model: modelState,
      assertions: checks,
    };
  }

  add("calendar approval card exists", true, `run=${runId}, message=${pending.message.id}`);
  add("run waits for approval", status === "waiting_input", `status=${status ?? "?"}`);
  const beforeDecision = await calendarEventsState();
  add(
    "calendar unchanged before decision",
    JSON.stringify(beforeDecision.events) === beforeEvents,
    `events=${beforeDecision.events.map((event) => event.id).join(",") || "none"}`,
  );
  const gmailBeforeDecision = await gmailSentState();
  add("gmail sent=0 before decision", gmailBeforeDecision.sent.length === 0, `sent=${gmailBeforeDecision.sent.length}`);

  await rpc(cookie, "threads/answer", {
    botId: calendarBot.id,
    runId,
    messageId: pending.message.id,
    answer: "deny",
  });
  const afterWait = await waitForRuns(cookie, [runId]);
  const afterStatus = afterWait.runs?.[0]?.status;
  add("run terminal after deny", TERMINAL.has(afterStatus), `status=${afterStatus ?? "?"}`);
  const afterSnapshot = await botSnapshot(cookie, calendarBot.id);
  const answeredMessage = (afterSnapshot.messages ?? []).find(
    (message) => message.id === pending.message.id,
  );
  const answeredAsk = (answeredMessage?.blocks ?? []).find(
    (block) => block.kind === "ask" && block.approvalEffectId === pending.block.approvalEffectId,
  );
  add(
    "card answered deny",
    answeredAsk?.status === "answered" && answeredAsk?.answer === "deny",
    `status=${answeredAsk?.status ?? "?"}, answer=${answeredAsk?.answer ?? "?"}`,
  );
  const afterCalendar = await calendarEventsState();
  add(
    "calendar has no new event",
    JSON.stringify(afterCalendar.events) === beforeEvents,
    `events=${afterCalendar.events.map((event) => event.id).join(",") || "none"}`,
  );
  const afterGmail = await gmailSentState();
  add("no notification email", afterGmail.sent.length === 0, `sent=${afterGmail.sent.length}`);

  const passed = checks.every((check) => check.pass);
  console.log(`  result: ${passed ? "PASS" : "FAIL"}`);
  return {
    id: item.id,
    status: passed ? "PASS" : "FAIL",
    reason: passed ? "assertions_passed" : "assertions_failed",
    reset,
    model: modelState,
    assertions: checks,
  };
}

function findBlock(snapshot, predicate) {
  for (const message of snapshot.messages ?? []) {
    for (const block of message.blocks ?? []) {
      if (predicate(block, message)) return { message, block };
    }
  }
  return null;
}

function botMessagesForRun(snapshot, runId) {
  return (snapshot.messages ?? []).filter(
    (message) => message.role === "bot" && message.runId === runId,
  );
}

function combinedRunText(snapshot, runId) {
  return botMessagesForRun(snapshot, runId).map(messageText).join("\n");
}

function combinedRunSteps(snapshot, runId) {
  return botMessagesForRun(snapshot, runId).flatMap(messageStepLabels);
}

async function snapshotForRunThread(cookie, bot, runRow) {
  if (!runRow || runRow.threadId === bot.threadId) return botSnapshot(cookie, bot.id);
  const groups = await rpc(cookie, "groups/list");
  const group = groups.find((candidate) => candidate.threadId === runRow.threadId);
  return group ? rpc(cookie, "threads/get", { groupId: group.id }) : botSnapshot(cookie, bot.id);
}

function deadlineHit(text, mmdd) {
  const [month, day] = mmdd.split("-");
  return new RegExp(`${month}\\s*月\\s*${Number(day)}\\s*日|${mmdd}|${month}/${Number(day)}`).test(text);
}

function shanghaiClock(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

async function runCase03(cookie, item, reset, modelState) {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const bots = await rpc(cookie, "bots/list");
  const chief = bots.find((bot) => bot.name === "总管");
  const inbox = bots.find((bot) => bot.name === "收件箱");
  add("总管 and 收件箱 exist", Boolean(chief && inbox), `chief=${chief?.id ?? "missing"}, inbox=${inbox?.id ?? "missing"}`);
  if (!chief || !inbox) {
    return { id: item.id, status: "FAIL", reason: "missing_bots", reset, model: modelState, assertions: checks };
  }

  await rpc(cookie, "threads/clear", { botId: chief.id });
  await rpc(cookie, "threads/clear", { botId: inbox.id });
  const beforeRunIds = await recentRunIds(cookie);
  const sent = await rpc(cookie, "threads/send", { botId: chief.id, text: item.input });
  const chiefRunIds = Array.isArray(sent.runIds) && sent.runIds.length > 0 ? sent.runIds : [sent.runId];
  const chiefWait = await waitForRuns(cookie, chiefRunIds);
  const chiefSnapshot = await botSnapshot(cookie, chief.id);
  const request = findBlock(
    chiefSnapshot,
    (block) => block.kind === "bot_message_sent" && block.toBotId === inbox.id,
  );
  add("总管 sent private request to 收件箱", Boolean(request), request ? `message=${request.message.id}` : "no bot_message_sent");
  add("request intent=request", request?.block?.intent === "request", `intent=${request?.block?.intent ?? "?"}`);

  const inboxRun = await waitForNewRun(
    cookie,
    beforeRunIds,
    (row) => row.botName === "收件箱" && row.trigger === "bot_message",
  );
  if (!inboxRun) {
    console.log(`  evidence no inbox run: chief run=${chiefRunIds[0]} status=${chiefWait.runs?.[0]?.status ?? "?"}; ${runEvidence(chiefSnapshot, chiefRunIds[0])}`);
    add("收件箱 woken by bot_message", false, "no new 收件箱 bot_message run");
    const passed = checks.every((check) => check.pass);
    console.log(`  result: ${passed ? "PASS" : "FAIL"}`);
    return { id: item.id, status: passed ? "PASS" : "FAIL", reason: "assertions_failed", reset, model: modelState, assertions: checks };
  }

  const inboxWait = await waitForRuns(cookie, [inboxRun.runId]);
  const inboxSnapshot = await snapshotForRunThread(cookie, inbox, inboxRun);
  const received = findBlock(
    inboxSnapshot,
    (block) => block.kind === "bot_message_received" && block.fromBotId === chief.id,
  );
  const inboxText = normalizeForMatch(combinedRunText(inboxSnapshot, inboxRun.runId));
  const inboxSteps = combinedRunSteps(inboxSnapshot, inboxRun.runId);
  add("收件箱 woken by bot_message", true, `run=${inboxRun.runId}`);
  add("收件箱 received private request", Boolean(received), received ? `message=${received.message.id}` : "no bot_message_received");
  add("收件箱 run completed", inboxWait.runs?.[0]?.status === "completed", `status=${inboxWait.runs?.[0]?.status ?? "?"}`);
  add(
    "收件箱 read Gmail",
    inboxSteps.some((label) => /gmail/i.test(label)) || /远山|李总|报价|王总/.test(inboxText),
    `steps=${inboxSteps.join(" | ") || "none"}`,
  );
  add(
    "收件箱 briefing includes m1/m3",
    /远山|李总/.test(inboxText) && /报价|王总/.test(inboxText),
    inboxText.slice(0, 220) || "no inbox text",
  );
  add(
    "收件箱 briefing excludes m4/m5",
    !/行业周报|周报/.test(inboxText) && !/午餐/.test(inboxText),
    inboxText.slice(0, 220) || "no inbox text",
  );

  const returnRun = await waitForNewRun(
    cookie,
    beforeRunIds,
    (row) => row.botName === "总管" && row.trigger === "bot_message",
    60_000,
  );
  if (returnRun) await waitForRuns(cookie, [returnRun.runId]);
  const chiefAfter = await snapshotForRunThread(cookie, chief, returnRun);
  const returnBlock = findBlock(
    chiefAfter,
    (block) => block.kind === "bot_message_received" && block.fromBotId === inbox.id,
  );
  const allChiefText = normalizeForMatch(
    (chiefAfter.messages ?? []).filter((message) => message.role === "bot").map(messageText).join("\n"),
  );
  add("结果回到总管", Boolean(returnBlock), returnBlock ? `message=${returnBlock.message.id}` : "no bot_message_received from 收件箱");
  add(
    "总管 relays the substance",
    /远山|李总/.test(allChiefText) && /报价|王总/.test(allChiefText),
    allChiefText.slice(0, 220) || "no chief text",
  );

  const passed = checks.every((check) => check.pass);
  console.log(`  result: ${passed ? "PASS" : "FAIL"}`);
  return {
    id: item.id,
    status: passed ? "PASS" : "FAIL",
    reason: passed ? "assertions_passed" : "assertions_failed",
    reset,
    model: modelState,
    assertions: checks,
  };
}

async function runCase10(cookie, item, reset, modelState) {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const bots = await rpc(cookie, "bots/list");
  const inbox = bots.find((bot) => bot.name === "收件箱");
  add("收件箱 exists", Boolean(inbox), `bot=${inbox?.id ?? "missing"}`);
  if (!inbox) {
    return { id: item.id, status: "FAIL", reason: "missing_bot", reset, model: modelState, assertions: checks };
  }

  await rpc(cookie, "threads/clear", { botId: inbox.id });
  const existing = await rpc(cookie, "routines/list", { botId: inbox.id });
  for (const routine of existing) {
    if (routine.name.startsWith("Eval ") || routine.prompt.includes("收件箱简报")) {
      await rpc(cookie, "routines/remove", { routineId: routine.id });
    }
  }

  const routine = await rpc(cookie, "routines/create", {
    botId: inbox.id,
    name: "Eval 每日收件箱简报 0830",
    prompt: item.input,
    crons: ["30 8 * * *"],
    timezone: "Asia/Shanghai",
    active: true,
    notify: true,
  });
  add(
    "routine created daily 08:30 Asia/Shanghai",
    routine.active === true &&
      routine.notify === true &&
      routine.timezone === "Asia/Shanghai" &&
      routine.crons.length === 1 &&
      routine.crons[0] === "30 8 * * *",
    `active=${routine.active}, notify=${routine.notify}, timezone=${routine.timezone}, crons=${routine.crons.join(",")}`,
  );
  add(
    "next run is 08:30 Asia/Shanghai",
    Boolean(routine.nextRunAt) && shanghaiClock(routine.nextRunAt) === "08:30",
    `nextRunAt=${routine.nextRunAt ?? "null"} -> ${routine.nextRunAt ? shanghaiClock(routine.nextRunAt) : "?"}`,
  );

  const beforeGmail = await gmailSentState();
  const beforeCalendar = await calendarEventsState();
  const test = await rpc(cookie, "routines/testRun", { routineId: routine.id });
  const waited = await waitForRuns(cookie, [test.runId]);
  const status = waited.runs?.[0]?.status;
  const runRow = (await rpc(cookie, "runs/list", { filter: "recent" })).runs?.find(
    (row) => row.runId === test.runId,
  );
  const history = await rpc(cookie, "routines/history", { routineId: routine.id });
  const historyRun = history.runs?.find((run) => run.id === test.runId);
  const snapshot = await botSnapshot(cookie, inbox.id);
  const text = normalizeForMatch(combinedRunText(snapshot, test.runId));
  const steps = combinedRunSteps(snapshot, test.runId);
  const textMessages = botMessagesForRun(snapshot, test.runId).filter(
    (message) => messageText(message).trim(),
  );

  add("testRun completed", status === "completed", `status=${status ?? "?"}, run=${test.runId}`);
  add("run trigger=routine", runRow?.trigger === "routine", `trigger=${runRow?.trigger ?? "?"}`);
  add("history has completed run", historyRun?.status === "completed", `historyStatus=${historyRun?.status ?? "?"}`);
  add("one briefing message", textMessages.length === 1, `messages=${textMessages.length}`);
  const missing = [
    ["m1 远山/李总", /远山|李总/.test(text)],
    ["m2 INV-42/金额修正", /inv-?42|金额修正/.test(text)],
    ["m3 报价/王总", /报价|王总/.test(text)],
    ["m1 截止 10-30", deadlineHit(text, "10-30")],
    ["m2/m3 截止 10-27", deadlineHit(text, "10-27")],
  ]
    .filter(([, hit]) => !hit)
    .map(([label]) => label);
  add(
    "briefing includes m1/m2/m3 and deadlines",
    missing.length === 0,
    missing.length > 0 ? `missing=${missing.join(", ")}; text=${text.slice(0, 240)}` : "all present",
  );
  add(
    "briefing excludes m4/m5",
    !/行业周报|周报/.test(text) && !/午餐/.test(text),
    text.slice(0, 240) || "no briefing text",
  );
  add(
    "briefing read Gmail",
    steps.some((label) => /gmail/i.test(label)) || missing.length === 0,
    `steps=${steps.join(" | ") || "none"}`,
  );
  const afterGmail = await gmailSentState();
  const afterCalendar = await calendarEventsState();
  add(
    "no external write",
    afterGmail.sent.length === 0 && JSON.stringify(afterCalendar.events) === JSON.stringify(beforeCalendar.events),
    `gmailSent=${afterGmail.sent.length}, calendarEvents=${afterCalendar.events.length}`,
  );

  const listed = (await rpc(cookie, "routines/list", { botId: inbox.id })).find(
    (candidate) => candidate.id === routine.id,
  );
  add(
    "routine listed as active daily 08:30",
    listed?.active === true &&
      listed.crons.length === 1 &&
      listed.crons[0] === "30 8 * * *" &&
      listed.timezone === "Asia/Shanghai",
    listed ? `active=${listed.active}, crons=${listed.crons.join(",")}, timezone=${listed.timezone}` : "routine missing from list",
  );

  const passed = checks.every((check) => check.pass);
  console.log(`  result: ${passed ? "PASS" : "FAIL"}`);
  return {
    id: item.id,
    status: passed ? "PASS" : "FAIL",
    reason: passed ? "assertions_passed" : "assertions_failed",
    reset,
    model: modelState,
    assertions: checks,
  };
}

async function competitorState() {
  const state = await getJson("http://127.0.0.1:4310/__state");
  return {
    status: state.status,
    teamPrice: state.json?.teamPrice,
    changelogCount: state.json?.changelogCount,
    mutated: state.json?.mutated,
  };
}

async function waitForWatchState(cookie, botId, routineId, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const routines = await rpc(cookie, "routines/list", { botId });
    last = routines.find((routine) => routine.id === routineId) ?? null;
    if (last?.watchState && predicate(last.watchState)) return last;
    await sleep(1_000);
  }
  return last;
}

async function runCase11(cookie, item, reset, modelState) {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const bots = await rpc(cookie, "bots/list");
  const research = bots.find((bot) => bot.name === "研究");
  add("研究 exists", Boolean(research), `bot=${research?.id ?? "missing"}`);
  if (!research) {
    return { id: item.id, status: "FAIL", reason: "missing_bot", reset, model: modelState, assertions: checks };
  }

  await rpc(cookie, "threads/clear", { botId: research.id });
  const clearMonitoringScratchpad = async () => {
    const items = await rpc(cookie, "scratchpad/list", {
      botId: research.id,
      includeDone: true,
    });
    const stale = items.filter((item) =>
      /云图|竞品|监测|监控/.test(`${item.title} ${item.notes}`),
    );
    for (const item of stale) {
      await rpc(cookie, "scratchpad/remove", { itemId: item.id });
    }
    return stale.length;
  };
  const clearedBefore = await clearMonitoringScratchpad();
  console.log(`  setup: cleared ${clearedBefore} stale monitoring scratchpad item(s)`);
  const existing = await rpc(cookie, "routines/list", { botId: research.id });
  for (const routine of existing) {
    if (routine.name.startsWith("Eval ") || routine.prompt.includes("竞品") || routine.prompt.includes("云图")) {
      await rpc(cookie, "routines/remove", { routineId: routine.id });
    }
  }

  await postJson("http://127.0.0.1:4310/__reset");
  const baseline = await competitorState();
  add(
    "competitor baseline 199/3 logs",
    baseline.teamPrice === 199 && baseline.changelogCount === 3,
    `teamPrice=${baseline.teamPrice}, changelogCount=${baseline.changelogCount}`,
  );

  const beforeCreateRuns = await recentRunIds(cookie);
  const routine = await rpc(cookie, "routines/create", {
    botId: research.id,
    name: "Eval 竞品监控 60m",
    prompt: item.input,
    crons: [],
    timezone: "Asia/Shanghai",
    active: true,
    notify: true,
    watch: {
      kind: "command",
      command:
        "curl -s http://host.docker.internal:4310/pricing.json; curl -s http://host.docker.internal:4310/changelog",
      everyMinutes: 60,
      loud: false,
    },
  });
  add(
    "routine watch every 60m, no cron",
    routine.active === true &&
      routine.notify === true &&
      routine.crons.length === 0 &&
      Boolean(routine.watch) &&
      ["command", "files"].includes(routine.watch.kind) &&
      routine.watch.everyMinutes === 60,
    `active=${routine.active}, notify=${routine.notify}, crons=${routine.crons.length}, watch=${routine.watch ? `${routine.watch.kind}/${routine.watch.everyMinutes}` : "null"}`,
  );

  const baselineState = await waitForWatchState(
    cookie,
    research.id,
    routine.id,
    (state) => state.outcome === "baseline" || state.outcome === "failed",
  );
  add(
    "baseline watch check recorded",
    baselineState?.watchState?.outcome === "baseline" && Boolean(baselineState.watchState.fingerprint),
    baselineState?.watchState
      ? `outcome=${baselineState.watchState.outcome}, fingerprint=${baselineState.watchState.fingerprint ? "set" : "null"}`
      : "no watch state",
  );
  const baselineRuns = (await rpc(cookie, "runs/list", { filter: "recent" })).runs?.filter(
    (row) => !beforeCreateRuns.has(row.runId) && row.botName === "研究" && row.trigger === "routine",
  ) ?? [];
  add("no change sends no run", baselineRuns.length === 0, `newRoutineRuns=${baselineRuns.length}`);
  const baselineSnapshot = await botSnapshot(cookie, research.id);
  add(
    "no change keeps thread silent",
    (baselineSnapshot.messages ?? []).length === 0,
    `messages=${(baselineSnapshot.messages ?? []).length}`,
  );

  const forceCheck = async () => {
    const before = await recentRunIds(cookie);
    await rpc(cookie, "routines/update", { routineId: routine.id, active: false });
    await rpc(cookie, "routines/update", { routineId: routine.id, active: true });
    const row = await waitForNewRun(
      cookie,
      before,
      (candidate) => candidate.botName === "研究" && candidate.trigger === "routine",
      120_000,
    );
    if (!row) return null;
    const waited = await waitForRuns(cookie, [row.runId], 300_000);
    const snapshot = await botSnapshot(cookie, research.id);
    const textMessages = botMessagesForRun(snapshot, row.runId).filter(
      (message) => messageText(message).trim(),
    );
    const text = normalizeForMatch(textMessages.map(messageText).join("\n"));
    const steps = combinedRunSteps(snapshot, row.runId);
    return { runId: row.runId, status: waited.runs?.[0]?.status, textMessages, text, steps };
  };

  const forceQuietCheck = async () => {
    const beforeState = await waitForWatchState(cookie, research.id, routine.id, () => true);
    const beforeRunIds = await recentRunIds(cookie);
    const beforeSnapshot = await botSnapshot(cookie, research.id);
    const beforeMessages = (beforeSnapshot.messages ?? []).length;
    await rpc(cookie, "routines/update", { routineId: routine.id, active: false });
    await rpc(cookie, "routines/update", { routineId: routine.id, active: true });
    const afterState = await waitForWatchState(
      cookie,
      research.id,
      routine.id,
      (state) => state.checkedAt !== beforeState?.watchState?.checkedAt,
      90_000,
    );
    const newRuns = (await rpc(cookie, "runs/list", { filter: "recent" })).runs?.filter(
      (row) => !beforeRunIds.has(row.runId) && row.botName === "研究" && row.trigger === "routine",
    ) ?? [];
    const afterSnapshot = await botSnapshot(cookie, research.id);
    return {
      beforeState,
      afterState,
      newRuns,
      beforeMessages,
      afterMessages: (afterSnapshot.messages ?? []).length,
    };
  };

  const mutate = await postJson("http://127.0.0.1:4310/__fixture/mutate");
  const mutated = await competitorState();
  add(
    "fixture mutated to 229 + audit log",
    mutate.status === 200 && mutated.teamPrice === 229 && mutated.changelogCount === 4,
    `HTTP ${mutate.status}, teamPrice=${mutated.teamPrice}, changelogCount=${mutated.changelogCount}`,
  );

  const second = await forceCheck();
  if (!second) {
    add("second wake created by watch", false, "no routine run after mutation check");
  } else {
    add("second wake completed", second.status === "completed", `status=${second.status ?? "?"}, run=${second.runId}`);
    add(
      "second wake read the site",
      second.steps.some((label) => /shell|browser|fetch/i.test(label)),
      `steps=${second.steps.join(" | ") || "none"}`,
    );
    add("second wake sends one briefing", second.textMessages.length === 1, `messages=${second.textMessages.length}`);
    add(
      "second wake reports 229 and audit log",
      /229/.test(second.text) && /审计|audit/i.test(second.text),
      second.text.slice(0, 240) || "no text",
    );
    const changedState = await waitForWatchState(
      cookie,
      research.id,
      routine.id,
      (state) => state.outcome === "changed",
    );
    add(
      "watch state recorded a change",
      changedState?.watchState?.outcome === "changed" && Boolean(changedState.watchState.fingerprint),
      changedState?.watchState ? `outcome=${changedState.watchState.outcome}` : "no watch state",
    );
  }

  const quiet = await forceQuietCheck();
  add(
    "third check sees no change",
    quiet.afterState?.watchState?.outcome === "unchanged" &&
      quiet.afterState.watchState.checkedAt !== quiet.beforeState?.watchState?.checkedAt,
    quiet.afterState?.watchState
      ? `outcome=${quiet.afterState.watchState.outcome}`
      : "no watch state",
  );
  add("third check sends no run", quiet.newRuns.length === 0, `newRoutineRuns=${quiet.newRuns.length}`);
  add(
    "third check adds no message",
    quiet.afterMessages === quiet.beforeMessages,
    `messages ${quiet.beforeMessages} -> ${quiet.afterMessages}`,
  );

  const afterGmail = await gmailSentState();
  add("no external write", afterGmail.sent.length === 0, `gmailSent=${afterGmail.sent.length}`);
  const listed = (await rpc(cookie, "routines/list", { botId: research.id })).find(
    (candidate) => candidate.id === routine.id,
  );
  add(
    "routine listed active watch 60m",
    listed?.active === true &&
      Boolean(listed.watch) &&
      listed.watch.everyMinutes === 60 &&
      listed.crons.length === 0,
    listed ? `active=${listed.active}, watch=${listed.watch ? `${listed.watch.kind}/${listed.watch.everyMinutes}` : "null"}, crons=${listed.crons.length}` : "routine missing",
  );

  const cleanupReset = await postJson("http://127.0.0.1:4310/__reset");
  const cleaned = await competitorState();
  await rpc(cookie, "routines/update", { routineId: routine.id, active: false });
  const clearedAfter = await clearMonitoringScratchpad();
  console.log(
    `  cleanup: competitor ${cleaned.teamPrice}/${cleaned.changelogCount}, routine paused, ${clearedAfter} monitoring scratchpad item(s) cleared (reset HTTP ${cleanupReset.status})`,
  );

  const passed = checks.every((check) => check.pass);
  console.log(`  result: ${passed ? "PASS" : "FAIL"}`);
  return {
    id: item.id,
    status: passed ? "PASS" : "FAIL",
    reason: passed ? "assertions_passed" : "assertions_failed",
    reset,
    model: modelState,
    assertions: checks,
  };
}

async function runCase02(cookie, item, reset, modelState) {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const target = await resolveTarget(cookie, item);
  const chief = target.members.find((member) => member.name === "总管");
  const research = target.members.find((member) => member.name === "研究");
  const schedule = target.members.find((member) => member.name === "日程");
  add(
    "group has 总管/研究/日程",
    Boolean(chief && research && schedule),
    `chief=${chief?.botId ?? "missing"}, research=${research?.botId ?? "missing"}, schedule=${schedule?.botId ?? "missing"}`,
  );
  if (!chief || !research || !schedule) {
    return { id: item.id, status: "FAIL", reason: "missing_members", reset, model: modelState, assertions: checks };
  }

  const beforeEvents = JSON.stringify((await calendarEventsState()).events);
  const beforeRunIds = await recentRunIds(cookie);
  const sent = await sendCase(cookie, item, target);
  console.log(`  target: group ${target.groupId}`);
  console.log(`  runIds: ${sent.runIds.join(", ")}`);
  const initial = await waitForRuns(cookie, sent.runIds, 300_000);
  add(
    "initial 总管 run completed",
    initial.runs.length > 0 && initial.runs.every((run) => run.status === "completed"),
    initial.runs.map((run) => `${run.botName}:${run.status}`).join(", ") || "no run row",
  );

  let snapshot = null;
  let handoffs = [];
  let chainRuns = [];
  let researchRun = null;
  let scheduleRun = null;
  let scheduleReply = null;
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    snapshot = await rpc(cookie, "threads/get", { groupId: target.groupId });
    handoffs = (snapshot.messages ?? []).flatMap((message) =>
      (message.blocks ?? []).filter((block) => block.kind === "handoff"),
    );
    const recent = (await rpc(cookie, "runs/list", { filter: "recent" })).runs ?? [];
    chainRuns = recent.filter(
      (row) => row.threadId === target.threadId && !beforeRunIds.has(row.runId),
    );
    researchRun = chainRuns.find((row) => row.botName === "研究") ?? null;
    scheduleRun = chainRuns.find((row) => row.botName === "日程") ?? null;
    const h1 = handoffs.find(
      (block) => block.fromBotId === chief.botId && block.toBotId === research.botId,
    );
    const h2 = handoffs.find(
      (block) => block.fromBotId === research.botId && block.toBotId === schedule.botId,
    );
    const scheduleMessage = (snapshot.messages ?? []).find(
      (message) =>
        message.role === "bot" &&
        message.botId === schedule.botId &&
        message.runId === scheduleRun?.runId &&
        messageText(message).trim(),
    );
    if (h1 && h2 && researchRun?.status === "completed" && scheduleRun?.status === "completed" && scheduleMessage) {
      scheduleReply = scheduleMessage;
      break;
    }
    await sleep(2_000);
  }

  if (!scheduleReply) {
    scheduleReply = (snapshot?.messages ?? []).find(
      (message) => message.role === "bot" && message.botId === schedule.botId && messageText(message).trim(),
    ) ?? null;
  }
  const h1 = handoffs.find(
    (block) => block.fromBotId === chief.botId && block.toBotId === research.botId,
  );
  const h2 = handoffs.find(
    (block) => block.fromBotId === research.botId && block.toBotId === schedule.botId,
  );
  add("总管→研究 handoff hop=1", h1?.hop === 1, `hop=${h1?.hop ?? "?"}`);
  add("研究→日程 handoff hop=2", h2?.hop === 2, `hop=${h2?.hop ?? "?"}`);
  const maxHop = Math.max(0, ...handoffs.map((block) => block.hop ?? 0));
  add("handoff chain hop <= 6", maxHop <= 6, `maxHop=${maxHop}`);
  const reverse = handoffs.filter(
    (block) =>
      (block.fromBotId === research.botId && block.toBotId === chief.botId) ||
      (block.fromBotId === schedule.botId &&
        [chief.botId, research.botId].includes(block.toBotId)),
  );
  add("no reverse handoff", reverse.length === 0, `reverse=${reverse.length}`);
  add("研究 handoff run completed", researchRun?.status === "completed", `status=${researchRun?.status ?? "?"}`);
  add("日程 handoff run completed", scheduleRun?.status === "completed", `status=${scheduleRun?.status ?? "?"}`);
  add(
    "handoff runs trigger=follow_up",
    Boolean(researchRun) && Boolean(scheduleRun) &&
      researchRun.trigger === "follow_up" &&
      scheduleRun.trigger === "follow_up",
    `research=${researchRun?.trigger ?? "?"}, schedule=${scheduleRun?.trigger ?? "?"}`,
  );
  const scheduleText = normalizeForMatch(messageText(scheduleReply));
  add(
    "日程 final has 11-05 16:00 agenda and prep",
    /11-05|11月5日|2026年11月5日/.test(scheduleText) &&
      scheduleText.includes("16:00") &&
      /议程/.test(scheduleText) &&
      /清单|准备/.test(scheduleText),
    scheduleText.slice(0, 260) || "no 日程 reply",
  );
  const afterEvents = JSON.stringify((await calendarEventsState()).events);
  add("calendar unchanged", afterEvents === beforeEvents, `events=${(await calendarEventsState()).events.length}`);

  if (!h1 || !h2 || researchRun?.status !== "completed" || scheduleRun?.status !== "completed") {
    console.log(
      `  evidence chain: handoffs=${handoffs.map((block) => `${block.fromBotId}->${block.toBotId}@${block.hop ?? "?"}`).join(",") || "none"}; runs=${chainRuns.map((row) => `${row.botName}:${row.status}/${row.trigger}`).join(",") || "none"}`,
    );
  }

  const passed = checks.every((check) => check.pass);
  console.log(`  result: ${passed ? "PASS" : "FAIL"}`);
  return {
    id: item.id,
    status: passed ? "PASS" : "FAIL",
    reason: passed ? "assertions_passed" : "assertions_failed",
    reset,
    model: modelState,
    assertions: checks,
  };
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
  if (item.id === "07") {
    console.log("  flow: 总管接单；若转交收件箱，跟随收件箱线程里的邮件审批卡");
    return await runCase07(cookie, item, reset, modelState);
  }
  if (item.id === "08") {
    console.log("  flow: 日程直接调用 Calendar 创建工具，由平台审批门弹卡");
    return await runCase08(cookie, item, reset, modelState);
  }
  if (item.id === "03") {
    console.log("  flow: 总管私聊委派收件箱，等结果回流到总管");
    return await runCase03(cookie, item, reset, modelState);
  }
  if (item.id === "10") {
    console.log("  flow: routines 直接创建 8:30 简报任务并 testRun");
    return await runCase10(cookie, item, reset, modelState);
  }
  if (item.id === "11") {
    console.log("  flow: 研究 Bot 60 分钟 watch，基线静默 → 229 播报 → 保持 229 再检查静默");
    return await runCase11(cookie, item, reset, modelState);
  }
  if (item.id === "02") {
    console.log("  flow: 新建群，总管→研究→日程 handoff 链");
    return await runCase02(cookie, item, reset, modelState);
  }

  const target = await resolveTarget(cookie, item);
  const beforeRunIds = await recentThreadRunIds(cookie, target.threadId);
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
  if (item.id === "01") {
    const evaluation = await evaluateCase01(cookie, target, sent, waited, beforeRunIds);
    const passed = evaluation.checks.every((check) => check.pass);
    console.log(`  result: ${passed ? "PASS" : "FAIL"}`);
    return {
      id: item.id,
      status: passed ? "PASS" : "FAIL",
      reason: passed ? "assertions_passed" : "assertions_failed",
      reset,
      model: modelState,
      runIds: sent.runIds,
      runs: waited.runs,
      assertions: evaluation.checks,
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
