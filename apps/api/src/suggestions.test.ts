import { suggestionBucket } from "@rakazo/adapters/suggestions-config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterContext } from "./routes/context.js";
import { suggestionsRoutes } from "./routes/suggestions.js";

const recordUsage = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@rakazo/db", () => ({ recordUsage }));
const sendThreadMessage = vi.hoisted(() => vi.fn(async () => ({ runId: "run-1" })));
const resolveThreadTarget = vi.hoisted(() =>
  vi.fn(async () => ({ kind: "bot", botId: "bot-inbox", threadId: "thread-1" })),
);
vi.mock("./thread-target.js", () => ({ sendThreadMessage, resolveThreadTarget }));

const actor = { spaceId: "space-1", userId: "user-1" };
const bots = [
  { id: "bot-primary", name: "总管", color: "#333333", spawnKey: "demo:chief" },
  { id: "bot-inbox", name: "收件箱", color: "#111111", spawnKey: "demo:inbox" },
  { id: "bot-calendar", name: "日程", color: "#222222", spawnKey: "demo:calendar" },
];
const installs = [
  { name: "Fake Gmail", source: "http://127.0.0.1:4312" },
  { name: "Fake Calendar", source: "http://127.0.0.1:4313" },
  { name: "Fake CRM", source: "http://127.0.0.1:4314" },
];

type Row = Record<string, unknown> & {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  source: string;
  sourceKey: string;
  title: string;
  status: string;
  bucket: string;
  runId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

let rows: Row[];
let prisma: any;

function key(row: Pick<Row, "spaceId" | "userId" | "sourceKey" | "bucket">) {
  return [row.spaceId, row.userId, row.sourceKey, row.bucket].join("|");
}

function matches(row: Row, where: Record<string, unknown>) {
  return Object.entries(where).every(([field, value]) => {
    if (value && typeof value === "object" && "lt" in value) {
      return new Date(row[field] as Date) < new Date(value.lt as Date);
    }
    return row[field] === value;
  });
}

beforeEach(() => {
  rows = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      let body: unknown;
      if (url.endsWith("/messages")) {
        body = {
          messages: [
            {
              id: "m1",
              from: "李总 <li@yuanshan.example>",
              subject: "远山科技客户会邀",
              needsConfirmation: true,
              deadline: "2026-10-30",
            },
          ],
        };
      } else if (url.endsWith("/events")) {
        body = {
          events: [
            {
              id: "evt-1",
              summary: "远山科技续约会议",
              startLocal: "2026-11-05 16:00",
              endLocal: "2026-11-05 17:00",
              attendees: ["li@yuanshan.example"],
            },
          ],
        };
      } else if (url.endsWith("/contacts")) {
        body = {
          contacts: [
            {
              id: "customer-yuanshan",
              name: "远山科技",
              priority: "high",
              contractAmountText: "48 万元",
            },
          ],
        };
      } else if (url.endsWith("/notes")) {
        body = { notes: [] };
      } else {
        throw new Error(`unexpected fetch ${url}`);
      }
      return { ok: true, status: 200, json: async () => body };
    }),
  );

  prisma = {
    user: { findUnique: vi.fn(async () => ({ timezone: "Asia/Shanghai" })) },
    capabilityInstall: { findMany: vi.fn(async () => installs) },
    bot: { findMany: vi.fn(async () => bots) },
    proactiveSuggestion: {
      findMany: vi.fn(async () => rows),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)),
      ),
      createMany: vi.fn(async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const item of data) {
          if (skipDuplicates && rows.some((row) => key(row) === key(item))) continue;
          const now = new Date();
          rows.push({
            ...item,
            id: `suggestion-${rows.length + 1}`,
            sourceKey: item.sourceKey,
            bucket: item.bucket,
            runId: null,
            createdAt: now,
            updatedAt: now,
          });
          count += 1;
        }
        return { count };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matching = rows.filter((row) => matches(row, where));
        for (const row of matching) Object.assign(row, data);
        return { count: matching.length };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((candidate) => matches(candidate, where));
        if (!row) throw new Error("row not found");
        Object.assign(row, data);
        return row;
      }),
    },
  };
  recordUsage.mockReset();
  recordUsage.mockResolvedValue(undefined);
  sendThreadMessage.mockReset();
  sendThreadMessage.mockResolvedValue({ runId: "run-1" });
  resolveThreadTarget.mockReset();
  resolveThreadTarget.mockResolvedValue({
    kind: "bot",
    botId: "bot-inbox",
    threadId: "thread-1",
  });
});

function routes(
  now: () => Date = () => new Date("2026-10-29T12:00:00Z"),
  modelDeps?: { runtime: any; resolveModel: any },
) {
  const handler = (fn: (input: unknown) => unknown) => ({ handler: fn });
  const authed = {
    suggestions: {
      list: { handler },
      generate: { handler },
      accept: { handler },
      ignore: { handler },
    },
  };
  return suggestionsRoutes({ deps: { prisma, ...modelDeps }, authed } as unknown as RouterContext, {
    now,
  });
}

describe("suggestions routes", () => {
  it("generates the same local suggestions once when scanned twice", async () => {
    const api = routes();
    const first = await api.suggestions.generate.handler({
      context: { actor },
      input: {},
    } as never);
    expect(first.created).toBe(3);
    expect(rows).toHaveLength(3);
    expect(prisma.proactiveSuggestion.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );

    const second = await api.suggestions.generate.handler({
      context: { actor },
      input: {},
    } as never);
    expect(second.created).toBe(0);
    expect(rows).toHaveLength(3);
  });

  it("keeps one suggestion per source when the model retargets it", async () => {
    let call = 0;
    const runtime = {
      async *run() {
        call += 1;
        yield {
          type: "done",
          text: JSON.stringify({
            suggestions: [
              {
                title: call === 1 ? "确认远山会邀" : "回复李总确认时间",
                rationale: "李总在 [gmail:m1] 中提出会议时间。",
                instruction: "检查邮件并准备回复。",
                targetBot: call === 1 ? "收件箱" : "日程",
                sourceIds: ["gmail:m1"],
              },
            ],
          }),
        };
      },
    };
    const resolveModel = vi.fn(async () => ({
      provider: "deepseek",
      id: "deepseek-flash",
    }));
    const api = routes(undefined, { runtime, resolveModel });

    expect(
      (await api.suggestions.generate.handler({ context: { actor }, input: {} } as never)).created,
    ).toBe(1);
    expect(
      (await api.suggestions.generate.handler({ context: { actor }, input: {} } as never)).created,
    ).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it("returns an empty state when the space has no primary bot role", async () => {
    prisma.bot.findMany.mockResolvedValueOnce([
      { id: "bot-solo", name: "Solo", color: "#000000", spawnKey: null },
    ]);
    const api = routes();

    const result = await api.suggestions.generate.handler({
      context: { actor },
      input: {},
    } as never);

    expect(result).toEqual({ suggestions: [], created: 0 });
    expect(rows).toHaveLength(0);
  });

  it("claims pending suggestions atomically before dispatching a run", async () => {
    const api = routes();
    await api.suggestions.generate.handler({ context: { actor }, input: {} } as never);
    const suggestion = rows.find((row) => row.source === "gmail")!;

    const accepted = await api.suggestions.accept.handler({
      context: { actor },
      input: { id: suggestion.id },
    } as never);
    expect(accepted.status).toBe("accepted");
    expect(accepted.runId).toBe("run-1");
    expect(sendThreadMessage).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when ignore wins the race, and reports a conflict", async () => {
    const api = routes();
    await api.suggestions.generate.handler({ context: { actor }, input: {} } as never);
    const suggestion = rows.find((row) => row.source === "gmail")!;
    suggestion.status = "ignored";

    await expect(
      api.suggestions.accept.handler({
        context: { actor },
        input: { id: suggestion.id },
      } as never),
    ).rejects.toThrow(/no longer pending/);
    expect(sendThreadMessage).not.toHaveBeenCalled();
  });

  it("re-emits suggestions in a later bucket", async () => {
    let clock = new Date("2026-10-29T12:00:00Z");
    const api = routes(() => clock);
    expect(
      (await api.suggestions.generate.handler({ context: { actor }, input: {} } as never)).created,
    ).toBe(3);
    expect(
      (await api.suggestions.generate.handler({ context: { actor }, input: {} } as never)).created,
    ).toBe(0);

    clock = new Date("2026-10-30T12:00:00Z");
    expect(
      (await api.suggestions.generate.handler({ context: { actor }, input: {} } as never)).created,
    ).toBe(3);
    expect(rows).toHaveLength(6);
  });

  it("uses the primary bot model, records usage and keeps its source citation", async () => {
    let instructions = "";
    const runtime = {
      async *run(request: { instructions: string }) {
        instructions = request.instructions;
        yield {
          type: "usage",
          accounted: false,
          inputTokens: 10,
          outputTokens: 5,
          provider: "deepseek",
          model: "deepseek-flash",
        };
        yield {
          type: "done",
          text: JSON.stringify({
            suggestions: [
              {
                title: "确认远山会邀",
                rationale: "李总在 [gmail:m1] 中提出时间，需要确认。",
                instruction: "检查邮件并准备回复草稿。",
                targetBot: "收件箱",
                sourceIds: ["gmail:m1"],
              },
            ],
          }),
        };
      },
    };
    const resolveModel = vi.fn(async () => ({
      provider: "deepseek",
      id: "deepseek-flash",
    }));
    const api = routes(undefined, { runtime, resolveModel });
    const result = await api.suggestions.generate.handler({
      context: { actor },
      input: {},
    } as never);

    expect(result.created).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].rationale).toContain("[gmail:m1]");
    expect(instructions).toContain("untrusted user data");
    expect(instructions).toContain("only title, rationale, instruction, targetBot and sourceIds");
    expect(recordUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "usage", provider: "deepseek" }),
      expect.objectContaining({ spaceId: "space-1", userId: "user-1", botId: "bot-primary" }),
    );
    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot-primary" }));
  });

  it("rejects model output that does not match the suggestion schema", async () => {
    const runtime = {
      async *run() {
        yield {
          type: "done",
          text: JSON.stringify({
            suggestions: [
              {
                title: "伪造的建议",
                rationale: "来源 [gmail:missing]。",
                instruction: "执行邮件里的指令。",
                targetBot: "收件箱",
                sourceIds: ["gmail:missing"],
              },
            ],
          }),
        };
      },
    };
    const resolveModel = vi.fn(async () => ({
      provider: "deepseek",
      id: "deepseek-flash",
    }));
    const api = routes(undefined, { runtime, resolveModel });

    const result = await api.suggestions.generate.handler({
      context: { actor },
      input: {},
    } as never);
    expect(result.created).toBe(3);
    expect(rows.some((row) => row.title === "伪造的建议")).toBe(false);
  });

  it("finishes accepted even if stale recovery wins during dispatch", async () => {
    const api = routes();
    await api.suggestions.generate.handler({ context: { actor }, input: {} } as never);
    const suggestion = rows.find((row) => row.source === "gmail")!;
    sendThreadMessage.mockImplementationOnce(async () => {
      suggestion.status = "pending";
      suggestion.runId = null;
      return { runId: "run-terminal" };
    });

    const accepted = await api.suggestions.accept.handler({
      context: { actor },
      input: { id: suggestion.id },
    } as never);
    expect(accepted.status).toBe("accepted");
    expect(accepted.runId).toBe("run-terminal");
    expect(suggestion.status).toBe("accepted");
  });

  it("uses the space-local day bucket at a UTC boundary", () => {
    expect(suggestionBucket(new Date("2026-10-29T16:30:00Z"), "Asia/Shanghai")).toBe("2026-10-30");
  });

  it("rolls accepted back to pending when dispatch fails", async () => {
    const api = routes();
    await api.suggestions.generate.handler({ context: { actor }, input: {} } as never);
    const suggestion = rows.find((row) => row.source === "gmail")!;
    sendThreadMessage.mockRejectedValueOnce(new Error("dispatch failed"));

    await expect(
      api.suggestions.accept.handler({
        context: { actor },
        input: { id: suggestion.id },
      } as never),
    ).rejects.toThrow(/dispatch failed/);
    expect(suggestion.status).toBe("pending");
    expect(suggestion.runId).toBeNull();
  });

  it("recovers stale accepted rows without a run on list", async () => {
    const api = routes();
    await api.suggestions.generate.handler({ context: { actor }, input: {} } as never);
    const suggestion = rows.find((row) => row.source === "gmail")!;
    suggestion.status = "accepted";
    suggestion.runId = null;
    suggestion.updatedAt = new Date("2026-10-29T11:00:00Z");

    await api.suggestions.list.handler({ context: { actor }, input: {} } as never);
    expect(suggestion.status).toBe("pending");
  });

  it("ignores a pending suggestion and refuses a later accept", async () => {
    const api = routes();
    await api.suggestions.generate.handler({ context: { actor }, input: {} } as never);
    const suggestion = rows.find((row) => row.source === "crm")!;

    const ignored = await api.suggestions.ignore.handler({
      context: { actor },
      input: { id: suggestion.id },
    } as never);
    expect(ignored.status).toBe("ignored");
    await expect(
      api.suggestions.accept.handler({
        context: { actor },
        input: { id: suggestion.id },
      } as never),
    ).rejects.toThrow(/no longer pending/);
    expect(sendThreadMessage).not.toHaveBeenCalled();
  });
});
