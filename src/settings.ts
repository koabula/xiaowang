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
export interface SettingsView extends Omit<SecretRecord, "apiKey" | "realtimeKey" | "realtimeProfiles"> {
  keyHint: string; realtimeKeyHint: string; ready: boolean;
  realtimeProfiles?: Partial<Record<RealtimeServiceId, VoiceProfileView>>;
}
export const EMPTY_SETTINGS: SecretRecord = {
  model: "", baseUrl: "", apiStyle: "", apiKey: "", realtimeModel: "", realtimeUrl: "", realtimeKey: "", realtimeService: "",
  realtimeVoice: "", realtimeRegion: "", realtimeWorkspace: "", locale: "zh",
};
const fields = ["model", "voice", "region", "workspace", "url", "key"] as const;
const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const clean = (input: unknown): string => typeof input === "string" ? input.trim() : "";
export const keyHint = (key: string): string => key ? `已保存 ····${key.slice(-4)}` : "";
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
  for (const name of Object.keys(EMPTY_SETTINGS) as Array<keyof typeof EMPTY_SETTINGS>) {
    if (name !== "realtimeProfiles" && typeof raw[name] === "string") result[name] = raw[name] as string;
  }
  const profiles = record(raw.realtimeProfiles); result.realtimeProfiles = {};
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
  for (const name of ["model", "baseUrl", "apiStyle", "apiKey"] as const) {
    if (typeof patch[name] === "string" && (name !== "apiKey" || clean(patch[name]))) next[name] = clean(patch[name]);
  }
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
export function publicSettings(secrets: SecretRecord): SettingsView {
  const { apiKey, realtimeKey, realtimeProfiles: _private, ...rest } = secrets;
  const profiles = voiceProfiles(secrets), views: Partial<Record<RealtimeServiceId, VoiceProfileView>> = {};
  for (const { id } of REALTIME_SERVICES) {
    const value = profiles[id]; if (!value) continue;
    const { key, ...options } = value; views[id] = { ...options, keyHint: keyHint(key) };
  }
  return { ...rest, keyHint: keyHint(apiKey), realtimeKeyHint: keyHint(realtimeKey), realtimeProfiles: views,
    ready: Boolean(secrets.model) && (Boolean(apiKey) || /localhost|127\.0\.0\.1/.test(secrets.baseUrl)) };
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
