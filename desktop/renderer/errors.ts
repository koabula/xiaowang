export function plainError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Error invoking remote method '[^']+': Error: /, "");
  if (message.includes("content or tool_calls")) return "模型服务拒绝了一条空的助手记录。再发一次就可以。";
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}
