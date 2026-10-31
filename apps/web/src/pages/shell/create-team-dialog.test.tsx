// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const template = {
  id: "work-assistant",
  name: "工作助理团队",
  description: "总管负责拆解和汇总。",
  groupName: "工作助理团队",
  bots: [
    {
      key: "chief",
      name: "总管",
      title: "统筹日程、优先级与跟进",
      description: "",
      color: "#D9508A",
      tools: ["Bot 间委派", "群内交接"],
      approval: "自己不执行外部写",
    },
    {
      key: "research",
      name: "研究",
      title: "按需调研并给出带来源的简报",
      description: "",
      color: "#3B82F6",
      tools: ["电脑浏览器"],
      approval: "外部写操作需要用户审批",
    },
  ],
};

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: () => ({ data: [template], isPending: false, isError: false, error: null }),
  };
});

vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    teams: { listTemplates: { queryOptions: () => ({}) } },
  }),
}));

vi.mock("../../lib/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));

import { CreateTeamDialog } from "./create-team-dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(onCreate: (templateId: string) => Promise<void>) {
  await act(async () => {
    root.render(<CreateTeamDialog onCancel={() => undefined} onCreate={onCreate} />);
  });
}

function button(name: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

describe("CreateTeamDialog", () => {
  it("previews the four roles and creates the template once", async () => {
    const onCreate = vi.fn(async () => undefined);
    await render(onCreate);
    expect(document.body.textContent).toContain("工作助理团队");
    expect(document.body.textContent).toContain("总管");
    expect(document.body.textContent).toContain("研究");
    expect(document.body.textContent).toContain("Bot 间委派");
    await act(async () => button("Create team").click());
    expect(onCreate).toHaveBeenCalledWith("work-assistant");
  });

  it("shows a readable error when creation fails", async () => {
    const onCreate = vi.fn(async () => {
      throw new Error("boom");
    });
    await render(onCreate);
    await act(async () => button("Create team").click());
    expect(document.body.textContent).toContain("Could not create team");
  });
});
