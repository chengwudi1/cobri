import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExperienceIndexGuidance, reflectExperience } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { maybeQueueExperienceReflection } from "./experience.js";

function setup({
  botMessage = true,
  repliedMessage = false,
}: {
  botMessage?: boolean;
  repliedMessage?: boolean;
} = {}) {
  const enqueue = vi.fn(async () => undefined);
  const prisma = {
    message: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.role === "user") return { id: "message-user" };
        if (repliedMessage && where.id === "message-bot") {
          return {
            id: "message-bot",
            blocks: [{ kind: "text", text: "先给了一个错误的答案" }],
            runId: "run-1",
            botId: "bot-1",
          };
        }
        if (!botMessage) return null;
        return {
          id: "message-bot",
          blocks: [{ kind: "text", text: "先给了一个错误的答案" }],
          runId: "run-1",
          botId: "bot-1",
        };
      }),
    },
    run: {
      findUnique: vi.fn(async () => ({ task: { prompt: "整理今天的待办" } })),
    },
  };
  return {
    enqueue,
    deps: {
      prisma: prisma as never,
      jobs: { enqueue, cancel: vi.fn(), close: vi.fn() } as never,
    },
    prisma,
  };
}

const actor = { spaceId: "space-1", userId: "user-1" } as never;
const target = { threadId: "thread-1" } as never;
const result = { seq: 10 };

describe("experience reflection enqueue", () => {
  it("queues one reflection for an explicit correction", async () => {
    const { deps, enqueue } = setup();
    await maybeQueueExperienceReflection(
      deps,
      actor,
      target,
      {
        text: "不对，应该先读经验库再回答",
      },
      result,
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      name: "experience.reflect",
      payload: expect.objectContaining({
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        sourceMessageId: "message-user",
        correction: "不对，应该先读经验库再回答",
      }),
    });
    const payload = enqueue.mock.calls[0]?.[0]?.payload as { wrongProcess: string };
    expect(payload.wrongProcess).toContain("整理今天的待办");
    expect(payload.wrongProcess).toContain("先给了一个错误的答案");
  });

  it("does not queue praise or a normal request", async () => {
    const { deps, enqueue } = setup();
    await maybeQueueExperienceReflection(deps, actor, target, { text: "做得很好，继续" }, result);
    await maybeQueueExperienceReflection(
      deps,
      actor,
      target,
      { text: "再查一下明天的日程" },
      result,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not queue when there is no prior bot run", async () => {
    const { deps, enqueue } = setup({ botMessage: false });
    await maybeQueueExperienceReflection(
      deps,
      actor,
      target,
      {
        text: "不对，应该先读经验库",
      },
      result,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("uses the replied bot message when the user replies to one", async () => {
    const { deps, enqueue } = setup({ repliedMessage: true });
    await maybeQueueExperienceReflection(
      deps,
      actor,
      target,
      {
        text: "不对，应该先读经验库",
        replyToMessageId: "message-bot",
      },
      result,
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("closes the loop from correction to next-run guidance", async () => {
    const { deps, enqueue } = setup();
    await maybeQueueExperienceReflection(
      deps,
      actor,
      target,
      {
        text: "不对，应该先读经验库再回答",
      },
      result,
    );
    const payload = enqueue.mock.calls[0]?.[0]?.payload as {
      spaceId: string;
      userId: string;
      botId: string;
      sourceMessageId: string;
      correction: string;
      wrongProcess: string;
    };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rakazo-experience-loop-"));
    try {
      const reflection = await reflectExperience(
        {
          prisma: {} as never,
          dataDir,
          runtime: {
            async *run() {
              yield {
                type: "done" as const,
                text: "cue: 回答前先读经验库时\nlesson: 先读 INDEX 再回答\nevidence: 没读经验库直接回答，被用户指出",
              };
            },
          } as never,
          resolveModel: (async () => ({ provider: "test", id: "test" })) as never,
        },
        payload,
      );
      expect(reflection.status).toBe("recorded");
      const guidance = loadExperienceIndexGuidance({
        dataDir,
        spaceId: payload.spaceId,
        userId: payload.userId,
      });
      expect(guidance).toContain("回答前先读经验库时");
      expect(guidance).toContain("experience_read");
      expect(guidance).toContain(".md");
      expect(guidance).not.toContain("先读 INDEX 再回答");
      expect(guidance).not.toContain("没读经验库直接回答");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
