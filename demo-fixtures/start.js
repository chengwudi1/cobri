#!/usr/bin/env node
"use strict";

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(os.tmpdir(), "cobri-demo-fixtures-pids.json");

const children = [];
const childPids = {};
let stopping = false;

function writePidFile() {
  try {
    fs.writeFileSync(
      PID_FILE,
      `${JSON.stringify({ ...childPids, startedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (error) {
    console.error(`Could not write ${PID_FILE}: ${error.message}`);
  }
}

function removePidFile() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Already gone.
  }
}

function stopAll(exitCode) {
  if (stopping) return;
  stopping = true;
  removePidFile();
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 1500).unref();
}

function start(file, label, key) {
  const child = spawn(process.execPath, [path.join(__dirname, file)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  children.push(child);
  if (Number.isInteger(child.pid)) childPids[key] = child.pid;
  child.stdout.on("data", (data) => process.stdout.write(`[${label}] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[${label}] ${data}`));
  child.on("error", (error) => {
    console.error(`[${label}] ${error.message}`);
    stopAll(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[${label}] exited (${signal ?? code}); stopping the other fixture.`);
    stopAll(code ?? 1);
  });
  return child;
}

console.log("Starting demo fixtures on 0.0.0.0:4310-4314 (health via 127.0.0.1)");
console.log("Press Ctrl+C to stop all, or run: node demo-fixtures/stop.js");

start("competitor-site.js", "competitor:4310", "competitor");
start("customer-portal.js", "portal:4311", "portal");
start("fake-gmail.js", "gmail:4312", "gmail");
start("fake-calendar.js", "calendar:4313", "calendar");
start("fake-crm.js", "crm:4314", "crm");
writePidFile();

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
