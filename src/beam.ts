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
