import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createSuggestionsScanReconciler, SUGGESTIONS_SCAN_INTERVAL_MS } from "./suggestions-scan.js";

function publisher() {
  const enqueue = vi.fn(async (_job: BackgroundJob): Promise<void> => undefined);
  const jobs: JobPublisher = {
    enqueue,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return { jobs, enqueue };
}

function fakePrisma(installs: Array<{ spaceId: string; userId: string }>) {
  return {
    capabilityInstall: { findMany: vi.fn(async () => installs) },
  } as unknown as PrismaClient;
}

describe("createSuggestionsScanReconciler", () => {
  it("enqueues one keyed scan per tenant per interval", async () => {
    let now = Date.parse("2026-10-29T12:00:00Z");
    const { jobs, enqueue } = publisher();
    const reconcile = createSuggestionsScanReconciler({
      prisma: fakePrisma([
        { spaceId: "space-1", userId: "user-1" },
        { spaceId: "space-2", userId: "user-2" },
      ]),
      jobs,
      now: () => now,
    });

    await reconcile();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "suggestions.scan",
        payload: { spaceId: "space-1", userId: "user-1" },
        replaceKey: "suggestions.scan:space-1:user-1",
        keepExisting: true,
      }),
    );

    now += SUGGESTIONS_SCAN_INTERVAL_MS - 1;
    await reconcile();
    expect(enqueue).toHaveBeenCalledTimes(2);

    now += 1;
    await reconcile();
    expect(enqueue).toHaveBeenCalledTimes(4);
  });

  it("logs and retries a failed schedule on the next tick", async () => {
    let now = Date.parse("2026-10-29T12:00:00Z");
    const prisma = fakePrisma([{ spaceId: "space-1", userId: "user-1" }]);
    vi.mocked(prisma.capabilityInstall.findMany).mockRejectedValueOnce(new Error("db down"));
    const { jobs, enqueue } = publisher();
    const reconcile = createSuggestionsScanReconciler({ prisma, jobs, now: () => now });

    await expect(reconcile()).rejects.toThrow("db down");
    expect(enqueue).not.toHaveBeenCalled();

    now += 30_000;
    await reconcile();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
