import { describe, expect, it } from "vitest";
import { correctionText, isCorrectionMessage } from "./experience.js";

describe("experience correction trigger", () => {
  it("accepts an explicit error together with a correction", () => {
    expect(isCorrectionMessage("不对，应该先读 INDEX，再打开匹配的经验")).toBe(true);
    expect(isCorrectionMessage("你错了，下次先做 smoke，再回到产品目标")).toBe(true);
    expect(isCorrectionMessage("这是功能啊，你仔细看了吗，去看论文再回答")).toBe(true);
  });

  it("rejects praise, new requests, and bare complaints without a correction", () => {
    expect(isCorrectionMessage("做得很好，继续下一个功能")).toBe(false);
    expect(isCorrectionMessage("把这个页面再改一下")).toBe(false);
    expect(isCorrectionMessage("不对")).toBe(false);
    expect(isCorrectionMessage("你错了")).toBe(false);
    expect(isCorrectionMessage("不对吗？")).toBe(false);
    expect(isCorrectionMessage("换个模型 API key")).toBe(false);
  });

  it("keeps the correction text bounded", () => {
    expect(correctionText("  不对，应该改成产品功能  ")).toBe("不对，应该改成产品功能");
    expect(correctionText("x".repeat(5000)).length).toBe(4000);
  });
});
