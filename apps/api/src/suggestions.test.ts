import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterContext } from "./routes/context.js";
import { suggestionsRoutes } from "./routes/suggestions.js";

const sendThreadMessage = vi.hoisted(() => vi.fn(async () => ({ runId: "run-1" })));
const resolveThreadTarget = vi.hoisted(() =>
  vi.fn(async () => ({ kind: "bot", botId: "bot-inbox", threadId: "thread-1" })),
);
vi.mock("./thread-target.js", () => ({ sendThreadMessage, resolveThreadTarget }));

const actor = { spaceId: "space-1", userId: "user-1" };
const bots = [
  { id: "bot-inbox", name: "收件箱", color: "#111111" },
  { id: "bot-calendar", name: "日程", color: "#222222" },
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
  title: string;
  status: string;
  runId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

let rows: Row[];
let prisma: any;

function key(row: Pick<Row, "spaceId" | "userId" | "source" | "botId" | "title">) {
  return [row.spaceId, row.userId, row.source, row.botId, row.title].join("|");
}

function matches(row: Row, where: Record<string, unknown>) {
  return Object.entries(where).every(([field, value]) => row[field] === value);
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
  sendThreadMessage.mockReset();
  sendThreadMessage.mockResolvedValue({ runId: "run-1" });
  resolveThreadTarget.mockReset();
  resolveThreadTarget.mockResolvedValue({
    kind: "bot",
    botId: "bot-inbox",
    threadId: "thread-1",
  });
});

function routes() {
  const handler = (fn: (input: unknown) => unknown) => ({ handler: fn });
  const authed = {
    suggestions: {
      list: { handler },
      generate: { handler },
      accept: { handler },
      ignore: { handler },
    },
  };
  return suggestionsRoutes({ deps: { prisma }, authed } as unknown as RouterContext);
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
