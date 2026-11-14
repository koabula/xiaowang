const PAPER = "#F4F4F5";

/** boring-avatars 的哈希。色块和下标都从这里取，必须和库里一致。 */
export function beamHash(name: string): number {
  let value = 0;
  for (let index = 0; index < name.length; index += 1) {
    value = (value << 5) - value + name.charCodeAt(index);
    value |= 0;
  }
  return Math.abs(value);
}

/**
 * beam 只从调色板里抽两格：hash % 5 是色块，(hash + 13) % 5 是底。
 * 按当前这张脸把这两格钉住，换脸时颜色不变，换颜色时脸不变。
 */
export function beamPalette(name: string, slab: string): string[] {
  const hash = beamHash(name);
  const colors = [PAPER, PAPER, PAPER, PAPER, PAPER];
  colors[hash % colors.length] = slab;
  colors[(hash + 13) % colors.length] = PAPER;
  return colors;
}

export const APP_ICON_NAME = "xiaowang";
export const APP_ICON_INK = "#18181B";

/** 按 macOS 程序坞规格导出透明底圆角方块，内放微侧墨滴小脸，边缘与其他应用图标齐平。 */
export function beamSvg(name: string, colors: string[], pixels = 1024): string {
  const face = beamFace(name, colors);
  const mouth = face.isMouthOpen
    ? `<path d="M454 574C490 604 544 606 582 574" stroke="${face.faceColor}" stroke-width="34" fill="none" stroke-linecap="round"/>`
    : `<path d="M438 560A92 70 0 0 0 602 560" fill="${face.faceColor}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 1024 1024" fill="none">
  <defs>
    <linearGradient id="xw-paper" x1="512" y1="100" x2="512" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#ECECEF"/>
    </linearGradient>
    <linearGradient id="xw-ink" x1="260" y1="180" x2="780" y2="860" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#27272C"/>
      <stop offset="1" stop-color="${face.wrapperColor}"/>
    </linearGradient>
    <filter id="xw-drop" x="40" y="56" width="944" height="944" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="20" stdDeviation="22" flood-color="#0A0A0E" flood-opacity="0.24"/>
      <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#0A0A0E" flood-opacity="0.12"/>
    </filter>
    <clipPath id="xw-squircle">
      <rect x="100" y="100" width="824" height="824" rx="185"/>
    </clipPath>
  </defs>
  <g filter="url(#xw-drop)">
    <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#xw-paper)"/>
  </g>
  <g clip-path="url(#xw-squircle)">
    <rect x="100" y="100" width="824" height="824" fill="url(#xw-paper)"/>
    <g transform="translate(36 44) rotate(-8 512 512)">
      <rect x="146" y="148" width="760" height="760" rx="340" fill="url(#xw-ink)"/>
    </g>
    <g transform="translate(26 16) rotate(-5 512 512)">
      <rect x="404" y="424" width="42" height="58" rx="21" fill="${face.faceColor}"/>
      <rect x="590" y="424" width="42" height="58" rx="21" fill="${face.faceColor}"/>
      ${mouth}
    </g>
  </g>
  <rect x="101.5" y="101.5" width="821" height="821" rx="183.5" stroke="#141416" stroke-opacity="0.08" stroke-width="3"/>
</svg>
`;
}

function beamFace(name: string, colors: string[]) {
  const hash = beamHash(name);
  const count = colors.length || 1;
  const pick = (offset: number) => colors[(hash + offset) % count] ?? "#18181B";
  const rawX = signed(hash, 10, 1);
  const rawY = signed(hash, 10, 2);
  const wrapperTranslateX = rawX < 5 ? rawX + 4 : rawX;
  const wrapperTranslateY = rawY < 5 ? rawY + 4 : rawY;
  const wrapperColor = pick(0);
  return {
    wrapperColor,
    faceColor: contrast(wrapperColor),
    backgroundColor: pick(13),
    wrapperTranslateX,
    wrapperTranslateY,
    wrapperRotate: signed(hash, 360),
    wrapperScale: 1 + signed(hash, 3) / 10,
    isMouthOpen: digit(hash, 2) % 2 === 0,
    isCircle: digit(hash, 1) % 2 === 0,
    eyeSpread: signed(hash, 5),
    mouthSpread: signed(hash, 3),
    faceRotate: signed(hash, 10, 3),
    faceTranslateX: wrapperTranslateX > 6 ? wrapperTranslateX / 2 : signed(hash, 8, 1),
    faceTranslateY: wrapperTranslateY > 6 ? wrapperTranslateY / 2 : signed(hash, 7, 2),
  };
}

function digit(value: number, index: number): number {
  return Math.floor(value / 10 ** index) % 10;
}

function signed(value: number, range: number, index?: number): number {
  const mod = value % range;
  return index !== undefined && digit(value, index) % 2 === 0 ? -mod : mod;
}

function contrast(hex: string): string {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 >= 128 ? "#000000" : "#FFFFFF";
}
