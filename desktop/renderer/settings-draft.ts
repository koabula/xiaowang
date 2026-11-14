import type { SettingsPatch } from "./types.ts";

/** Saving trims strings, and an empty key input means “keep the stored key”. */
export function hasUnsavedSettings(draft: SettingsPatch, saved: SettingsPatch): boolean {
  return (Object.keys(draft) as Array<keyof SettingsPatch>).some(key => {
    const value = draft[key]?.trim() ?? "";
    if (key === "apiKey" || key === "realtimeKey") return value.length > 0;
    return value !== (saved[key]?.trim() ?? "");
  });
}
