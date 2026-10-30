import { ORPCError } from "@orpc/server";
import type {
  Actor,
  CreateSharedThreadInput,
  ListSharedThreadsInput,
  SharedBot,
  SharedThread,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

const THREAD_SELECT = {
  id: true,
  botId: true,
  spaceId: true,
  userId: true,
  title: true,
  createdAt: true,
} as const;

type SharedThreadRow = {
  id: string;
  botId: string;
  spaceId: string;
  userId: string;
  title: string;
  createdAt: Date;
};

function sharedThreadDto(row: SharedThreadRow, readOnly: boolean): SharedThread {
  return { ...row, createdAt: row.createdAt.toISOString(), readOnly };
}

/**
 * Sharing and per-member containers for a Space's bots. Sharing is owner-only;
 * containers carry no messages or runs yet. Row-level security keeps one
 * member's containers invisible to the next and refuses inserts once a share
 * is gone, so the checks here mirror the database rather than replace it.
 */
export function createSharedBotsService(prisma: PrismaClient) {
  async function ownedBotId(actor: Actor, botId: string): Promise<string> {
    const bot = await prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    });
    if (!bot) throw new IsolationError();
    return bot.id;
  }

  return {
    async share(actor: Actor, input: { botId: string }) {
      const botId = await ownedBotId(actor, input.botId);
      await prisma.botShare.upsert({
        where: { botId_spaceId: { botId, spaceId: actor.spaceId } },
        create: { botId, spaceId: actor.spaceId, sharedBy: actor.userId },
        update: { sharedBy: actor.userId },
      });
      return { ok: true as const };
    },

    async unshare(actor: Actor, input: { botId: string }) {
      const botId = await ownedBotId(actor, input.botId);
      await prisma.botShare.deleteMany({ where: { botId, spaceId: actor.spaceId } });
      return { ok: true as const };
    },

    /** Bots other members shared into this Space; the caller's own stay in bots.list. */
    async listShared(actor: Actor): Promise<SharedBot[]> {
      const shares = await prisma.botShare.findMany({
        where: {
          spaceId: actor.spaceId,
          bot: { userId: { not: actor.userId }, archivedAt: null },
        },
        select: {
          botId: true,
          sharedBy: true,
          createdAt: true,
          bot: { select: { name: true, title: true, description: true, color: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      return shares.map((share) => ({
        botId: share.botId,
        name: share.bot.name,
        title: share.bot.title,
        description: share.bot.description,
        color: share.bot.color,
        sharedBy: share.sharedBy,
        sharedAt: share.createdAt.toISOString(),
      }));
    },

    async createThread(actor: Actor, input: CreateSharedThreadInput): Promise<SharedThread> {
      const share = await prisma.botShare.findFirst({
        where: { botId: input.botId, spaceId: actor.spaceId },
        select: { bot: { select: { name: true } } },
      });
      if (!share) {
        throw new ORPCError("FORBIDDEN", { message: "This bot is not shared with this space" });
      }
      await prisma.sharedThread.createMany({
        data: {
          botId: input.botId,
          userId: actor.userId,
          spaceId: actor.spaceId,
          title: input.title ?? share.bot.name,
        },
        skipDuplicates: true,
      });
      const thread = await prisma.sharedThread.findFirstOrThrow({
        where: { botId: input.botId, userId: actor.userId, spaceId: actor.spaceId },
        select: THREAD_SELECT,
      });
      return sharedThreadDto(thread, false);
    },

    async listThreads(actor: Actor, input: ListSharedThreadsInput = {}): Promise<SharedThread[]> {
      const threads = await prisma.sharedThread.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          ...(input.botId ? { botId: input.botId } : {}),
        },
        select: THREAD_SELECT,
        orderBy: { createdAt: "asc" },
      });
      const botIds = [...new Set(threads.map((thread) => thread.botId))];
      const shares = botIds.length
        ? await prisma.botShare.findMany({
            where: { spaceId: actor.spaceId, botId: { in: botIds } },
            select: { botId: true },
          })
        : [];
      const shared = new Set(shares.map((share) => share.botId));
      return threads.map((thread) => sharedThreadDto(thread, !shared.has(thread.botId)));
    },
  };
}

export type SharedBotsService = ReturnType<typeof createSharedBotsService>;
