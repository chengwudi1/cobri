import { describe, expect, it, vi } from "vitest";
import { taskTools } from "./run-tools-tasks.js";

function context(name: string) {
  const append = vi.fn(async () => ({ seq: 1 }));
  const findMany = vi.fn(async () => [
    {
      id: "skill-1",
      name,
      description: "Prepare a customer meeting",
      content: "---\nname: Prepare a customer meeting\ndescription: x\n---\nsteps",
      source: "user",
    },
  ]);
  const ctx = {
    deps: { prisma: { agentSkill: { findMany } }, events: { append } },
    run: { spaceId: "space-1", userId: "user-1", id: "run-1" },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
  };
  return { ctx: ctx as never, append };
}

describe("skill_read invocation record", () => {
  it("appends skill.invoked with the resolved skill and run identity", async () => {
    const { ctx, append } = context("Prepare a customer meeting");
    const result = (await taskTools.skill_read?.(ctx, {
      args: { name: "Prepare a customer meeting" },
    } as never)) as { id?: string; name?: string };
    expect(result).toMatchObject({ id: "skill-1", name: "Prepare a customer meeting" });
    expect(append).toHaveBeenCalledWith({
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      type: "skill.invoked",
      payload: { skillId: "skill-1", name: "Prepare a customer meeting" },
    });
  });
});
