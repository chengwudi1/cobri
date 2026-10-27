#!/usr/bin/env node
"use strict";

import http from "node:http";

const HOST = process.env.HOST || "0.0.0.0";
const DISPLAY_HOST = process.env.PUBLIC_HOST || "127.0.0.1";
const PORT = Number(process.env.FAKE_CALENDAR_PORT || 4313);
const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_TIMEZONE = "Asia/Shanghai";

const SEED_EVENTS = [
  {
    id: "evt-1",
    summary: "产品评审",
    start: "2026-11-05T15:00:00+08:00",
    end: "2026-11-05T16:00:00+08:00",
    startLocal: "2026-11-05 15:00",
    endLocal: "2026-11-05 16:00",
    timezone: DEFAULT_TIMEZONE,
    attendees: ["product@demo.test"],
    location: "会议室 A",
    createdAt: "2026-10-27T09:00:00+08:00",
  },
];

let state;

function resetState() {
  state = {
    events: SEED_EVENTS.map((event) => ({
      ...event,
      attendees: [...event.attendees],
    })),
    nextEventId: 2,
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

function normalizeAttendees(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function localize(value, timezone) {
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value ?? "";
    return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
  } catch {
    return String(value);
  }
}

function openApiDocument(req) {
  const publicBase =
    process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ||
    `http://${String(req.headers.host || `${DISPLAY_HOST}:${PORT}`).split(",")[0].trim()}`;
  return {
    openapi: "3.0.3",
    info: {
      title: "Cobri Fake Google Calendar",
      version: "1.0.0",
      description: "Local deterministic Google Calendar fixture for Cobri evaluations.",
    },
    servers: [{ url: publicBase }],
    paths: {
      "/events": {
        get: {
          operationId: "GOOGLECALENDAR_LIST_EVENTS",
          summary: "List all calendar events",
          responses: { 200: { description: "Calendar events" } },
        },
        post: {
          operationId: "GOOGLECALENDAR_CREATE_EVENT",
          summary: "Create a calendar event without deduplication",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    summary: { type: "string" },
                    start: { type: "string" },
                    end: { type: "string" },
                    timezone: { type: "string" },
                    attendees: {
                      type: "array",
                      items: { type: "string" },
                    },
                    location: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["summary", "start", "end"],
                },
              },
            },
          },
          responses: { 201: { description: "Created event" } },
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
      sendJson(res, 200, { ok: true, service: "fake-calendar", port: PORT });
      return;
    }
    if (req.method === "GET" && path === "/") {
      redirect(res, "/events");
      return;
    }
    if (req.method === "GET" && path === "/events") {
      sendJson(res, 200, { events: state.events, count: state.events.length });
      return;
    }
    if (req.method === "POST" && path === "/events") {
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
      const summary = String(raw.summary ?? raw.title ?? "").trim();
      const start = String(raw.start ?? raw.start_datetime ?? "").trim();
      const end = String(raw.end ?? raw.end_datetime ?? "").trim();
      if (!summary || !start || !end) {
        sendJson(res, 400, {
          error: "summary, start and end are required",
        });
        return;
      }

      const timezone = String(raw.timezone ?? raw.time_zone ?? DEFAULT_TIMEZONE).trim() ||
        DEFAULT_TIMEZONE;
      const event = {
        id: `evt-${state.nextEventId}`,
        summary,
        start,
        end,
        startLocal: localize(start, timezone),
        endLocal: localize(end, timezone),
        timezone,
        attendees: normalizeAttendees(raw.attendees),
        location: String(raw.location ?? "").trim(),
        description: String(raw.description ?? "").trim(),
        createdAt: new Date().toISOString(),
      };
      state.nextEventId += 1;
      state.events.push(event);
      sendJson(res, 201, { id: event.id, event });
      return;
    }
    if (req.method === "GET" && path === "/__state") {
      sendJson(res, 200, {
        service: "fake-calendar",
        port: PORT,
        events: state.events,
        nextEventId: state.nextEventId,
      });
      return;
    }
    if (req.method === "POST" && path === "/__reset") {
      resetState();
      sendJson(res, 200, { ok: true, events: state.events.length });
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
  console.log(`fake-calendar listening on http://${HOST}:${PORT}`);
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
