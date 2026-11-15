import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);
interface Node { type: string; value?: string; alt?: string | null; children?: Node[] }
function text(node: Node): string {
  if (["html", "definition", "footnoteDefinition"].includes(node.type)) return "";
  if (node.type === "image") return node.alt || "图片";
  if (node.type === "break") return " ";
  if (node.value !== undefined) return node.value;
  const block = ["root", "list", "listItem", "blockquote", "table", "tableRow"].includes(node.type);
  return (node.children ?? []).map(text).join(block ? " " : "");
}
export function messagePreview(markdown: string, max = 42): string {
  const plain = text(parser.parse(markdown) as Node).replace(/\s+/g, " ").trim();
  const chars = Array.from(plain);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : plain;
}
