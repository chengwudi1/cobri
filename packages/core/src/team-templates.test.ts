import { describe, expect, it } from "vitest";
import { getTeamTemplate, TEAM_TEMPLATES, WORK_ASSISTANT_TEAM_TEMPLATE } from "./team-templates.js";

describe("team templates", () => {
  it("defines the work assistant team with four distinct roles", () => {
    expect(WORK_ASSISTANT_TEAM_TEMPLATE.groupName).toBe("工作助理团队");
    expect(WORK_ASSISTANT_TEAM_TEMPLATE.bots.map((bot) => bot.name)).toEqual([
      "总管",
      "研究",
      "收件箱",
      "日程",
    ]);
    expect(new Set(WORK_ASSISTANT_TEAM_TEMPLATE.bots.map((bot) => bot.key)).size).toBe(4);
    for (const bot of WORK_ASSISTANT_TEAM_TEMPLATE.bots) {
      expect(bot.instructions.trim()).not.toBe("");
      expect(bot.tools.length).toBeGreaterThan(0);
      expect(bot.approval.trim()).not.toBe("");
    }
  });

  it("keeps the coordinator out of external writes and the approval rules explicit", () => {
    const chief = WORK_ASSISTANT_TEAM_TEMPLATE.bots.find((bot) => bot.key === "chief");
    const inbox = WORK_ASSISTANT_TEAM_TEMPLATE.bots.find((bot) => bot.key === "inbox");
    const calendar = WORK_ASSISTANT_TEAM_TEMPLATE.bots.find((bot) => bot.key === "calendar");
    expect(chief?.instructions).toContain("不发送邮件");
    expect(inbox?.instructions).toContain("审批");
    expect(calendar?.instructions).toContain("审批");
  });

  it("resolves a template by id and ignores unknown ids", () => {
    expect(getTeamTemplate("work-assistant")).toBe(WORK_ASSISTANT_TEAM_TEMPLATE);
    expect(getTeamTemplate("missing")).toBeUndefined();
    expect(TEAM_TEMPLATES).toContain(WORK_ASSISTANT_TEAM_TEMPLATE);
  });
});
