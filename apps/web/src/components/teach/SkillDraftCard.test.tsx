// @vitest-environment jsdom

import type { SkillPlaybook } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const skills = vi.hoisted(() => ({
  updateDraft: vi.fn(async () => ({})),
  save: vi.fn(async () => ({})),
  saveShared: vi.fn(async () => ({ id: "agent-1", name: "Export", content: "---" })),
  testRun: vi.fn(async () => ({ runId: "run-1" })),
}));

vi.mock("../../lib/rpc", () => ({ rpc: { skills } }));
vi.mock("../../lib/user-error", () => ({ errorText: (error: unknown) => String(error) }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: unknown, ...values: unknown[]) => {
    if (Array.isArray(parts)) {
      return parts.reduce(
        (out: string, part: string, index: number) => `${out}${part}${values[index] ?? ""}`,
        "",
      );
    }
    return (parts as { message?: string } | null)?.message ?? "";
  };
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button {...props} />
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Label: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Container,
  };
});
vi.mock("../ai/primitives", () => ({
  BuiCard: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { SkillDraftCard } from "./SkillDraftCard";

const playbook: SkillPlaybook = {
  whenToUse: "When a customer asks for a meeting recap",
  inputs: ["meeting"],
  steps: ["Read the invitation", "Write the recap"],
  howToCheck: "Recap has the time and attendees",
  whatToReturn: "One-page recap",
  approvalBoundaries: "Do not send without approval",
  failureHandling: "Ask the user",
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("saves the draft and promotes it to the shared skill store", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SkillDraftCard
          block={{
            kind: "skill_draft",
            skillId: "skill-1",
            name: "Export",
            goal: "Export a list",
            playbook,
            status: "saved",
          }}
          onRefresh={async () => undefined}
          onAddRoutine={() => undefined}
        />
      </QueryClientProvider>,
    );
  });
  const share = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save as shared skill",
  );
  expect(share).toBeTruthy();
  await act(async () => share?.click());
  await vi.waitFor(() => expect(skills.saveShared).toHaveBeenCalledWith({ skillId: "skill-1" }));
  expect(skills.updateDraft).toHaveBeenCalled();
  expect(skills.save).toHaveBeenCalledWith({ skillId: "skill-1", name: "Export" });
  expect(container.querySelector('[data-testid="skill-shared"]')).toBeTruthy();
  expect(invalidate).toHaveBeenCalled();
  const predicate = invalidate.mock.calls[0]?.[0]?.predicate as
    | ((query: { queryKey: unknown[] }) => boolean)
    | undefined;
  expect(
    predicate?.({
      queryKey: [["user:u", "space:s", "agentSkills", "list"], { input: undefined }],
    }),
  ).toBe(true);
  expect(
    predicate?.({
      queryKey: [["user:u", "space:s", "memory", "list"], { input: undefined }],
    }),
  ).toBe(false);
  expect(predicate?.({ queryKey: ["user:u", "space:s", "agentSkills", "list"] })).toBe(false);
  act(() => root.unmount());
  container.remove();
});
