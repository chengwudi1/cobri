#!/usr/bin/env node
/**
 * One-click control for the local Cobri demo stack.
 * File: scripts/cobri-demo.mjs
 *
 * Usage (from the repo root, Git Bash or cmd):
 *   node scripts/cobri-demo.mjs start
 *   node scripts/cobri-demo.mjs stop
 *   node scripts/cobri-demo.mjs status
 *
 * Manages:
 *   - Rakazo dev stack: web 5180, api 3100, sandbox supervisor 7091.
 *     Started with WEB_PORT=5180, API_PORT=3100 and the pnpm.exe shim on PATH.
 *   - Four fixture servers: 4310 competitor, 4311 portal, 4312 gmail, 4313 calendar.
 *
 * Safety:
 *   - start checks health first and skips anything already running.
 *   - stop only ends the dev tree recorded in state.json (started by this script)
 *     and the four demo fixtures. It never targets 5173 or another Vite app.
 *   - state and logs live outside the checkout, in %LOCALAPPDATA%\CobriDemo.
 *
 * Requirements:
 *   - Node 24.15+ for the repo's jsdom dependency. If the current Node is older,
 *     this script re-executes with the executable named by COBRI_NODE.
 *   - pnpm 9.x, resolved from the global npm prefix or COBRI_PNPM_EXE.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const knownNode = process.env.COBRI_NODE || "";

function nodeIsSupported() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return (major === 24 && minor >= 15) || major > 24;
}

if (!nodeIsSupported() && process.env.COBRI_DEMO_REEXEC !== "1") {
  if (fs.existsSync(knownNode)) {
    const result = spawnSync(knownNode, [scriptPath, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: {
        ...process.env,
        COBRI_DEMO_REEXEC: "1",
        PATH: `${path.dirname(knownNode)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    process.exit(result.status ?? 1);
  }
  console.error(`Node ${process.versions.node} is too old. Use Node 24.15+ or set COBRI_NODE.`);
  process.exit(1);
}

const pnpmJs =
  process.env.COBRI_PNPM_JS ||
  path.join(process.env.APPDATA ?? "", "npm", "node_modules", "pnpm", "bin", "pnpm.cjs");
const pnpmExe = process.env.COBRI_PNPM_EXE || "";
const stateDir =
  process.env.COBRI_DEMO_STATE_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), "CobriDemo");
const stateFile = path.join(stateDir, "state.json");
const devLog = path.join(stateDir, "dev.log");
const fixtureLog = path.join(stateDir, "fixtures.log");
const fixturePidFile = path.join(os.tmpdir(), "cobri-demo-fixtures-pids.json");

const DEV = [
  { name: "web", port: 5180, url: "http://127.0.0.1:5180/" },
  { name: "api", port: 3100, url: "http://127.0.0.1:3100/health" },
  { name: "supervisor", port: 7091, url: "http://127.0.0.1:7091/health" },
];

const FIXTURES = [
  { name: "competitor", port: 4310, url: "http://127.0.0.1:4310/pricing" },
  { name: "portal", port: 4311, url: "http://127.0.0.1:4311/" },
  { name: "gmail", port: 4312, url: "http://127.0.0.1:4312/messages" },
  { name: "calendar", port: 4313, url: "http://127.0.0.1:4313/events" },
];

const ALL = [...DEV, ...FIXTURES];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usage() {
  console.log("Usage: node scripts/cobri-demo.mjs <start|stop|status>");
}

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  ensureStateDir();
  if (Object.keys(state).length === 0) {
    fs.rmSync(stateFile, { force: true });
    return;
  }
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function demoEnv() {
  const nodeDir = path.dirname(process.execPath);
  const shimDir = pnpmExe ? path.dirname(pnpmExe) : "";
  return {
    ...process.env,
    WEB_PORT: "5180",
    API_PORT: "3100",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    PATH: [nodeDir, process.env.PATH, shimDir].filter(Boolean).join(path.delimiter),
  };
}

async function probe(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(2500),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "TimeoutError" ? "timeout" : String(error?.message ?? error),
    };
  }
}

function listeningPid(port) {
  let output;
  try {
    output = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  } catch {
    return null;
  }
  const pattern = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "im");
  const match = output.match(pattern);
  return match ? Number(match[1]) : null;
}

function devRootPid() {
  if (process.platform !== "win32") return null;
  let rows;
  try {
    rows = JSON.parse(
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      ),
    );
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) rows = [rows];

  const byId = new Map(rows.map((row) => [Number(row.ProcessId), row]));
  const servicePids = DEV.map((service) => listeningPid(service.port));
  if (servicePids.some((pid) => !pid)) return null;

  const chains = servicePids.map((pid) => {
    const chain = [];
    let current = pid;
    for (let depth = 0; depth < 20 && byId.has(current); depth += 1) {
      chain.push(current);
      current = Number(byId.get(current).ParentProcessId);
    }
    return chain;
  });
  const common = chains[0].find((pid) => chains.every((chain) => chain.includes(pid)));
  if (!common) return null;

  const command = String(byId.get(common)?.CommandLine ?? "");
  const normalize = (value) => value.replace(/\\/g, "/").toLowerCase();
  if (!normalize(command).includes(normalize(repoRoot)) || !/turbo|dev\.mjs|pnpm/i.test(command)) {
    return null;
  }
  return { pid: common, command };
}

async function snapshot(services) {
  return Promise.all(
    services.map(async (service) => ({
      ...service,
      health: await probe(service.url),
      pid: listeningPid(service.port),
    })),
  );
}

function printSnapshot(rows) {
  for (const row of rows) {
    const health = row.health.ok ? "ok" : "down";
    const detail = row.health.ok
      ? ""
      : ` (${row.health.status ? `HTTP ${row.health.status}` : row.health.error})`;
    console.log(
      `${String(row.port).padEnd(5)} ${row.name.padEnd(11)} ${health.padEnd(5)} pid=${row.pid ?? "-"}${detail}`,
    );
  }
}

function tail(file, lines = 50) {
  try {
    const text = fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
    console.error(text.slice(-lines).join("\n"));
  } catch {
    console.error(`(no log at ${file})`);
  }
}

async function waitFor(services, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  let lastReport = 0;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await snapshot(services);
    if (rows.every((row) => row.health.ok)) return { ok: true, rows };
    if (child && child.exitCode !== null) return { ok: false, exited: true, rows };
    if (Date.now() - lastReport > 15000) {
      lastReport = Date.now();
      console.log("waiting for health...");
      printSnapshot(rows);
    }
    await delay(1000);
  }
  return { ok: false, rows };
}

function checkPnpm() {
  const candidates = [];
  if (pnpmJs && fs.existsSync(pnpmJs)) {
    candidates.push({ label: pnpmJs, file: process.execPath, args: [pnpmJs] });
  }
  if (pnpmExe && fs.existsSync(pnpmExe)) {
    candidates.push({ label: pnpmExe, file: pnpmExe, args: [] });
  }
  const failures = [];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.file, [...candidate.args, "--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) {
      return {
        ...candidate,
        version: String(result.stdout ?? "").trim().split(/\r?\n/)[0],
      };
    }
    failures.push(
      `${candidate.label}: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
  throw new Error(
    `pnpm check failed. Checked:\n${candidates.map((c) => c.label).join("\n") || "(none)"}${
      failures.length ? `\n${failures.join("\n")}` : ""
    }`,
  );
}

function commandLine(pid) {
  try {
    if (process.platform === "win32") {
      return execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ],
        { encoding: "utf8", windowsHide: true },
      ).trim();
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function killTree(pid) {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "pipe",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readFixturePidFile() {
  try {
    const data = JSON.parse(fs.readFileSync(fixturePidFile, "utf8"));
    return Object.entries(data).filter(
      ([key, value]) => key !== "startedAt" && Number.isInteger(value),
    );
  } catch {
    return null;
  }
}

function stopFixtures() {
  const recorded = readFixturePidFile();
  const recordedSafe =
    recorded?.length > 0 &&
    recorded.every(([, pid]) => /demo-fixtures/i.test(commandLine(pid)));

  if (recordedSafe) {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "demo-fixtures", "stop.js")],
      { cwd: repoRoot, env: demoEnv(), encoding: "utf8", windowsHide: true },
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.status === 0) return true;
    console.error(`fixtures: stop.js exited ${result.status}; falling back to port PIDs.`);
  } else if (recorded?.length) {
    console.error("fixtures: recorded PIDs no longer match demo-fixtures; ignoring the pid file.");
  }

  let stopped = false;
  for (const fixture of FIXTURES) {
    const pid = listeningPid(fixture.port);
    if (!pid) continue;
    if (!/demo-fixtures/i.test(commandLine(pid))) {
      console.error(`fixtures: ${fixture.name} pid ${pid} is not a demo fixture; skipping.`);
      continue;
    }
    try {
      killTree(pid);
      stopped = true;
    } catch (error) {
      console.error(`fixtures: could not stop ${fixture.name} (${pid}): ${error.message}`);
    }
  }
  return stopped;
}

async function startDev(pnpm) {
  ensureStateDir();
  const logFd = fs.openSync(devLog, "a");
  fs.writeSync(logFd, `\n=== start ${new Date().toISOString()} ===\n`);
  const child = spawn(pnpm.file, [...pnpm.args, "dev"], {
    cwd: repoRoot,
    env: demoEnv(),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) throw new Error(`dev: pnpm dev did not return a PID. See ${devLog}`);
  const state = readState();
  state.devPid = child.pid;
  state.devStartedAt = new Date().toISOString();
  saveState(state);
  console.log(`dev: started pnpm dev (pid ${child.pid}); waiting for 5180/3100/7091...`);

  const result = await waitFor(DEV, 180000, child);
  if (!result.ok) {
    printSnapshot(result.rows);
    console.error("dev: raw log tail:");
    tail(devLog);
    try {
      killTree(child.pid);
    } catch {
      // Already gone.
    }
    const next = readState();
    delete next.devPid;
    delete next.devStartedAt;
    saveState(next);
    throw new Error(`dev: health check failed${result.exited ? " (pnpm dev exited)" : " (180s timeout)"}.`);
  }
  console.log("dev: healthy (5180/3100/7091)");
}

async function startFixtures() {
  ensureStateDir();
  const logFd = fs.openSync(fixtureLog, "a");
  fs.writeSync(logFd, `\n=== start ${new Date().toISOString()} ===\n`);
  const child = spawn(process.execPath, [path.join(repoRoot, "demo-fixtures", "start.js")], {
    cwd: repoRoot,
    env: demoEnv(),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) throw new Error(`fixtures: start.js did not return a PID. See ${fixtureLog}`);
  const state = readState();
  state.fixturesPid = child.pid;
  state.fixturesStartedAt = new Date().toISOString();
  saveState(state);
  console.log(`fixtures: started demo-fixtures/start.js (pid ${child.pid}); waiting for 4310-4313...`);

  const result = await waitFor(FIXTURES, 60000, child);
  if (!result.ok) {
    printSnapshot(result.rows);
    console.error("fixtures: raw log tail:");
    tail(fixtureLog);
    stopFixtures();
    try {
      killTree(child.pid);
    } catch {
      // Already gone.
    }
    const next = readState();
    delete next.fixturesPid;
    delete next.fixturesStartedAt;
    saveState(next);
    throw new Error(
      `fixtures: health check failed${result.exited ? " (start.js exited)" : " (60s timeout)"}.`,
    );
  }
  console.log("fixtures: healthy (4310-4313)");
}

async function start() {
  ensureStateDir();
  const pnpm = checkPnpm();
  console.log(`pnpm ${pnpm.version}`);

  const devRows = await snapshot(DEV);
  if (devRows.every((row) => row.health.ok)) {
    const state = readState();
    if (state.devPid && !isAlive(state.devPid)) {
      delete state.devPid;
      delete state.devStartedAt;
      delete state.devAdoptedAt;
      saveState(state);
    }
    if (state.devPid) {
      console.log("dev: already running, skipping.");
    } else {
      const root = devRootPid();
      if (root) {
        state.devPid = root.pid;
        state.devAdoptedAt = new Date().toISOString();
        saveState(state);
        console.log(`dev: already running; adopted pid ${root.pid} for stop (not restarted).`);
      } else {
        console.log("dev: already running, skipping (not started by this script; stop will leave it).");
      }
    }
  } else if (devRows.some((row) => row.health.ok)) {
    printSnapshot(devRows);
    throw new Error("dev: partial stack; not starting duplicates. Stop the existing dev stack first.");
  } else {
    await startDev(pnpm);
  }

  const fixtureRows = await snapshot(FIXTURES);
  if (fixtureRows.every((row) => row.health.ok)) {
    console.log("fixtures: already running, skipping.");
  } else if (fixtureRows.some((row) => row.health.ok)) {
    printSnapshot(fixtureRows);
    throw new Error(
      "fixtures: partial state; stop the fixtures (node demo-fixtures/stop.js) and run start again.",
    );
  } else {
    await startFixtures();
  }

  console.log("start: ready");
  printSnapshot(await snapshot(ALL));
}

async function stop() {
  const state = readState();
  let changed = false;

  let devPid = null;
  if (state.devPid && isAlive(state.devPid)) {
    if (/pnpm|dev\.mjs|turbo/i.test(commandLine(state.devPid))) devPid = state.devPid;
  }
  if (!devPid) {
    const root = devRootPid();
    if (root) {
      devPid = root.pid;
      console.log(`dev: adopting running stack pid ${devPid} for stop.`);
    }
  }
  if (devPid) {
    console.log(`dev: stopping pid ${devPid}`);
    try {
      killTree(devPid);
    } catch (error) {
      console.error(`dev: could not stop pid ${devPid}: ${error.message}`);
    }
  } else {
    console.log("dev: no running demo stack found; skipping (5173 is never touched).");
  }
  if (state.devPid || state.devStartedAt || state.devAdoptedAt) {
    delete state.devPid;
    delete state.devStartedAt;
    delete state.devAdoptedAt;
    changed = true;
  }

  const fixtureRows = await snapshot(FIXTURES);
  if (fixtureRows.some((row) => row.health.ok)) {
    console.log("fixtures: stopping 4310-4313...");
    stopFixtures();
    const after = await snapshot(FIXTURES);
    const remaining = after.filter((row) => row.health.ok);
    if (remaining.length) {
      console.error("fixtures: still up after stop:");
      printSnapshot(remaining);
    }
    changed = true;
  } else {
    console.log("fixtures: not running, skipping.");
  }

  if (state.fixturesPid) {
    delete state.fixturesPid;
    delete state.fixturesStartedAt;
    changed = true;
  }
  if (changed) saveState(state);
  console.log("stop: done");
}

async function status() {
  const rows = await snapshot(ALL);
  printSnapshot(rows);
  const healthy = rows.filter((row) => row.health.ok).length;
  console.log(`${healthy}/${rows.length} healthy`);
}

const command = process.argv[2];
try {
  if (command === "start") await start();
  else if (command === "stop") await stop();
  else if (command === "status") await status();
  else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\n${error?.message ?? error}`);
  process.exitCode = 1;
}
