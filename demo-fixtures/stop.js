#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PID_FILE = path.join(os.tmpdir(), "cobri-demo-fixtures-pids.json");

let record;
try {
  record = JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
} catch {
  console.error(
    `No running fixture record at ${PID_FILE}.\nStart them first with: node demo-fixtures/start.js`,
  );
  process.exit(1);
}

const entries = Object.entries(record).filter(
  ([key, value]) => key !== "startedAt" && Number.isInteger(value),
);

if (entries.length === 0) {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Already gone.
  }
  console.error("No fixture process ids were recorded.");
  process.exit(1);
}

let signaled = 0;
for (const [name, pid] of entries) {
  try {
    process.kill(pid);
    console.log(`Signaled ${name} (${pid}).`);
    signaled += 1;
  } catch (error) {
    if (error.code !== "ESRCH") {
      console.error(`Could not stop ${name} (${pid}): ${error.message}`);
    }
  }
}

setTimeout(() => {
  for (const [name, pid] of entries) {
    try {
      process.kill(pid, "SIGKILL");
      console.log(`Force-stopped ${name} (${pid}).`);
    } catch {
      // The graceful stop already ended it.
    }
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Already gone.
  }
  console.log(`Done. ${signaled} process(es) signaled.`);
}, 600);
