// @vitest-environment jsdom

import type { SettingsScope } from "@rakazo/contracts";
import { encodeLoginSecret } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  list: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../lib/rpc", () => ({
  rpc: { vault },
  rpcForSpace: () => ({ vault }),
  createSpaceRpc: () => ({ vault }),
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { VaultSettings } from "./VaultSettings";

const FAKE_VALUE = "fake-value-SENTINEL-1";
const stamp = "2026-09-01T00:00:00.000Z";
const rows = [
  { name: "api", origin: "https://api.example.com", auth: { type: "bearer" } },
  {
    name: "custom",
    origin: "https://svc.example.com",
    auth: { type: "header", name: "X-Api-Key" },
  },
  {
    name: "router",
    origin: "http://192.168.1.20:8080",
    auth: { type: "basic", username: "admin" },
  },
  { name: "portal", origin: "https://portal.example.com", auth: { type: "login" } },
].map((row) => ({ ...row, createdAt: stamp, updatedAt: stamp }));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(scope: SettingsScope = "account") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <VaultSettings scope={scope} />
      </QueryClientProvider>,
    );
  });
  await flush();
}

function byTestId<T extends HTMLElement>(testId: string): T {
  const found = container.querySelector<T>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`Missing element: ${testId}`);
  return found;
}

async function type(testId: string, value: string) {
  const element = byTestId<HTMLInputElement | HTMLSelectElement>(testId);
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

async function click(testId: string) {
  await act(async () => {
    byTestId<HTMLButtonElement>(testId).click();
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vault.list.mockReset().mockResolvedValue(rows);
  vault.put.mockReset();
  vault.remove.mockReset().mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe("VaultSettings", () => {
  it("lists credential metadata and no values", async () => {
    await render();
    expect(vault.list.mock.calls[0]?.[0]).toEqual({ scope: "account" });
    const text = container.textContent ?? "";
    expect(container.querySelectorAll('[data-testid="vault-credential-row"]')).toHaveLength(4);
    for (const expected of [
      "https://api.example.com",
      "Bearer token",
      'Header "X-Api-Key"',
      "http://192.168.1.20:8080",
      "Basic auth (admin)",
      "Website login",
    ]) {
      expect(text).toContain(expected);
    }
    expect(container.querySelectorAll("input")).toHaveLength(0);
  });

  it("shows only the add action until there is something to list", async () => {
    vault.list.mockResolvedValue([]);
    await render();
    expect(byTestId("credential-add").textContent).toBe("Add credential");
    expect(container.querySelector('[data-testid="vault-card"]')).toBeNull();
    await click("credential-add");
    const form = byTestId("vault-card").querySelector('[data-testid="credential-add-form"]');
    expect(form?.textContent).toContain("Encrypted and never shown again");
    // The form has its own save and cancel, so the add action steps aside while it is open.
    expect(container.querySelector('[data-testid="credential-add"]')).toBeNull();
  });

  it("reads and writes the Space's own vault when scoped to the Space", async () => {
    vault.put.mockResolvedValue(rows[0]);
    await render("space");
    expect(vault.list.mock.calls[0]?.[0]).toEqual({ scope: "space" });
    await click("credential-replace-api");
    await type("credential-replace-value", FAKE_VALUE);
    await click("credential-replace-save");
    expect(vault.put).toHaveBeenCalledWith({
      scope: "space",
      destination: { name: "api", origin: "https://api.example.com", auth: { type: "bearer" } },
      value: FAKE_VALUE,
    });
    await click("credential-remove-custom");
    await click("credential-remove-confirm-custom");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "space", name: "custom" });
  });

  it("adds a header credential and clears the value, then refetches", async () => {
    const savedHeader = rows[1];
    if (!savedHeader) throw new Error("missing header fixture");
    let resolvePut: (row: typeof savedHeader) => void = () => undefined;
    vault.put.mockReturnValue(
      new Promise((resolve) => {
        resolvePut = resolve;
      }),
    );
    await render();
    await click("credential-add");
    await type("credential-name", "custom");
    await type("credential-origin", "https://svc.example.com");
    await type("credential-auth-type", "header");
    await type("credential-header-name", "X-Api-Key");
    await type("credential-value", FAKE_VALUE);
    expect(byTestId<HTMLInputElement>("credential-value").type).toBe("password");
    expect(byTestId<HTMLInputElement>("credential-value").autocomplete).toBe("new-password");
    await click("credential-add-save");
    expect(byTestId<HTMLInputElement>("credential-value").value).toBe("");
    expect(container.innerHTML).not.toContain(FAKE_VALUE);

    await act(async () => {
      resolvePut(savedHeader);
    });
    await flush();

    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: "custom",
        origin: "https://svc.example.com",
        auth: { type: "header", name: "X-Api-Key" },
      },
      value: FAKE_VALUE,
    });
    expect(vault.list).toHaveBeenCalledTimes(2);
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("clears the value and shows the server error when saving fails", async () => {
    vault.put.mockRejectedValue(
      new Error("Invalid credential destination — origin: Expected an HTTPS origin"),
    );
    await render();
    await click("credential-add");
    await type("credential-name", "router2");
    await type("credential-origin", "http://192.168.1.21");
    await type("credential-value", FAKE_VALUE);
    await click("credential-add-save");

    expect(vault.put).toHaveBeenCalledTimes(1);
    expect(byTestId<HTMLInputElement>("credential-value").value).toBe("");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Invalid credential destination",
    );
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("encodes a website login with encodeLoginSecret", async () => {
    vault.put.mockResolvedValue(rows[3]);
    await render();
    await click("credential-add");
    await type("credential-name", "portal2");
    await type("credential-origin", "https://portal.example.com");
    await type("credential-auth-type", "login");
    await type("credential-username", " jamie ");
    await type("credential-value", FAKE_VALUE);
    await click("credential-add-save");

    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: "portal2",
        origin: "https://portal.example.com",
        auth: { type: "login" },
      },
      value: encodeLoginSecret({ username: "jamie", password: FAKE_VALUE }),
    });
  });

  it("replaces a value on the same destination", async () => {
    vault.put.mockResolvedValue(rows[2]);
    await render();
    const replace = byTestId<HTMLButtonElement>("credential-replace-router");
    expect(replace.getAttribute("aria-label")).toBe("Replace value");
    expect(replace.textContent).toBe("");
    expect(replace.querySelector("svg")).not.toBeNull();
    const remove = byTestId<HTMLButtonElement>("credential-remove-router");
    expect(remove.getAttribute("aria-label")).toBe("Remove");
    expect(remove.textContent).toBe("");
    await click("credential-replace-router");
    await type("credential-replace-value", FAKE_VALUE);
    await click("credential-replace-save");

    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: {
        name: "router",
        origin: "http://192.168.1.20:8080",
        auth: { type: "basic", username: "admin" },
      },
      value: FAKE_VALUE,
    });
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("shows an unreadable saved row with remove but no replace", async () => {
    vault.list.mockResolvedValue([
      {
        name: "Legacy Name",
        origin: "https://legacy.example.com",
        auth: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ]);
    await render();
    const row = byTestId("vault-credential-row");
    expect(row.textContent).toContain("These saved settings can't be read.");
    expect(container.querySelector('[data-testid="credential-replace-Legacy Name"]')).toBeNull();
    await click("credential-remove-Legacy Name");
    expect(container.textContent).toContain("Remove Legacy Name?");
    await click("credential-remove-confirm-Legacy Name");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "account", name: "Legacy Name" });
    expect(vault.list).toHaveBeenCalledTimes(2);
  });

  it("hides replace and shows the unreadable row when a readable auth has an invalid name", async () => {
    vault.list.mockResolvedValue([
      {
        name: "Legacy Name",
        origin: "https://legacy.example.com",
        auth: { type: "bearer" },
        createdAt: stamp,
        updatedAt: stamp,
      },
    ]);
    await render();
    const row = byTestId("vault-credential-row");
    expect(row.textContent).toContain("These saved settings can't be read.");
    expect(container.querySelector('[data-testid="credential-replace-Legacy Name"]')).toBeNull();
    await click("credential-remove-Legacy Name");
    expect(container.textContent).toContain("Remove Legacy Name?");
    await click("credential-remove-confirm-Legacy Name");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "account", name: "Legacy Name" });
    expect(vault.list).toHaveBeenCalledTimes(2);
  });

  it("keeps the add form open when save succeeds but list reload fails", async () => {
    vault.put.mockResolvedValue(rows[0]);
    vault.list.mockResolvedValueOnce(rows).mockRejectedValueOnce(new Error("list failed"));
    await render();
    await click("credential-add");
    await type("credential-name", "api2");
    await type("credential-origin", "https://api.example.com");
    await type("credential-value", FAKE_VALUE);
    await click("credential-add-save");

    expect(vault.put).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="credential-add-form"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load credentials.",
    );
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("clears a typed replace value when opening remove on another row", async () => {
    await render();
    await click("credential-replace-api");
    await type("credential-replace-value", FAKE_VALUE);
    expect(byTestId<HTMLInputElement>("credential-replace-value").value).toBe(FAKE_VALUE);
    await click("credential-remove-custom");
    expect(container.querySelector('[data-testid="credential-replace-value"]')).toBeNull();
    expect(container.textContent).toContain("Remove custom?");
    // Protected value must not linger in any live input.
    const leaked = Array.from(container.querySelectorAll("input, textarea")).some((input) =>
      (input as HTMLInputElement).value.includes(FAKE_VALUE),
    );
    expect(leaked).toBe(false);
  });

  it("removes only after an explicit confirm", async () => {
    await render();
    await click("credential-remove-api");
    expect(vault.remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Remove api?");
    await click("credential-remove-confirm-api");
    expect(vault.remove).toHaveBeenCalledWith({ scope: "account", name: "api" });
    expect(vault.list).toHaveBeenCalledTimes(2);
  });
});

describe("VaultSettings command variables", () => {
  const commandRow = {
    name: "netbird-setup-key",
    origin: "",
    auth: { type: "command" },
    createdAt: stamp,
    updatedAt: stamp,
  };

  it("adds a command variable with no origin and shows its derived name", async () => {
    vault.put.mockResolvedValue(commandRow);
    await render();
    await click("credential-add");
    await type("credential-origin", "https://leftover.example.com");
    await type("credential-auth-type", "command");
    expect(container.querySelector('[data-testid="credential-origin"]')).toBeNull();
    await type("credential-name", "netbird-setup-key");
    expect(byTestId("credential-command-variable").textContent).toContain("$NETBIRD_SETUP_KEY");
    await type("credential-value", FAKE_VALUE);
    expect(byTestId<HTMLButtonElement>("credential-add-save").disabled).toBe(false);
    await click("credential-add-save");

    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: "netbird-setup-key", auth: { type: "command" } },
      value: FAKE_VALUE,
    });
    expect(vault.put.mock.calls[0]![0].destination).not.toHaveProperty("origin");
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("shows the blocklist error and cannot save a reserved name", async () => {
    await render();
    await click("credential-add");
    await type("credential-auth-type", "command");
    await type("credential-name", "ld_preload");
    await type("credential-value", FAKE_VALUE);
    expect(byTestId("credential-command-variable-error").textContent).toContain(
      "$LD_PRELOAD is reserved",
    );
    expect(container.querySelector('[data-testid="credential-command-variable"]')).toBeNull();
    expect(byTestId<HTMLButtonElement>("credential-add-save").disabled).toBe(true);
    await act(async () => {
      byTestId<HTMLFormElement>("credential-add-form").requestSubmit();
    });
    await flush();
    expect(vault.put).not.toHaveBeenCalled();
  });

  it("lists a command variable with its variable name and replaces its value", async () => {
    vault.list.mockResolvedValue([commandRow]);
    vault.put.mockResolvedValue(commandRow);
    await render();
    const row = byTestId("vault-credential-row");
    expect(row.textContent).toContain("Command variable$NETBIRD_SETUP_KEY");
    await click("credential-replace-netbird-setup-key");
    await type("credential-replace-value", FAKE_VALUE);
    await click("credential-replace-save");
    expect(vault.put).toHaveBeenCalledWith({
      scope: "account",
      destination: { name: "netbird-setup-key", auth: { type: "command" } },
      value: FAKE_VALUE,
    });
  });
});
