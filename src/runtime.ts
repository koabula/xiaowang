import { createHash } from "node:crypto";
import { ContextManager } from "./context-manager.ts";
import type { LlmProvider, ToolSchema } from "./types.ts";
import path from "node:path";
import { STEWARD_BASELINE, STEWARD_NAME, STEWARD_PROMPT, STEWARD_SLUG } from "./persona.ts";
import { resolveHome, Store } from "./store.ts";
import type { Bot, Kickoff } from "./types.ts";

/** 无界面的运行时。桌面端以后挂在同一个 Store 和同一套循环上。 */
export class Runtime {
  private readonly contexts = new Map<string, ContextManager>();
  readonly kickoffs: Kickoff[] = [];
  readonly store: Store;

  private constructor(store: Store) {
    this.store = store;
  }

  static open(home = resolveHome()): Runtime {
    const runtime = new Runtime(Store.open(home));
    runtime.ensureSteward();
    return runtime;
  }

  close(): void {
    this.store.close();
  }

  ensureSteward(): Bot {
    const existing = this.store.getBot(STEWARD_SLUG);
    if (existing) return existing;
    const bot = this.store.createBot({
      name: STEWARD_NAME,
      slug: STEWARD_SLUG,
      systemPrompt: STEWARD_PROMPT,
    });
    this.store.append(bot.id, { type: "baseline", text: STEWARD_BASELINE });
    this.store.setActiveBot(bot.id);
    return bot;
  }

  activeBot(): Bot {
    const id = this.store.getActiveBotId();
    if (id) {
      const bot = this.store.getBot(id);
      if (bot) return bot;
    }
    const steward = this.ensureSteward();
    this.store.setActiveBot(steward.id);
    return steward;
  }

  enqueueKickoff(job: Kickoff): void {
    this.kickoffs.push(job);
  }

  modelContext(bot: Bot, system: string, tools: ToolSchema[], provider: LlmProvider): ContextManager {
    const key = createHash("sha256").update(JSON.stringify([bot.id, provider.contextKey ?? provider.model, provider.contextPolicy, system, tools])).digest("hex");
    let context = this.contexts.get(key);
    if (!context) { context = new ContextManager(this.store, bot.id, system, tools, provider); this.contexts.set(key, context); }
    return context;
  }

  botWorkspace(bot: Bot): string {
    return path.resolve(bot.workspaceDir);
  }
}
