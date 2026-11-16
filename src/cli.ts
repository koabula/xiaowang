#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contextUsage } from "./context-manager.ts";
import { runTurn, type StepEvent } from "./harness.ts";
import { formatVoiceBrief, projectVoiceBrief } from "./project.ts";
import { configFromEnv, createProvider } from "./provider.ts";
import { Runtime } from "./runtime.ts";
import { resolveHome } from "./store.ts";
import type { LlmProvider, SessionEvent } from "./types.ts";

const HELP = `小王同学（无头内核）

用法
  xiaowang                         在终端里和当前 Bot 对话
  xiaowang ask [--bot slug] 问题   问一句就退出
  xiaowang bots                    列出项目
  xiaowang new <任务名> [--baseline 任务说明]
  xiaowang add <文件> [--bot slug] 把 PDF 或文本放进资料库，并引用到当前项目
  xiaowang library [slug]          列出当前项目引用的原件
  xiaowang share <id或文件名> --to <slug> [--from slug]
  xiaowang stats [slug]            输出 token、缓存用量与投影检查点统计
  xiaowang events [slug]           打印只追加的会话记录
  xiaowang brief [slug]            打印给实时语音准备的薄上下文
  xiaowang help

对话里的命令
  /bots    /use <slug>    /new <项目名>
  /library /events        /brief
  /help    /quit

环境变量
  XIAOWANG_HOME        数据目录，默认 ~/.xiaowang
  XIAOWANG_API_STYLE   openai 或 anthropic。不设时，claude 走 anthropic，其余走 OpenAI 兼容接口
  XIAOWANG_BASE_URL    接口前缀。OpenAI 兼容接口会在后面接 /chat/completions
  XIAOWANG_API_KEY     密钥。只放在环境变量里，不会写入会话或工作区
  XIAOWANG_MODEL       模型名

例子
  export XIAOWANG_BASE_URL=https://api.deepseek.com/v1
  export XIAOWANG_API_KEY=sk-...
  export XIAOWANG_MODEL=deepseek-chat
  xiaowang ask 检索 speculative decoding 的代表论文，并写一份笔记

  export XIAOWANG_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
  export XIAOWANG_MODEL=qwen-plus

  export XIAOWANG_API_STYLE=anthropic
  export XIAOWANG_MODEL=claude-sonnet-4-5
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    if (!command && input.isTTY) {
      await withRuntime((runtime) => repl(runtime));
      return;
    }
    output.write(HELP);
    return;
  }

  await withRuntime(async (runtime) => {
    if (command === "bots") {
      printBots(runtime);
      return;
    }
    if (command === "stats") {
      const bot = args[1] ? runtime.store.requireBot(args[1]) : runtime.activeBot();
      output.write(JSON.stringify(contextUsage(runtime.store, bot.id), null, 2) + "\n");
      return;
    }
    if (command === "events") {
      printEvents(runtime, args[1]);
      return;
    }
    if (command === "brief") {
      printBrief(runtime, args[1]);
      return;
    }
    if (command === "new") {
      createFromCli(runtime, args.slice(1));
      return;
    }
    if (command === "add") {
      addFromCli(runtime, args.slice(1));
      return;
    }
    if (command === "library") {
      printLibrary(runtime, args[1]);
      return;
    }
    if (command === "share") {
      shareFromCli(runtime, args.slice(1));
      return;
    }
    if (command === "ask") {
      await ask(runtime, args.slice(1));
      return;
    }
    if (command === "repl") {
      const slug = args[1];
      if (slug) runtime.store.setActiveBot(runtime.store.requireBot(slug).id);
      if (!input.isTTY) throw new Error("repl 需要在终端里运行。一次性提问用 xiaowang ask。");
      await repl(runtime);
      return;
    }
    throw new Error(`未知命令：${command}。运行 xiaowang help 查看用法。`);
  });
}

async function withRuntime(fn: (runtime: Runtime) => Promise<void> | void): Promise<void> {
  const runtime = Runtime.open(resolveHome());
  try {
    await fn(runtime);
  } finally {
    runtime.close();
  }
}

async function repl(runtime: Runtime): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const current = runtime.activeBot();
  output.write(`${current.name}（${current.slug}）\n输入 /help 查看命令。\n`);
  try {
    while (true) {
      const line = (await rl.question("你: ")).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/help") {
        output.write(HELP);
        continue;
      }
      try {
        if (line === "/bots") printBots(runtime);
        else if (line === "/events") printEvents(runtime);
        else if (line === "/brief") printBrief(runtime);
        else if (line === "/library") printLibrary(runtime);
        else if (line.startsWith("/use ")) switchBot(runtime, line.slice(5).trim());
        else if (line.startsWith("/new ")) createFromCli(runtime, splitArgs(line.slice(5)));
        else {
          const provider = createProvider(configFromEnv());
          await runAndPrint(runtime, runtime.activeBot().id, line, provider);
        }
      } catch (error) {
        output.write(`${errorMessage(error)}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

async function ask(runtime: Runtime, args: string[]): Promise<void> {
  const { positionals, flags } = parseFlags(args);
  const question = positionals.join(" ").trim();
  if (!question) throw new Error("用法：xiaowang ask [--bot slug] 你的问题");
  const provider = createProvider(configFromEnv());
  if (typeof flags.bot === "string") {
    runtime.store.setActiveBot(runtime.store.requireBot(flags.bot).id);
  }
  output.write(`你: ${question}\n`);
  await runAndPrint(runtime, runtime.activeBot().id, question, provider);
}

async function runAndPrint(
  runtime: Runtime,
  botId: string,
  text: string,
  provider: LlmProvider,
): Promise<void> {
  let lastSlug = runtime.store.requireBot(botId).slug;
  try {
    const turn = await runTurn(runtime, {
      botId,
      input: text,
      provider,
      onStep(step) {
        if (step.bot.slug !== lastSlug) {
          output.write(`\n—— ${step.bot.name}（${step.bot.slug}）——\n`);
          lastSlug = step.bot.slug;
        }
        printStep(step);
      },
    });
    if (turn.skippedKickoffs > 0) {
      output.write(`还有 ${turn.skippedKickoffs} 个首轮调研只记在新项目的会话里，没有自动开始。\n`);
    }
  } catch (error) {
    throw new Error(`${errorMessage(error)}\n这句话已经记在会话里。`);
  }
}

function printStep(step: StepEvent): void {
  if (step.kind === "assistant") {
    if (step.text.trim()) output.write(`${step.bot.name}: ${step.text}\n`);
    return;
  }
  const status = step.isError ? "失败" : "完成";
  const preview = step.text.replace(/\s+/g, " ").slice(0, 160);
  output.write(`${dim(`  · ${step.name} ${status} ${preview}`)}\n`);
}

function printBots(runtime: Runtime): void {
  const activeId = runtime.activeBot().id;
  for (const bot of runtime.store.listBots()) {
    const mark = bot.id === activeId ? "*" : " ";
    const parent = bot.parentBotId ? runtime.store.getBot(bot.parentBotId)?.slug : "";
    const from = parent ? `来自 ${parent}` : "总入口";
    output.write(`${mark} ${bot.slug}\t${bot.name}\t${from}\n`);
  }
}

function printEvents(runtime: Runtime, slug?: string): void {
  const bot = slug ? runtime.store.requireBot(slug) : runtime.activeBot();
  output.write(`${bot.name}（${bot.slug}） ${bot.workspaceDir}\n`);
  const events = runtime.store.getEvents(bot.id);
  if (events.length === 0) {
    output.write("（还没有事件）\n");
    return;
  }
  for (const stored of events) {
    output.write(`${stored.id}\t${summarize(stored.event)}\n`);
  }
}

function printBrief(runtime: Runtime, slug?: string): void {
  const bot = slug ? runtime.store.requireBot(slug) : runtime.activeBot();
  const library = runtime.store.listLibrary(bot.id);
  output.write(
    `${formatVoiceBrief(projectVoiceBrief(bot, runtime.store.getEvents(bot.id), { library }), runtime.ensureSteward().name)}\n`,
  );
}

function printLibrary(runtime: Runtime, slug?: string): void {
  const bot = slug ? runtime.store.requireBot(slug) : runtime.activeBot();
  output.write(`${bot.name}（${bot.slug}）的资料库\n`);
  const refs = runtime.store.listLibrary(bot.id);
  if (refs.length === 0) {
    output.write("（还没有引用）\n");
    return;
  }
  for (const ref of refs) {
    output.write(`${ref.id}\t${ref.filename}\t${ref.byteSize}B\n`);
  }
}

function addFromCli(runtime: Runtime, args: string[]): void {
  const { positionals, flags } = parseFlags(args);
  const filePath = positionals.join(" ").trim();
  if (!filePath) throw new Error("用法：xiaowang add <文件> [--bot slug]");
  const bot = typeof flags.bot === "string" ? runtime.store.requireBot(flags.bot) : runtime.activeBot();
  const abs = expandUserPath(filePath);
  const stat = statSync(abs, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`找不到文件：${abs}`);
  const added = runtime.store.addLibraryBytes(bot.id, path.basename(abs), readFileSync(abs));
  const verb = added.alreadyReferenced ? "已经在当前项目里" : added.deduped ? "已为当前项目加上引用" : "已放入资料库";
  output.write(`${verb}：${added.ref.id} ${added.ref.filename}\n${bot.slug}\n`);
}

function shareFromCli(runtime: Runtime, args: string[]): void {
  const { positionals, flags } = parseFlags(args);
  const query = positionals.join(" ").trim();
  const to = typeof flags.to === "string" ? flags.to : "";
  if (!query || !to) throw new Error("用法：xiaowang share <id或文件名> --to <slug> [--from slug]");
  const source = typeof flags.from === "string" ? runtime.store.requireBot(flags.from) : runtime.activeBot();
  const target = runtime.store.requireBot(to);
  const ref = runtime.store.shareLibraryFile(source.id, query, target.id);
  output.write(`已把 ${ref.filename}（${ref.id}）交给 ${target.name}（${target.slug}）\n`);
}

function expandUserPath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return path.join(homedir(), filePath.slice(2));
  return path.resolve(filePath);
}

function createFromCli(runtime: Runtime, args: string[]): void {
  const { positionals, flags } = parseFlags(args);
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("用法：xiaowang new <任务名> [--baseline 任务说明]");
  const baseline = typeof flags.baseline === "string" ? flags.baseline : "（尚未写入任务说明）";
  const parent = runtime.activeBot();
  const bot = runtime.store.createBot({
    name,
    systemPrompt: baseline,
    parentBotId: parent.id,
  });
  runtime.store.append(bot.id, { type: "baseline", text: baseline, fromBotId: parent.id });
  output.write(`已建立 ${bot.name}（${bot.slug}）\n${bot.workspaceDir}\n`);
}

function switchBot(runtime: Runtime, slug: string): void {
  const bot = runtime.store.requireBot(slug);
  runtime.store.setActiveBot(bot.id);
  output.write(`已切换到 ${bot.name}（${bot.slug}）\n`);
}

function summarize(event: SessionEvent): string {
  switch (event.type) {
    case "context_scope":
      return `context_scope\t${event.model}\tv${event.projectorVersion}`;
    case "context_state":
      return `context_state\t${event.key}`;
    case "context_append":
    case "context_checkpoint":
      return `${event.type}\tepoch=${event.epoch}\tentries=${event.entries.length}\tthrough=${event.throughEventId}`;
    case "model_usage":
      return `model_usage\t${event.model}\tinput=${event.usage?.inputTokens ?? "?"}\tcache=${event.usage?.cacheReadTokens ?? "?"}\t${event.durationMs}ms`;
    case "user_text":
      return `user_text\t${oneLine(event.text)}`;
    case "assistant_turn": {
      const tools = event.toolCalls.map((call) => call.name).filter(Boolean).join(",");
      const suffix = tools ? `\ttools=${tools}` : "";
      return `assistant\t${oneLine(event.text)}${suffix}`;
    }
    case "tool_result":
      return `tool_result\t${event.name}\t${event.isError ? "失败" : "完成"}\t${oneLine(event.output)}`;
    case "baseline":
      return `baseline\t${oneLine(event.text)}`;
    case "artifact":
      return `artifact\t${event.path}\t${event.bytes}B`;
    default:
      return "unknown";
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function splitArgs(line: string): string[] {
  return line.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
}

function dim(text: string): string {
  return output.isTTY ? `\u001b[2m${text}\u001b[0m` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  main().catch((error: unknown) => {
    output.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
