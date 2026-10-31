import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { MessageBlock } from "@rakazo/contracts";
import { blocksToAgentHistoryText, correctionText, isCorrectionMessage } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";

type ExperienceReflectionDeps = {
  prisma: PrismaClient;
  jobs: JobPublisher;
};

/**
 * A human correction is the only trigger. The work run is already durable; this
 * only queues one hidden reflection, so a normal message never adds a session.
 */
export async function maybeQueueExperienceReflection(
  deps: ExperienceReflectionDeps,
  actor: Actor,
  target: ThreadTarget,
  input: { text?: string; replyToMessageId?: string },
  result: { seq: number },
): Promise<void> {
  const text = input.text?.trim();
  if (!text || !isCorrectionMessage(text)) return;

  const userMessage = await deps.prisma.message.findFirst({
    where: { threadId: target.threadId, seq: result.seq, role: "user" },
    select: { id: true },
  });
  if (!userMessage) return;

  const select = { id: true, blocks: true, runId: true, botId: true } as const;
  const replied =
    input.replyToMessageId != null
      ? await deps.prisma.message.findFirst({
          where: {
            id: input.replyToMessageId,
            threadId: target.threadId,
            role: "bot",
            runId: { not: null },
          },
          select,
        })
      : null;
  const botMessage =
    replied ??
    (await deps.prisma.message.findFirst({
      where: {
        threadId: target.threadId,
        role: "bot",
        seq: { lt: result.seq },
        runId: { not: null },
      },
      orderBy: { seq: "desc" },
      select,
    }));
  if (!botMessage?.runId || !botMessage.botId) return;

  const parsed = MessageBlock.array().safeParse(botMessage.blocks);
  const botText = parsed.success ? blocksToAgentHistoryText(parsed.data) : "";
  const run = await deps.prisma.run.findUnique({
    where: { id: botMessage.runId },
    select: { task: { select: { prompt: true } } },
  });
  const wrongProcess = [run?.task?.prompt, botText]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n")
    .slice(0, 8000);
  if (!wrongProcess) return;

  await deps.jobs.enqueue({
    name: "experience.reflect",
    payload: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: botMessage.botId,
      sourceMessageId: userMessage.id,
      correction: correctionText(text),
      wrongProcess,
    },
  });
}
