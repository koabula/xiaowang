import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  anthropicMessagesUrl,
  configFromEnv,
  createProvider,
  openaiChatUrl,
  toAnthropicMessages,
  toOpenAIMessages,
} from "../src/provider.ts";
import type { ModelMessage } from "../src/types.ts";

test("openai-compatible urls keep the vendor prefix", () => {
  assert.equal(openaiChatUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  assert.equal(openaiChatUrl("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(
    openaiChatUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.equal(
    openaiChatUrl("https://generativelanguage.googleapis.com/v1beta/openai"),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
  assert.equal(anthropicMessagesUrl("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
});

test("config detects claude and allows a local server without a key", () => {
  assert.equal(
    configFromEnv({ XIAOWANG_MODEL: "claude-sonnet-4-5", XIAOWANG_API_KEY: "sk-test" }).apiStyle,
    "anthropic",
  );
  const local = configFromEnv({
    XIAOWANG_MODEL: "llama3.1",
    XIAOWANG_BASE_URL: "http://127.0.0.1:11434/v1",
  });
  assert.equal(local.apiStyle, "openai");
  assert.equal(local.apiKey, "ollama");
  assert.throws(() => configFromEnv({ XIAOWANG_MODEL: "deepseek-chat" }), /XIAOWANG_API_KEY/);
});

test("tool transcripts become openai and anthropic messages", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "第一句" },
    { role: "user", content: "第二句" },
    {
      role: "assistant",
      content: "我先查。",
      toolCalls: [{ id: "c1", name: "search_arxiv", arguments: "{\"query\":\"transformer\"}" }],
    },
    { role: "tool", toolCallId: "c1", content: "找到 1 篇" },
  ];
  const openai = toOpenAIMessages("系统", messages);
  assert.equal((openai[1] as { content: string }).content.includes("第一句"), true);
  assert.equal((openai[1] as { content: string }).content.includes("第二句"), true);
  assert.equal(openai.length, 4);
  const anthropic = toAnthropicMessages(messages) as Array<{ role: string; content: unknown }>;
  assert.equal(anthropic[1]?.role, "assistant");
  assert.equal(anthropic[2]?.role, "user");
  assert.equal(Array.isArray(anthropic[2]?.content), true);
});

test("providers parse tool calls and redact keys from errors", async () => {
  const openai = await listen((body, response) => {
    const json = JSON.parse(body) as { tools: Array<{ function: { name: string } }> };
    assert.equal(json.tools[0]?.function.name, "search_arxiv");
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "bad sk-secret" }));
  });
  const failing = createProvider({
    apiStyle: "openai",
    baseUrl: openai.baseUrl,
    apiKey: "sk-secret",
    model: "dummy",
  });
  await assert.rejects(
    failing.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tools: tool() }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      assert.match(message, /拒绝了密钥/);
      assert.equal(message.includes("sk-secret"), false);
      return true;
    },
  );
  await openai.close();

  const anthropic = await listen((_body, response) => {
    response.end(
      JSON.stringify({
        content: [
          { type: "text", text: "我先记下来。" },
          { type: "tool_use", id: "toolu_1", name: "remember_terms", input: { terms: [{ term: "MoE" }] } },
        ],
      }),
    );
  });
  const provider = createProvider({
    apiStyle: "anthropic",
    baseUrl: anthropic.baseUrl,
    apiKey: "sk-ant",
    model: "claude-test",
  });
  const result = await provider.complete({
    system: "s",
    messages: [{ role: "user", content: "记住 MoE" }],
    tools: tool(),
  });
  assert.match(result.text, /我先记下来/);
  assert.equal(result.toolCalls[0]?.name, "remember_terms");
  assert.match(result.toolCalls[0]?.arguments ?? "", /MoE/);
  await anthropic.close();
});

function tool() {
  return [
    {
      name: "search_arxiv",
      description: "search",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  ];
}

function listen(
  handler: (body: string, response: import("node:http").ServerResponse, authorization: string) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      handler(Buffer.concat(chunks).toString("utf8"), response, request.headers.authorization ?? "");
      if (!response.writableEnded) response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () =>
          new Promise((done, reject) => {
            server.close((error) => (error ? reject(error) : done()));
          }),
      });
    });
  });
}
