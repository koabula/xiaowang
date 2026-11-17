import type { BrowserWindow, Session, WebContents } from "electron";
import { fileURLToPath } from "node:url";
import { assertHttpUrl } from "../../src/stage.ts";

/** Match the application document, never every file URL or every page on the dev origin. */
export function isAppPage(value: string, entry: string): boolean {
  try {
    const url = new URL(value), app = new URL(entry);
    if (url.protocol !== app.protocol || url.host !== app.host) return false;
    // Chromium may render an unreserved character literally (e.g. RUNNER~1),
    // while Node's pathToFileURL encodes it. Compare the actual file paths.
    return url.protocol === "file:"
      ? fileURLToPath(url) === fileURLToPath(app)
      : url.pathname === app.pathname;
  } catch { return false; }
}

export function protectAppWindow(window: BrowserWindow, entry: string, openExternal: (url: string) => Promise<void>): void {
  const contents = window.webContents;
  contents.on("will-navigate", (event, url) => { if (!isAppPage(url, entry)) event.preventDefault(); });
  contents.on("will-redirect", (event, url) => { if (!isAppPage(url, entry)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    const checked = assertHttpUrl(url);
    if (typeof checked === "string") void openExternal(checked).catch(() => {});
    return { action: "deny" };
  });
}

export function configurePagePermissions(appSession: Session, browserSession: Session, owner: () => BrowserWindow | null, entry: string): void {
  const trusted = (contents: WebContents | null, url: string | undefined, main: boolean) => Boolean(
    contents && contents === owner()?.webContents && main && isAppPage(contents.getURL(), entry) && url && isAppPage(url, entry),
  );
  appSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permission === "media" && details.mediaType === "audio" && trusted(contents, details.requestingUrl, details.isMainFrame));
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const media = "mediaTypes" in details ? details.mediaTypes : undefined;
    callback(permission === "media" && Boolean(media?.length) && media!.every(type => type === "audio")
      && trusted(contents, details.requestingUrl, details.isMainFrame));
  });
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setDevicePermissionHandler(() => false);
}
