import type { SettingsPatch } from "./types.ts";
import { REALTIME_SERVICES } from "../../src/realtime-catalog.ts";
import type { VoiceProfilePatch } from "../../src/settings.ts";

const normalizedProfile = (value?: VoiceProfilePatch) => ({ model: value?.model?.trim() ?? "", voice: value?.voice?.trim() ?? "", region: value?.region?.trim() ?? "", workspace: value?.workspace?.trim() ?? "", url: value?.url?.trim() ?? "", key: value?.key?.trim() ?? "", clearKey: value?.clearKey === true });
/** All provider drafts count, including an edited key in an inactive provider tab. */
export function hasUnsavedSettings(draft: SettingsPatch, saved: SettingsPatch): boolean {
  for (const key of Object.keys(draft) as Array<keyof SettingsPatch>) {
    if (key === "realtimeProfiles") continue;
    const value = draft[key]?.trim() ?? "";
    if (key === "apiKey" || key === "realtimeKey") { if (value) return true; }
    else if (value !== (saved[key]?.trim() ?? "")) return true;
  }
  return REALTIME_SERVICES.some(({ id }) => JSON.stringify(normalizedProfile(draft.realtimeProfiles?.[id])) !== JSON.stringify(normalizedProfile(saved.realtimeProfiles?.[id])));
}
