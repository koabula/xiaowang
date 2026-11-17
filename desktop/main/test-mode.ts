import { app, clipboard, type BrowserWindowConstructorOptions } from "electron";

// Set only by the desktop test launcher; normal and development launches are unchanged.
export const backgroundTest = process.env.XIAOWANG_E2E_MODE === "background";
if (backgroundTest && process.platform === "darwin") app.setActivationPolicy("accessory");
if (backgroundTest && process.platform === "linux") {
  // Xvfb has no display-driven GPU frame clock for an unmapped native window.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-frame-rate-limit");
}
// Playwright's Electron loader forces basic_text on Linux. Exercise the CI
// session's real keyring so persistence tests retain the production guarantees.
if (process.platform === "linux" && (backgroundTest || process.env.XIAOWANG_E2E_MODE === "native")) {
  app.commandLine.appendSwitch("password-store", "gnome-libsecret");
}

declare global {
  var __xwBackgroundAudit: { shown: number[]; focused: number[]; clipboard: string[] } | undefined;
}
if (backgroundTest) {
  const audit = globalThis.__xwBackgroundAudit = { shown: [] as number[], focused: [] as number[], clipboard: [] as string[] };
  app.on("browser-window-created", (_event, window) => {
    if (window.isVisible()) audit.shown.push(window.id);
    if (window.isFocused()) audit.focused.push(window.id);
    window.on("show", () => audit.shown.push(window.id));
    window.on("focus", () => audit.focused.push(window.id));
    window.webContents.setAudioMuted(true);
  });
  // A mistakenly added clipboard operation fails before touching the user's data.
  const api = clipboard as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(api)) if (typeof value === "function" && /^(read|write|clear)/.test(name)) {
    api[name] = () => { audit.clipboard.push(name); throw new Error(`系统剪贴板操作 ${name} 只允许在原生专项测试中执行。`); };
  }
}

export function testWindowOptions(): BrowserWindowConstructorOptions {
  return backgroundTest ? {
    show: false, focusable: false, skipTaskbar: true, paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false, focusOnNavigation: false },
  } : {};
}
