/** Shared by the file picker and the workspace opening path. */
export function filePreview(name: string): "canvas" | "file" | "unsupported" {
  if (/\.html?$/i.test(name)) return "canvas";
  return /\.(pdf|md|markdown|txt|csv|json|jsonl|png|jpe?g|webp|gif)$/i.test(name) ? "file" : "unsupported";
}
