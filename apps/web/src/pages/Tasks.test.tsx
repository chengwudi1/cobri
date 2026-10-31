// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  bootstrap: null as any,
  active: { runs: [] as any[] },
  recent: { runs: [] as any[] },
  artifacts: { items: [] as any[], nextCursor: null as string | null },
}));

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    bootstrap: {
      queryOptions: () => ({ queryKey: ["bootstrap"], queryFn: async () => state.bootstrap }),
    },
    runs: {
      list: {
        queryOptions: ({ input }: { input: { filter: "active" | "recent" } }) => ({
          queryKey: ["runs", input.filter],
          queryFn: async () => (input.filter === "active" ? state.active : state.recent),
        }),
      },
    },
    artifacts: {
      listSpace: {
        queryOptions: () => ({
          queryKey: ["artifacts"],
          queryFn: async () => state.artifacts,
        }),
      },
    },
  }),
}));
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "刚刚" }));
vi.mock("../lib/user-error", () => ({ errorText: (error: unknown) => String(error) }));

import { TasksPage } from "./Tasks";

const bot = {
  id: "bot-chief",
  name: "总管",
  color: "#D9508A",
  status: "idle",
};

function run(overrides: Record<string, unknown>) {
  return {
    runId: "run-1",
    botId: "bot-chief",
    botName: "总管",
    groupId: "group-1",
    groupName: "工作助理团队",
    threadId: "thread-1",
    status: "running",
    trigger: "user",
    notificationsEnabled: true,
    promptSnippet: "整理今天的待办",
    agentMessage: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: "artifact-1",
    botId: "bot-chief",
    groupId: "group-1",
    runId: "run-1",
    name: "团队周报.md",
    description: null,
    mimeType: "text/markdown",
    size: 2048,
    version: 1,
    createdAt: new Date().toISOString(),
    versionCount: 1,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  state.bootstrap = {
    bots: [bot],
    groups: [{ id: "group-1", archivedAt: null }],
  };
  state.active = {
    runs: [
      run({ runId: "run-doing", status: "running", promptSnippet: "整理今天的待办" }),
      run({ runId: "run-waiting", status: "waiting_input", promptSnippet: "发邮件给李总" }),
    ],
  };
  state.recent = {
    runs: [
      run({ runId: "run-handoff", status: "completed", trigger: "follow_up", promptSnippet: "来自研究的交接" }),
    ],
  };
  state.artifacts = { items: [artifact()], nextCursor: null };
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TasksPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

it("shows active work, approval blockers, handoffs and artifacts", async () => {
  await render();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (document.body.textContent?.includes("Doing now")) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  const text = document.body.textContent ?? "";
  expect(text).toContain("Doing now");
  expect(text).toContain("Waiting on you");
  expect(text).toContain("整理今天的待办");
  expect(text).toContain("发邮件给李总");
  expect(text).toContain("来自研究的交接");
  expect(text).toContain("团队周报.md");
  expect(text).toContain("总管");
});

it("keeps archived groups out of the panel", async () => {
  state.bootstrap = {
    bots: [bot],
    groups: [{ id: "group-eval", archivedAt: new Date().toISOString() }],
  };
  state.active = { runs: [run({ groupId: "group-eval", groupName: "eval" })] };
  state.recent = { runs: [] };
  state.artifacts = { items: [artifact({ groupId: "group-eval" })], nextCursor: null };
  await render();
  const text = document.body.textContent ?? "";
  expect(text).not.toContain("整理今天的待办");
  expect(text).not.toContain("团队周报.md");
});
