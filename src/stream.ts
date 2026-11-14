/** Decode SSE across arbitrary UTF-8/chunk boundaries, including multiline data. */
export async function* readEventStream(response: Response): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) throw new Error("模型服务没有返回响应内容。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done && buffer && !buffer.endsWith("\n")) buffer += "\n";
      let at: number;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, at).replace(/\r$/, "");
        buffer = buffer.slice(at + 1);
        if (!line) {
          if (data.length) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
      if (chunk.done) break;
    }
    if (data.length) yield { event, data: data.join("\n") };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function requestSignal(signal?: AbortSignal, timeout = 120_000): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}
