import { DOUBAO_REALTIME_MODEL, DOUBAO_REALTIME_URL, DOUBAO_VOICE } from "./realtime.ts";

export type RealtimeServiceId = "qwen" | "openai" | "doubao";
export type RealtimeRegion = "beijing" | "singapore";

export interface RealtimeModelChoice {
  id: string;
  name: string;
  generation?: "3.5" | "3.8";
}

export interface RealtimeVoiceChoice {
  id: string;
  name: string;
}

export interface ResolvedRealtime {
  service: RealtimeServiceId;
  model: string;
  voice: string;
  region: RealtimeRegion;
  workspace: string;
  url: string;
}

export interface RealtimeDraft {
  service?: string;
  model?: string;
  voice?: string;
  region?: string;
  workspace?: string;
  url?: string;
}

const QWEN_BEIJING = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const QWEN_SINGAPORE = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime";
const OPENAI_URL = "wss://api.openai.com/v1/realtime";

export const REALTIME_SERVICES: { id: RealtimeServiceId; name: string; models: RealtimeModelChoice[] }[] = [
  {
    id: "qwen",
    name: "通义千问",
    models: [
      { id: "qwen3.5-omni-plus-realtime", name: "Omni Plus", generation: "3.5" },
      { id: "qwen3.5-omni-flash-realtime", name: "Omni Flash", generation: "3.5" },
      { id: "qwen3.8-omni-flash-realtime", name: "Omni 3.8", generation: "3.8" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-realtime-2.1", name: "Realtime 2.1" },
      { id: "gpt-realtime-2.1-mini", name: "Realtime 2.1 Mini" },
    ],
  },
  {
    id: "doubao",
    name: "豆包全双工",
    models: [{ id: DOUBAO_REALTIME_MODEL, name: "实时语音 3.0" }],
  },
];

const QWEN_VOICES: { id: string; name: string; generations: Array<"3.5" | "3.8"> }[] = [
  ["Tina", "甜甜", "both"],
  ["Cindy", "林欣宜", "both"],
  ["Liora Mira", "清欢", "both"],
  ["Raymond", "林川野", "both"],
  ["Zane", "泽恩", "3.8"],
  ["Katerina", "卡捷琳娜", "both"],
  ["Ryan", "甜茶", "both"],
  ["Mia", "舒然", "both"],
  ["Cici", "绵绵", "3.8"],
  ["Theo Calm", "予安", "both"],
  ["Serena", "苏瑶", "both"],
  ["Maia", "四月", "both"],
  ["Evan", "江晨", "both"],
  ["Qiao", "小乔妹", "both"],
  ["Momo", "茉兔", "both"],
  ["Wil", "伟伦", "both"],
  ["Angel", "安琪", "both"],
  ["Li Cassian", "李公公", "both"],
  ["Joyner", "阿逗", "both"],
  ["Gold", "金爷", "both"],
  ["Jennifer", "詹妮弗", "both"],
  ["Aiden", "艾登", "both"],
  ["Mione", "敏儿", "both"],
  ["Sunny", "晴儿", "both"],
  ["Dylan", "晓东", "both"],
  ["Eric", "程川", "both"],
  ["Peter", "李彼得", "both"],
  ["Joseph Chen", "阿樸伯", "both"],
  ["Marcus", "秦川", "both"],
  ["Li", "老李", "both"],
  ["Rocky", "阿强", "both"],
  ["Kiki", "阿清", "both"],
  ["Sohee", "素熙", "both"],
  ["Eliška", "艾莉卡", "both"],
  ["Alek", "阿列克", "both"],
  ["Arda", "阿尔达", "both"],
  ["Dolce", "多尔切", "both"],
  ["Lenn", "莱恩", "both"],
  ["Ono Anna", "小野杏", "both"],
  ["Sonrisa", "索尼莎", "both"],
  ["Bodega", "博德加", "both"],
  ["Andre", "安德雷", "both"],
  ["Radio Gol", "拉迪奥·戈尔", "both"],
  ["Rizky", "阿力", "both"],
  ["Roya", "萝雅", "both"],
  ["Hana", "阿幸", "both"],
  ["Jakub", "雅克", "both"],
  ["Griet", "海娜", "both"],
  ["Marina", "玛丽娜", "both"],
  ["Siiri", "西芮", "both"],
  ["Ingrid", "林恩", "both"],
  ["Sigga", "海娜·冰岛", "both"],
  ["Bea", "雅娜", "both"],
  ["Chloe", "思怡", "both"],
  ["Emilien", "埃米尔安", "both"],
  ["longanlingxin", "龙安灵心", "3.8"],
  ["Sunnybobi", "知芝", "3.5"],
  ["Ethan", "晨煦", "3.5"],
  ["Harvey", "厚", "3.5"],
].map((row) => ({
  id: row[0] ?? "",
  name: row[1] ?? "",
  generations: row[2] === "both" ? (["3.5", "3.8"] as const) : [row[2] === "3.8" ? "3.8" as const : "3.5" as const],
}));

const OPENAI_VOICES: RealtimeVoiceChoice[] = [
  ["marin", "Marin"],
  ["cedar", "Cedar"],
  ["alloy", "Alloy"],
  ["ash", "Ash"],
  ["ballad", "Ballad"],
  ["coral", "Coral"],
  ["echo", "Echo"],
  ["sage", "Sage"],
  ["shimmer", "Shimmer"],
  ["verse", "Verse"],
].map((row) => ({ id: row[0] ?? "", name: row[1] ?? "" }));

const DOUBAO_VOICES: RealtimeVoiceChoice[] = [
  { id: DOUBAO_VOICE, name: "Vivi 2.0" },
  { id: "zh_female_xiaohe_uranus_bigtts", name: "小何 2.0" },
  { id: "zh_male_m191_uranus_bigtts", name: "云舟 2.0" },
  { id: "zh_male_taocheng_uranus_bigtts", name: "小天 2.0" },
];

export function realtimeKeyPage(service: string, region: string): string {
  if (service === "openai") return "https://platform.openai.com/api-keys";
  if (service === "doubao") return "https://console.volcengine.com/speech/new/setting/apikeys?projectName=default";
  if (region === "singapore") return "https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key";
  return "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key";
}

export function modelsFor(service: RealtimeServiceId): RealtimeModelChoice[] {
  return REALTIME_SERVICES.find((item) => item.id === service)?.models ?? [];
}

export function voicesFor(service: RealtimeServiceId, model: string): RealtimeVoiceChoice[] {
  if (service === "openai") return OPENAI_VOICES;
  if (service === "doubao") return DOUBAO_VOICES;
  const generation = modelsFor("qwen").find((item) => item.id === model)?.generation ?? "3.5";
  return QWEN_VOICES.filter((voice) => voice.generations.includes(generation)).map(({ id, name }) => ({ id, name }));
}

export function resolveRealtime(draft: RealtimeDraft = {}): ResolvedRealtime {
  const service = serviceOf(draft);
  const models = modelsFor(service);
  const hinted = models.some((item) => item.id === draft.model)
    ? draft.model
    : (service === "qwen" && /\.maas\./i.test(draft.url ?? "") ? "qwen3.8-omni-flash-realtime" : "");
  const model = models.some((item) => item.id === hinted) ? (hinted as string) : (models[0]?.id ?? "");
  const voices = voicesFor(service, model);
  const voice = voices.some((item) => item.id === draft.voice) ? (draft.voice as string) : (voices[0]?.id ?? "");
  const region = regionOf(draft);
  const workspace = (draft.workspace?.trim() || workspaceOf(draft.url ?? "")).trim();
  return { service, model, voice, region, workspace, url: urlFor(service, model, region, workspace) };
}

export function sharesTextKey(service: RealtimeServiceId, baseUrl: string): boolean {
  const host = baseUrl.toLowerCase();
  if (service === "qwen") return host.includes("dashscope") || host.includes("qwencloud") || host.includes("aliyuncs.com");
  if (service === "openai") return host.includes("api.openai.com");
  return false;
}

export function keyForService(service: RealtimeServiceId, realtimeKey: string, textKey: string, textBaseUrl: string): string {
  if (realtimeKey.trim()) return realtimeKey.trim();
  if (sharesTextKey(service, textBaseUrl) && textKey.trim()) return textKey.trim();
  return "";
}

function serviceOf(draft: RealtimeDraft): RealtimeServiceId {
  if (draft.service === "qwen" || draft.service === "openai" || draft.service === "doubao") return draft.service;
  const url = draft.url ?? "";
  if (/\/api\/v3\/duplex\/realtime\/dialogue/i.test(url)) return "doubao";
  if (/api\.openai\.com/i.test(url)) return "openai";
  return "qwen";
}

function regionOf(draft: RealtimeDraft): RealtimeRegion {
  if (draft.region === "beijing" || draft.region === "singapore") return draft.region;
  const url = (draft.url ?? "").toLowerCase();
  if (url.includes("dashscope-intl") || url.includes("ap-southeast-1")) return "singapore";
  return "beijing";
}

function workspaceOf(url: string): string {
  if (/\.maas\./i.test(url)) return url.replace(/\/$/, "");
  return "";
}

function urlFor(service: RealtimeServiceId, model: string, region: RealtimeRegion, workspace: string): string {
  if (service === "openai") return OPENAI_URL;
  if (service === "doubao") return DOUBAO_REALTIME_URL;
  if (model.startsWith("qwen3.8")) return workspaceUrl(workspace, region);
  return region === "singapore" ? QWEN_SINGAPORE : QWEN_BEIJING;
}

function workspaceUrl(workspace: string, region: RealtimeRegion): string {
  if (!workspace) return "";
  if (/^wss:\/\//i.test(workspace)) return workspace.replace(/\/$/, "");
  const host = region === "singapore" ? "ap-southeast-1" : "cn-beijing";
  return `wss://${workspace}.${host}.maas.aliyuncs.com/api-ws/v1/realtime`;
}
