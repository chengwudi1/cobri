import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  bootstrapUserSpace,
  createDb,
  createRepos,
  IsolationError,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SharedBotsService } from "./shared-bots.js";
import { createSharedBotsService } from "./shared-bots.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const describePostgres = databaseUrl ? describe.sequential : describe.skip;

describePostgres("shared bots (PostgreSQL)", () => {
  const stamp = randomUUID().slice(0, 8);
  const signup = { signupsEnabled: undefined, signupAllowlist: undefined };
  const userIds: string[] = [];
  const spaceIds: string[] = [];
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let service: SharedBotsService;
  let botId: string;
  let ownerSpaceId: string;
  let owner: Actor;
  let memberA: Actor;
  let memberB: Actor;
  let stranger: Actor;

  const actorFor = (userId: string, spaceId: string): Actor => ({
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    service = createSharedBotsService(prisma);
    const system = asSystem(prisma, "shared bot fixture");

    const createUser = async (label: string) => {
      const id = `shared-${label}-${stamp}`;
      userIds.push(id);
      await system.user.create({
        data: { id, name: label, email: `${id}@rakazo.test`, emailVerified: false },
      });
      return id;
    };
    const ownerId = await createUser("owner");
    const memberAId = await createUser("member-a");
    const memberBId = await createUser("member-b");
    const strangerId = await createUser("stranger");

    ({ spaceId: ownerSpaceId } = await runAsSystem("shared bot fixture", () =>
      bootstrapUserSpace(prisma, { id: ownerId }, signup),
    ));
    spaceIds.push(ownerSpaceId);
    const { organizationId } = await system.space.findUniqueOrThrow({
      where: { id: ownerSpaceId },
      select: { organizationId: true },
    });
    for (const userId of [memberAId, memberBId]) {
      await system.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        },
      });
    }
    const { spaceId: strangerSpaceId } = await runAsSystem("shared bot fixture", () =>
      bootstrapUserSpace(prisma, { id: strangerId }, signup),
    );
    spaceIds.push(strangerSpaceId);

    owner = actorFor(ownerId, ownerSpaceId);
    memberA = actorFor(memberAId, ownerSpaceId);
    memberB = actorFor(memberBId, ownerSpaceId);
    stranger = actorFor(strangerId, strangerSpaceId);

    const bot = await runAsTenant(owner, () =>
      createRepos(prisma).createBot(owner, {
        name: "Shared Assistant",
        title: "Helper",
        description: "Shared helper",
        instructions: "",
        notifyOnFinish: true,
      }),
    );
    botId = bot.id;
  });

  afterAll(async () => {
    if (prisma) {
      const system = asSystem(prisma, "shared bot fixture cleanup");
      await system.organization.deleteMany({ where: { id: { in: spaceIds } } });
      await system.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await close?.();
  });

  it("lets only the bot's owner share or unshare it", async () => {
    await expect(
      runAsTenant(memberA, () => service.share(memberA, { botId })),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      runAsTenant(memberA, () => service.unshare(memberA, { botId })),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      runAsTenant(stranger, () => service.share(stranger, { botId })),
    ).rejects.toBeInstanceOf(IsolationError);

    await expect(runAsTenant(owner, () => service.share(owner, { botId }))).resolves.toEqual({
      ok: true,
    });

    const share = await asSystem(prisma).botShare.findUnique({
      where: { botId_spaceId: { botId, spaceId: ownerSpaceId } },
    });
    expect(share?.sharedBy).toBe(owner.userId);
  });

  it("gives each member a private container that others cannot see", async () => {
    const seenByA = await runAsTenant(memberA, () => service.listShared(memberA));
    expect(seenByA.map((shared) => shared.botId)).toEqual([botId]);
    const seenByOwner = await runAsTenant(owner, () => service.listShared(owner));
    expect(seenByOwner).toEqual([]);
    const seenByStranger = await runAsTenant(stranger, () => service.listShared(stranger));
    expect(seenByStranger).toEqual([]);

    const aThread = await runAsTenant(memberA, () => service.createThread(memberA, { botId }));
    expect(aThread).toMatchObject({
      botId,
      spaceId: ownerSpaceId,
      userId: memberA.userId,
      title: "Shared Assistant",
      readOnly: false,
    });
    const bThread = await runAsTenant(memberB, () =>
      service.createThread(memberB, { botId, title: "B's notes" }),
    );
    expect(bThread.title).toBe("B's notes");
    expect(bThread.id).not.toBe(aThread.id);

    // Asking again returns the same container instead of piling up rows.
    const again = await runAsTenant(memberA, () => service.createThread(memberA, { botId }));
    expect(again.id).toBe(aThread.id);

    const aThreads = await runAsTenant(memberA, () => service.listThreads(memberA));
    expect(aThreads.map((thread) => thread.id)).toEqual([aThread.id]);
    const bThreads = await runAsTenant(memberB, () => service.listThreads(memberB));
    expect(bThreads.map((thread) => thread.id)).toEqual([bThread.id]);

    // Row-level security, not just the list filter, hides the other member's row.
    await expect(
      runAsTenant(memberA, () => prisma.sharedThread.findUnique({ where: { id: bThread.id } })),
    ).resolves.toBeNull();
  });

  it("allows containers to be read, updated and deleted while the bot is shared", async () => {
    const [aThread] = await runAsTenant(memberA, () => service.listThreads(memberA));
    expect(aThread).toBeDefined();
    const updated = await runAsTenant(memberA, () =>
      prisma.sharedThread.update({ where: { id: aThread!.id }, data: { title: "A renamed" } }),
    );
    expect(updated.title).toBe("A renamed");
    await expect(
      runAsTenant(memberA, () => prisma.sharedThread.findUnique({ where: { id: aThread!.id } })),
    ).resolves.toMatchObject({ title: "A renamed" });

    const [bThread] = await runAsTenant(memberB, () => service.listThreads(memberB));
    expect(bThread).toBeDefined();
    await runAsTenant(memberB, () => prisma.sharedThread.delete({ where: { id: bThread!.id } }));
    await expect(runAsTenant(memberB, () => service.listThreads(memberB))).resolves.toEqual([]);
    const recreated = await runAsTenant(memberB, () =>
      service.createThread(memberB, { botId, title: "B again" }),
    );
    expect(recreated.title).toBe("B again");
  });

  it("refuses new containers after unshare and keeps existing ones read-only", async () => {
    await expect(runAsTenant(owner, () => service.unshare(owner, { botId }))).resolves.toEqual({
      ok: true,
    });
    await expect(runAsTenant(memberA, () => service.listShared(memberA))).resolves.toEqual([]);
    await expect(
      runAsTenant(memberA, () => service.createThread(memberA, { botId })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const aThreads = await runAsTenant(memberA, () => service.listThreads(memberA));
    expect(aThreads).toHaveLength(1);
    expect(aThreads[0]?.readOnly).toBe(true);
    const bThreads = await runAsTenant(memberB, () => service.listThreads(memberB));
    expect(bThreads).toHaveLength(1);
    expect(bThreads[0]?.readOnly).toBe(true);

    const aThreadId = aThreads[0]!.id;
    await expect(
      runAsTenant(memberA, () => prisma.sharedThread.findUnique({ where: { id: aThreadId } })),
    ).resolves.toMatchObject({ id: aThreadId });
    await expect(
      runAsTenant(memberA, () => prisma.sharedThread.delete({ where: { id: aThreadId } })),
    ).rejects.toThrow();
    await expect(
      runAsTenant(memberA, () =>
        prisma.sharedThread.update({ where: { id: aThreadId }, data: { title: "nope" } }),
      ),
    ).rejects.toThrow();
    expect(await asSystem(prisma).sharedThread.count({ where: { id: aThreadId } })).toBe(1);

    const kept = await asSystem(prisma).sharedThread.count({ where: { spaceId: ownerSpaceId } });
    expect(kept).toBe(2);

    // Sharing again revives the same containers instead of starting over.
    await runAsTenant(owner, () => service.share(owner, { botId }));
    const revived = await runAsTenant(memberA, () => service.listThreads(memberA));
    expect(revived.map((thread) => thread.id)).toEqual(aThreads.map((thread) => thread.id));
    expect(revived[0]?.readOnly).toBe(false);
  });
});
