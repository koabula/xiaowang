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

/** 应用图标铺满整张方块，眼睛和嘴放在正中。程序坞会把方块裁成圆角。 */
export function beamSvg(name: string, colors: string[], pixels = 1024): string {
  const face = beamFace(name, colors);
  const size = 36;
  const mouth = face.isMouthOpen
    ? `<path d="M12.2 21.6c1.8 1.7 3.6 2.5 5.8 2.5s4-.8 5.8-2.5" stroke="#FFFFFF" stroke-width="1.8" fill="none" stroke-linecap="round"/>`
    : `<path d="M11.4 21.2c2.6 3.3 10.6 3.3 13.2 0" stroke="#FFFFFF" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${size} ${size}" fill="none">
  <rect width="${size}" height="${size}" fill="${face.wrapperColor}"/>
  <g transform="translate(18 18) scale(1.45) translate(-18 -18)">
    <rect x="10.1" y="11" width="3.2" height="4.3" rx="1.6" fill="#FFFFFF"/>
    <rect x="22.7" y="11" width="3.2" height="4.3" rx="1.6" fill="#FFFFFF"/>
    ${mouth}
  </g>
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
