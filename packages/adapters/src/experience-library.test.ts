import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureExperienceLibrary,
  experienceRoot,
  finishExperienceSource,
  loadExperienceGuidance,
  loadExperienceIndexGuidance,
  readExperienceEntry,
  readExperienceFromPath,
  readExperienceIndex,
  releaseExperienceSource,
  reserveExperienceSource,
  selectExperienceEntries,
  writeExperience,
} from "./experience-library.js";

const roots: string[] = [];

function tempRoot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rakazo-experience-"));
  roots.push(dataDir);
  const root = experienceRoot(dataDir, "space-1", "user-1");
  ensureExperienceLibrary(root);
  return { dataDir, root };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const entry = {
  domain: "general" as const,
  cue: "用户要求改配置或换外部服务时",
  lesson: "配置变更只做最小验证，然后回到原任务",
  evidence: "把一次配置变更扩成额外工程，被用户指出跑偏",
};

describe("experience library", () => {
  it("keeps the legacy guidance helper as a test aid", () => {
    const { dataDir, root } = tempRoot();
    const result = writeExperience({ root, ...entry });
    expect(result.recorded).toBe(true);
    expect(readExperienceIndex(root)).toHaveLength(1);
    const guidance = loadExperienceGuidance({
      dataDir,
      spaceId: "space-1",
      userId: "user-1",
      query: "改配置 换外部服务",
    });
    expect(guidance).toContain(entry.cue);
    expect(guidance).toContain(entry.lesson);
    expect(guidance).not.toContain(entry.evidence);
  });

  it("injects only index cues and paths, never lessons", () => {
    const { dataDir, root } = tempRoot();
    const result = writeExperience({ root, ...entry });
    expect(result.recorded).toBe(true);
    const indexPath = readExperienceIndex(root)[0]!.path;
    const guidance = loadExperienceIndexGuidance({
      dataDir,
      spaceId: "space-1",
      userId: "user-1",
    });
    expect(guidance).toContain(entry.cue);
    expect(guidance).toContain(indexPath);
    expect(guidance).toContain("experience_read");
    expect(guidance).toContain("1–3");
    expect(guidance).not.toContain(entry.lesson);
    expect(guidance).not.toContain(entry.evidence);
  });

  it("does not inject an empty library index", () => {
    const { dataDir } = tempRoot();
    expect(
      loadExperienceIndexGuidance({ dataDir, spaceId: "space-1", userId: "user-1" }),
    ).toBeUndefined();
  });

  it("caps the injected index at 40 entries", () => {
    const { dataDir, root } = tempRoot();
    const lines = Array.from({ length: 45 }, (_, index) => `- cue ${index} — general/${index}.md`);
    fs.writeFileSync(path.join(root, "INDEX.md"), `${lines.join("\n")}\n`);
    const guidance = loadExperienceIndexGuidance({
      dataDir,
      spaceId: "space-1",
      userId: "user-1",
    });
    expect(guidance).toBeDefined();
    expect(guidance!.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(40);
    expect(guidance).toContain("- cue 39 — general/39.md");
    expect(guidance).not.toContain("- cue 40 — general/40.md");
  });

  it("writes and reads confidence and component metadata", () => {
    const { root } = tempRoot();
    writeExperience({ root, ...entry });
    const index = readExperienceIndex(root)[0]!;
    const text = fs.readFileSync(path.join(root, index.path), "utf8");
    expect(text).toContain("<!-- confidence: low -->");
    expect(text).toContain("<!-- component: answer_policy -->");
    expect(readExperienceEntry(root, index)).toMatchObject({
      confidence: "low",
      component: "answer_policy",
    });
  });

  it("does not inject an unrelated task", () => {
    const { dataDir, root } = tempRoot();
    writeExperience({ root, ...entry });
    expect(
      loadExperienceGuidance({
        dataDir,
        spaceId: "space-1",
        userId: "user-1",
        query: "把论文全文按引用格式整理",
      }),
    ).toBeUndefined();
  });

  it("rejects traversal, absolute and non-markdown paths in readExperienceEntry", () => {
    const { root } = tempRoot();
    writeExperience({ root, ...entry });
    const indexPath = readExperienceIndex(root)[0]!.path;
    expect(readExperienceEntry(root, { cue: "x", path: indexPath })).not.toBeNull();
    for (const bad of [
      "../outside.md",
      path.join(root, "general", "outside.md"),
      "general/notes.txt",
    ]) {
      expect(readExperienceEntry(root, { cue: "x", path: bad })).toBeNull();
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symlink that escapes the library", () => {
    const { dataDir, root } = tempRoot();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "rakazo-experience-outside-"));
    roots.push(outsideDir);
    const outside = path.join(outsideDir, "outside.md");
    fs.writeFileSync(outside, "# outside\n\n## Lesson\n\nsecret\n\n## Evidence\n\nsecret\n");
    fs.symlinkSync(outside, path.join(root, "general", "link.md"));
    expect(readExperienceEntry(root, { cue: "x", path: "general/link.md" })).toBeNull();
    expect(
      readExperienceFromPath({
        dataDir,
        spaceId: "space-1",
        userId: "user-1",
        relativePath: "general/link.md",
      }),
    ).toMatchObject({ error: expect.stringMatching(/escapes/) });
  });

  it("reclaims a stale pending marker and keeps a fresh one", () => {
    const { root } = tempRoot();
    const started = new Date("2026-10-30T00:00:00.000Z");
    expect(reserveExperienceSource(root, "message-1", started)).toBe(true);
    expect(
      reserveExperienceSource(root, "message-1", new Date(started.getTime() + 14 * 60 * 1_000)),
    ).toBe(false);
    expect(
      reserveExperienceSource(root, "message-1", new Date(started.getTime() + 16 * 60 * 1_000)),
    ).toBe(true);
    expect(
      reserveExperienceSource(root, "message-1", new Date(started.getTime() + 16 * 60 * 1_000)),
    ).toBe(false);
    expect(
      fs.readdirSync(path.join(root, ".sources")).some((name) => name.includes(".stale.")),
    ).toBe(false);
    finishExperienceSource(root, "message-2", "recorded");
    expect(
      reserveExperienceSource(root, "message-2", new Date(started.getTime() + 60 * 60 * 1_000)),
    ).toBe(false);
    expect(reserveExperienceSource(root, "../unsafe", started)).toBe(false);
  });

  it("dedupes a near-identical cue", () => {
    const { root } = tempRoot();
    expect(writeExperience({ root, ...entry }).recorded).toBe(true);
    const second = writeExperience({
      root,
      ...entry,
      cue: "用户要求改配置/换外部服务时",
    });
    expect(second.recorded).toBe(false);
    expect(second.reason).toBe("duplicate");
    expect(readExperienceIndex(root)).toHaveLength(1);
  });

  it("claims one source once and releases a failed reflection", () => {
    const { root } = tempRoot();
    expect(reserveExperienceSource(root, "message-1")).toBe(true);
    expect(reserveExperienceSource(root, "message-1")).toBe(false);
    releaseExperienceSource(root, "message-1");
    expect(reserveExperienceSource(root, "message-1")).toBe(true);
  });

  it("refuses partial entries and invalid domains", () => {
    const { root } = tempRoot();
    expect(writeExperience({ root, ...entry, lesson: " " })).toEqual({
      recorded: false,
      reason: "missing_fields",
    });
    expect(writeExperience({ root, ...entry, domain: "unknown" as never })).toEqual({
      recorded: false,
      reason: "invalid_domain",
    });
    expect(readExperienceIndex(root)).toHaveLength(0);
  });

  it("selects at most three entries", () => {
    const { root } = tempRoot();
    for (const [index, cue] of [
      "用户要求改配置时",
      "用户要求换外部服务时",
      "用户要求改数据库时",
      "用户要求换模型时",
    ].entries()) {
      writeExperience({
        root,
        ...entry,
        cue,
        lesson: `lesson ${index}`,
        evidence: `evidence ${index}`,
      });
    }
    expect(
      selectExperienceEntries({ root, query: "用户要求改配置、换外部服务、改数据库、换模型" }),
    ).toHaveLength(3);
  });

  it("keeps separate spaces and users separate", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rakazo-experience-"));
    roots.push(dataDir);
    const alice = experienceRoot(dataDir, "space-1", "alice");
    ensureExperienceLibrary(alice);
    writeExperience({ root: alice, ...entry });
    expect(
      loadExperienceGuidance({
        dataDir,
        spaceId: "space-1",
        userId: "bob",
        query: "改配置 换外部服务",
      }),
    ).toBeUndefined();
    expect(
      loadExperienceGuidance({
        dataDir,
        spaceId: "space-2",
        userId: "alice",
        query: "改配置 换外部服务",
      }),
    ).toBeUndefined();
  });
});
