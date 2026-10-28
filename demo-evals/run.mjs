#!/usr/bin/env node
"use strict";

import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, RESET_SERVICES, SMOKE } from "./cases.mjs";

const HOMES_DIR = fileURLToPath(new URL("../data/homes", import.meta.url));

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
  const scheduleReplyText = replies
    .filter((message) => message.botId === expectedBotId("日程"))
    .map(messageText)
    .join("\n");
  const researchReplyText = replies
    .filter((message) => message.botId === expectedBotId("研究"))
    .map(messageText)
    .join("\n");
  const replyBotIds = new Set(replies.map((message) => message.botId));
  add(
    "two bot replies with correct botIds",
    replyBotIds.size === 2 &&
      replyBotIds.has(expectedBotId("日程")) &&
      replyBotIds.has(expectedBotId("研究")),
    `messages=${replies.length}, bots=${[...replyBotIds].join(", ") || "none"}`,
  );

  const scheduleText = normalizeForMatch(scheduleReplyText);
  add(
    "schedule reply states conflict and slot",
    scheduleText.includes("产品评审") && scheduleText.includes("15:00-16:00"),
    scheduleText ? scheduleText.slice(0, 160) : "missing schedule reply",
  );

  const researchText = normalizeForMatch(researchReplyText);
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

  const scheduleRun = waited.runs.find((run) => run.botName === "日程");
  const researchRun = waited.runs.find((run) => run.botName === "研究");
  const scheduleSteps = combinedRunSteps(snapshot, scheduleRun?.runId);
  add(
    "schedule run read the calendar",
    scheduleSteps.some((label) => /calendar/i.test(label)),
    `steps=${scheduleSteps.join(" | ") || "none"}`,
  );

  const researchSteps = combinedRunSteps(snapshot, researchRun?.runId);
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

async function clearBotScratchpad(cookie, botId) {
  const items = await rpc(cookie, "scratchpad/list", { botId, includeDone: true });
  for (const item of items) {
    await rpc(cookie, "scratchpad/remove", { itemId: item.id });
  }
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
    await clearBotScratchpad(cookie, chief.id);
    await clearBotScratchpad(cookie, inbox.id);
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
      const timeMatches =
        body.includes("16:00") ||
        /下午\s*4\s*[:：]?\s*0?0/.test(body) ||
        /下午\s*4\s*点/.test(body);
      add(
        "[allow] body carries 2026-11-05 16:00",
        timeMatches &&
          /2026-11-05|2026年11月5日|2026\s*年\s*11\s*月\s*5\s*日|11月5日|11-05/.test(body),
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
  const inboxRawText = combinedRunText(inboxSnapshot, inboxRun.runId);
  const inboxText = normalizeForMatch(inboxRawText);
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
    "收件箱 briefing excludes m4/m5 as todo",
    !listsM4M5AsTodo(inboxRawText),
    listsM4M5AsTodo(inboxRawText) ? inboxRawText.slice(0, 220) : "not in numbered/bulleted items",
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
  const rawText = combinedRunText(snapshot, test.runId);
  const text = normalizeForMatch(rawText);
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
  const m4m5Listed = listsM4M5AsTodo(rawText);
  add(
    "briefing does not list m4/m5 as todo",
    !m4m5Listed,
    m4m5Listed ? `listed m4/m5 as item; text=${rawText.slice(0, 240)}` : "not in numbered/bulleted/table items",
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

async function clearMonitoringArtifacts(botId) {
  const home = path.join(HOMES_DIR, botId);
  await rm(path.join(home, "monitor"), { recursive: true, force: true });
  await rm(path.join(home, "yuntu"), { recursive: true, force: true });
  const reports = path.join(home, "reports");
  try {
    const entries = await readdir(reports, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) await rm(path.join(reports, entry.name), { force: true });
    }
  } catch {
    // No reports directory is fine.
  }
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
  await clearMonitoringArtifacts(research.id);
  console.log(`  setup: cleared ${clearedBefore} stale monitoring scratchpad item(s) and monitor/report files`);
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

async function listComputerFiles(cookie, botId, path) {
  try {
    return await rpc(cookie, "computer/files", { botId, path });
  } catch {
    return null;
  }
}

async function snapshotHomeFiles(cookie, botId) {
  const files = new Map();
  const visit = async (path, depth) => {
    const entries = await listComputerFiles(cookie, botId, path);
    if (!entries) return;
    for (const entry of entries) {
      const full = entry.path.startsWith("/") ? entry.path : `/${entry.path}`;
      if (entry.kind === "file") files.set(full, entry.size);
      else if (
        entry.kind === "dir" &&
        depth < 2 &&
        !/\/\.(browser-profiles|cache|config|dbus|local|fontconfig)(\/|$)/.test(full)
      ) {
        await visit(full, depth + 1);
      }
    }
  };
  await visit("/", 0);
  return files;
}

async function readComputerFile(cookie, botId, path) {
  try {
    const result = await rpc(cookie, "computer/readFile", { botId, path });
    return result.content;
  } catch {
    return null;
  }
}

async function runCase04(cookie, item, reset, modelState) {
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

  const boot = await rpc(cookie, "computer/boot", { botId: research.id });
  add("research computer running", boot.state === "running", `state=${boot.state}`);
  const beforeFiles = await snapshotHomeFiles(cookie, research.id);
  const beforeContents = new Map();
  for (const [path] of beforeFiles) {
    if (path.endsWith(".md")) beforeContents.set(path, await readComputerFile(cookie, research.id, path));
  }

  const target = await resolveTarget(cookie, item);
  const sent = await sendCase(cookie, item, target);
  console.log(`  target: bot ${target.threadId}`);
  console.log(`  runIds: ${sent.runIds.join(", ")}`);
  const waited = await waitForRuns(cookie, sent.runIds, 300_000);
  const runId = sent.runIds[0];
  const status = waited.runs?.[0]?.status;
  const snapshot = await botSnapshot(cookie, research.id);
  add("research run completed", status === "completed", `status=${status ?? "?"}, run=${runId}`);
  const steps = combinedRunSteps(snapshot, runId);
  add(
    "research used the computer browser",
    steps.some((label) => /browser|computer_observe|computer_act/i.test(label)),
    `steps=${steps.join(" | ") || "none"}`,
  );

  const afterFiles = await snapshotHomeFiles(cookie, research.id);
  const candidates = [];
  for (const [path, size] of afterFiles) {
    if (!path.endsWith(".md")) continue;
    const beforeSize = beforeFiles.get(path);
    const content = await readComputerFile(cookie, research.id, path);
    if (content == null) continue;
    const changed =
      beforeSize === undefined || beforeSize !== size || beforeContents.get(path) !== content;
    if (changed) candidates.push({ path, content });
  }
  const looksLikeBrief = (content) =>
    /199/.test(content) &&
    /399/.test(content) &&
    /云图|竞品/.test(content) &&
    /更新日志|changelog/i.test(content);
  const brief = candidates.find((candidate) => looksLikeBrief(candidate.content)) ?? candidates[0] ?? null;
  add(
    "new or updated brief in own home",
    Boolean(brief) && !brief.path.startsWith("/shared/"),
    brief ? `path=${brief.path}` : `candidates=${candidates.map((candidate) => candidate.path).join(",") || "none"}`,
  );
  if (brief) {
    const content = brief.content;
    add("brief has team 199 / enterprise 399", content.includes("199") && content.includes("399"), `path=${brief.path}`);
    const logHits = ["2026-10-21", "2026-10-14", "2026-10-07"].filter((date) => content.includes(date)).length;
    add("brief has 3 changelog entries", logHits === 3, `dateHits=${logHits}/3`);
    add(
      "brief has source links",
      /host\.docker\.internal:4310\/pricing/.test(content) &&
        /host\.docker\.internal:4310\/changelog/.test(content),
      "pricing+changelog links",
    );
  } else {
    add("brief has team 199 / enterprise 399", false, "no brief file");
    add("brief has 3 changelog entries", false, "no brief file");
    add("brief has source links", false, "no brief file");
  }

  const shared = await listComputerFiles(cookie, research.id, "/shared");
  let sharedBrief = false;
  if (shared) {
    for (const entry of shared.filter((candidate) => candidate.kind === "file" && candidate.path.endsWith(".md")).slice(0, 20)) {
      const content = await readComputerFile(
        cookie,
        research.id,
        entry.path.startsWith("/") ? entry.path : `/${entry.path}`,
      );
      if (content && /199/.test(content) && /399/.test(content) && /云图|竞品/.test(content)) {
        sharedBrief = true;
        break;
      }
    }
  }
  add(
    "shared has no brief",
    !sharedBrief,
    shared ? `entries=${shared.length}, brief=${sharedBrief}` : "no shared directory (dedicated bot)",
  );
  const profiles = await listComputerFiles(cookie, research.id, "/.browser-profiles");
  add(
    "independent browser profile",
    Array.isArray(profiles) && profiles.length > 0,
    profiles?.map((entry) => entry.path).join(",") || "none",
  );

  if (!brief) {
    console.log(
      `  evidence: run=${runId} status=${status ?? "?"}; steps=${steps.join(" | ") || "none"}; text=${messageText((snapshot.messages ?? []).find((message) => message.runId === runId && message.role === "bot")).slice(0, 300) || "none"}; candidates=${candidates.map((candidate) => candidate.path).join(",") || "none"}`,
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

async function crmState() {
  const state = await getJson("http://127.0.0.1:4314/__state");
  return {
    status: state.status,
    notes: Array.isArray(state.json?.notes) ? state.json.notes : [],
    contacts: Array.isArray(state.json?.contacts) ? state.json.contacts : [],
  };
}

async function runThreadRunIds(cookie, threadId) {
  const [active, recent] = await Promise.all([
    rpc(cookie, "runs/list", { filter: "active" }),
    rpc(cookie, "runs/list", { filter: "recent" }),
  ]);
  return new Set(
    [...(active.runs ?? []), ...(recent.runs ?? [])]
      .filter((row) => row.threadId === threadId)
      .map((row) => row.runId),
  );
}

async function runRowFor(cookie, runId) {
  const [active, recent] = await Promise.all([
    rpc(cookie, "runs/list", { filter: "active" }),
    rpc(cookie, "runs/list", { filter: "recent" }),
  ]);
  return [...(active.runs ?? []), ...(recent.runs ?? [])].find((row) => row.runId === runId) ?? null;
}

function isSubsetOf(left, right) {
  return [...left].every((id) => right.has(id));
}

async function runCase09(cookie, item, reset, modelState) {
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
  await postJson("http://127.0.0.1:4314/__reset");
  await postJson("http://127.0.0.1:4312/__reset");
  const baselineCrm = await crmState();
  const baselineGmail = await gmailSentState();
  add("CRM starts with 0 notes", baselineCrm.notes.length === 0, `notes=${baselineCrm.notes.length}`);
  add("Gmail starts with 0 sent", baselineGmail.sent.length === 0, `sent=${baselineGmail.sent.length}`);

  const target = {
    kind: "bot",
    botId: inbox.id,
    threadId: inbox.threadId,
    members: [{ botId: inbox.id, name: inbox.name }],
  };
  const sent = await sendCase(cookie, item, target);
  const runIds = sent.runIds;
  const runId = runIds[0];
  console.log(`  runIds: ${runIds.join(", ")}`);
  const firstWait = await waitForRuns(cookie, runIds, 300_000);
  const firstStatus = firstWait.runs?.[0]?.status;
  const firstSnapshot = await botSnapshot(cookie, inbox.id);
  const crmCard = findPendingApproval(firstSnapshot, runId, /CRM_CREATE_NOTE/i);
  add("first approval is CRM note", Boolean(crmCard), crmCard ? `message=${crmCard.message.id}` : "no CRM_CREATE_NOTE card");
  add("run waits on CRM approval", firstStatus === "waiting_input", `status=${firstStatus ?? "?"}`);
  const firstCrm = await crmState();
  const firstGmail = await gmailSentState();
  add("CRM notes=0 before approval", firstCrm.notes.length === 0, `notes=${firstCrm.notes.length}`);
  add("Gmail sent=0 before approval", firstGmail.sent.length === 0, `sent=${firstGmail.sent.length}`);
  if (!crmCard) {
    console.log(
      `  evidence no CRM approval: run=${runId} status=${firstStatus ?? "?"}; ${runEvidence(firstSnapshot, runId)}; ask=${runAskPayloads(firstSnapshot, runId)}; crmNotes=${firstCrm.notes.length}; gmailSent=${firstGmail.sent.length}`,
    );
    const passed = checks.every((check) => check.pass);
    console.log(`  result: ${passed ? "PASS" : "FAIL"}`);
    return { id: item.id, status: passed ? "PASS" : "FAIL", reason: "assertions_failed", reset, model: modelState, assertions: checks };
  }

  const beforeCrmRefresh = await runThreadRunIds(cookie, inbox.threadId);
  const crmRefreshSnapshot = await botSnapshot(cookie, inbox.id);
  const crmRefreshCard = findPendingApproval(crmRefreshSnapshot, runId, /CRM_CREATE_NOTE/i);
  const crmRefreshRow = await runRowFor(cookie, runId);
  const afterCrmRefresh = await runThreadRunIds(cookie, inbox.threadId);
  add(
    "refresh keeps the same CRM card",
    crmRefreshCard?.message.id === crmCard.message.id &&
      crmRefreshCard?.block.approvalEffectId === crmCard.block.approvalEffectId,
    `message=${crmRefreshCard?.message.id ?? "missing"}`,
  );
  add("refresh keeps run waiting", crmRefreshRow?.status === "waiting_input", `status=${crmRefreshRow?.status ?? "?"}`);
  add("refresh creates no new run", isSubsetOf(afterCrmRefresh, beforeCrmRefresh), `runs=${afterCrmRefresh.size}`);

  await rpc(cookie, "threads/answer", {
    botId: inbox.id,
    runId,
    messageId: crmCard.message.id,
    answer: "allow",
  });
  const afterCrmWait = await waitForRuns(cookie, [runId], 300_000);
  const afterCrmStatus = afterCrmWait.runs?.[0]?.status;
  const crmAfter = await crmState();
  add("CRM note exactly 1", crmAfter.notes.length === 1, `notes=${crmAfter.notes.length}`);
  if (crmAfter.notes.length === 1) {
    const note = crmAfter.notes[0];
    const noteText = normalizeForMatch(note.body);
    add("CRM note targets 远山科技", note.contactId === "customer-yuanshan", `contactId=${note.contactId}`);
    add("CRM note carries contract amount", /48\s*万|480,?000/.test(noteText), `body=${String(note.body).slice(0, 160)}`);
    add("CRM note mentions contract/amount", /合同|金额/.test(noteText), `body=${String(note.body).slice(0, 160)}`);
  }
  const secondSnapshot = await botSnapshot(cookie, inbox.id);
  const emailCard = findPendingApproval(secondSnapshot, runId, /GMAIL_SEND_EMAIL/i);
  add(
    "second approval is email send",
    afterCrmStatus === "waiting_input" && Boolean(emailCard),
    `status=${afterCrmStatus ?? "?"}, card=${emailCard?.message.id ?? "missing"}`,
  );
  add("Gmail sent=0 before email approval", (await gmailSentState()).sent.length === 0, `sent=${(await gmailSentState()).sent.length}`);
  if (!emailCard) {
    console.log(
      `  evidence no email approval: run=${runId} status=${afterCrmStatus ?? "?"}; ${runEvidence(secondSnapshot, runId)}; ask=${runAskPayloads(secondSnapshot, runId)}; crmNotes=${crmAfter.notes.length}`,
    );
    const passed = checks.every((check) => check.pass);
    console.log(`  result: ${passed ? "PASS" : "FAIL"}`);
    return { id: item.id, status: passed ? "PASS" : "FAIL", reason: "assertions_failed", reset, model: modelState, assertions: checks };
  }

  const beforeEmailRefresh = await runThreadRunIds(cookie, inbox.threadId);
  const emailRefreshSnapshot = await botSnapshot(cookie, inbox.id);
  const emailRefreshCard = findPendingApproval(emailRefreshSnapshot, runId, /GMAIL_SEND_EMAIL/i);
  const emailRefreshRow = await runRowFor(cookie, runId);
  const afterEmailRefresh = await runThreadRunIds(cookie, inbox.threadId);
  add(
    "refresh keeps the same email card",
    emailRefreshCard?.message.id === emailCard.message.id &&
      emailRefreshCard?.block.approvalEffectId === emailCard.block.approvalEffectId,
    `message=${emailRefreshCard?.message.id ?? "missing"}`,
  );
  add("email run still waiting", emailRefreshRow?.status === "waiting_input", `status=${emailRefreshRow?.status ?? "?"}`);
  add("email refresh creates no new run", isSubsetOf(afterEmailRefresh, beforeEmailRefresh), `runs=${afterEmailRefresh.size}`);

  await rpc(cookie, "threads/answer", {
    botId: inbox.id,
    runId,
    messageId: emailCard.message.id,
    answer: "allow",
  });
  const finalWait = await waitForRuns(cookie, [runId], 300_000);
  const finalStatus = finalWait.runs?.[0]?.status;
  add("run terminal after both approvals", TERMINAL.has(finalStatus), `status=${finalStatus ?? "?"}`);
  const gmailAfter = await gmailSentState();
  add("email sent exactly 1", gmailAfter.sent.length === 1, `sent=${gmailAfter.sent.length}`);
  if (gmailAfter.sent.length === 1) {
    const record = gmailAfter.sent[0];
    add("email recipient is 李总", /li@yuanshan\.example|李总/i.test(String(record.to ?? "")), `to=${record.to ?? "?"}`);
    add(
      "email is a quote",
      /报价|续约/.test(normalizeForMatch(`${record.subject ?? ""} ${record.body ?? ""}`)),
      `subject=${record.subject ?? "?"}`,
    );
  }
  const finalCrm = await crmState();
  const finalGmail = await gmailSentState();
  add("refresh keeps CRM notes at 1", finalCrm.notes.length === 1, `notes=${finalCrm.notes.length}`);
  add("refresh keeps Gmail sent at 1", finalGmail.sent.length === 1, `sent=${finalGmail.sent.length}`);
  const finalRuns = await runThreadRunIds(cookie, inbox.threadId);
  add("no extra run after both approvals", isSubsetOf(finalRuns, beforeCrmRefresh), `runs=${finalRuns.size}`);

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

async function memoryDocs(cookie, botId, scope) {
  return rpc(cookie, "memory/list", scope === "user" ? { scope: "user" } : { botId, scope: "bot" });
}

async function resetMemoryForCase12(cookie, bots) {
  const preference = /远山|一页纸|Asia\/Shanghai|李总/;
  for (const bot of bots) {
    const docs = await memoryDocs(cookie, bot.id, "bot");
    for (const doc of docs) {
      if (!preference.test(doc.content)) continue;
      if (doc.path === "MEMORY.md") {
        await rpc(cookie, "memory/update", {
          documentId: doc.id,
          content: `# ${bot.name}\n`,
          expectedRevision: doc.revision,
        });
      } else {
        await rpc(cookie, "memory/remove", { documentId: doc.id });
      }
    }
  }
  const userDocs = await memoryDocs(cookie, null, "user");
  for (const doc of userDocs) {
    if (!preference.test(doc.content)) continue;
    if (doc.path === "MEMORY.md") {
      await rpc(cookie, "memory/update", {
        documentId: doc.id,
        content: "# Space memory\n\nPreferences and context kept within this space live here.\n",
        expectedRevision: doc.revision,
      });
    } else {
      await rpc(cookie, "memory/remove", { documentId: doc.id });
    }
  }
}

async function runCase12(cookie, item, reset, modelState) {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const bots = await rpc(cookie, "bots/list");
  const chief = bots.find((bot) => bot.name === "总管");
  const research = bots.find((bot) => bot.name === "研究");
  add("总管 and 研究 exist", Boolean(chief && research), `chief=${chief?.id ?? "missing"}, research=${research?.id ?? "missing"}`);
  if (!chief || !research) {
    return { id: item.id, status: "FAIL", reason: "missing_bots", reset, model: modelState, assertions: checks };
  }

  await rpc(cookie, "threads/clear", { botId: chief.id });
  await resetMemoryForCase12(cookie, bots);
  const cleaned = [...(await memoryDocs(cookie, chief.id, "bot")), ...(await memoryDocs(cookie, null, "user"))]
    .map((doc) => doc.content)
    .join("\n");
  add("memory cleaned before the test", !/远山|一页纸|Asia\/Shanghai|李总/.test(cleaned), "no stale 远山 preference");

  const turnStart = new Date().toISOString();
  const turn1 = await rpc(cookie, "threads/send", { botId: chief.id, text: item.turns[0] });
  const turn1Ids = Array.isArray(turn1.runIds) && turn1.runIds.length > 0 ? turn1.runIds : [turn1.runId];
  const turn1Wait = await waitForRuns(cookie, turn1Ids, 300_000);
  add("turn 1 completed", turn1Wait.runs?.[0]?.status === "completed", `status=${turn1Wait.runs?.[0]?.status ?? "?"}`);

  const chiefMemory = await memoryDocs(cookie, chief.id, "bot");
  const userMemory = await memoryDocs(cookie, null, "user");
  const memoryText = [...chiefMemory, ...userMemory].map((doc) => doc.content).join("\n");
  const preferences = ["中文", "一页纸", "Asia/Shanghai", "李总"];
  const missingPreferences = preferences.filter((term) => !memoryText.includes(term));
  add(
    "memory/list contains four 远山 preferences",
    missingPreferences.length === 0,
    missingPreferences.length > 0 ? `missing=${missingPreferences.join(", ")}` : "中文/一页纸/Asia/Shanghai/李总",
  );
  const memoryUpdated = [...chiefMemory, ...userMemory].some(
    (doc) => new Date(doc.updatedAt) >= new Date(turnStart),
  );
  add("memory was written after turn 1", memoryUpdated, `docs=${chiefMemory.length + userMemory.length}`);

  const otherMemory = [...(await memoryDocs(cookie, research.id, "bot")), ...(await memoryDocs(cookie, null, "user"))]
    .map((doc) => doc.content)
    .join("\n");
  add(
    "another bot cannot see the preference",
    !/远山|一页纸|Asia\/Shanghai|李总/.test(otherMemory),
    "研究 + user scope",
  );

  await rpc(cookie, "threads/clear", { botId: chief.id });
  const turn2 = await rpc(cookie, "threads/send", { botId: chief.id, text: item.turns[1] });
  const turn2Ids = Array.isArray(turn2.runIds) && turn2.runIds.length > 0 ? turn2.runIds : [turn2.runId];
  const turn2Wait = await waitForRuns(cookie, turn2Ids, 300_000);
  add("turn 2 completed", turn2Wait.runs?.[0]?.status === "completed", `status=${turn2Wait.runs?.[0]?.status ?? "?"}`);
  const snapshot = await botSnapshot(cookie, chief.id);
  const reply = (snapshot.messages ?? [])
    .filter((message) => message.role === "bot" && message.runId === turn2Ids[0])
    .map(messageText)
    .join("\n");
  const text = normalizeForMatch(reply);
  add(
    "new session gives 11-05 16:00 agenda",
    /11-05|11月5日|2026年11月5日|2026\s*年\s*11\s*月\s*5\s*日/.test(text) &&
      text.includes("16:00") &&
      text.includes("议程"),
    text.slice(0, 260) || "no reply",
  );
  add("new session uses 李总", text.includes("李总"), text.slice(0, 160) || "no reply");
  add("new session is Chinese", /[\u4e00-\u9fff]/.test(text), "has Chinese characters");
  add(
    "new session does not re-ask preferences",
    !/什么语言|用哪种语言|哪个时区|时区是|怎么称呼|如何称呼|称呼您|您希望我叫/.test(text),
    text.slice(0, 240) || "no reply",
  );
  const otherAfter = [...(await memoryDocs(cookie, research.id, "bot")), ...(await memoryDocs(cookie, null, "user"))]
    .map((doc) => doc.content)
    .join("\n");
  add(
    "another bot still cannot see the preference",
    !/远山|一页纸|Asia\/Shanghai|李总/.test(otherAfter),
    "研究 + user scope",
  );

  if (text === "") {
    console.log(`  evidence: turn2=${turn2Ids[0]} status=${turn2Wait.runs?.[0]?.status ?? "?"}; memory=${memoryText.slice(0, 300)}`);
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

async function portalState() {
  const state = await getJson("http://127.0.0.1:4311/__state");
  return {
    status: state.status,
    sessions: state.json?.sessions ?? 0,
    unread: state.json?.unread ?? 0,
  };
}

async function profileNames(cookie, botId) {
  const entries = await listComputerFiles(cookie, botId, "/.browser-profiles");
  return (entries ?? []).map((entry) => entry.path).sort();
}

function hasThreeUnread(text) {
  const plain = String(text).replace(/[*_`]/g, "");
  return /(?:3\s*unread|3\s*条未读|三条未读|3\s*封未读|未读(?:消息|邮件)?\s*(?:共|:|：)?\s*3\s*(?:条|封))/i.test(plain);
}

function listsM4M5AsTodo(rawText) {
  return String(rawText)
    .split("\n")
    .some((line) => {
      if (!/(?:行业周报|周报|午餐)/.test(line)) return false;
      if (/不列|不含|排除|不计入|不需要|不会出现|无需|不用|忽略|不作为|不占用/.test(line)) {
        return false;
      }
      return /^\s*(?:\d+[.)、]|[-*•]|\|)/.test(line);
    });
}

async function runCase06(cookie, item, reset, modelState) {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const target = await resolveTarget(cookie, item);
  const inbox = target.members.find((member) => member.name === "收件箱");
  const schedule = target.members.find((member) => member.name === "日程");
  add(
    "group has 收件箱/日程",
    Boolean(inbox && schedule),
    `inbox=${inbox?.botId ?? "missing"}, schedule=${schedule?.botId ?? "missing"}`,
  );
  if (!inbox || !schedule) {
    return { id: item.id, status: "FAIL", reason: "missing_members", reset, model: modelState, assertions: checks };
  }

  const inboxBoot = await rpc(cookie, "computer/boot", { botId: inbox.botId });
  const scheduleBoot = await rpc(cookie, "computer/boot", { botId: schedule.botId });
  add("both computers running", inboxBoot.state === "running" && scheduleBoot.state === "running", `inbox=${inboxBoot.state}, schedule=${scheduleBoot.state}`);

  const sent = await sendCase(cookie, item, target);
  console.log(`  target: group ${target.groupId}`);
  console.log(`  runIds: ${sent.runIds.join(", ")}`);
  const waited = await waitForRuns(cookie, sent.runIds, 300_000);
  const inboxRun = waited.runs.find((run) => run.botName === "收件箱") ?? null;
  const scheduleRun = waited.runs.find((run) => run.botName === "日程") ?? null;
  add("收件箱 run completed", inboxRun?.status === "completed", `status=${inboxRun?.status ?? "?"}`);
  add("日程 run completed", scheduleRun?.status === "completed", `status=${scheduleRun?.status ?? "?"}`);

  const snapshot = await rpc(cookie, "threads/get", { groupId: target.groupId });
  const inboxText = combinedRunText(snapshot, inboxRun?.runId);
  const scheduleText = combinedRunText(snapshot, scheduleRun?.runId);
  const inboxSteps = combinedRunSteps(snapshot, inboxRun?.runId);
  const scheduleSteps = combinedRunSteps(snapshot, scheduleRun?.runId);
  add(
    "收件箱 used the browser",
    inboxSteps.some((label) => /browser|computer_observe|computer_act/i.test(label)),
    `steps=${inboxSteps.join(" | ") || "none"}`,
  );
  add(
    "日程 used the browser",
    scheduleSteps.some((label) => /browser|computer_observe|computer_act/i.test(label)),
    `steps=${scheduleSteps.join(" | ") || "none"}`,
  );
  const inboxLoggedIn =
    /Signed in as inbox@demo\.test/i.test(inboxText) ||
    (/inbox@demo\.test/i.test(inboxText) &&
      /已登录|登录成功|登录状态正常/i.test(inboxText));
  add(
    "收件箱 sees Signed in as inbox@demo.test and 3 unread",
    inboxLoggedIn && hasThreeUnread(inboxText),
    inboxText.slice(0, 260) || "no inbox text",
  );
  add(
    "日程 sees the login page, not the inbox account",
    /Sign in|登录页|未登录|需要登录/i.test(scheduleText) &&
      !/Signed in as inbox@demo\.test/i.test(scheduleText),
    scheduleText.slice(0, 260) || "no schedule text",
  );

  const inboxProfiles = await profileNames(cookie, inbox.botId);
  const scheduleProfiles = await profileNames(cookie, schedule.botId);
  add(
    "browser profiles differ",
    inboxProfiles.length > 0 &&
      scheduleProfiles.length > 0 &&
      JSON.stringify(inboxProfiles) !== JSON.stringify(scheduleProfiles),
    `inbox=${inboxProfiles.join(",") || "none"}; schedule=${scheduleProfiles.join(",") || "none"}`,
  );
  const portalAfterGroup = await portalState();
  add(
    "portal has one login session and 3 unread",
    portalAfterGroup.sessions >= 1 && portalAfterGroup.unread === 3,
    `sessions=${portalAfterGroup.sessions}, unread=${portalAfterGroup.unread}`,
  );

  await rpc(cookie, "threads/clear", { botId: inbox.botId });
  const reopen = await rpc(cookie, "threads/send", {
    botId: inbox.botId,
    text: "再打开 http://host.docker.internal:4311/inbox 刷新一下，确认还登录着",
  });
  const reopenIds = Array.isArray(reopen.runIds) && reopen.runIds.length > 0 ? reopen.runIds : [reopen.runId];
  const reopenWait = await waitForRuns(cookie, reopenIds, 300_000);
  const reopenSnapshot = await botSnapshot(cookie, inbox.botId);
  const reopenText = combinedRunText(reopenSnapshot, reopenIds[0]);
  const reopenLoggedIn =
    /Signed in as inbox@demo\.test/i.test(reopenText) ||
    (/inbox@demo\.test/i.test(reopenText) &&
      /Sign out|退出|仍.{0,40}登录|已登录|登录.{0,10}有效|未.{0,10}登出/i.test(reopenText));
  add(
    "收件箱 reopen stays signed in with 3 unread",
    reopenWait.runs?.[0]?.status === "completed" &&
      reopenLoggedIn &&
      hasThreeUnread(reopenText),
    reopenText.slice(0, 260) || "no reopen text",
  );
  const portalFinal = await portalState();
  add("portal still has 3 unread", portalFinal.unread === 3, `sessions=${portalFinal.sessions}, unread=${portalFinal.unread}`);

  if (!inboxText || !scheduleText) {
    console.log(`  evidence: inbox=${inboxRun?.runId ?? "none"}/${inboxRun?.status ?? "?"}; schedule=${scheduleRun?.runId ?? "none"}/${scheduleRun?.status ?? "?"}; steps inbox=${inboxSteps.join(" | ") || "none"}; steps schedule=${scheduleSteps.join(" | ") || "none"}`);
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

async function runCase05(cookie, item, reset, modelState) {
  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const bots = await rpc(cookie, "bots/list");
  const inbox = bots.find((bot) => bot.name === "收件箱");
  const chief = bots.find((bot) => bot.name === "总管");
  add("收件箱 and 总管 exist", Boolean(inbox && chief), `inbox=${inbox?.id ?? "missing"}, chief=${chief?.id ?? "missing"}`);
  if (!inbox || !chief) {
    return { id: item.id, status: "FAIL", reason: "missing_bots", reset, model: modelState, assertions: checks };
  }

  await rpc(cookie, "threads/clear", { botId: inbox.id });
  await rpc(cookie, "threads/clear", { botId: chief.id });
  const beforeGmail = await gmailSentState();
  const beforeCalendar = await calendarEventsState();
  const beforeFiles = await snapshotHomeFiles(cookie, inbox.id);
  const beforeRunIds = await recentRunIds(cookie);

  const sent = await rpc(cookie, "threads/send", { botId: inbox.id, text: item.input });
  const inboxIds = Array.isArray(sent.runIds) && sent.runIds.length > 0 ? sent.runIds : [sent.runId];
  const inboxWait = await waitForRuns(cookie, inboxIds, 300_000);
  const inboxRunId = inboxIds[0];
  add("收件箱 run completed", inboxWait.runs?.[0]?.status === "completed", `status=${inboxWait.runs?.[0]?.status ?? "?"}`);

  const inboxSnapshot = await botSnapshot(cookie, inbox.id);
  const resultEntry = findBlock(
    inboxSnapshot,
    (block) => block.kind === "bot_message_sent" && block.toBotId === chief.id && block.intent === "result",
  );
  const runFileBlocks = (inboxSnapshot.messages ?? [])
    .filter((message) => message.runId === inboxRunId)
    .flatMap((message) => (message.blocks ?? []).filter((block) => block.kind === "file"));
  add("收件箱 sent a result message", Boolean(resultEntry), resultEntry ? `message=${resultEntry.message.id}` : "no bot_message_sent intent=result");
  add(
    "bot message carries an attachment",
    Boolean(resultEntry?.message.blocks.some((block) => block.kind === "file")),
    `fileBlocks=${runFileBlocks.map((block) => block.name).join(",") || "none"}`,
  );

  const chiefRun = await waitForNewRun(
    cookie,
    beforeRunIds,
    (row) => row.botName === "总管" && row.trigger === "bot_message",
    120_000,
  );
  let chiefSnapshot = null;
  let received = null;
  let chiefReply = "";
  if (chiefRun) {
    await waitForRuns(cookie, [chiefRun.runId], 300_000);
    chiefSnapshot = await botSnapshot(cookie, chief.id);
    received = findBlock(
      chiefSnapshot,
      (block) => block.kind === "bot_message_received" && block.fromBotId === inbox.id,
    );
    chiefReply = combinedRunText(chiefSnapshot, chiefRun.runId);
  }
  add("总管 received the bot message", Boolean(received), received ? `message=${received.message.id}` : "no bot_message_received");
  add(
    "总管 received the attachment",
    Boolean(received?.message.blocks.some((block) => block.kind === "file")),
    received ? `blocks=${received.message.blocks.map((block) => block.kind).join(",")}` : "no message",
  );
  const receivedAttachment = Boolean(
    received?.message.blocks.some((block) => block.kind === "file"),
  );
  add(
    "总管 restates the agenda",
    receivedAttachment &&
      /11-05|11月5日|2026\s*年\s*11\s*月\s*5\s*日/.test(normalizeForMatch(chiefReply)) &&
      normalizeForMatch(chiefReply).includes("16:00") &&
      normalizeForMatch(chiefReply).includes("李总"),
    chiefReply.slice(0, 260) || "no chief reply",
  );

  const afterFiles = await snapshotHomeFiles(cookie, inbox.id);
  const changed = [];
  for (const [path, size] of afterFiles) {
    if (!path.endsWith(".md") || path.startsWith("/shared/")) continue;
    const beforeSize = beforeFiles.get(path);
    if (beforeSize === undefined || beforeSize !== size) changed.push(path);
  }
  let agendaFile = null;
  for (const path of changed) {
    const content = await readComputerFile(cookie, inbox.id, path);
    if (
      content &&
      /11-05|11月5日|2026\s*年\s*11\s*月\s*5\s*日/.test(content) &&
      content.includes("16:00") &&
      content.includes("李总") &&
      content.includes("议程")
    ) {
      agendaFile = { path, content };
      break;
    }
  }
  add(
    "agenda file exists in 收件箱 own home",
    Boolean(agendaFile),
    agendaFile?.path ?? `changed=${changed.join(",") || "none"}`,
  );

  const afterGmail = await gmailSentState();
  const afterCalendar = await calendarEventsState();
  add(
    "no external write",
    afterGmail.sent.length === 0 &&
      JSON.stringify(afterCalendar.events) === JSON.stringify(beforeCalendar.events),
    `gmailSent=${afterGmail.sent.length}, calendarEvents=${afterCalendar.events.length}`,
  );

  if (!resultEntry || !received) {
    console.log(
      `  evidence: inboxRun=${inboxRunId}/${inboxWait.runs?.[0]?.status ?? "?"}; resultText=${resultEntry?.block?.text ?? "none"}; fileBlocks=${runFileBlocks.map((block) => block.name).join(",") || "none"}; chiefRun=${chiefRun?.runId ?? "none"}; receivedText=${received?.block?.text?.slice(0, 200) ?? "none"}`,
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

async function resetIsolationState(cookie) {
  const bots = await rpc(cookie, "bots/list");
  const research = bots.find((bot) => bot.name === "研究");
  for (const bot of bots) {
    await rpc(cookie, "threads/clear", { botId: bot.id }).catch(() => undefined);
    await clearBotScratchpad(cookie, bot.id).catch(() => undefined);
    const routines = await rpc(cookie, "routines/list", { botId: bot.id }).catch(() => []);
    for (const routine of routines) {
      await rpc(cookie, "routines/remove", { routineId: routine.id }).catch(() => undefined);
    }
    const docs = await memoryDocs(cookie, bot.id, "bot").catch(() => []);
    for (const doc of docs) {
      if (doc.path === "MEMORY.md") {
        await rpc(cookie, "memory/update", {
          documentId: doc.id,
          content: `# ${bot.name}\n`,
          expectedRevision: doc.revision,
        }).catch(() => undefined);
      } else {
        await rpc(cookie, "memory/remove", { documentId: doc.id }).catch(() => undefined);
      }
    }
  }
  const userDocs = await memoryDocs(cookie, null, "user").catch(() => []);
  for (const doc of userDocs) {
    if (doc.path === "MEMORY.md") {
      await rpc(cookie, "memory/update", {
        documentId: doc.id,
        content: "# Space memory\n\nPreferences and context kept within this space live here.\n",
        expectedRevision: doc.revision,
      }).catch(() => undefined);
    } else {
      await rpc(cookie, "memory/remove", { documentId: doc.id }).catch(() => undefined);
    }
  }
  const groups = await rpc(cookie, "groups/list").catch(() => []);
  for (const group of groups) {
    await rpc(cookie, "threads/clear", { groupId: group.id }).catch(() => undefined);
  }
  if (research) await clearMonitoringArtifacts(research.id);
}

async function runModelCase(cookie, item) {
  const reset = await resetFixtures();
  console.log(`\n[${item.id}] ${item.title}`);
  printReset(reset);
  if (!reset.every((entry) => entry.clean)) {
    console.log("  result: UNQUALIFIED (fixture_reset_failed)");
    return { id: item.id, status: "UNQUALIFIED", reason: "fixture_reset_failed", reset };
  }

  await resetIsolationState(cookie);
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
  if (item.blocked) {
    console.log("  result: BLOCKED (platform_no_peer_attachment)");
    for (const blocker of item.blockers ?? []) console.log(`  blocker: ${blocker}`);
    return {
      id: item.id,
      status: "BLOCKED",
      reason: "platform_no_peer_attachment",
      blockers: item.blockers ?? [],
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
  if (item.id === "04") {
    console.log("  flow: 研究 Bot 电脑浏览器生成竞品速报，存自己目录");
    return await runCase04(cookie, item, reset, modelState);
  }
  if (item.id === "09") {
    console.log("  flow: 收件箱直接处理 CRM 备注→报价邮件，两次审批");
    return await runCase09(cookie, item, reset, modelState);
  }
  if (item.id === "12") {
    console.log("  flow: 总管记住远山偏好 → 清空线程 → 新会话按老规矩出议程");
    return await runCase12(cookie, item, reset, modelState);
  }
  if (item.id === "06") {
    console.log("  flow: 新建群，收件箱登录客户门户，日程只看登录页，再验证收件箱重开");
    return await runCase06(cookie, item, reset, modelState);
  }
  if (item.id === "05") {
    console.log("  flow: 收件箱做议程文件并通过消息交总管，验证消息附件与总管读取");
    return await runCase05(cookie, item, reset, modelState);
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
      `\nSUMMARY total=${results.length} pass=${count("PASS")} fail=${count("FAIL")} blocked=${count("BLOCKED")} unqualified=${count("UNQUALIFIED")}`,
    );
    process.exitCode =
      count("FAIL") > 0 ? 1 : count("UNQUALIFIED") > 0 || count("BLOCKED") > 0 ? 2 : 0;
    return;
  }

  console.log(usage());
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
