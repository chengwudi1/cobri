#!/usr/bin/env node
"use strict";

import http from "node:http";

const HOST = process.env.HOST || "0.0.0.0";
const DISPLAY_HOST = process.env.PUBLIC_HOST || "127.0.0.1";
const PORT = Number(process.env.FAKE_GMAIL_PORT || 4312);
const MAX_BODY_BYTES = 128 * 1024;

const SEED_MESSAGES = [
  {
    id: "m1",
    from: "李总 <li@yuanshan.example>",
    to: "inbox@demo.test",
    subject: "远山科技客户会邀",
    body: "邀请您参加 2026-11-05 16:00（Asia/Shanghai）的续约会议，请确认时间和议题。",
    receivedAt: "2026-10-27T09:00:00+08:00",
    urgent: true,
    deadline: "2026-10-30",
    needsConfirmation: true,
  },
  {
    id: "m2",
    from: "财务 <finance@demo.test>",
    to: "inbox@demo.test",
    subject: "INV-42 金额修正",
    body: "INV-42 的金额需从 900 修正为 720，今天截止。",
    receivedAt: "2026-10-27T08:30:00+08:00",
    urgent: true,
    deadline: "2026-10-27",
    needsConfirmation: false,
  },
  {
    id: "m3",
    from: "王总 <wang@demo.test>",
    to: "inbox@demo.test",
    subject: "报价审批",
    body: "远山科技续约报价请在今天完成审批。",
    receivedAt: "2026-10-27T08:00:00+08:00",
    urgent: true,
    deadline: "2026-10-27",
    needsConfirmation: false,
  },
  {
    id: "m4",
    from: "行业观察 <news@demo.test>",
    to: "inbox@demo.test",
    subject: "行业周报",
    body: "本周行业动态摘要，仅供阅读。",
    receivedAt: "2026-10-26T18:00:00+08:00",
    urgent: false,
    deadline: null,
    needsConfirmation: false,
  },
  {
    id: "m5",
    from: "午餐群 <lunch@demo.test>",
    to: "inbox@demo.test",
    subject: "午餐邀约",
    body: "周五中午一起吃饭？",
    receivedAt: "2026-10-26T12:00:00+08:00",
    urgent: false,
    deadline: null,
    needsConfirmation: false,
  },
];

let state;

function resetState() {
  state = {
    messages: SEED_MESSAGES.map((message) => ({ ...message })),
    sent: [],
    nextSentId: 1,
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

function normalizeCc(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join(", ");
  }
  return String(value ?? "").trim();
}

function openApiDocument(req) {
  const publicBase =
    process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ||
    `http://${String(req.headers.host || `${DISPLAY_HOST}:${PORT}`).split(",")[0].trim()}`;
  return {
    openapi: "3.0.3",
    info: {
      title: "Cobri Fake Gmail",
      version: "1.0.0",
      description: "Local deterministic Gmail fixture for Cobri evaluations.",
    },
    servers: [{ url: publicBase }],
    paths: {
      "/messages": {
        get: {
          operationId: "GMAIL_LIST_MESSAGES",
          summary: "List the five seeded inbox messages",
          responses: { 200: { description: "Seeded messages" } },
        },
      },
      "/send": {
        post: {
          operationId: "GMAIL_SEND_EMAIL",
          summary: "Record an email send without deduplication",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    to: { type: "string" },
                    cc: { type: "string" },
                    subject: { type: "string" },
                    body: { type: "string" },
                  },
                  required: ["to", "subject", "body"],
                },
              },
            },
          },
          responses: { 201: { description: "Recorded send" } },
        },
      },
      "/sent": {
        get: {
          operationId: "GMAIL_LIST_SENT",
          summary: "List recorded email sends",
          responses: { 200: { description: "Sent records" } },
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
      sendJson(res, 200, { ok: true, service: "fake-gmail", port: PORT });
      return;
    }
    if (req.method === "GET" && path === "/") {
      redirect(res, "/messages");
      return;
    }
    if (req.method === "GET" && path === "/messages") {
      sendJson(res, 200, { messages: state.messages, count: state.messages.length });
      return;
    }
    if (req.method === "GET" && path === "/sent") {
      sendJson(res, 200, { sent: state.sent, count: state.sent.length });
      return;
    }
    if (req.method === "POST" && path === "/send") {
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
      const to = String(raw.to ?? raw.recipient_email ?? "").trim();
      const cc = normalizeCc(raw.cc ?? raw.cc_email);
      const subject = String(raw.subject ?? "").trim();
      const bodyText = String(raw.body ?? raw.text ?? raw.html_body ?? "").trim();
      if (!to || !subject || !bodyText) {
        sendJson(res, 400, {
          error: "to, subject and body are required",
        });
        return;
      }

      const record = {
        id: `sent-${state.nextSentId}`,
        to,
        cc,
        subject,
        body: bodyText,
        sentAt: new Date().toISOString(),
      };
      state.nextSentId += 1;
      state.sent.push(record);
      sendJson(res, 201, { id: record.id, sentAt: record.sentAt, record });
      return;
    }
    if (req.method === "GET" && path === "/__state") {
      sendJson(res, 200, {
        service: "fake-gmail",
        port: PORT,
        messages: state.messages,
        sent: state.sent,
        nextSentId: state.nextSentId,
      });
      return;
    }
    if (req.method === "POST" && path === "/__reset") {
      resetState();
      sendJson(res, 200, {
        ok: true,
        messages: state.messages.length,
        sent: state.sent.length,
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
  console.log(`fake-gmail listening on http://${HOST}:${PORT}`);
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
