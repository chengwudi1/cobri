# Cobri 本地演示夹具

零第三方依赖，使用 Node 24 内置模块；五个服务默认监听 `0.0.0.0`，本地健康检查用 `127.0.0.1`，不占用 Rakazo 的 3000/3001 端口。

| 服务 | 端口 | 文件 | 用途 |
| --- | --- | --- | --- |
| 竞品站（云图智能） | 4310 | `competitor-site.js` | 定价页、更新日志、JSON、价格变更 |
| 客户门户 | 4311 | `customer-portal.js` | 登录、cookie 会话、3 条未读消息 |
| 假 Gmail | 4312 | `fake-gmail.js` | 5 封种子邮件、发送记录 |
| 假日历 | 4313 | `fake-calendar.js` | 已有事件、创建事件 |
| 假 CRM | 4314 | `fake-crm.js` | 远山科技联系人、备注 |

## 监听地址与容器访问

五个服务默认监听 `0.0.0.0`，所以宿主机、局域网和 Docker 容器都能访问。启动日志里的健康检查地址仍用 `127.0.0.1`。

Bot 跑在容器里时，容器内的 `localhost` / `127.0.0.1` 指容器自己，不是宿主机。Windows 和 macOS 的 Docker Desktop 用：

```text
http://host.docker.internal:4312
http://host.docker.internal:4313
```

Linux Docker 需要在容器上显式加主机映射，例如 `--add-host=host.docker.internal:host-gateway`，或者直接使用宿主机局域网 IP。

2026-10-28 实测：五个假服务以 `0.0.0.0` 启动后，在运行中的 `rakazo/computer:local` Bot 容器里执行：

- `curl http://host.docker.internal:4310/pricing` → HTTP 200，响应片段 `<title>定价 · 云图智能</title>`。
- `curl http://host.docker.internal:4312/messages` → HTTP 200，响应片段 `"id": "m1"`、`"subject": "远山科技客户会邀"`。

`host.docker.internal` 已通，本次不需要退回 Docker 网关地址；不同环境的网关可用 `ip route` 或 `/proc/net/route` 查看。测试期间假服务保持运行，未重启 Rakazo。

Rakazo 侧还需要：

- API 和 worker 两边都设置 `MCP_ALLOW_PRIVATE_ENDPOINT=true`，然后重启两个进程；只设 API 不够。
- 安装 OpenAPI 时用容器能访问的地址，例如 `http://host.docker.internal:4312/openapi.json`。假服务的 `/openapi.json` 默认按请求的 `Host` 生成 `servers[0].url`，也可以设置 `PUBLIC_BASE_URL=http://host.docker.internal:4312` 后重启假服务。
- `POST /__fixture/mutate` 仍然只接受回环地址。如果测试进程在容器里，需要从宿主机调用，或另外做一层代理；从容器直接调用会得到 403。

安全提示：监听 `0.0.0.0` 会把假服务暴露给局域网，只适合本地演示。需要收紧时用 `HOST=127.0.0.1 node demo-fixtures/start.js`。

## 启动

在仓库根目录下执行：

```bash
node demo-fixtures/start.js
```

五个服务会同时启动，日志分别带 `[competitor:4310]`、`[portal:4311]`、`[gmail:4312]`、`[calendar:4313]`、`[crm:4314]` 前缀。也可以分开启动：

```bash
node demo-fixtures/competitor-site.js
node demo-fixtures/customer-portal.js
node demo-fixtures/fake-gmail.js
node demo-fixtures/fake-calendar.js
node demo-fixtures/fake-crm.js
```

## 停止

推荐在另一个终端执行：

```bash
node demo-fixtures/stop.js
```

`start.js` 会把子进程的 PID 记录到系统临时目录的 `cobri-demo-fixtures-pids.json`，`stop.js` 读取后结束它们。也可以直接在启动终端按 `Ctrl+C`。

如果只单独启动了某一个服务，`stop.js` 不知道它的 PID；在该终端按 `Ctrl+C`，或按端口结束。PowerShell：

```powershell
Get-NetTCPConnection -LocalPort 4310,4311,4312,4313,4314 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

Git Bash：

```bash
netstat -ano | grep -E ':(4310|4311|4312|4313|4314)\b'
taskkill //PID <上一步看到的 PID> //F
```

## 四个 Bot 种子与创建脚本

- `bot-seeds.js`：四个 Bot 的完整定义和群定义。
- `seed-bots.js`：零依赖 CLI，用 Node 24 自带 `fetch` 调 Rakazo RPC；默认 dry-run。

| key | 名称 | 一句话职责 |
| --- | --- | --- |
| `chief` | 总管 | 统筹任务、委派子 Bot 并汇总结果 |
| `research` | 研究 | 竞品调研与带出处的资料简报 |
| `inbox` | 收件箱 | 邮件分拣、紧急事项与回复草稿 |
| `calendar` | 日程 | 日历冲突检查与会议安排建议 |

群的名称是「工作助理团队」，成员为以上四个 Bot。每个 Bot 的系统提示词都在 `bot-seeds.js` 里，统一包含三条约束：不越权、外部写必须审批、结果回发起人。

模型字段在定义里是 `modelProvider: null`、`modelId: null`、`thinkingLevel: null`。`bots/create` 的输入没有模型字段，所以 `--apply` 会在创建后调用 `bots/update` 把这三项清空。

### API 路径与鉴权（只读核对结果）

- 创建 Bot：`POST {base-url}/rpc/bots/create`，body 是 `{"json": CreateBotInput}`，响应是 `{"json": Bot}`。
- 更新 Bot：`POST {base-url}/rpc/bots/update`，body 是 `{"json": {...}}`。
- 列表群：`POST {base-url}/rpc/groups/list`，body 是 `{"json": {}}`。
- 创建群：`POST {base-url}/rpc/groups/create`，body 是 `{"json": {name, botIds}}`。
- `CreateBotInput` 字段：`name`、`title`、`description`、`instructions`、`notifyOnFinish`、`computerMode`、`spawnKey`；没有模型字段。
- 鉴权：Better Auth 会话 cookie（`better-auth.session_token=...`）或签名 Bearer token（登录响应里的 `session.token`）。脚本会带 `Origin`；有多 Space 时可传 `--space-id` 作为 `x-rakazo-space-id`。
- 默认 base URL 是 `http://127.0.0.1:5173`（仓库 Vite 默认）；演示若跑在 3000 或 API 的 3100，用 `--base-url` 覆盖。

### 用法

```bash
# 帮助
node demo-fixtures/seed-bots.js --help

# 默认 dry-run：只打印四个 Bot 和群的完整定义，不发请求
node demo-fixtures/seed-bots.js

# 真正创建（本轮没有执行）
node demo-fixtures/seed-bots.js --apply \
  --base-url http://127.0.0.1:5173 \
  --cookie 'better-auth.session_token=<session>'
```

`--apply` 会先创建四个 Bot，再创建群。Bot 带 `spawnKey`，重复执行会复用同名 Bot；群会先查 `groups/list`，同名群已存在时跳过创建。dry-run 输出里的群 `botIds` 是 `<created:chief>` 这类占位符，因为此时还没有真实 Bot id。

## 竞品站（4310）

- `GET /pricing`：可见文本包含 `团队版 ¥199/席/月` 和 `企业版 ¥399/席/月`。
- `GET /pricing.json`：同样的价格和 3 条更新日志，供测试确定性读取。
- `GET /changelog`：3 条带日期和标题的更新日志。
- `POST /__fixture/mutate`：仅本机可调用，幂等。第一次把团队版改成 `¥229` 并新增「新增审计日志」；之后再次调用返回 `changed: false`，不会重复添加。
- 重启竞品服务会恢复到初始状态（199 元、3 条日志）。

示例：

```bash
curl -s http://127.0.0.1:4310/pricing
curl -s http://127.0.0.1:4310/pricing.json
curl -s http://127.0.0.1:4310/changelog
curl -X POST http://127.0.0.1:4310/__fixture/mutate
curl -X POST http://127.0.0.1:4310/__fixture/mutate
```

## 客户门户（4311）

- 账号：`inbox@demo.test`
- 密码：任意非空字符串
- `GET /`：未登录时显示登录页，可见文本包含 `Sign in`。
- `POST /login`：接受 URL 编码表单或 JSON，字段为 `email`、`password`；成功返回 302 到 `/inbox` 并设置 `portal_session` cookie；邮箱不对或密码为空返回 401。
- `GET /inbox`：未登录返回 302 到 `/`；登录后可见 `Signed in as inbox@demo.test`、`3 unread messages` 和 3 条未读消息。
- `GET /logout`：清除 cookie 并回到登录页。
- Cookie 为持久 cookie（`Max-Age=604800`，7 天），关闭浏览器后在同一 profile 重新打开仍保持登录。

示例：

```bash
curl -i http://127.0.0.1:4311/inbox
curl -i -c /tmp/cobri-portal-cookies.txt \
  -d 'email=inbox@demo.test&password=demo' \
  http://127.0.0.1:4311/login
curl -s -b /tmp/cobri-portal-cookies.txt http://127.0.0.1:4311/inbox
```

## 假 Gmail（4312）

种子邮件固定为 `m1`-`m5`：

| ID | 主题 | 要点 | 紧急 |
| --- | --- | --- | --- |
| `m1` | 远山科技客户会邀 | 需确认，含 `2026-11-05 16:00`（Asia/Shanghai） | 是 |
| `m2` | INV-42 金额修正 | 金额 900 修正为 720，今天截止 | 是 |
| `m3` | 报价审批 | 王总，今天截止 | 是 |
| `m4` | 行业周报 | 非紧急 | 否 |
| `m5` | 午餐邀约 | 非紧急 | 否 |

接口：

- `GET /messages`：返回 `{ messages, count }`，5 封种子邮件。
- `POST /send`：记录一次发送，字段为 `to`、`cc`、`subject`、`body`；返回 `{ id, sentAt, record }`。不做去重，重复调用会产生多条 `sent-N` 记录。
- `GET /sent`：返回 `{ sent, count }`，按调用顺序保留全部发送记录。
- `GET /__state`：一次返回 `messages`、`sent`、`nextSentId`。
- `POST /__reset`：恢复 5 封种子邮件并清空发送记录，可重复调用。
- `GET /openapi.json`：给 Rakazo 的 installed OpenAPI 源使用的描述文件，operationId 为 `GMAIL_LIST_MESSAGES`、`GMAIL_SEND_EMAIL`、`GMAIL_LIST_SENT`。
- `GET /health`：健康检查。

`POST /send` 同时接受 `to` 和 `recipient_email`，方便在假服务与真实 Gmail 工具之间切换；发送记录的 `cc` 统一存成逗号分隔字符串。

示例：

```bash
curl -s http://127.0.0.1:4312/messages
curl -s -X POST http://127.0.0.1:4312/send \
  -H 'content-type: application/json' \
  -d '{"to":"li@yuanshan.example","cc":"wang@demo.test","subject":"会议确认","body":"确认 2026-11-05 16:00"}'
curl -s http://127.0.0.1:4312/sent
curl -s -X POST http://127.0.0.1:4312/__reset
```

## 假日历（4313）

种子事件：

- `evt-1`：产品评审，`2026-11-05T15:00:00+08:00` 到 `2026-11-05T16:00:00+08:00`，Asia/Shanghai，会议室 A。

接口：

- `GET /events`：返回 `{ events, count }`，包含种子事件和之后创建的事件。
- `POST /events`：创建事件，字段为 `summary`、`start`、`end`、`timezone`、`attendees`、`location`、`description`；返回 `{ id, event }`。不做去重，重复调用会产生多条 `evt-N`。
- `GET /__state`：一次返回 `events` 和 `nextEventId`。
- `POST /__reset`：恢复只有 `evt-1` 的种子状态，可重复调用。
- `GET /openapi.json`：operationId 为 `GOOGLECALENDAR_LIST_EVENTS`、`GOOGLECALENDAR_CREATE_EVENT`。
- `GET /health`：健康检查。

`start`、`end` 建议传带时区偏移的 ISO 8601 字符串；返回里同时有 `startLocal`、`endLocal`（按 `timezone` 格式化）和 `createdAt`，便于区分新旧事件。

示例：

```bash
curl -s http://127.0.0.1:4313/events
curl -s -X POST http://127.0.0.1:4313/events \
  -H 'content-type: application/json' \
  -d '{"summary":"远山续约会议","start":"2026-11-05T16:00:00+08:00","end":"2026-11-05T17:00:00+08:00","timezone":"Asia/Shanghai","attendees":["li@yuanshan.example","wang@demo.test"]}'
curl -s http://127.0.0.1:4313/events
curl -s -X POST http://127.0.0.1:4313/__reset
```

## 一键验收

```bash
# 四个服务都在监听
curl -s http://127.0.0.1:4310/health
curl -s http://127.0.0.1:4311/health
curl -s http://127.0.0.1:4312/health
curl -s http://127.0.0.1:4313/health

# 竞品站
curl -s http://127.0.0.1:4310/pricing
curl -s http://127.0.0.1:4310/pricing.json
curl -s http://127.0.0.1:4310/changelog

# 客户门户：未登录 302，登录后可见收件箱
curl -i http://127.0.0.1:4311/inbox
curl -i -c /tmp/cobri-portal-cookies.txt -d 'email=inbox@demo.test&password=demo' http://127.0.0.1:4311/login
curl -s -b /tmp/cobri-portal-cookies.txt http://127.0.0.1:4311/inbox

# 假 Gmail：发送两次，/sent 应有两条
curl -s http://127.0.0.1:4312/messages
curl -s -X POST http://127.0.0.1:4312/send -H 'content-type: application/json' -d '{"to":"li@yuanshan.example","subject":"确认一","body":"第一次"}'
curl -s -X POST http://127.0.0.1:4312/send -H 'content-type: application/json' -d '{"to":"li@yuanshan.example","subject":"确认二","body":"第二次"}'
curl -s http://127.0.0.1:4312/sent
curl -s -X POST http://127.0.0.1:4312/__reset

# 假日历：创建后 /events 应有两条
curl -s http://127.0.0.1:4313/events
curl -s -X POST http://127.0.0.1:4313/events -H 'content-type: application/json' -d '{"summary":"远山续约会议","start":"2026-11-05T16:00:00+08:00","end":"2026-11-05T17:00:00+08:00","timezone":"Asia/Shanghai"}'
curl -s http://127.0.0.1:4313/events
curl -s -X POST http://127.0.0.1:4313/__reset
```

## Rakazo 连接器调查

### 内置 Gmail / Google Calendar 走哪条路

邮件和日历没有 Rakazo 自建的 Gmail/Calendar REST 适配器；工具来自托管连接器目录，部署时二选一：

- **Composio**：`packages/adapters/src/composio-connector.ts`。构造函数只把 `apiKey` 交给 SDK（`new Composio({ apiKey })`），没有 base URL 参数。
- **Pipedream**：`packages/adapters/src/pipedream-connector.ts`。`API_BASE` 固定为 `https://api.pipedream.com`，`MCP_ENDPOINT` 固定为 `https://remote.mcp.pipedream.net/v3`，没有环境变量覆盖。

Provider 配置和持久化：

- `packages/contracts/src/integration-settings.ts`：`IntegrationProviderConfigSchema` 只允许 `composio + apiKey` 或 `pipedream + clientId/clientSecret/projectId/environment`。
- `packages/adapters/src/integration-provider-settings.ts`：按上面的配置创建 `ComposioConnector` 或 `PipedreamConnector`，并把配置加密存到 `integration_provider_configs`。
- `packages/db/prisma/schema.prisma`：`IntegrationProviderConfig` 模型，对应 `integration_provider_configs` 表，只有 `id` 和 `ciphertext`。
- `apps/api/src/env.ts`：从 `COMPOSIO_API_KEY`、`PIPEDREAM_CLIENT_ID`、`PIPEDREAM_CLIENT_SECRET`、`PIPEDREAM_PROJECT_ID`、`PIPEDREAM_ENVIRONMENT` 读取环境兜底。
- `.env.example`：上述变量的样例位置。

结论：内置 Gmail/Calendar 的 provider 配置里没有 base URL 或 endpoint 字段，Rakazo 代码也没有读取相关覆盖项。仅靠现有配置无法把内置请求指到 4312/4313；要改只能改适配器，或改走下面的 installed OpenAPI 路径。

### 可改道：installed OpenAPI 工具源

Rakazo 支持把本地 OpenAPI 文档安装成工具源，这条路径可以指向 4312/4313：

- `packages/adapters/src/installed-connectors.ts`：`prepareApiInstall` 会读取 OpenAPI 文档，取 `servers[0].url` 作为 base URL，并把每个带 `operationId` 的 operation 转成工具。
- `apps/api/src/routes/mcp.ts`：`capabilities/install` 对 `kind: "api"` 调用 `prepareApiInstall`，并传入 `allowPrivateEndpoint: mayUsePrivateEndpoint(deps)`。
- `apps/api/src/mcp-servers.ts`：`mayUsePrivateEndpoint` 只在 `env.mcpAllowPrivateEndpoint === true` 时放行。
- `apps/api/src/env.ts`：`MCP_ALLOW_PRIVATE_ENDPOINT=true` 打开该开关。
- `apps/api/src/app.ts`：把 `env.mcpAllowPrivateEndpoint` 传给 `InstalledConnectorProvider`。
- `apps/web/src/pages/PluginsOverlay.tsx`：Plugins 里的 **Add OpenAPI** 表单，提交 `kind: "api"`、OpenAPI 文档 URL、`{ openApi: true, auth: { type: "none" } }`。
- `packages/contracts/src/rpc.ts`：`capabilities/install` 的 `kind` 枚举包含 `api`，输入为 `name`、`source`、`config`、可选 `credential`。
- `docs/self-host.md`：说明 installed API/MCP 源默认只允许公网 HTTPS，本地源需要 `MCP_ALLOW_PRIVATE_ENDPOINT=true`。

两个假服务已经各自提供 `/openapi.json`；`servers[0].url` 默认跟随请求的 `Host`（本机是 `127.0.0.1`，从容器里用 `host.docker.internal` 拉取时会写成该地址），也可以用 `PUBLIC_BASE_URL` 覆盖。operationId 已按 `GMAIL_*`、`GOOGLECALENDAR_*` 命名。使用步骤：

1. API 和 worker 都设置 `MCP_ALLOW_PRIVATE_ENDPOINT=true` 并重启。
2. 在 Plugins 里 Add OpenAPI，填 `http://127.0.0.1:4312/openapi.json` 或 `http://127.0.0.1:4313/openapi.json`，认证选 None。
3. 确认对应 Bot 能看到这些工具（必要时在 Bot 的工具/集成设置里启用），工具列表里应出现 `GMAIL_SEND_EMAIL`、`GOOGLECALENDAR_CREATE_EVENT` 等名字。

工具名可以按 operationId 对齐，但参数以安装的 OpenAPI schema 为准：假 Gmail 的 `POST /send` 用 `to`、`cc`、`subject`、`body`（同时接受 `recipient_email`），假日历用 `start`、`end`。如果评测要沿用 Composio 的 `recipient_email`、`start_datetime`、`event_duration_minutes` 等参数，需要改 OpenAPI schema 或在中间层做映射。

注意：如果 Rakazo 的 API/worker 跑在 Docker 里，容器里的 `127.0.0.1` 不是宿主机；需要把假服务改成监听可达地址（例如 `0.0.0.0`），并把 OpenAPI 的 `servers[0].url` 改成 `host.docker.internal` 或宿主机局域网地址。

### 没找到的部分

- 没有找到 Gmail/Calendar 专用的 base URL 环境变量，也没有 `COMPOSIO_BASE_URL`、`PIPEDREAM_BASE_URL` 之类的覆盖项。
- 没有找到 Rakazo 内置的本地 Gmail/Calendar 假适配器；现有本地假服务只在 `packages/testkit` 的评测夹具里，不是可配置 provider。
- 本轮没有启动 Rakazo、没有执行 `capabilities/install`，所以“installed OpenAPI 指向 4312/4313”只做了代码路径确认，还没有产品侧端到端验证。

### 结论

- 内置 Gmail/Calendar：**不能**通过配置改到本地 4312/4313，除非改 `composio-connector.ts` / `pipedream-connector.ts` 或 provider 配置 schema。
- 评测用法：走 **installed OpenAPI**，开 `MCP_ALLOW_PRIVATE_ENDPOINT=true`，安装两个 `/openapi.json`。这条路径不改 Rakazo 代码，工具名可通过 operationId 对齐审批规则。
