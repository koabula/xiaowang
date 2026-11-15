/** Obvious negation wins; a model's quoted request also supports open-ended wording. */
export function refusesHangup(request: string): boolean {
  return /(?:不要|别|不用|不必|不能|不想|不可以|先不|还不)[^\n，。！？,;；.!?]{0,8}(?:挂|结束.{0,6}(?:通话|电话))|(?:don't|do not|not|never)[^\n,;.!?]{0,12}(?:hang\s*up|end.{0,6}call)/i.test(request);
}
export function canEndCall(request: string, quotedRequest = ""): boolean {
  const end = /挂(?:断|掉|了|吧|电话)|结束.{0,6}(?:通话|电话)|再见|拜拜|goodbye|\bbye\b|hang\s*up|end\s+(?:the\s+)?call/i;
  if (!request.trim() || refusesHangup(request)) return false;
  if (end.test(request)) return true;
  const flat = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const quote = flat(quotedRequest);
  return quote.length >= 3 && flat(request).includes(quote);
}
