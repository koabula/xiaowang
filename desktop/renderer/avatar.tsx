import BoringAvatar from "boring-avatars";
import { inkFor } from "./ink.ts";

const FAMILY = ["#18181B", "#F4F4F5", "#177E6B", "#C44D34", "#2B59C3", "#B86B19", "#467A56", "#6B4C7A", "#1E6F8C"];

export function Avatar({
  slug,
  size = 36,
  live = false,
  mood = "idle",
}: {
  slug: string;
  size?: number;
  live?: boolean;
  mood?: "idle" | "think";
}) {
  const className = ["avatar", live ? "live" : "", mood === "think" ? "think" : ""].filter(Boolean).join(" ");
  return (
    <span className={className} style={{ width: size, height: size }}>
      <BoringAvatar name={slug || "xiaowang"} variant="beam" size={size} colors={beamColors(slug)} />
    </span>
  );
}

function beamColors(slug: string): string[] {
  if (slug === "xiaowang") return ["#18181B", "#3F3F46", "#F4F4F5", "#A1A1AA", "#FFFFFF"];
  let hash = 0;
  for (const char of slug) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  const accent = inkFor(slug);
  return [accent, FAMILY[hash % FAMILY.length] ?? accent, "#F4F4F5", "#18181B", FAMILY[(hash >> 3) % FAMILY.length] ?? accent];
}
