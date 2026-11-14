export type Locale = "zh" | "en";

export function localeOf(value: string | undefined): Locale {
  return value === "en" ? "en" : "zh";
}
