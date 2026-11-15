import assert from "node:assert/strict";
import { test } from "node:test";
import { messagePreview } from "../src/message-preview.ts";
test("sidebar previews are readable text, preserving code, links, symbols and block spacing", () => {
  assert.equal(messagePreview("## 结论\n\n**核心** [论文](https://example.com) `C#`"), "结论 核心 论文 C#");
  assert.equal(messagePreview("- [x] 完成\n- *继续*\n\n> 引用"), "完成 继续 引用");
  assert.equal(messagePreview("```js\nconst x = 1;\n```\n\n![图表](image.png)"), "const x = 1; 图表");
  assert.equal(messagePreview("| A | B |\n| - | - |\n| 1 | 2 |"), "A B 1 2");
  assert.equal(messagePreview("C# 和 2 * 3"), "C# 和 2 * 3");
  assert.equal(messagePreview("😀😀😀", 2), "😀😀…");
  assert.equal(messagePreview("<script>alert(1)</script>"), "");
});
