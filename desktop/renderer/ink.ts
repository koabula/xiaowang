const INKS = ["#177E6B", "#C44D34", "#2B59C3", "#B86B19", "#467A56", "#7A543E", "#6B4C7A", "#1E6F8C"];

export function inkFor(slug: string): string {
  if (slug === "xiaowang") return "#18181B";
  let hash = 0;
  for (const char of slug) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return INKS[hash % INKS.length] ?? INKS[0];
}

export function faceFor(slug: string): number {
  if (slug === "xiaowang") return 0;
  let hash = 0;
  for (const char of slug) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return (hash % 5) + 1;
}

export function shadeId(slug: string): string {
  let hash = 0;
  for (const char of slug) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return `shade-${hash.toString(16)}`;
}
