#!/usr/bin/env node
"use strict";

import http from "node:http";
import crypto from "node:crypto";

const HOST = process.env.HOST || "0.0.0.0";
const DISPLAY_HOST = process.env.PUBLIC_HOST || "127.0.0.1";
const PORT = Number(process.env.PORTAL_PORT || 4311);
const ACCOUNT_EMAIL = "inbox@demo.test";
const COOKIE_NAME = "portal_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_SECRET =
  process.env.PORTAL_SESSION_SECRET || "cobri-demo-portal-fixture-secret";
const MAX_BODY_BYTES = 64 * 1024;
const UNREAD_COUNT = 3;
const sessions = new Map();

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · 客户门户</title>
</head>
<body>
  <header><strong>客户门户</strong></header>
  <main>${body}</main>
</body>
</html>`;
}

function loginPage(error) {
  return page(
    "登录",
    `<h1>Sign in</h1>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/login">
  <label>Email <input name="email" type="email" autocomplete="username" placeholder="inbox@demo.test"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Sign in</button>
</form>
<p>演示账号：inbox@demo.test，密码任意非空。</p>`,
  );
}

function inboxPage(email) {
  return page(
    "收件箱",
    `<h1>Inbox</h1>
<p>Signed in as ${escapeHtml(email)}</p>
<p>3 条未读消息 / 3 unread messages</p>
<ol>
  <li>远山科技：确认下周四 16:00 的客户会</li>
  <li>财务：INV-42 金额修正待确认</li>
  <li>王总：续约报价待审批</li>
</ol>
<p><a href="/logout">Sign out</a></p>`,
  );
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function sendJson(res, status, value, headers = {}) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end();
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const rawValue = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }
  return cookies;
}

function createSessionToken(email) {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS }),
    "utf8",
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function readSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      data.email !== ACCOUNT_EMAIL ||
      !Number.isFinite(data.exp) ||
      data.exp <= Date.now()
    ) {
      return null;
    }
    if (!sessions.has(token)) return null;
    return data;
  } catch {
    return null;
  }
}

function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const expires = new Date(Date.now() + SESSION_TTL_MS).toUTCString();
  return `${COOKIE_NAME}=${token}; Max-Age=${maxAge}; Expires=${expires}; Path=/; HttpOnly; SameSite=Lax`;
}

const CLEAR_COOKIE = `${COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax`;

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

function parseFields(body, contentType) {
  if (String(contentType || "").includes("application/json")) {
    const value = JSON.parse(body || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return value;
  }
  return Object.fromEntries(new URLSearchParams(body).entries());
}

const server = http.createServer(async (req, res) => {
  try {
    let url;
    try {
      url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    } catch {
      sendHtml(res, 400, page("请求错误", "<h1>400</h1><p>请求地址不正确。</p>"));
      return;
    }

    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, service: "customer-portal", port: PORT });
      return;
    }

    if (req.method === "GET" && path === "/") {
      const session = readSession(req);
      if (session) {
        redirect(res, "/inbox");
        return;
      }
      sendHtml(res, 200, loginPage());
      return;
    }

    if (req.method === "GET" && path === "/login") {
      const session = readSession(req);
      if (session) {
        redirect(res, "/inbox");
        return;
      }
      sendHtml(res, 200, loginPage());
      return;
    }

    if (req.method === "POST" && path === "/login") {
      let fields;
      try {
        const body = await readBody(req);
        fields = parseFields(body, req.headers["content-type"]);
      } catch {
        sendHtml(res, 400, loginPage("请求格式不正确。"));
        return;
      }

      const email = String(fields.email || "").trim().toLowerCase();
      const password = String(fields.password || "");
      if (email !== ACCOUNT_EMAIL || password.length === 0) {
        sendHtml(res, 401, loginPage("邮箱或密码不正确。"));
        return;
      }

      const token = createSessionToken(ACCOUNT_EMAIL);
      sessions.set(token, { email: ACCOUNT_EMAIL, createdAt: Date.now() });
      redirect(res, "/inbox", { "Set-Cookie": sessionCookie(token) });
      return;
    }

    if (req.method === "GET" && path === "/inbox") {
      const session = readSession(req);
      if (!session) {
        redirect(res, "/");
        return;
      }
      sendHtml(res, 200, inboxPage(session.email));
      return;
    }

    if (
      (req.method === "GET" || req.method === "POST") &&
      path === "/logout"
    ) {
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
      if (token) sessions.delete(token);
      redirect(res, "/", { "Set-Cookie": CLEAR_COOKIE });
      return;
    }

    if (req.method === "GET" && path === "/__state") {
      sendJson(res, 200, {
        service: "customer-portal",
        sessions: sessions.size,
        unread: UNREAD_COUNT,
      });
      return;
    }

    if (req.method === "POST" && path === "/__reset") {
      sessions.clear();
      sendJson(
        res,
        200,
        { ok: true, sessions: 0, unread: UNREAD_COUNT },
        { "Set-Cookie": CLEAR_COOKIE },
      );
      return;
    }

    if (path === "/login") {
      res.writeHead(405, {
        Allow: "GET, POST",
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("Method Not Allowed\n");
      return;
    }

    sendHtml(res, 404, page("未找到", "<h1>404</h1><p>页面不存在。</p>"));
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendHtml(res, 500, page("错误", "<h1>500</h1>"));
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`customer-portal listening on http://${HOST}:${PORT}`);
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
