export function activityLine(name: string, input: unknown): string {
  const record = isRecord(input) ? input : {};
  const query = text(record.query);
  const file = text(record.file) || text(record.path);
  const page = text(record.page) || text(record.start_page);
  const target = text(record.target) || text(record.url);
  switch (name) {
    case "search_literature":
      return query ? `查询相关论文 · ${clip(query, 36)}` : "查询相关论文";
    case "read_document":
      return file ? `阅读 ${clip(file, 32)}${page ? ` 第 ${page} 页` : ""}` : "阅读资料";
    case "browser_navigate":
      return target ? `打开 ${clip(labelFromUrl(target), 36)}` : "打开网页";
    case "browser_snapshot":
      return "查看页面";
    case "browser_click":
      return target ? `点击「${clip(target, 24)}」` : "点击页面";
    case "browser_type":
      return "在页面里输入";
    case "browser_scroll":
      return "滚动页面";
    case "browser_back":
      return "返回上一页";
    case "write_file":
      return file ? `写下 ${clip(file, 40)}` : "写下笔记";
    case "read_file":
      return file ? `读 ${clip(file, 40)}` : "读工作区文件";
    case "show_stage":
      return page ? `翻到第 ${page} 页` : "打开右栏";
    case "list_library":
      return "查看资料库";
    case "list_files":
      return "查看工作区";
    case "import_file":
      return "放入资料库";
    case "share_file":
      return "把资料交给另一个任务";
    case "spawn_bot":
      return text(record.name) ? `单独开一个任务 · ${clip(text(record.name), 24)}` : "单独开一个任务";
    case "remember_terms":
      return "记下术语";
    default:
      return "想一想";
  }
}

function labelFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const last = url.pathname.split("/").filter(Boolean).pop();
    return last ? `${url.hostname}/${last}` : url.hostname;
  } catch {
    return value;
  }
}

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
