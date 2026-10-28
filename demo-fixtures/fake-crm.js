#!/usr/bin/env node
"use strict";

import http from "node:http";

const HOST = process.env.HOST || "0.0.0.0";
const DISPLAY_HOST = process.env.PUBLIC_HOST || "127.0.0.1";
const PORT = Number(process.env.FAKE_CRM_PORT || 4314);
const MAX_BODY_BYTES = 128 * 1024;

const SEED_CONTACTS = [
  {
    id: "customer-yuanshan",
    name: "远山科技",
    contractAmount: 480000,
    contractAmountText: "48 万元",
    status: "active",
    priority: "high",
    createdAt: "2026-10-01T09:00:00+08:00",
  },
];

let state;

function resetState() {
  state = {
    contacts: SEED_CONTACTS.map((contact) => ({ ...contact })),
    notes: [],
    nextNoteId: 1,
  };
}

resetState();

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
  });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseBody(body, contentType) {
  if (String(contentType || "").includes("application/json")) {
    return JSON.parse(body || "{}");
  }
  return Object.fromEntries(new URLSearchParams(body).entries());
}

function openApiDocument(req) {
  const publicBase =
    process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ||
    `http://${String(req.headers.host || `${DISPLAY_HOST}:${PORT}`).split(",")[0].trim()}`;
  return {
    openapi: "3.0.3",
    info: {
      title: "Cobri Fake CRM",
      version: "1.0.0",
      description: "Local deterministic CRM fixture for Cobri evaluations.",
    },
    servers: [{ url: publicBase }],
    paths: {
      "/contacts": {
        get: {
          operationId: "CRM_LIST_CONTACTS",
          summary: "List seeded CRM contacts",
          responses: { 200: { description: "CRM contacts" } },
        },
      },
      "/notes": {
        get: {
          operationId: "CRM_LIST_NOTES",
          summary: "List CRM notes, optionally filtered by contactId",
          parameters: [
            {
              name: "contactId",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: { 200: { description: "CRM notes" } },
        },
        post: {
          operationId: "CRM_CREATE_NOTE",
          summary: "Create a CRM note without deduplication",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    contactId: { type: "string" },
                    body: { type: "string" },
                    author: { type: "string" },
                  },
                  required: ["contactId", "body"],
                },
              },
            },
          },
          responses: { 201: { description: "Created note" } },
        },
      },
    },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    let url;
    try {
      url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    } catch {
      sendJson(res, 400, { error: "invalid URL" });
      return;
    }

    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, service: "fake-crm", port: PORT });
      return;
    }
    if (req.method === "GET" && path === "/") {
      redirect(res, "/contacts");
      return;
    }
    if (req.method === "GET" && path === "/contacts") {
      sendJson(res, 200, { contacts: state.contacts, count: state.contacts.length });
      return;
    }
    if (req.method === "GET" && path === "/notes") {
      const contactId = url.searchParams.get("contactId");
      const notes = contactId
        ? state.notes.filter((note) => note.contactId === contactId)
        : state.notes;
      sendJson(res, 200, { notes, count: notes.length });
      return;
    }
    if (req.method === "POST" && path === "/notes") {
      let fields;
      try {
        const body = await readBody(req);
        fields = parseBody(body, req.headers["content-type"]);
      } catch {
        sendJson(res, 400, { error: "invalid request body" });
        return;
      }

      const raw =
        fields && typeof fields === "object" && fields.body !== null &&
        typeof fields.body === "object" && !Array.isArray(fields.body)
          ? fields.body
          : fields && typeof fields === "object"
            ? fields
            : {};
      const contactId = String(raw.contactId ?? raw.recordId ?? "").trim();
      const body = String(raw.body ?? raw.text ?? "").trim();
      if (!contactId || !body) {
        sendJson(res, 400, { error: "contactId and body are required" });
        return;
      }
      const author = String(raw.author ?? raw.createdBy ?? "unknown").trim() || "unknown";
      const note = {
        id: `note-${state.nextNoteId}`,
        contactId,
        body,
        author,
        createdAt: new Date().toISOString(),
      };
      state.nextNoteId += 1;
      state.notes.push(note);
      sendJson(res, 201, { id: note.id, note });
      return;
    }
    if (req.method === "GET" && path === "/__state") {
      sendJson(res, 200, {
        service: "fake-crm",
        port: PORT,
        contacts: state.contacts,
        notes: state.notes,
        nextNoteId: state.nextNoteId,
      });
      return;
    }
    if (req.method === "POST" && path === "/__reset") {
      resetState();
      sendJson(res, 200, {
        ok: true,
        contacts: state.contacts.length,
        notes: state.notes.length,
      });
      return;
    }
    if (req.method === "GET" && path === "/openapi.json") {
      sendJson(res, 200, openApiDocument(req));
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal error" });
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`fake-crm listening on http://${HOST}:${PORT}`);
  console.log(`health: http://${DISPLAY_HOST}:${PORT}/health`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process first.`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
