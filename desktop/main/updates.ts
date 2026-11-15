import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js';
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js';
import type { UpdateInfo } from 'electron-updater';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareMacUpdate, launchMacInstaller, type PreparedMacUpdate } from './mac-update.ts';
import type { UpdateEngine } from './update-state.ts';

const { AppUpdater } = electronUpdater;

/** Keep electron-updater's authenticated feed handling, caching and SHA-512 checks.
 * Install macOS bundles with our transactional helper so unsigned builds work too. */
class MacZipUpdater extends AppUpdater {
  private readonly downloader = new ElectronHttpExecutor();
  constructor() { super(undefined); }
  protected override async doDownloadUpdate(options: DownloadUpdateOptions) {
    const { provider, info } = options.updateInfoAndProvider;
    const files = provider.resolveFiles(info);
    const zip = files.find(file => file.url.pathname.endsWith(`-mac-${process.arch}.zip`))
      ?? files.find(file => file.url.pathname.endsWith('-mac-universal.zip'));
    if (!zip) throw new Error('此 Release 未提供适合当前 Mac 的更新包。');
    if (!zip.info.sha512) throw new Error('更新包缺少完整性校验信息。');
    return this.executeDownload({
      fileExtension: 'zip', fileInfo: zip, downloadUpdateOptions: options,
      task: (destination, downloadOptions) => this.downloader.download(zip.url, destination, downloadOptions),
      done: async event => { this.dispatchUpdateDownloaded(event); },
    });
  }
  override quitAndInstall(): void { throw new Error('Mac updates must use the prepared transactional installer.'); }
}

export function createUpdateEngine(idle: () => boolean): UpdateEngine {
  // The loopback-only override is for isolated desktop fixtures; never accepts a
  // feed supplied by a renderer, webpage, model tool, or remote configuration.
  const override = process.env.XIAOWANG_UPDATE_TEST_FEED;
  if (override) {
    const url = new URL(override);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('测试更新地址必须是本机服务。');
  }
  const updater = process.platform === 'darwin' ? new MacZipUpdater() : electronUpdater.autoUpdater;
  if (override) {
    const config = { provider: 'generic' as const, url: override, updaterCacheDirName: `xiaowang-test-${createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)}` };
    const configPath = path.join(app.getPath('userData'), 'test-app-update.yml');
    writeFileSync(configPath, JSON.stringify(config));
    updater.updateConfigPath = configPath;
    updater.setFeedURL(config); updater.forceDevUpdateConfig = true;
    updater.disableDifferentialDownload = true;
  }
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  // Expected failures are handled by the action's promise, including offline and
  // repositories which have not published their first release yet.
  updater.on('error', error => console.warn('Update:', error.message));
  let latest: UpdateInfo | undefined;
  let downloadedFile: string | undefined;
  let prepared: PreparedMacUpdate | undefined;
  updater.on('update-downloaded', event => { downloadedFile = event.downloadedFile; });
  return {
    async check() {
      if (!app.isPackaged && !override) return null;
      const result = await updater.checkForUpdates();
      latest = result?.updateInfo;
      return latest?.version ?? null;
    },
    async download(progress) {
      downloadedFile = undefined;
      const handler = (value: { percent: number }) => progress(value.percent);
      updater.on('download-progress', handler);
      try {
        const files = await updater.downloadUpdate();
        downloadedFile ??= files[0];
        if (!downloadedFile) throw new Error('更新下载未完成，请重试。');
      } finally { updater.removeListener('download-progress', handler); }
    },
    async install() {
      if (!app.isPackaged || !latest || !downloadedFile) throw new Error('请使用安装后的应用进行自动更新。');
      if (process.platform === 'darwin') {
        prepared ??= await prepareMacUpdate(downloadedFile, path.resolve(path.dirname(process.execPath), '../..'), latest.version);
        if (!idle()) return false;
        await launchMacInstaller(prepared, app.getPath('userData'));
        app.quit();
      } else {
        if (!idle()) return false;
        updater.quitAndInstall(true, true);
      }
    },
  };
}
