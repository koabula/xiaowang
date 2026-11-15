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

export const APP_ICON_NAME = "xw-6udis";
export const APP_ICON_INK = "#2B59C3";

/** 按 macOS 程序坞规格导出透明底圆角方块，使用指定 beam 几何与色彩。 */
export function beamSvg(name: string, colors: string[], pixels = 1024): string {
  const face = beamFace(name, colors);
  const scale = 824 / 36;
  const mouth = face.isMouthOpen
    ? `<path d="M15 ${19 + face.mouthSpread}c2 1 4 1 6 0" stroke="${face.faceColor}" fill="none" stroke-linecap="round"/>`
    : `<path d="M13,${19 + face.mouthSpread} a1,0.75 0 0,0 10,0" fill="${face.faceColor}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 1024 1024" fill="none">
  <defs>
    <clipPath id="xw-squircle">
      <rect x="100" y="100" width="824" height="824" rx="185"/>
    </clipPath>
    <filter id="xw-drop" x="40" y="56" width="944" height="944" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#0A0A0E" flood-opacity="0.22"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="${face.backgroundColor}" filter="url(#xw-drop)"/>
  <g clip-path="url(#xw-squircle)">
    <g transform="translate(100 100) scale(${scale})">
      <rect width="36" height="36" fill="${face.backgroundColor}"/>
      <rect x="0" y="0" width="36" height="36"
        transform="translate(${face.wrapperTranslateX} ${face.wrapperTranslateY}) rotate(${face.wrapperRotate} 18 18) scale(${face.wrapperScale})"
        fill="${face.wrapperColor}" rx="${face.isCircle ? 36 : 6}"/>
      <g transform="translate(${face.faceTranslateX} ${face.faceTranslateY}) rotate(${face.faceRotate} 18 18)">
        ${mouth}
        <rect x="${14 - face.eyeSpread}" y="14" width="1.5" height="2" rx="1" fill="${face.faceColor}"/>
        <rect x="${20 + face.eyeSpread}" y="14" width="1.5" height="2" rx="1" fill="${face.faceColor}"/>
      </g>
    </g>
  </g>
  <rect x="101.5" y="101.5" width="821" height="821" rx="183.5" stroke="#141416" stroke-opacity="0.08" stroke-width="3"/>
</svg>
`;
}

export function beamFace(name: string, colors: string[]) {
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
