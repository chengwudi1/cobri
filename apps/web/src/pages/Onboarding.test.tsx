// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
    Plural: ({ value }: { value: number }) => String(value),
  };
});

const navigate = vi.hoisted(() => vi.fn());
const rpcMock = vi.hoisted(() => ({
  me: vi.fn(),
  models: { list: vi.fn(), connect: vi.fn() },
  bots: { list: vi.fn(), create: vi.fn() },
  teams: { create: vi.fn() },
  onboarding: { start: vi.fn(), promptFocus: vi.fn() },
}));

vi.mock("../lib/rpc", () => ({ rpc: rpcMock }));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate, useParams: () => ({}) };
});

vi.mock("../lib/use-model-oauth-signin", () => ({
  useModelOAuthSignIn: () => ({
    oauth: null,
    pasteCode: "",
    setPasteCode: () => undefined,
    oauthPending: false,
    popupBlocked: false,
    cancelOAuthAttempt: () => undefined,
    startSubscriptionSignIn: () => undefined,
    submitOAuthCode: () => undefined,
  }),
}));

import { OnboardingPage } from "./Onboarding";

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
  rpcMock.me.mockResolvedValue({
    billingEnabled: false,
    needsModel: false,
    needsSignupSurvey: false,
  });
  rpcMock.models.list.mockResolvedValue([]);
  rpcMock.bots.list.mockResolvedValue([]);
  rpcMock.bots.create.mockResolvedValue({ id: "bot-1", spawnKey: "onboarding:first" });
  rpcMock.teams.create.mockResolvedValue({ group: { id: "group-1" }, bots: [] });
  rpcMock.onboarding.start.mockResolvedValue({});
  rpcMock.onboarding.promptFocus.mockResolvedValue({});
  navigate.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render() {
  await act(async () => {
    root.render(<OnboardingPage />);
  });
}

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startChoice() {
  await waitFor(
    () => document.querySelector('[data-testid="onboarding-start-team"]') !== null,
    "the start choice",
  );
}

function button(testId: string) {
  const element = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`missing ${testId}`);
  return element;
}

describe("OnboardingPage start choice", () => {
  it("creates the team and opens its group without creating a bot", async () => {
    await render();
    await startChoice();
    await act(async () => button("onboarding-start-team").click());
    await waitFor(
      () => navigate.mock.calls.some(([to]) => to === "/app/g/group-1"),
      "group navigation",
    );
    expect(rpcMock.teams.create).toHaveBeenCalledWith({ templateId: "work-assistant" });
    expect(rpcMock.bots.create).not.toHaveBeenCalled();
    expect(rpcMock.bots.list).toHaveBeenCalled();
  });

  it("keeps the single-bot flow when that option is chosen", async () => {
    await render();
    await startChoice();
    await act(async () => button("onboarding-start-single").click());
    await waitFor(
      () => navigate.mock.calls.some(([to]) => to === "/app/bot-1"),
      "bot navigation",
    );
    expect(rpcMock.bots.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Chief", spawnKey: "onboarding:first" }),
    );
    expect(rpcMock.teams.create).not.toHaveBeenCalled();
    expect(rpcMock.onboarding.start).toHaveBeenCalledWith({ botId: "bot-1" });
  });

  it("skips the choice when the space already has a bot", async () => {
    rpcMock.bots.list.mockResolvedValue([
      { id: "existing-1", name: "Chief", spawnKey: "onboarding:first" },
    ]);
    await render();
    await waitFor(
      () => navigate.mock.calls.some(([to]) => to === "/app/existing-1"),
      "existing bot navigation",
    );
    expect(document.querySelector('[data-testid="onboarding-start-team"]')).toBeNull();
    expect(rpcMock.bots.create).not.toHaveBeenCalled();
    expect(rpcMock.teams.create).not.toHaveBeenCalled();
  });
});
