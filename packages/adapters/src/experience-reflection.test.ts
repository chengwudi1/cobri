import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { experienceRoot, readExperienceIndex } from "./experience-library.js";
import {
  type ExperienceReflectionDeps,
  parseExperienceReflection,
  reflectExperience,
  validateExperienceReflectionTarget,
} from "./experience-reflection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fakeRuntime(text: string) {
  return {
    async *run() {
      yield { type: "done" as const, text };
    },
  };
}

function deps(dataDir: string, text: string): ExperienceReflectionDeps {
  return {
    prisma: {} as ExperienceReflectionDeps["prisma"],
    dataDir,
    runtime: fakeRuntime(text) as unknown as ExperienceReflectionDeps["runtime"],
    resolveModel: async () => ({ provider: "test", id: "test" }) as never,
  };
}

const payload = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  sourceMessageId: "message-1",
  correction: "不对，应该先读 INDEX 再回答",
  wrongProcess: "没有读经验库就直接回答，答案跑偏",
};

describe("experience reflection", () => {
  it("parses the three fields and rejects a forced lesson", () => {
    expect(
      parseExperienceReflection(
        "cue: 用户要求改配置时\nlesson: 只做最小验证\nevidence: 扩成了额外工程",
      ),
    ).toEqual({
      kind: "ok",
      cue: "用户要求改配置时",
      lesson: "只做最小验证",
      evidence: "扩成了额外工程",
    });
    expect(parseExperienceReflection("没有")).toEqual({ kind: "none" });
    expect(parseExperienceReflection("cue: 只有线索")).toEqual({ kind: "invalid" });
    expect(
      parseExperienceReflection(
        '{"cue":"用户要求改配置时","lesson":"只做最小验证","evidence":"扩成了额外工程"}',
      ),
    ).toEqual({
      kind: "ok",
      cue: "用户要求改配置时",
      lesson: "只做最小验证",
      evidence: "扩成了额外工程",
    });
    expect(
      parseExperienceReflection("线索：用户要求改配置时\n教训：只做最小验证\n证据：扩成了额外工程"),
    ).toEqual({
      kind: "ok",
      cue: "用户要求改配置时",
      lesson: "只做最小验证",
      evidence: "扩成了额外工程",
    });
  });

  it("records one entry after a correction and skips the same source again", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rakazo-reflection-"));
    roots.push(dataDir);
    const result = await reflectExperience(
      deps(
        dataDir,
        "cue: 用户要求改配置时\nlesson: 配置变更只做最小验证\nevidence: 把配置变更扩成额外工程，被用户指出跑偏",
      ),
      payload,
    );
    expect(result.status).toBe("recorded");
    const root = experienceRoot(dataDir, payload.spaceId, payload.userId);
    const index = readExperienceIndex(root);
    expect(index).toHaveLength(1);
    const text = fs.readFileSync(path.join(root, index[0]!.path), "utf8");
    expect(text).toContain("<!-- confidence: low -->");
    expect(text).toContain("<!-- component: answer_policy -->");
    const again = await reflectExperience(deps(dataDir, "没有"), payload);
    expect(again.status).toBe("already_reflected");
    expect(readExperienceIndex(root)).toHaveLength(1);
  });

  it("records nothing when the reflection says there is no transferable lesson", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rakazo-reflection-"));
    roots.push(dataDir);
    const result = await reflectExperience(deps(dataDir, "没有"), payload);
    expect(result.status).toBe("no_lesson");
    expect(
      readExperienceIndex(experienceRoot(dataDir, payload.spaceId, payload.userId)),
    ).toHaveLength(0);
  });

  function targetPrisma({
    thread,
    member = true,
  }: {
    thread: {
      spaceId: string;
      userId: string;
      botId: string | null;
      groupId: string | null;
    } | null;
    member?: boolean;
  }) {
    return {
      message: { findUnique: async () => (thread ? { thread } : null) },
      chatGroupMember: { findFirst: async () => (member ? { id: "member-1" } : null) },
    } as unknown as Parameters<typeof validateExperienceReflectionTarget>[0];
  }

  it("rejects a payload from another tenant", async () => {
    const prisma = targetPrisma({
      thread: { spaceId: "space-2", userId: "user-2", botId: "bot-1", groupId: null },
    });
    expect(await validateExperienceReflectionTarget(prisma, payload)).toEqual({
      ok: false,
      reason: "tenant_mismatch",
    });
  });

  it("rejects another bot in the same DM and a non-member bot in a group", async () => {
    const otherDm = targetPrisma({
      thread: { spaceId: "space-1", userId: "user-1", botId: "bot-2", groupId: null },
    });
    expect(await validateExperienceReflectionTarget(otherDm, payload)).toMatchObject({
      ok: false,
      reason: "bot_mismatch",
    });
    const nonMember = targetPrisma({
      thread: { spaceId: "space-1", userId: "user-1", botId: null, groupId: "group-1" },
      member: false,
    });
    expect(await validateExperienceReflectionTarget(nonMember, payload)).toMatchObject({
      ok: false,
      reason: "bot_mismatch",
    });
  });

  it("accepts the DM bot and a real group member", async () => {
    const dm = targetPrisma({
      thread: { spaceId: "space-1", userId: "user-1", botId: "bot-1", groupId: null },
    });
    expect(await validateExperienceReflectionTarget(dm, payload)).toEqual({
      ok: true,
      tenant: { spaceId: "space-1", userId: "user-1" },
    });
    const group = targetPrisma({
      thread: { spaceId: "space-1", userId: "user-1", botId: null, groupId: "group-1" },
    });
    expect(await validateExperienceReflectionTarget(group, payload)).toEqual({
      ok: true,
      tenant: { spaceId: "space-1", userId: "user-1" },
    });
  });

  it("rejects an unsafe source id and a missing source message", async () => {
    const prisma = targetPrisma({
      thread: { spaceId: "space-1", userId: "user-1", botId: "bot-1", groupId: null },
    });
    expect(
      await validateExperienceReflectionTarget(prisma, {
        ...payload,
        sourceMessageId: "../message-1",
      }),
    ).toMatchObject({ ok: false, reason: "unsafe_source_id" });
    expect(
      await validateExperienceReflectionTarget(targetPrisma({ thread: null }), payload),
    ).toMatchObject({ ok: false, reason: "source_not_found" });
  });
});
