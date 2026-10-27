#!/usr/bin/env node
"use strict";

import { BOT_SEEDS, GROUP_SEED } from "./bot-seeds.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:5173";

const API = {
  createBot: "bots/create",
  updateBot: "bots/update",
  listGroups: "groups/list",
  createGroup: "groups/create",
};

function usage() {
  return `Cobri bot seeds

Usage:
  node demo-fixtures/seed-bots.js [--dry-run | --apply] [options]

Options:
  --dry-run            Print the full plan and send nothing (default).
  --apply              Create four bots and one group through Rakazo.
  --base-url <url>     Rakazo web/API origin.
                       Default: ${DEFAULT_BASE_URL} (repo Vite default).
                       Use http://127.0.0.1:3000 if your demo runs there.
  --cookie <value>     Better Auth Cookie header or session token
                       (better-auth.session_token=...).
  --bearer <token>     Signed bearer token from the sign-in response.
  --space-id <id>      Optional x-rakazo-space-id header.
  --help               Show this help.

API:
  POST {base-url}/rpc/bots/create   body {"json": CreateBotInput}
  POST {base-url}/rpc/bots/update   body {"json": {...}}
  POST {base-url}/rpc/groups/list   body {"json": {}}
  POST {base-url}/rpc/groups/create body {"json": {name, botIds}}

Auth:
  Better Auth session cookie or signed Authorization: Bearer token.
  Requests also send Origin: <base-url origin>.
  Dry run is the default; no network requests are made.

Model:
  bots/create has no model fields. --apply clears modelProvider, modelId and
  thinkingLevel through bots/update after creation.
`;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    apply: false,
    help: false,
    baseUrl: process.env.RAKAZO_BASE_URL || DEFAULT_BASE_URL,
    cookie: process.env.RAKAZO_COOKIE || "",
    bearer: process.env.RAKAZO_BEARER || "",
    spaceId: process.env.RAKAZO_SPACE_ID || "",
  };
  let explicitDryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const equals = raw.indexOf("=");
    const name = equals >= 0 ? raw.slice(0, equals) : raw;
    const inlineValue = equals >= 0 ? raw.slice(equals + 1) : undefined;

    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) fail(`${name} needs a value`);
      index += 1;
      return next;
    };

    switch (name) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        explicitDryRun = true;
        break;
      case "--base-url":
        options.baseUrl = value();
        break;
      case "--cookie":
        options.cookie = value();
        break;
      case "--bearer":
        options.bearer = value();
        break;
      case "--space-id":
        options.spaceId = value();
        break;
      default:
        fail(`unknown option: ${raw}`);
    }
  }

  if (options.help) return options;
  if (options.apply && explicitDryRun) fail("--apply and --dry-run cannot be combined");
  if (options.cookie && options.bearer) fail("use either --cookie or --bearer, not both");
  return options;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`invalid --base-url: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("--base-url must use http or https");
  }
  return url.toString().replace(/\/+$/, "");
}

function botCreateInput(seed) {
  return {
    name: seed.name,
    title: seed.title,
    description: seed.description,
    instructions: seed.instructions,
    notifyOnFinish: seed.notifyOnFinish,
    computerMode: seed.computerMode,
    spawnKey: seed.spawnKey,
  };
}

function buildPlan(baseUrl, options) {
  return {
    dryRun: true,
    baseUrl,
    auth: options.cookie
      ? "cookie provided"
      : options.bearer
        ? "bearer provided"
        : "not provided (--apply requires --cookie or --bearer)",
    api: {
      createBot: `POST ${baseUrl}/rpc/${API.createBot}`,
      updateBot: `POST ${baseUrl}/rpc/${API.updateBot}`,
      listGroups: `POST ${baseUrl}/rpc/${API.listGroups}`,
      createGroup: `POST ${baseUrl}/rpc/${API.createGroup}`,
    },
    bots: BOT_SEEDS.map((seed) => ({
      key: seed.key,
      create: botCreateInput(seed),
      model: {
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
      },
      afterCreate: {
        procedure: API.updateBot,
        json: {
          botId: `<created:${seed.key}>`,
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
        },
      },
    })),
    group: {
      name: GROUP_SEED.name,
      botKeys: [...GROUP_SEED.botKeys],
      botIds: GROUP_SEED.botKeys.map((key) => `<created:${key}>`),
    },
  };
}

function requestHeaders(baseUrl, options) {
  const url = new URL(baseUrl);
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    origin: url.origin,
  };
  if (options.cookie) {
    headers.cookie = options.cookie.includes("=")
      ? options.cookie
      : `better-auth.session_token=${options.cookie}`;
  }
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.spaceId) headers["x-rakazo-space-id"] = options.spaceId;
  return headers;
}

async function rpc(baseUrl, headers, procedure, input) {
  const response = await fetch(`${baseUrl}/rpc/${procedure}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ json: input }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${procedure}: HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok || (payload && payload.error)) {
    const detail =
      payload?.error?.message ??
      (typeof payload?.error === "string" ? payload.error : text.slice(0, 500));
    throw new Error(`${procedure}: HTTP ${response.status}: ${detail}`);
  }
  return payload?.json ?? payload;
}

async function apply(baseUrl, options) {
  if (!options.cookie && !options.bearer) {
    fail("--apply requires --cookie or --bearer");
  }

  const headers = requestHeaders(baseUrl, options);
  const created = [];
  try {
    for (const seed of BOT_SEEDS) {
      const bot = await rpc(baseUrl, headers, API.createBot, botCreateInput(seed));
      const updated = await rpc(baseUrl, headers, API.updateBot, {
        botId: bot.id,
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
      });
      created.push({
        key: seed.key,
        name: seed.name,
        id: bot.id,
        modelProvider: updated?.modelProvider ?? null,
        modelId: updated?.modelId ?? null,
      });
      console.log(`Created bot ${seed.name}: ${bot.id}`);
    }

    const groups = await rpc(baseUrl, headers, API.listGroups, {});
    let group = Array.isArray(groups)
      ? groups.find((item) => item.name === GROUP_SEED.name)
      : undefined;
    const reused = Boolean(group);

    if (group) {
      console.log(`Group ${GROUP_SEED.name} already exists: ${group.id}; skipping creation.`);
    } else {
      group = await rpc(baseUrl, headers, API.createGroup, {
        name: GROUP_SEED.name,
        botIds: created.map((bot) => bot.id),
      });
      console.log(`Created group ${GROUP_SEED.name}: ${group.id}`);
    }

    console.log(
      JSON.stringify(
        {
          baseUrl,
          bots: created,
          group: {
            id: group.id,
            threadId: group.threadId ?? null,
            reused,
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (created.length > 0) {
      console.error(
        `Bots created before failure: ${created.map((bot) => `${bot.name}=${bot.id}`).join(", ")}`,
      );
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!options.apply) {
    console.log("Dry run: no requests will be sent.");
    console.log(JSON.stringify(buildPlan(baseUrl, options), null, 2));
    return;
  }

  await apply(baseUrl, options);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
