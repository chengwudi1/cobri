export const RESET_SERVICES = [
  {
    key: "competitor",
    name: "竞品站",
    baseUrl: "http://127.0.0.1:4310",
    resetPath: "/__reset",
    cleanFallback: "pricing.json",
  },
  {
    key: "portal",
    name: "客户门户",
    baseUrl: "http://127.0.0.1:4311",
    resetPath: "/__reset",
    cleanFallback: "login-page",
  },
  {
    key: "gmail",
    name: "假 Gmail",
    baseUrl: "http://127.0.0.1:4312",
    resetPath: "/__reset",
  },
  {
    key: "calendar",
    name: "假日历",
    baseUrl: "http://127.0.0.1:4313",
    resetPath: "/__reset",
  },
];

const group = (name, mentions = []) => ({ kind: "group", name, mentions });
const bot = (name) => ({ kind: "bot", name });

const GROUP_APIS = [
  "POST /rpc/groups/list",
  "POST /rpc/threads/send",
  "POST /rpc/runs/list",
  "POST /rpc/threads/get",
];
const BOT_APIS = [
  "POST /rpc/bots/list",
  "POST /rpc/threads/send",
  "POST /rpc/runs/list",
  "POST /rpc/threads/get",
];

const model = (description) => ({ kind: "model", description });

export const CASES = [
  {
    id: "01",
    category: "群聊与委派",
    title: "群聊 @ 路由：两个 Bot 各自接活",
    target: group("工作助理团队", ["日程", "研究"]),
    input:
      "@日程 查一下下周四下午三点到五点我有没有冲突；@研究 同时给我远山科技最近一个月的融资和产品动态。",
    expected:
      "同一群 transcript 出现两条带 Bot 名称的回复；日程指出 15:00-16:00 与产品评审冲突、16:00 后可用；研究给出种子事实；未被 @ 的总管不回复。",
    assertions: [
      {
        kind: "rpc",
        ref: "threads/send",
        description: "群消息返回的 runIds 恰好 2 条。",
      },
      {
        kind: "rpc",
        ref: "runs/list",
        description:
          "两条 run 分别属于日程和研究，trigger=user、status=completed；没有总管的 run。",
      },
      {
        kind: "rpc",
        ref: "threads/get",
        description:
          "两条 bot 消息的 botId 正确；日程文本含产品评审和 15:00-16:00；研究文本含竞品种子事实。",
      },
      {
        kind: "fixture",
        ref: "calendar",
        description: "日程 run 有日历读取记录。",
      },
      {
        kind: "fixture",
        ref: "competitor",
        description: "研究 run 有竞品页读取记录（browser_* 或 web_fetch）。",
      },
      model("以上回复和工具选择依赖真实模型；无模型时本条 unqualified。"),
    ],
    tools: ["GOOGLECALENDAR_LIST_EVENTS", "web_fetch / browser_*", "群 @ 路由"],
    apis: [...GROUP_APIS],
    requiresModel: true,
  },
  {
    id: "02",
    category: "群聊与委派",
    title: "群内交接链：总管 → 研究 → 日程",
    target: group("工作助理团队", ["总管"]),
    input:
      "把远山科技下周四下午四点的客户会安排一下：研究先查对方最近的情况和参会人背景，日程再按结果给出议程和提前准备清单，先别写日历。",
    expected:
      "群里出现总管→研究、研究→日程两条可见交接；日程最后给出议程和准备清单；日历没有新增或修改。",
    assertions: [
      {
        kind: "rpc",
        ref: "threads/get",
        description:
          "两条 handoff block：总管→研究 hop=1，研究→日程 hop=2；没有反向交接。",
      },
      {
        kind: "rpc",
        ref: "runs/list",
        description:
          "目标 run 的 trigger=follow_up、botId 正确、均 completed；交接链 hop 不超过 6。",
      },
      {
        kind: "rpc",
        ref: "threads/get",
        description: "日程最终消息含 11-05 16:00 的议程与准备清单。",
      },
      {
        kind: "fixture",
        ref: "calendar",
        description: "假日历事件数保持 1 条，没有提前写入。",
      },
      model("交接链依赖模型调用 handoff_to_bot；无模型时本条 unqualified。"),
    ],
    tools: ["handoff_to_bot / message_bot", "GOOGLECALENDAR_LIST_EVENTS", "web_*"],
    apis: [...GROUP_APIS],
    requiresModel: true,
  },
  {
    id: "03",
    category: "群聊与委派",
    title: "跨 Bot 私聊委派与结果回传",
    target: bot("总管"),
    input: "让收件箱 Bot 把今天必须我亲自回的邮件挑出来，整理好直接发给我。",
    expected:
      "总管线程出现已发给收件箱的 peer receipt 和最终汇总；收件箱线程出现来自总管的任务与结果。",
    assertions: [
      {
        kind: "rpc",
        ref: "threads/get",
        description:
          "总管线程有 bot_message_sent（toBotId=收件箱、intent=request）；收件箱线程有 bot_message_received 和 trigger=bot_message 的 run。",
      },
      {
        kind: "rpc",
        ref: "threads/get",
        description:
          "收件箱 run 调用 GMAIL_LIST_MESSAGES；结果包含远山会邀和王总报价审批，不含行业周报/午餐。",
      },
      {
        kind: "rpc",
        ref: "threads/get",
        description: "总管最终回复引用收件箱返回的列表，不是只写已转告。",
      },
      {
        kind: "fixture",
        ref: "gmail",
        description: "假 Gmail 保持 5 封种子邮件且没有新增发送记录。",
      },
      model("跨 Bot 委派依赖模型调用 message_bot；无模型时本条 unqualified。"),
    ],
    tools: ["message_bot", "GMAIL_LIST_MESSAGES"],
    apis: [...BOT_APIS],
    requiresModel: true,
  },
  {
    id: "04",
    category: "独立电脑",
    title: "研究 Bot 用自己的浏览器做竞品速报",
    target: bot("研究"),
    input:
      "把云图智能官网的定价页和最近三条更新日志做成一份带链接的竞品速报，存在你自己的电脑里，别放到共享目录。",
    expected:
      "研究 Bot 的电脑里能看到浏览器访问竞品页；research/ 下出现带链接的速报；shared/ 里没有该文件。",
    assertions: [
      {
        kind: "rpc",
        ref: "computer/readFile",
        description:
          "读到 bots/<researchId>/research/yuntu-brief-2026-10-27.md，内容含团队版 199、企业版 399、3 条日志和来源链接。",
      },
      {
        kind: "rpc",
        ref: "computer/files",
        description: "shared/ 列表没有该速报；研究 Bot 有独立 browser profile。",
      },
      {
        kind: "rpc",
        ref: "threads/get",
        description: "研究 run 至少有一次 browser_navigate/browser_snapshot 或 computer_observe/act。",
      },
      model("浏览器调研和产物写入依赖模型；无模型时本条 unqualified。"),
    ],
    tools: ["browser_navigate / browser_snapshot", "write_file", "computer/readFile"],
    apis: [...BOT_APIS, "POST /rpc/computer/readFile", "POST /rpc/computer/files"],
    requiresModel: true,
  },
  {
    id: "05",
    category: "独立电脑",
    title: "共享目录交接，草稿留在自己 home",
    target: bot("收件箱"),
    input:
      "把远山科技这封会邀里的时间、参会人、待确认事项整理到团队共享目录 meeting/yuanshan-2026-11-05.md，原始邮件摘录存到你自己的 notes/ 里。",
    expected:
      "总管和日程都能读到 shared/meeting/yuanshan-2026-11-05.md；原始邮件摘录只在收件箱 Bot 的 notes/；shared 文档不含整封邮件原文。",
    assertions: [
      {
        kind: "rpc",
        ref: "computer/readFile",
        description:
          "收件箱读 shared 路径成功，内容含 11-05 16:00、李总/王总、待确认事项；总管读同一路径成功。",
      },
      {
        kind: "rpc",
        ref: "computer/files",
        description:
          "shared 列表包含会议文档；原始邮件摘录位于 bots/<inboxId>/notes/，不在 shared。",
      },
      {
        kind: "rpc",
        ref: "threads/get",
        description: "收件箱 run completed，并有两条 write_file 的 computer.command。",
      },
      model("目录整理依赖模型规划写文件；无模型时本条 unqualified。"),
    ],
    tools: ["write_file", "read_file / list_files", "Team Computer shared/"],
    apis: [...BOT_APIS, "POST /rpc/computer/readFile", "POST /rpc/computer/files"],
    requiresModel: true,
  },
  {
    id: "06",
    category: "独立电脑",
    title: "独立登录态：同一门户，两个 Bot 互不可见",
    target: group("工作助理团队", ["收件箱", "日程"]),
    input: "@收件箱 登录客户门户看一下未读消息；@日程 也打开同一个门户确认一下登录状态。",
    expected:
      "收件箱页面显示已登录账号与 3 条未读；日程看到登录页，看不到收件箱账号；收件箱重开后仍登录。",
    assertions: [
      {
        kind: "rpc",
        ref: "threads/get",
        description:
          "两个 run 各自有浏览器访问同一 portal 的记录；收件箱 snapshot 含 Signed in as inbox@demo.test 与 3 条未读。",
      },
      {
        kind: "rpc",
        ref: "computer/status",
        description:
          "日程 snapshot 是登录页（Sign in），不含收件箱账号；两个 Bot 的 browser profile 不同。",
      },
      {
        kind: "fixture",
        ref: "portal",
        description: "收件箱重开后仍保持登录；会话不串到日程。",
      },
      model("浏览器登录态检查依赖模型操作电脑；无模型时本条 unqualified。"),
    ],
    tools: ["browser_navigate / browser_snapshot", "computer/status", "客户门户 fixture"],
    apis: [...GROUP_APIS, "POST /rpc/computer/status"],
    requiresModel: true,
  },
  {
    id: "07",
    category: "审批门",
    title: "邮件发送审批：批准前零发送",
    target: bot("总管"),
    input:
      "给远山科技的李总发会议确认邮件：下周四下午四点，议题是续约报价，抄送王总。",
    expected:
      "出现审批卡，显示收件人、抄送、主题、正文、11-05 16:00；批准前发件箱为空；Allow once 后只发一封。",
    assertions: [
      {
        kind: "rpc",
        ref: "threads/get",
        description:
          "ask block 有 approvalEffectId、status=pending；run waiting_input；external_effects.status=intended。",
      },
      {
        kind: "fixture",
        ref: "gmail",
        description: "审批前 sent 为 0；Allow once 后 sent 恰好 1，收件人/抄送/主题/正文匹配。",
      },
      {
        kind: "rpc",
        ref: "threads/answer",
        description:
          "回答 allow 后 ask status=answered/answer=allow，effect 从 approved 到 completed，刷新不重复发送。",
      },
      model("审批卡内容和工具调用依赖模型；无模型时本条 unqualified。"),
    ],
    tools: ["GMAIL_SEND_EMAIL", "approval card", "threads/answer"],
    apis: [...BOT_APIS, "POST /rpc/threads/answer"],
    requiresModel: true,
  },
  {
    id: "08",
    category: "审批门",
    title: "日历写入审批：拒绝后零副作用",
    target: bot("日程"),
    input: "在日历上新建下周四下午四点和远山科技李总的续约会议，邀请李总和王总。",
    expected:
      "出现日历创建审批卡，显示标题、11-05 16:00、Asia/Shanghai、两位参会人；Deny 后日历无事件、无通知。",
    assertions: [
      {
        kind: "rpc",
        ref: "threads/get",
        description:
          "ask block 对应 GOOGLECALENDAR_CREATE_EVENT；run waiting_input；假日历事件数不变。",
      },
      {
        kind: "rpc",
        ref: "threads/answer",
        description:
          "Deny 后 ask answered/deny，effect denied，run 进入终态，不自动重试。",
      },
      {
        kind: "fixture",
        ref: "calendar",
        description:
          "假日历仍只有 evt-1；假邮箱没有通知；start 按 Asia/Shanghai 解析为 2026-11-05T16:00:00+08:00。",
      },
      model("日历审批依赖模型调用日历工具；无模型时本条 unqualified。"),
    ],
    tools: ["GOOGLECALENDAR_CREATE_EVENT", "approval card", "threads/answer"],
    apis: [...BOT_APIS, "POST /rpc/threads/answer"],
    requiresModel: true,
  },
  {
    id: "09",
    category: "审批门",
    title: "审批暂停恢复 + 恰好一次",
    target: bot("总管"),
    input: "把远山合同的金额备注写进 CRM，然后把这版报价发邮件给李总；两件事都做成。",
    expected:
      "先出现 CRM 备注审批，刷新后仍在；批准后只写一条备注；随后邮件审批，批准后只发一封；再次刷新计数不变。",
    assertions: [
      {
        kind: "rpc",
        ref: "threads/get",
        description:
          "第一次审批前 notes=0、sent=0；external_effects=intended；run waiting_input。",
      },
      {
        kind: "rpc",
        ref: "threads/get",
        description:
          "刷新后同一 messageId/runId 的 ask 仍在，run 仍 waiting_input，没有新 task/run。",
      },
      {
        kind: "rpc",
        ref: "threads/answer",
        description:
          "依次 allow 后 CRM note 恰好 1 条、邮件恰好 1 封；每条 effect 只 completed 一次，idempotencyKey 唯一。",
      },
      {
        kind: "fixture",
        ref: "gmail",
        description: "再次刷新后 sent 仍为 1，没有第二封。",
      },
      model("审批恢复依赖模型完成多个外部写；无模型时本条 unqualified。"),
    ],
    tools: ["CRM_CREATE_NOTE", "GMAIL_SEND_EMAIL", "approval card", "threads/answer"],
    apis: [...BOT_APIS, "POST /rpc/threads/answer"],
    requiresModel: true,
    blockers: ["CRM 假服务未安装：当前只装了 Gmail 和 Calendar，CRM_CREATE_NOTE 不可用。"],
  },
  {
    id: "10",
    category: "定时任务",
    title: "每日收件箱简报",
    target: bot("收件箱"),
    input: "每天早上 8:30 给我一份收件箱简报，只列今天需要我处理或回的邮件和截止时间。",
    expected:
      "routine 列表出现每天 8:30 的任务；强制 wake 后收件箱对话出现简报，含远山会邀、INV-42、王总报价审批及截止时间，不含周报/午餐。",
    assertions: [
      {
        kind: "rpc",
        ref: "routines/list",
        description:
          "active=true、crons 恰为 30 8 * * *、timezone=Asia/Shanghai、nextRunAt 非空且落在 8:30。",
      },
      {
        kind: "rpc",
        ref: "routines/history",
        description:
          "testRun 返回 runId，history 到 completed；runs trigger=routine、routineId 对应，run 内调用 GMAIL_LIST_MESSAGES。",
      },
      {
        kind: "fixture",
        ref: "gmail",
        description:
          "简报含 m1/m2/m3 的截止时间，不含 m4/m5；没有发送类写；一次 wake 只产生一条简报。",
      },
      model("routine 创建和简报生成依赖模型；无模型时本条 unqualified。"),
    ],
    tools: ["routines/create", "routines/testRun", "routines/history", "GMAIL_LIST_MESSAGES"],
    apis: [
      ...BOT_APIS,
      "POST /rpc/routines/list",
      "POST /rpc/routines/testRun",
      "POST /rpc/routines/history",
    ],
    requiresModel: true,
  },
  {
    id: "11",
    category: "定时任务",
    title: "竞品变化监控：无变化保持静默",
    target: bot("研究"),
    input: "盯着云图智能的定价页和更新日志，每小时看一次；有变化就发我，没变化别打扰我。",
    expected:
      "routine 显示有变化时检查；第一次无变化不发言；改成 229 并新增审计日志后第二次发一条；第三次不重复。",
    assertions: [
      {
        kind: "rpc",
        ref: "routines/list",
        description:
          "watch 的 kind 为 command/files、everyMinutes=60、active=true、crons 为空、notify=true。",
      },
      {
        kind: "rpc",
        ref: "routines/history",
        description:
          "第一次 wake completed 且该 runId 没有非 steps 的 bot 消息；第二次 wake 有 199→229 和审计日志；第三次不再发。",
      },
      {
        kind: "fixture",
        ref: "competitor",
        description: "每次 wake 都有实际读取记录；跳读或读取失败不算无变化。",
      },
      model("watch routine 的创建和变化判断依赖模型；无模型时本条 unqualified。"),
    ],
    tools: ["routines/watch", "__fixture/mutate", "通知/静默判定"],
    apis: [
      ...BOT_APIS,
      "POST /rpc/routines/list",
      "POST /rpc/routines/testRun",
      "POST /rpc/routines/history",
      "POST http://127.0.0.1:4310/__fixture/mutate",
    ],
    requiresModel: true,
  },
  {
    id: "12",
    category: "记忆",
    title: "记住客户偏好并在新会话使用",
    target: bot("总管"),
    input:
      "记住：远山科技的汇报一律用中文、一页纸摘要，所有会议按 Asia/Shanghai 排，称呼李总；以后别再问我。",
    turns: [
      "记住：远山科技的汇报一律用中文、一页纸摘要，所有会议按 Asia/Shanghai 排，称呼李总；以后别再问我。",
      "按老规矩给远山排下周四的会，先给我议程。",
    ],
    expected:
      "记忆里出现四条远山偏好；清空会话后第二轮直接给出中文一页纸议程，时间 11-05 16:00，称呼李总，不再追问。",
    assertions: [
      {
        kind: "rpc",
        ref: "memory/list",
        description:
          "scope=bot 或 user 的记忆含中文、一页纸、Asia/Shanghai、李总；有 sourceRunId 等记忆证据。",
      },
      {
        kind: "rpc",
        ref: "threads/clear",
        description:
          "清空后第二轮回复含 11-05 16:00、中文议程、李总，没有语言/时区/称呼追问。",
      },
      {
        kind: "rpc",
        ref: "memory/list",
        description: "另一个 Bot 或另一个 workspace 不含这份远山偏好。",
      },
      model("记忆写入和新会话使用依赖模型；无模型时本条 unqualified。"),
    ],
    tools: ["memory tools", "threads/clear", "memory/list"],
    apis: [...BOT_APIS, "POST /rpc/threads/clear", "POST /rpc/memory/list"],
    requiresModel: true,
  },
];

export const SMOKE = {
  id: "smoke",
  category: "冒烟",
  title: "登录 + 重置 + 直接读假 Gmail/Calendar 状态",
  input: "不发送群消息，不调用模型。",
  expected:
    "5180 登录成功；四个假服务重置调用完成；Gmail 有 m1-m5 且 sent=0；日历只有 evt-1；竞品站为 199/3 条；门户未登录时是登录页。",
  assertions: [
    { kind: "rpc", ref: "bots/list", description: "会话有效，能读到四个 Bot。" },
    { kind: "rpc", ref: "groups/list", description: "群「工作助理团队」存在且含四个 Bot。" },
    { kind: "fixture", ref: "gmail", description: "messages.length=5（m1-m5），sent=0。" },
    { kind: "fixture", ref: "calendar", description: "events.length=1，evt-1 是产品评审。" },
    { kind: "fixture", ref: "competitor", description: "pricing.json 是 199/3 条。" },
    { kind: "fixture", ref: "portal", description: "/ 是登录页，/inbox 未登录 302。" },
  ],
  requiresModel: false,
};
