// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const suggestionRpc = vi.hoisted(() => ({
  generate: vi.fn(),
  accept: vi.fn(),
  ignore: vi.fn(),
}));
const state = vi.hoisted(() => ({
  bootstrap: null as any,
  active: { runs: [] as any[] },
  recent: { runs: [] as any[] },
  usage: null as any,
  suggestions: [] as any[],
  computers: {} as Record<string, any>,
  activeMode: "resolve" as "resolve" | "pending" | "reject",
  recentMode: "resolve" as "resolve" | "pending" | "reject",
  activeCalls: 0,
  recentCalls: 0,
}));

vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    bootstrap: {
      queryOptions: () => ({
        queryKey: ["bootstrap"],
        queryFn: async () => state.bootstrap,
      }),
    },
    runs: {
      list: {
        queryOptions: ({ input }: { input: { filter: "active" | "recent" } }) => ({
          queryKey: ["runs", input.filter],
          queryFn: async () => {
            if (input.filter === "active") {
              state.activeCalls += 1;
              if (state.activeMode === "pending") return new Promise(() => {});
              if (state.activeMode === "reject") throw new Error("active failed");
              return state.active;
            }
            state.recentCalls += 1;
            if (state.recentMode === "pending") return new Promise(() => {});
            if (state.recentMode === "reject") throw new Error("recent failed");
            return state.recent;
          },
        }),
      },
    },
    usage: {
      summary: {
        queryOptions: () => ({ queryKey: ["usage"], queryFn: async () => state.usage }),
      },
    },
    suggestions: {
      list: {
        queryOptions: () => ({
          queryKey: ["suggestions"],
          queryFn: async () => state.suggestions,
        }),
      },
    },
    computer: {
      status: {
        queryOptions: ({ input }: { input: { botId: string } }) => ({
          queryKey: ["computer", input.botId],
          queryFn: async () => state.computers[input.botId],
        }),
      },
    },
  }),
}));
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "just now" }));
vi.mock("../lib/user-error", () => ({ errorText: (error: unknown) => String(error) }));
vi.mock("../lib/space-rpc", () => ({
  useSpaceRpc: () => ({ suggestions: suggestionRpc }),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children?: ReactNode }) => children };
});
vi.mock("../components/PageLoading", () => ({
  PageLoading: () => <div data-testid="page-loading" />,
}));
vi.mock("./ActivityList", () => ({ statusTone: () => "text-success" }));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Badge: Container,
    BotAvatar: () => <span data-testid="bot-avatar" />,
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    Card: Container,
    CardContent: Container,
    CardHeader: Container,
    CardTitle: Container,
    Skeleton: (props: ComponentProps<"div">) => <div {...props} />,
    Spinner: (props: ComponentProps<"svg">) => <svg role="status" {...props} />,
    cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
  };
});

import { OverviewPage } from "./Overview";

const PRIMARY_GROUP_ID = "cmvqvgu05000sbcaf6cojvz47";

function bot(id: string, name: string) {
  return {
    id,
    name,
    title: `${name}职责`,
    color: "#3366ff",
    status: "idle",
    modelProvider: null,
    modelId: null,
  };
}

function run(id: string, botId: string, botName: string, status: string) {
  return {
    runId: id,
    botId,
    botName,
    groupId: null,
    groupName: null,
    threadId: `thread-${id}`,
    status,
    trigger: "user",
    notificationsEnabled: true,
    promptSnippet: "摘要",
    agentMessage: null,
    updatedAt: new Date().toISOString(),
  };
}

const primaryBots = [
  bot("bot-chief", "总管"),
  bot("bot-research", "研究"),
  bot("bot-inbox", "收件箱"),
  bot("bot-calendar", "日程"),
];

function primaryBootstrap() {
  return {
    groups: [
      {
        id: "eval-group",
        name: "评测组",
        members: [{ botId: "bot-eval", name: "评测 Bot", color: "#999999" }],
      },
      {
        id: PRIMARY_GROUP_ID,
        name: "主团队",
        members: primaryBots.map((item) => ({
          botId: item.id,
          name: item.name,
          color: item.color,
        })),
      },
    ],
    bots: [...primaryBots, bot("bot-eval", "评测 Bot")],
    routines: [],
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.bootstrap = primaryBootstrap();
  state.active = { runs: [run("run-waiting", "bot-research", "研究", "waiting_input")] };
  state.recent = { runs: [run("run-done", "bot-chief", "总管", "completed")] };
  state.usage = {
    runs: 99,
    modelCalls: 7,
    costUsd: 0.0013,
    models: [{ provider: "deepseek", model: "deepseek-flash" }],
  };
  state.suggestions = [];
  suggestionRpc.generate.mockReset();
  suggestionRpc.accept.mockReset();
  suggestionRpc.ignore.mockReset();
  state.computers = Object.fromEntries(
    primaryBots.map((item) => [item.id, { state: "stopped", mode: "dedicated" }]),
  );
  state.activeMode = "resolve";
  state.recentMode = "resolve";
  state.activeCalls = 0;
  state.recentCalls = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function renderPage() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/app/overview"]}>
          <OverviewPage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

it("renders the primary group's bots, model calls and accessible run table", async () => {
  await renderPage();
  expect(container.textContent).toContain("主团队");
  for (const item of primaryBots) expect(container.textContent).toContain(item.name);
  expect(container.textContent).not.toContain("评测 Bot");
  expect(container.textContent).toContain("7 model calls");
  expect(container.textContent).not.toContain("99 model calls");
  const headers = [...container.querySelectorAll("th")];
  expect(headers).toHaveLength(5);
  expect(headers.every((header) => header.getAttribute("scope") === "col")).toBe(true);
  expect(container.textContent).toContain("Not provided");
  expect(container.querySelector('[title="接口未返回运行起止时间"]')).toBeNull();
});

it("shows loading state instead of zeros or empty text while runs load", async () => {
  state.activeMode = "pending";
  state.recentMode = "pending";
  await renderPage();
  expect(container.querySelectorAll('[data-testid="stat-loading"]').length).toBeGreaterThanOrEqual(
    2,
  );
  expect(container.textContent).toContain("Loading…");
  expect(container.textContent).not.toContain("Nothing pending");
  expect(container.textContent).not.toContain("No recent runs");
});

it("keeps run errors visible and retries them", async () => {
  state.activeMode = "reject";
  state.recentMode = "reject";
  await renderPage();
  expect(container.textContent).toContain("Run data unavailable");
  const retries = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Try again",
  );
  expect(retries.length).toBeGreaterThanOrEqual(2);
  const before = state.activeCalls + state.recentCalls;
  await act(async () => retries[0]!.click());
  await settle();
  expect(state.activeCalls + state.recentCalls).toBeGreaterThan(before);
});

it("dispatches and ignores a suggestion from the overview card", async () => {
  state.suggestions = [
    {
      id: "suggestion-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-inbox",
      botName: "收件箱",
      botColor: "#3366ff",
      source: "gmail",
      title: "确认：远山科技客户会邀",
      rationale: "李总发来的会邀需要确认。",
      instruction: "检查并准备回复草稿。",
      status: "pending",
      runId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  suggestionRpc.accept.mockResolvedValue({});
  suggestionRpc.ignore.mockResolvedValue({});
  await renderPage();
  await settle();

  const card = container.querySelector('[data-testid="suggestion-card"]');
  expect(card).not.toBeNull();
  const hand = [...card!.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Hand to"),
  );
  expect(hand?.textContent).toContain("收件箱");
  await act(async () => hand!.click());
  await settle();
  expect(suggestionRpc.accept).toHaveBeenCalledWith({ id: "suggestion-1" });

  const ignore = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Ignore",
  );
  await act(async () => ignore!.click());
  await settle();
  expect(suggestionRpc.ignore).toHaveBeenCalledWith({ id: "suggestion-1" });
});

it("shows an empty state when the primary group is missing", async () => {
  state.bootstrap = {
    groups: [
      {
        id: "eval-group",
        name: "评测组",
        members: [{ botId: "bot-eval", name: "评测 Bot", color: "#999999" }],
      },
    ],
    bots: [bot("bot-eval", "评测 Bot")],
    routines: [],
  };
  await renderPage();
  expect(container.textContent).toContain("Demo main group not found");
  expect(container.textContent).not.toContain("评测 Bot");
});
