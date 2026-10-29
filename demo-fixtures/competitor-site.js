#!/usr/bin/env node
"use strict";

import http from "node:http";

const HOST = process.env.HOST || "0.0.0.0";
const DISPLAY_HOST = process.env.PUBLIC_HOST || "127.0.0.1";
const PORT = Number(process.env.COMPETITOR_PORT || 4310);

const INITIAL_CHANGELOG = [
  { date: "2026-10-21", title: "团队版按席位计费上线" },
  { date: "2026-10-14", title: "新增用量报表导出" },
  { date: "2026-10-07", title: "企业版支持 SSO 单点登录" },
];

const INITIAL_NEWS = [
  {
    date: "2026-10-20",
    title: "云图智能团队版新增审计日志，计划调价至 229 元，尚未生效，以定价页为准",
  },
  {
    date: "2026-10-12",
    title: "远山科技发布「远山智脑 2.0」，新增合同审阅与报价单生成",
  },
  {
    date: "2026-09-18",
    title: "远山科技完成 B 轮融资 2.4 亿元，海岚资本领投，资金用于行业大模型",
  },
];

let state;

function resetState() {
  state = {
    company: "云图智能",
    teamPrice: 199,
    enterprisePrice: 399,
    changelog: INITIAL_CHANGELOG.map((entry) => ({ ...entry })),
    news: INITIAL_NEWS.map((entry) => ({ ...entry })),
    mutated: false,
  };
}

resetState();

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
  <title>${escapeHtml(title)} · 云图智能</title>
</head>
<body>
  <header><strong>云图智能</strong> <nav><a href="/pricing">定价</a> · <a href="/changelog">更新日志</a> · <a href="/news">新闻</a></nav></header>
  <main>${body}</main>
</body>
</html>`;
}

function pricingPage() {
  return page(
    "定价",
    `<h1>云图智能定价</h1>
<ul>
  <li>团队版 ¥${state.teamPrice}/席/月</li>
  <li>企业版 ¥${state.enterprisePrice}/席/月</li>
</ul>
<p>价格以人民币计价，按席位按月结算。</p>
<p><a href="/pricing.json">查看 JSON</a> · <a href="/changelog">更新日志</a></p>`,
  );
}

function changelogPage() {
  const items = state.changelog
    .map(
      (entry) =>
        `  <li><time datetime="${escapeHtml(entry.date)}">${escapeHtml(entry.date)}</time> ${escapeHtml(entry.title)}</li>`,
    )
    .join("\n");
  return page(
    "更新日志",
    `<h1>更新日志</h1>
<p>共 ${state.changelog.length} 条更新</p>
<ol>
${items}
</ol>`,
  );
}

function newsPage() {
  const items = state.news
    .map(
      (entry) =>
        `  <li><time datetime="${escapeHtml(entry.date)}">${escapeHtml(entry.date)}</time> ${escapeHtml(entry.title)}</li>`,
    )
    .join("\n");
  return page(
    "新闻",
    `<h1>行业新闻</h1>
<p>共 ${state.news.length} 条新闻</p>
<ol>
${items}
</ol>`,
  );
}

function pricingPayload() {
  return {
    company: state.company,
    currency: "CNY",
    billingUnit: "seat/month",
    teamPrice: state.teamPrice,
    enterprisePrice: state.enterprisePrice,
    plans: [
      { id: "team", name: "团队版", price: state.teamPrice, unit: "席/月" },
      { id: "enterprise", name: "企业版", price: state.enterprisePrice, unit: "席/月" },
    ],
    changelog: state.changelog.map((entry) => ({ ...entry })),
  };
}

function newsPayload() {
  return {
    company: state.company,
    count: state.news.length,
    news: state.news.map((entry) => ({ ...entry })),
  };
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end();
}

function isLoopback(address) {
  const value = String(address || "");
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function handleMutate(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, {
      Allow: "POST",
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end("Use POST\n");
    return;
  }
  if (!isLoopback(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: "loopback only" });
    return;
  }

  let changed = false;
  if (!state.mutated) {
    state.mutated = true;
    state.teamPrice = 229;
    state.changelog.unshift({ date: "2026-10-27", title: "新增审计日志" });
    changed = true;
  }

  sendJson(res, 200, {
    ok: true,
    changed,
    teamPrice: state.teamPrice,
    changelogCount: state.changelog.length,
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  } catch {
    sendHtml(res, 400, page("请求错误", "<h1>400</h1><p>请求地址不正确。</p>"));
    return;
  }

  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true, service: "competitor-site", port: PORT });
    return;
  }
  if (req.method === "GET" && path === "/") {
    redirect(res, "/pricing");
    return;
  }
  if (req.method === "GET" && path === "/pricing") {
    sendHtml(res, 200, pricingPage());
    return;
  }
  if (req.method === "GET" && path === "/pricing.json") {
    sendJson(res, 200, pricingPayload());
    return;
  }
  if (req.method === "GET" && path === "/changelog") {
    sendHtml(res, 200, changelogPage());
    return;
  }
  if (req.method === "GET" && path === "/news") {
    sendHtml(res, 200, newsPage());
    return;
  }
  if (req.method === "GET" && path === "/news.json") {
    sendJson(res, 200, newsPayload());
    return;
  }
  if (path === "/__fixture/mutate") {
    handleMutate(req, res);
    return;
  }
  if (req.method === "GET" && path === "/__fixture/state") {
    sendJson(res, 200, pricingPayload());
    return;
  }
  if (req.method === "GET" && path === "/__state") {
    sendJson(res, 200, {
      service: "competitor-site",
      teamPrice: state.teamPrice,
      enterprisePrice: state.enterprisePrice,
      changelogCount: state.changelog.length,
      newsCount: state.news.length,
      mutated: state.mutated,
    });
    return;
  }
  if (req.method === "POST" && path === "/__reset") {
    resetState();
    sendJson(res, 200, {
      ok: true,
      teamPrice: state.teamPrice,
      changelogCount: state.changelog.length,
      newsCount: state.news.length,
    });
    return;
  }

  sendHtml(res, 404, page("未找到", "<h1>404</h1><p>页面不存在。</p>"));
});

server.listen(PORT, HOST, () => {
  console.log(`competitor-site listening on http://${HOST}:${PORT}`);
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
