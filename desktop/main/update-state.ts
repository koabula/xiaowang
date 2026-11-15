import semver from 'semver';

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
export interface UpdateState {
  currentVersion: string;
  phase: UpdatePhase;
  version?: string;
  percent?: number;
  error?: string;
}
export interface UpdateEngine {
  check(): Promise<string | null>;
  download(progress: (percent: number) => void): Promise<void>;
  install(): Promise<boolean | void>;
}

/** Downloads require a click; installation waits for calls, work and unsaved settings. */
export class UpdateController {
  private state: UpdateState;
  private checking?: Promise<void>;
  private applying?: Promise<void>;
  private downloading?: Promise<void>;
  private downloaded = false;
  private requested = false;
  private readonly engine: UpdateEngine;
  private readonly changed: (state: UpdateState) => void;
  private readonly idle: () => boolean;

  constructor(currentVersion: string, engine: UpdateEngine, changed: (state: UpdateState) => void, idle: () => boolean) {
    this.state = { currentVersion, phase: 'idle' }; this.engine = engine; this.changed = changed; this.idle = idle;
  }
  snapshot(): UpdateState { return { ...this.state }; }
  private patch(patch: Partial<UpdateState>) { this.state = { ...this.state, ...patch }; this.changed(this.snapshot()); }

  check(): Promise<void> {
    if (this.checking) return this.checking;
    if (this.downloading || this.downloaded || this.applying || this.state.phase === 'available') return Promise.resolve();
    this.patch({ phase: 'checking', error: undefined });
    this.checking = this.engine.check().then(version => {
      const newer = version && semver.valid(version) && semver.gt(version, this.state.currentVersion) && !semver.prerelease(version);
      this.patch({ phase: newer ? 'available' : 'idle', version: newer ? version : undefined, percent: undefined });
    }).catch(error => this.patch({ phase: 'error', error: message(error) })).finally(() => { this.checking = undefined; });
    return this.checking;
  }

  async update(): Promise<void> {
    if (!this.state.version) { await this.check(); if (!this.state.version) return; }
    if (this.downloading) return this.downloading;
    if (this.applying) return this.applying;
    if (this.state.phase === 'installing') return;
    if (this.downloaded) { this.requested = true; return this.installWhenIdle(); }
    this.requested = true;
    this.patch({ phase: 'downloading', percent: 0, error: undefined });
    this.downloading = this.engine.download(percent => {
      if (this.state.phase === 'downloading') this.patch({ percent: Math.min(100, Math.max(0, percent)) });
    }).then(() => {
      this.downloaded = true;
      this.patch({ phase: 'ready', percent: 100 });
    }).catch(error => { this.requested = false; this.patch({ phase: 'error', error: message(error) }); })
      .finally(() => { this.downloading = undefined; });
    await this.downloading;
    await this.installWhenIdle();
  }

  installWhenIdle(): Promise<void> {
    if (this.applying) return this.applying;
    if (this.state.phase === 'installing' || !this.requested || !this.downloaded || !this.idle()) return Promise.resolve();
    this.patch({ phase: 'installing', error: undefined });
    this.applying = this.engine.install().then(installed => {
      if (installed === false) this.patch({ phase: 'ready' });
    }).catch(error => {
      this.requested = false;
      this.patch({ phase: 'error', error: message(error) });
    }).finally(() => { this.applying = undefined; });
    return this.applying;
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
