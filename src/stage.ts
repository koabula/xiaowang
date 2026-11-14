/** 桌面右栏与应用内浏览器。命令行里这两项没有窗口。 */

export type StageView =
  | { mode: "file"; id: string; filename: string; page: number }
  | { mode: "browser"; url: string }
  | { mode: "slides"; title: string; pages: string[] };

export interface StageDriver {
  show(view: StageView): void;
}

export interface BrowserDriver {
  holder(): "bot" | "user";
  navigate(url: string): Promise<string>;
  snapshot(): Promise<string>;
  click(target: string): Promise<string>;
  type(target: string, text: string): Promise<string>;
  scroll(direction: "up" | "down"): Promise<string>;
  back(): Promise<string>;
}

const SENSITIVE = /支付|付款|下单|提交订单|删除|注销|购买|pay\b|purchase|checkout|submit|delete account/i;

export function isSensitiveBrowserTarget(target: string): boolean {
  return SENSITIVE.test(target);
}

export function assertHttpUrl(value: string): string | { error: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: "需要一个完整的 http 或 https 地址。" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "浏览器只打开 http 和 https。" };
  }
  return url.toString();
}

export function splitSlides(markdown: string): string[] {
  const pages = markdown
    .split(/\n---\n/)
    .map((page) => page.trim())
    .filter(Boolean);
  return pages.length > 0 ? pages : ["（这一份还没有内容）"];
}

export const BROWSER_ABSENT = "应用内浏览器还没接上。请在桌面端打开右栏的浏览器。";
export const USER_HAS_BROWSER = "用户正在控制浏览器。等用户点「停止」交还之后再操作。页面可以先用 browser_snapshot 看。";
