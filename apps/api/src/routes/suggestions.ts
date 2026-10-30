import { ORPCError } from "@orpc/server";
import { generateSuggestions, recoverStaleAccepted } from "@rakazo/adapters/suggestions";
import type { ProactiveSuggestion } from "@rakazo/contracts";
import { resolveThreadTarget, sendThreadMessage } from "../thread-target.js";
import type { RouterContext } from "./context.js";

type BotInfo = { id: string; name: string; color: string };

function mapSuggestion(
  row: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    source: string;
    title: string;
    rationale: string;
    instruction: string;
    status: string;
    runId: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  bot: BotInfo | undefined,
): ProactiveSuggestion {
  return {
    id: row.id,
    spaceId: row.spaceId,
    userId: row.userId,
    botId: row.botId,
    botName: bot?.name ?? "Unknown",
    botColor: bot?.color ?? "",
    source: row.source,
    title: row.title,
    rationale: row.rationale,
    instruction: row.instruction,
    status: row.status as ProactiveSuggestion["status"],
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function suggestionsRoutes(ctx: RouterContext, options: { now?: () => Date } = {}) {
  const { deps, authed } = ctx;
  const now = options.now ?? (() => new Date());

  async function botLookup(actor: { spaceId: string; userId: string }) {
    const bots = await deps.prisma.bot.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true, name: true, color: true },
    });
    return new Map(bots.map((bot) => [bot.name, bot]));
  }

  async function listSuggestions(actor: { spaceId: string; userId: string }) {
    const rows = await deps.prisma.proactiveSuggestion.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const bots = await botLookup(actor);
    const byId = new Map([...bots.values()].map((bot) => [bot.id, bot]));
    return rows.map((row) => mapSuggestion(row, byId.get(row.botId)));
  }

  return {
    suggestions: {
      list: authed.suggestions.list.handler(async ({ context }) => {
        await recoverStaleAccepted({ prisma: deps.prisma, now }, context.actor);
        return listSuggestions(context.actor);
      }),
      generate: authed.suggestions.generate.handler(async ({ context }) => {
        const result = await generateSuggestions(
          {
            prisma: deps.prisma,
            runtime: deps.runtime,
            resolveModel: deps.resolveModel,
            now,
          },
          context.actor,
        );
        return {
          suggestions: await listSuggestions(context.actor),
          created: result.created,
        };
      }),
      ignore: authed.suggestions.ignore.handler(async ({ context, input }) => {
        const { actor } = context;
        const claimed = await deps.prisma.proactiveSuggestion.updateMany({
          where: {
            id: input.id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            status: "pending",
          },
          data: { status: "ignored", updatedAt: now() },
        });
        if (claimed.count === 0) {
          const current = await deps.prisma.proactiveSuggestion.findFirst({
            where: { id: input.id, spaceId: actor.spaceId, userId: actor.userId },
          });
          if (!current) throw new ORPCError("NOT_FOUND", { message: "Suggestion not found." });
          throw new ORPCError("CONFLICT", {
            message: "Suggestion is no longer pending.",
          });
        }
        const row = await deps.prisma.proactiveSuggestion.findFirst({
          where: { id: input.id, spaceId: actor.spaceId, userId: actor.userId },
        });
        if (!row) throw new ORPCError("NOT_FOUND", { message: "Suggestion not found." });
        const bots = await botLookup(actor);
        return mapSuggestion(
          row,
          [...bots.values()].find((bot) => bot.id === row.botId),
        );
      }),
      accept: authed.suggestions.accept.handler(async ({ context, input }) => {
        const { actor } = context;
        const row = await deps.prisma.proactiveSuggestion.findFirst({
          where: { id: input.id, spaceId: actor.spaceId, userId: actor.userId },
        });
        if (!row) throw new ORPCError("NOT_FOUND", { message: "Suggestion not found." });
        const bots = await botLookup(actor);
        const bot = [...bots.values()].find((candidate) => candidate.id === row.botId);
        if (!bot) throw new ORPCError("NOT_FOUND", { message: "Target bot not found." });

        const claimed = await deps.prisma.proactiveSuggestion.updateMany({
          where: {
            id: row.id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            status: "pending",
          },
          data: { status: "accepted", updatedAt: now() },
        });
        if (claimed.count === 0) {
          throw new ORPCError("CONFLICT", {
            message: "Suggestion is no longer pending.",
          });
        }

        try {
          const target = await resolveThreadTarget(deps.prisma, actor, { botId: bot.id });
          const sent = await sendThreadMessage(deps, actor, target, {
            text: `${row.title}\n\n${row.instruction}\n\nReason: ${row.rationale}`,
            clientNonce: `suggestion:${row.id}`,
          });
          const terminal = await deps.prisma.proactiveSuggestion.updateMany({
            where: {
              id: row.id,
              spaceId: actor.spaceId,
              userId: actor.userId,
            },
            data: { status: "accepted", runId: sent.runId, updatedAt: now() },
          });
          if (terminal.count === 0) {
            throw new ORPCError("NOT_FOUND", { message: "Suggestion not found." });
          }
          const updated = await deps.prisma.proactiveSuggestion.findFirst({
            where: { id: row.id, spaceId: actor.spaceId, userId: actor.userId },
          });
          if (!updated) throw new ORPCError("NOT_FOUND", { message: "Suggestion not found." });
          return mapSuggestion(updated, bot);
        } catch (error) {
          await deps.prisma.proactiveSuggestion.updateMany({
            where: {
              id: row.id,
              spaceId: actor.spaceId,
              userId: actor.userId,
              status: "accepted",
              runId: null,
            },
            data: { status: "pending", updatedAt: now() },
          });
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: error instanceof Error ? error.message : "Could not dispatch this suggestion.",
          });
        }
      }),
    },
  };
}
