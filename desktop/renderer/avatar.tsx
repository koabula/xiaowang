import BoringAvatar from "boring-avatars";
import { beamPalette } from "../../src/beam.ts";
import { inkFor } from "./ink.ts";

export function nextAvatarSeed(slug: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let tail = "";
  for (const byte of bytes) tail += alphabet[byte % alphabet.length];
  return `${slug}-${tail}`;
}

export function Avatar({
  slug,
  seed,
  ink,
  size = 36,
  mood = "idle",
}: {
  slug: string;
  seed?: string;
  ink?: string;
  size?: number;
  mood?: "idle" | "think";
}) {
  const name = seed || slug || "xiaowang";
  const timing = motionTiming(name);
  const className = ["avatar", mood === "think" ? "think" : ""].filter(Boolean).join(" ");
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        ["--blink-delay" as string]: timing.blinkDelay,
        ["--blink-span" as string]: timing.blinkSpan,
        ["--glance-delay" as string]: timing.glanceDelay,
        ["--glance-span" as string]: timing.glanceSpan,
        ["--glance-x" as string]: timing.glanceX,
        ["--think-blink" as string]: timing.thinkBlink,
      }}
    >
      <BoringAvatar name={name} variant="beam" size={size} colors={beamColors(name, slug, ink)} />
    </span>
  );
}

function motionTiming(seed: string): {
  blinkDelay: string;
  blinkSpan: string;
  glanceDelay: string;
  glanceSpan: string;
  glanceX: string;
  thinkBlink: string;
} {
  let hash = 0;
  for (const char of seed) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  const direction = hash % 2 === 0 ? 1 : -1;
  return {
    blinkDelay: `${hash % 7}s`,
    blinkSpan: `${7 + (hash % 4)}s`,
    glanceDelay: `${(hash >> 3) % 9}s`,
    glanceSpan: `${13 + (hash % 5)}s`,
    glanceX: `${direction * 6}%`,
    thinkBlink: `${3.2 + (hash % 3) * 0.4}s`,
  };
}

function beamColors(seed: string, slug: string, ink?: string): string[] {
  const slab = ink?.trim() || inkFor(slug || seed);
  return beamPalette(seed, slab);
}
