import { REALTIME_SERVICES, realtimeServicesForSettings, resolveRealtime, type RealtimeServiceId } from "./realtime-catalog.ts";

export interface VoiceProfile { model: string; voice: string; region: string; workspace: string; url: string; key: string }
export type VoiceProfilePatch = Partial<VoiceProfile> & { clearKey?: boolean };
export type VoiceProfileView = Omit<VoiceProfile, "key"> & { keyHint: string };
export const CONTEXT_SETTINGS = {
  contextProfile: "XIAOWANG_CONTEXT_PROFILE", contextWindow: "XIAOWANG_CONTEXT_WINDOW",
  contextHighWater: "XIAOWANG_CONTEXT_HIGH_WATER_TOKENS", contextLowWater: "XIAOWANG_CONTEXT_LOW_WATER_TOKENS",
  contextOutput: "XIAOWANG_MAX_OUTPUT_TOKENS", contextSafety: "XIAOWANG_CONTEXT_SAFETY_TOKENS",
  modelContextWindow: "XIAOWANG_MODEL_CONTEXT_WINDOW",
} as const;
export interface ContextSettings {
  contextProfile?: string; contextWindow?: string; contextHighWater?: string; contextLowWater?: string;
  contextOutput?: string; contextSafety?: string; modelContextWindow?: string;
}
export interface SecretRecord extends ContextSettings {
  model: string; baseUrl: string; apiStyle: string; apiKey: string;
  textKeys?: Record<string, string>;
  realtimeModel: string; realtimeUrl: string; realtimeKey: string; realtimeService: string;
  realtimeVoice: string; realtimeRegion: string; realtimeWorkspace: string; locale: string;
  realtimeProfiles?: Partial<Record<RealtimeServiceId, VoiceProfile>>;
}
export interface SecretPatch extends ContextSettings {
  model?: string; baseUrl?: string; apiStyle?: string; apiKey?: string;
  realtimeModel?: string; realtimeUrl?: string; realtimeKey?: string; realtimeService?: string;
  realtimeVoice?: string; realtimeRegion?: string; realtimeWorkspace?: string; locale?: string;
  realtimeProfiles?: Partial<Record<RealtimeServiceId, VoiceProfilePatch>>;
}
export interface SettingsView extends Omit<SecretRecord, "apiKey" | "textKeys" | "realtimeKey" | "realtimeProfiles"> {
  keyHint: string; realtimeKeyHint: string; ready: boolean;
  textKeyHints?: Record<string, string>;
  realtimeProfiles?: Partial<Record<RealtimeServiceId, VoiceProfileView>>;
}
export const EMPTY_SETTINGS: SecretRecord = {
  model: "", baseUrl: "", apiStyle: "", apiKey: "", realtimeModel: "", realtimeUrl: "", realtimeKey: "", realtimeService: "",
  realtimeVoice: "", realtimeRegion: "", realtimeWorkspace: "", locale: "zh",
};
const fields = ["model", "voice", "region", "workspace", "url", "key"] as const;
const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const clean = (input: unknown): string => typeof input === "string" ? input.trim() : "";
export const keyHint = (key: string, persisted = true): string => key ? `${persisted ? "已保存" : "仅本次使用"} ····${key.slice(-4)}` : "";
export function textServiceOrigin(settings: Pick<SecretRecord, "baseUrl" | "apiStyle" | "model">): string {
  const anthropic = settings.apiStyle === "anthropic" || !settings.apiStyle && settings.model.startsWith("claude");
  try {
    const url = new URL(settings.baseUrl || (anthropic ? "https://api.anthropic.com" : "https://api.openai.com"));
    return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
  } catch { return ""; }
}
function profile(service: RealtimeServiceId, input: Partial<VoiceProfile> = {}): VoiceProfile {
  const choice = resolveRealtime({ service, ...input });
  return { model: choice.model, voice: choice.voice, region: choice.region, workspace: service === "qwen" ? choice.workspace : "", url: choice.url, key: input.key ?? "" };
}
export function voiceProfiles(current: SecretRecord): Partial<Record<RealtimeServiceId, VoiceProfile>> {
  const profiles: Partial<Record<RealtimeServiceId, VoiceProfile>> = {};
  for (const { id } of REALTIME_SERVICES) {
    const value = current.realtimeProfiles?.[id];
    if (value) profiles[id] = profile(id, value);
  }
  // A legacy key belongs only to its originally selected service, never every service.
  const selected = resolveRealtime({ service: current.realtimeService, url: current.realtimeUrl }).service;
  if (!profiles[selected]) profiles[selected] = profile(selected, { model: current.realtimeModel, voice: current.realtimeVoice,
    region: current.realtimeRegion, workspace: current.realtimeWorkspace, url: current.realtimeUrl, key: current.realtimeKey });
  return profiles;
}
export function readSettings(input: unknown): SecretRecord {
  const raw = record(input), result = { ...EMPTY_SETTINGS };
  for (const name of Object.keys(EMPTY_SETTINGS) as Array<Exclude<keyof SecretRecord, "realtimeProfiles" | "textKeys">>) {
    if (typeof raw[name] === "string") result[name] = raw[name] as string;
  }
  const profiles = record(raw.realtimeProfiles); result.realtimeProfiles = {};
  result.textKeys = {};
  for (const [origin, key] of Object.entries(record(raw.textKeys))) {
    if (typeof key === "string" && textServiceOrigin({ baseUrl: origin, apiStyle: "", model: "" }) === origin) result.textKeys[origin] = key;
  }
  for (const { id } of REALTIME_SERVICES) if (Object.hasOwn(profiles, id)) {
    const entry = record(profiles[id]), value: Partial<VoiceProfile> = {};
    for (const name of fields) if (typeof entry[name] === "string") value[name] = clean(entry[name]);
    result.realtimeProfiles[id] = profile(id, value);
  }
  return mergeSettings(result, {});
}
/** Pure merge used both for saving and unsaved previews. Blank keys retain only their own profile. */
export function mergeSettings(current: SecretRecord, patch: SecretPatch): SecretRecord {
  const next = { ...current }, profiles = voiceProfiles(current);
  const textKeys = { ...current.textKeys }, previousOrigin = textServiceOrigin(current);
  if (previousOrigin && current.apiKey) textKeys[previousOrigin] = current.apiKey;
  for (const name of ["model", "baseUrl", "apiStyle"] as const) {
    if (typeof patch[name] === "string") next[name] = clean(patch[name]);
  }
  const origin = textServiceOrigin(next), suppliedKey = clean(patch.apiKey);
  if (origin && suppliedKey) textKeys[origin] = suppliedKey;
  next.apiKey = origin ? textKeys[origin] ?? "" : "";
  next.textKeys = textKeys;
  for (const name of Object.keys(CONTEXT_SETTINGS) as Array<keyof ContextSettings>) delete next[name];
  if (typeof patch.locale === "string") next.locale = patch.locale.trim() === "en" ? "en" : "zh";
  const incoming = record(patch.realtimeProfiles);
  for (const { id } of REALTIME_SERVICES) if (Object.hasOwn(incoming, id)) {
    const entry = record(incoming[id]), value = { ...(profiles[id] ?? profile(id)) };
    for (const name of fields) if (typeof entry[name] === "string" && (name !== "key" || clean(entry[name]))) value[name] = clean(entry[name]);
    if (entry.clearKey === true && !clean(entry.key)) value.key = "";
    profiles[id] = profile(id, value);
  }
  const selected = resolveRealtime({ service: patch.realtimeService ?? current.realtimeService, url: patch.realtimeUrl ?? current.realtimeUrl }).service;
  const value = { ...(profiles[selected] ?? profile(selected)) };
  const mapping = { realtimeModel: "model", realtimeVoice: "voice", realtimeRegion: "region", realtimeWorkspace: "workspace", realtimeUrl: "url", realtimeKey: "key" } as const;
  for (const [flat, field] of Object.entries(mapping) as Array<[keyof typeof mapping, typeof fields[number]]>) {
    if (typeof patch[flat] === "string" && (field !== "key" || clean(patch[flat]))) value[field] = clean(patch[flat]);
  }
  const active = profile(selected, value); profiles[selected] = active;
  return { ...next, realtimeProfiles: profiles, realtimeService: selected, realtimeModel: active.model, realtimeVoice: active.voice,
    realtimeRegion: active.region, realtimeWorkspace: active.workspace, realtimeUrl: active.url, realtimeKey: active.key };
}
export function publicSettings(secrets: SecretRecord, persisted?: SecretRecord): SettingsView {
  const { apiKey, textKeys: _textKeys, realtimeKey, realtimeProfiles: _private, ...rest } = secrets;
  const profiles = voiceProfiles(secrets), views: Partial<Record<RealtimeServiceId, VoiceProfileView>> = {};
  const storedProfiles = persisted ? voiceProfiles(persisted) : profiles;
  for (const { id } of REALTIME_SERVICES) {
    const value = profiles[id]; if (!value) continue;
    const { key, ...options } = value; views[id] = { ...options, keyHint: keyHint(key, storedProfiles[id]?.key === key) };
  }
  const storedTextKey = persisted ? mergeSettings(persisted, { baseUrl: secrets.baseUrl, apiStyle: secrets.apiStyle, model: secrets.model }).apiKey : apiKey;
  const currentTextKeys = { ...secrets.textKeys, [textServiceOrigin(secrets)]: apiKey };
  const storedTextKeys = persisted ? { ...persisted.textKeys, [textServiceOrigin(persisted)]: persisted.apiKey } : currentTextKeys;
  const textKeyHints = Object.fromEntries(Object.entries(currentTextKeys).filter(([origin, key]) => origin && key).map(([origin, key]) => [origin, keyHint(key, storedTextKeys[origin] === key)]));
  const selected = resolveRealtime({ service: secrets.realtimeService }).service;
  return { ...rest, keyHint: keyHint(apiKey, storedTextKey === apiKey), textKeyHints, realtimeKeyHint: keyHint(realtimeKey, storedProfiles[selected]?.key === realtimeKey), realtimeProfiles: views,
    ready: Boolean(secrets.model) && (Boolean(apiKey) || /localhost|127\.0\.0\.1/.test(secrets.baseUrl)) };
}

/** Save only deliberate edits, not unchanged values supplied by an environment overlay. */
export function settingsPatchForSave(current: SecretRecord, patch: SecretPatch): SecretPatch {
  const changed: SecretPatch = {};
  for (const name of Object.keys(EMPTY_SETTINGS) as Array<Exclude<keyof SecretRecord, "realtimeProfiles" | "textKeys">>) {
    const value = patch[name];
    if (typeof value !== "string") continue;
    if (name === "apiKey" || name === "realtimeKey" ? Boolean(clean(value)) : clean(value) !== current[name]) changed[name] = value;
  }
  // An explicitly entered key must be saved with the endpoint currently being edited,
  // even when that endpoint originally came from the environment.
  if (clean(patch.apiKey)) {
    changed.baseUrl = patch.baseUrl ?? current.baseUrl;
    changed.apiStyle = patch.apiStyle ?? current.apiStyle;
    if (!clean(changed.baseUrl)) changed.model = patch.model ?? current.model;
  }
  if (clean(patch.realtimeKey)) {
    for (const name of ["realtimeService", "realtimeUrl", "realtimeModel", "realtimeVoice", "realtimeRegion", "realtimeWorkspace"] as const) changed[name] = patch[name] ?? current[name];
  }
  const profiles = voiceProfiles(current);
  for (const { id } of REALTIME_SERVICES) {
    const incoming = patch.realtimeProfiles?.[id]; if (!incoming) continue;
    const previous = profiles[id] ?? profile(id), edited: VoiceProfilePatch = {};
    for (const field of fields) {
      const value = incoming[field];
      if (typeof value === "string" && (field === "key" ? Boolean(clean(value)) : clean(value) !== previous[field])) edited[field] = value;
    }
    if (clean(incoming.key)) for (const field of fields) edited[field] = incoming[field] ?? previous[field];
    if (incoming.clearKey) edited.clearKey = true;
    if (Object.keys(edited).length) (changed.realtimeProfiles ??= {})[id] = edited;
  }
  return changed;
}

export function withoutSecretKeys(settings: SecretRecord): SecretRecord {
  const next = structuredClone(settings);
  next.apiKey = ""; next.textKeys = {}; next.realtimeKey = "";
  for (const value of Object.values(next.realtimeProfiles ?? {})) if (value) value.key = "";
  return next;
}

/** Apply desktop availability without deleting an inactive provider's saved credentials. */
export function availableRealtimeSettings(current: SecretRecord, experimentalMossEnabled = false): SecretRecord {
  if (experimentalMossEnabled || resolveRealtime({ service: current.realtimeService, url: current.realtimeUrl }).service !== "moss") return current;
  const profiles = voiceProfiles(current), available = realtimeServicesForSettings();
  const fallback = available.find(({ id }) => profiles[id]?.key.trim() && profiles[id]?.url) ?? available[0]!;
  return mergeSettings(current, { realtimeService: fallback.id });
}

/** Legacy values cannot override automatically resolved model budgets. */
export function contextEnvironment(_record: ContextSettings, _env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {};
}
