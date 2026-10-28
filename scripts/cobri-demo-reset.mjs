#!/usr/bin/env node
/**
 * Cobri demo reset.
 * File: scripts/cobri-demo-reset.mjs
 *
 * Usage (repo root, Node 24):
 *   node scripts/cobri-demo-reset.mjs            # dry-run (default)
 *   node scripts/cobri-demo-reset.mjs --apply    # execute
 *
 * What it does:
 *   1. POST /__reset to the four local fixtures (4310-4313).
 *   2. Archive test groups named "*eval*" in the demo space. Archiving sets
 *      chat_groups.archivedAt; it never deletes groups, bots, messages or runs.
 *   Protected: the exact main group "工作助理团队" and the four bots
 *   总管/研究/收件箱/日程. The script never writes to bots.
 *
 * It reads the local dev database through the `rakazo-dev-postgres` Docker
 * container. Dry-run only reads the DB and GETs fixture health endpoints; it
 * performs no POST and no UPDATE. Failures report the step and raw error.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node scripts/cobri-demo-reset.mjs [--apply | --dry-run]");
  process.exit(0);
}
const apply = args.includes("--apply");
if (args.includes("--dry-run") && apply) {
  console.error("Use either --apply or --dry-run, not both.");
  process.exit(1);
}
const unknown = args.filter((arg) => !["--apply", "--dry-run"].includes(arg));
if (unknown.length) {
  console.error(`Unknown option(s): ${unknown.join(", ")}`);
  process.exit(1);
}

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const dbContainer = process.env.COBRI_DB_CONTAINER || "rakazo-dev-postgres";
const dbUser = process.env.COBRI_DB_USER || "rakazo";
const dbName = process.env.COBRI_DB_NAME || "rakazo";
const mainGroupName = process.env.COBRI_MAIN_GROUP || "工作助理团队";
const protectedBotNames = ["总管", "研究", "收件箱", "日程"];

const fixtures = [
  { port: 4310, health: "/pricing" },
  { port: 4311, health: "/" },
  { port: 4312, health: "/messages" },
  { port: 4313, health: "/events" },
];

const failures = [];

function noteFailure(step, error) {
  const message = String(error?.message ?? error);
  failures.push({ step, message });
  console.error(`[fail] ${step}: ${message}`);
}

function psqlJson(sql) {
  try {
    const output = execFileSync(
      "docker",
      ["exec", dbContainer, "psql", "-U", dbUser, "-d", dbName, "-At", "-c", sql],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    return JSON.parse(output || "[]");
  } catch (error) {
    const raw = [error?.message, error?.stderr, error?.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(raw || "psql failed");
  }
}

function psqlExec(sql) {
  try {
    return execFileSync(
      "docker",
      ["exec", dbContainer, "psql", "-U", dbUser, "-d", dbName, "-At", "-c", sql],
      { encoding: "utf8", windowsHide: true },
    ).trim();
  } catch (error) {
    const raw = [error?.message, error?.stderr, error?.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(raw || "psql failed");
  }
}

async function probeFixture(fixture) {
  const url = `http://127.0.0.1:${fixture.port}${fixture.health}`;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`health ${url} returned HTTP ${response.status}`);
    return `HTTP ${response.status}`;
  } catch (error) {
    throw new Error(`health ${url}: ${error?.message ?? error}`);
  }
}

async function resetFixture(fixture) {
  const url = `http://127.0.0.1:${fixture.port}/__reset`;
  let response;
  try {
    response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(`${url}: ${error?.message ?? error}`);
  }
  const body = (await response.text()).trim().slice(0, 200);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}${body ? ` ${body}` : ""}`);
  }
  return `${url} -> HTTP ${response.status}${body ? ` (${body})` : ""}`;
}

async function main() {
  console.log(`Cobri demo reset — ${apply ? "APPLY" : "DRY RUN (no changes)"}`);
  console.log(`DB: ${dbContainer}/${dbName} via docker exec`);

  let groups = [];
  let bots = [];
  try {
    groups = psqlJson(
      `select coalesce(json_agg(json_build_object(
         'id', id, 'name', name, 'spaceId', "spaceId", 'userId', "userId",
         'archivedAt', "archivedAt"
       ) order by "createdAt"), '[]'::json) from chat_groups`,
    );
  } catch (error) {
    noteFailure("list groups", error);
  }
  try {
    bots = psqlJson(
      `select coalesce(json_agg(json_build_object('id', id, 'name', name) order by name), '[]'::json)
       from bots
       where "archivedAt" is null and name in (${protectedBotNames
         .map((name) => `'${name.replaceAll("'", "''")}'`)
         .join(", ")})`,
    );
  } catch (error) {
    noteFailure("list protected bots", error);
  }

  const mains = groups.filter((group) => group.name === mainGroupName && !group.archivedAt);
  const main = mains.length === 1 ? mains[0] : null;
  if (mains.length !== 1) {
    noteFailure(
      "find main group",
      new Error(`expected one active group named "${mainGroupName}", found ${mains.length}`),
    );
  }

  const sameSpace = main
    ? groups.filter((group) => group.spaceId === main.spaceId && group.userId === main.userId)
    : [];
  const testGroups = sameSpace.filter(
    (group) => group.id !== main?.id && /eval/i.test(group.name),
  );
  const otherGroups = sameSpace.filter(
    (group) => group.id !== main?.id && !/eval/i.test(group.name),
  );
  const toArchive = testGroups.filter((group) => !group.archivedAt);

  console.log("\nFixtures:");
  for (const fixture of fixtures) {
    try {
      const health = await probeFixture(fixture);
      if (apply) {
        console.log(`  [apply] ${await resetFixture(fixture)}`);
      } else {
        console.log(
          `  [plan] POST http://127.0.0.1:${fixture.port}/__reset (health ${health})`,
        );
      }
    } catch (error) {
      noteFailure(`fixture ${fixture.port} ${apply ? "reset" : "probe"}`, error);
    }
  }

  console.log("\nGroups:");
  if (main) {
    console.log(`  [protect] main group: ${main.name} (${main.id})`);
  }
  console.log(
    `  [protect] bots: ${bots.map((bot) => `${bot.name} (${bot.id})`).join(", ") || "not found"}`,
  );
  for (const group of testGroups) {
    if (group.archivedAt) {
      console.log(`  [skip] already archived: ${group.name} (${group.id})`);
    } else if (apply) {
      console.log(`  [apply] archive: ${group.name} (${group.id})`);
    } else {
      console.log(`  [plan] archive: ${group.name} (${group.id})`);
    }
  }
  for (const group of otherGroups) {
    console.log(`  [skip] other group: ${group.name} (${group.id})`);
  }
  if (testGroups.length === 0) console.log("  [plan] no eval test groups found");

  if (apply && toArchive.length > 0) {
    try {
      const ids = toArchive.map((group) => group.id);
      if (!ids.every((id) => /^[a-z0-9]+$/i.test(id))) {
        throw new Error("refusing to archive unexpected group id format");
      }
      const list = ids.map((id) => `'${id}'`).join(", ");
      const updated = psqlExec(
        `update chat_groups set "archivedAt" = now(), "updatedAt" = now()
         where id in (${list}) and "archivedAt" is null
         returning id`,
      );
      const count = updated ? updated.split(/\r?\n/).filter(Boolean).length : 0;
      console.log(`  [ok] archived ${count}/${ids.length} group(s)`);
      if (count !== ids.length) {
        noteFailure("archive groups", new Error(`updated ${count}, expected ${ids.length}`));
      }
    } catch (error) {
      noteFailure("archive groups", error);
    }
  }

  console.log(
    `\nSummary: ${fixtures.length} fixture reset(s), ${toArchive.length} group archive(s) ${
      apply ? "applied" : "planned"
    }; ${failures.length} failure(s).`,
  );
  if (!apply) console.log("Dry run only. Re-run with --apply to execute.");
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  noteFailure("unexpected", error);
  process.exitCode = 1;
});
