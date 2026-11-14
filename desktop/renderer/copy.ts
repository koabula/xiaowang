import { localeOf, type Locale } from "../../src/locale.ts";

export type { Locale };
export { localeOf };

export interface Copy {
  search: string;
  newTask: string;
  findTask: string;
  taskName: string;
  settings: string;
  collapseStage: string;
  expandStage: string;
  files: string;
  browser: string;
  canvas: string;
  addToLibrary: string;
  dictateLater: string;
  stop: string;
  call: string;
  hangup: string;
  mute: string;
  unmute: string;
  connecting: string;
  listening: string;
  speaking: string;
  inCall: string;
  collapseCall: string;
  expandCall: string;
  watching: string;
  takeControl: string;
  youControl: string;
  release: string;
  emptyCanvas: string;
  emptyLibrary: string;
  pickFile: string;
  connectModel: string;
  close: string;
  language: string;
  text: string;
  callSection: string;
  style: string;
  auto: string;
  openai: string;
  anthropic: string;
  baseUrl: string;
  modelKey: string;
  fetchModels: string;
  check: string;
  model: string;
  service: string;
  getKey: string;
  region: string;
  beijing: string;
  singapore: string;
  workspace: string;
  workspacePlaceholder: string;
  key: string;
  voice: string;
  preview: string;
  stopPreview: string;
  save: string;
  name: string;
  anotherFace: string;
  saveName: string;
  materials: string;
  remove: string;
  noMaterials: string;
  addMaterials: string;
  taskDisplayName: string;
  message(name: string): string;
  nextRound(name: string): string;
}

const zh: Copy = {
  search: "搜索",
  newTask: "新任务",
  findTask: "找任务",
  taskName: "任务名称",
  settings: "设置",
  collapseStage: "收起右栏",
  expandStage: "展开右栏",
  files: "文件",
  browser: "浏览器",
  canvas: "Canvas",
  addToLibrary: "放入资料库",
  dictateLater: "听写还没接上",
  stop: "停下",
  call: "通话",
  hangup: "挂断",
  mute: "静音",
  unmute: "打开麦克风",
  connecting: "正在接通",
  listening: "正在听",
  speaking: "正在说",
  inCall: "通话中",
  collapseCall: "收起通话记录",
  expandCall: "展开通话记录",
  watching: "仅观看",
  takeControl: "取得控制权",
  youControl: "你正在控制",
  release: "停止",
  emptyCanvas: "写好的页面会出现在这里。",
  emptyLibrary: "把 PDF 或笔记放进这个任务。",
  pickFile: "选择一份资料。",
  connectModel: "先接上模型",
  close: "关闭",
  language: "语言",
  text: "文字",
  callSection: "通话",
  style: "接口风格",
  auto: "自动",
  openai: "OpenAI 兼容",
  anthropic: "Anthropic",
  baseUrl: "接口地址",
  modelKey: "模型密钥",
  fetchModels: "获取模型",
  check: "检查",
  model: "模型",
  service: "服务",
  getKey: "获取密钥",
  region: "地域",
  beijing: "北京",
  singapore: "新加坡",
  workspace: "工作空间",
  workspacePlaceholder: "工作空间 ID，或完整 wss 地址",
  key: "密钥",
  voice: "音色",
  preview: "试听",
  stopPreview: "停止",
  save: "保存并进入",
  name: "名字",
  anotherFace: "换一张",
  saveName: "保存名字",
  materials: "资料",
  remove: "移出",
  noMaterials: "这个任务还没有资料。",
  addMaterials: "添加资料",
  taskDisplayName: "改的是这个任务的显示名。",
  message: (name) => (name ? `给 ${name} 发消息` : "发消息"),
  nextRound: (name) => `下一轮起，总入口和每个任务都用「${name}」认识自己。`,
};

const en: Copy = {
  search: "Search",
  newTask: "New task",
  findTask: "Find a task",
  taskName: "Task name",
  settings: "Settings",
  collapseStage: "Hide the side pane",
  expandStage: "Show the side pane",
  files: "Files",
  browser: "Browser",
  canvas: "Canvas",
  addToLibrary: "Add to the library",
  dictateLater: "Dictation is not connected",
  stop: "Stop",
  call: "Call",
  hangup: "Hang up",
  mute: "Mute",
  unmute: "Unmute",
  connecting: "Connecting",
  listening: "Listening",
  speaking: "Speaking",
  inCall: "On a call",
  collapseCall: "Hide the transcript",
  expandCall: "Show the transcript",
  watching: "Watching",
  takeControl: "Take control",
  youControl: "You have control",
  release: "Stop",
  emptyCanvas: "A page will show up here once it is ready.",
  emptyLibrary: "Add a PDF or a note to this task.",
  pickFile: "Choose a file.",
  connectModel: "Connect a model",
  close: "Close",
  language: "Language",
  text: "Text",
  callSection: "Call",
  style: "API style",
  auto: "Auto",
  openai: "OpenAI compatible",
  anthropic: "Anthropic",
  baseUrl: "Base URL",
  modelKey: "Model key",
  fetchModels: "Fetch models",
  check: "Check",
  model: "Model",
  service: "Service",
  getKey: "Get a key",
  region: "Region",
  beijing: "Beijing",
  singapore: "Singapore",
  workspace: "Workspace",
  workspacePlaceholder: "Workspace ID, or a full wss URL",
  key: "Key",
  voice: "Voice",
  preview: "Preview",
  stopPreview: "Stop",
  save: "Save",
  name: "Name",
  anotherFace: "Another face",
  saveName: "Save name",
  materials: "Files",
  remove: "Remove",
  noMaterials: "This task has no files yet.",
  addMaterials: "Add files",
  taskDisplayName: "This changes the task's display name.",
  message: (name) => (name ? `Message ${name}` : "Message"),
  nextRound: (name) => `From the next turn, the home and every task answer as “${name}”.`,
};

export function copyFor(locale: Locale): Copy {
  return locale === "en" ? en : zh;
}
