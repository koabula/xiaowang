import { faceFor, inkFor, shadeId } from "./ink.ts";

export function Avatar({ slug, size = 36, live = false }: { slug: string; size?: number; live?: boolean }) {
  const ink = inkFor(slug);
  const id = shadeId(slug);
  return (
    <span className={live ? "avatar live" : "avatar"} style={{ width: size, height: size }}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <radialGradient id={id} cx="34%" cy="30%" r="72%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.72" />
            <stop offset="28%" stopColor={ink} stopOpacity="0.15" />
            <stop offset="70%" stopColor={ink} stopOpacity="0" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0.38" />
          </radialGradient>
        </defs>
        <circle cx="32" cy="32" r="30" fill={ink} />
        <circle cx="32" cy="32" r="30" fill={`url(#${id})`} />
        <ellipse cx="24" cy="20" rx="9" ry="6" fill="#ffffff" opacity="0.34" />
        <Face kind={faceFor(slug)} />
      </svg>
    </span>
  );
}

function Face({ kind }: { kind: number }) {
  if (kind === 0) {
    return (
      <>
        <rect x="22" y="26" width="6" height="14" rx="3" fill="#fff" />
        <rect x="36" y="26" width="6" height="14" rx="3" fill="#fff" />
      </>
    );
  }
  if (kind === 1) {
    return (
      <>
        <circle cx="24" cy="32" r="3.2" fill="#fff" />
        <circle cx="40" cy="32" r="3.2" fill="#fff" />
      </>
    );
  }
  if (kind === 2) {
    return (
      <>
        <rect x="20" y="28" width="5.5" height="12" rx="2.8" fill="#fff" />
        <path d="M38 34h8" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      </>
    );
  }
  if (kind === 3) {
    return (
      <>
        <rect x="23" y="24" width="4.5" height="16" rx="2.2" fill="#fff" />
        <rect x="36.5" y="24" width="4.5" height="16" rx="2.2" fill="#fff" />
      </>
    );
  }
  if (kind === 4) {
    return (
      <>
        <rect x="20" y="29" width="8" height="4" rx="2" fill="#fff" />
        <rect x="36" y="29" width="8" height="4" rx="2" fill="#fff" />
      </>
    );
  }
  return (
    <>
      <circle cx="23" cy="30" r="3" fill="#fff" />
      <circle cx="41" cy="30" r="3" fill="#fff" />
      <path d="M26 40c2.2 2.4 9.8 2.4 12 0" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </>
  );
}
