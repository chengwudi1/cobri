/** A user message counts as a correction only when it says the work is wrong and asks for a different approach. */
const EXPLICIT_ERROR =
  /不对|错了|错|跑偏|偏离|说错|不是这样|这是功能|搞错|理解错|你确定|没看|没仔细|不是我要|不是这个/iu;
const CORRECTION =
  /应该|改成|而是|下次|以后|记住|只做|不要|别再|正确|去看|看(?:了|过)?论文|我要的是|按.{0,6}做/iu;

export function isCorrectionMessage(text: string): boolean {
  const message = String(text ?? "").trim();
  if (message.length < 8) return false;
  if (!EXPLICIT_ERROR.test(message)) return false;
  if (!CORRECTION.test(message)) return false;
  return true;
}

/** The correction is the whole user message; extraction only trims it for the reflection prompt. */
export function correctionText(text: string): string {
  return String(text ?? "").trim().slice(0, 4000);
}
