import type { JobPublisher } from "@rakazo/adapter-kit";
import { suggestionsScanJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export const SUGGESTIONS_SCAN_INTERVAL_MS = 30 * 60_000;

/**
 * Uses the existing reconciler tick as the clock: every tenant with an API
 * capability is scanned at most once per interval, and the queued job key keeps
 * a slow scan from stacking behind itself.
 */
export function createSuggestionsScanReconciler(deps: {
  prisma: Pick<PrismaClient, "capabilityInstall">;
  jobs: JobPublisher;
  intervalMs?: number;
  now?: () => number;
}) {
  const intervalMs = deps.intervalMs ?? SUGGESTIONS_SCAN_INTERVAL_MS;
  let lastScanAt: number | undefined;

  return async () => {
    const at = deps.now?.() ?? Date.now();
    if (lastScanAt !== undefined && at - lastScanAt < intervalMs) return;
    try {
      const installs = await deps.prisma.capabilityInstall.findMany({
        where: { kind: "api" },
        select: { spaceId: true, userId: true },
        distinct: ["spaceId", "userId"],
      });
      for (const actor of installs) {
        await deps.jobs.enqueue(suggestionsScanJob(actor.spaceId, actor.userId));
      }
      lastScanAt = at;
      getLogger().info("suggestions.scan_scheduled", { tenants: installs.length });
    } catch (error) {
      getLogger().error("suggestions.scan_schedule_failed", error);
      throw error;
    }
  };
}
