'use strict';

const SOURCE_ROOT = '../';
const SVG_NS = 'http://www.w3.org/2000/svg';
const diagrams = new Map();
let statusTimer;

const node = (id, x, y, w, h, title, lines, description, sources, tone = 'blue') =>
  ({ id, x, y, w, h, title, lines, description, sources, tone });
const edge = (from, to, d, label = '', x = 0, y = 0, kind = 'control') =>
  ({ from, to, d, label, x, y, kind });

const overview = {
  title: 'LLM + Realtime 全景架构',
  subtitle: '语音交互、后台研究与工作区上下文在应用内协调',
  height: 920,
  defaultNode: 'call',
  viewNodes: { text: 'queue', voice: 'call', direct: 'tools' },
  nodes: [
    node('audio', 40, 150, 235, 100, '语音输入与播放', ['麦克风 PCM · Web Audio', '播放位置与空闲回执'], '渲染进程采集并发送 PCM，接收音频进入本地播放队列。应用通过实际播放回执安排后续讲解与挂断。', ['desktop/renderer/call-audio.ts', 'desktop/renderer/App.tsx']),
    node('call', 345, 150, 300, 100, '通话调度与协议适配', ['通话状态 · 工具路由 · 中断', '播放回执 · 结果通知'], '主进程连接 Realtime 服务，处理转写、调用身份、工具执行和音频生命周期。Gemini 使用专属通话类，其他当前开放的服务通过 LiveCall 及对应协议配置接入。', ['desktop/main/index.ts', 'desktop/main/call.ts', 'desktop/main/gemini-call.ts']),
    node('realtime', 765, 150, 350, 100, 'Realtime 模型', ['Gemini · OpenAI · 千问 · 豆包', '32K 活跃窗口目标'], 'Gemini 32K → 16K 滑动；OpenAI 按指令开销配置历史限额。豆包/千问由服务端管理音频历史，应用限制注入内容。模型接收语音、通话简报和动态上下文，生成语音并调用工具。复杂工作通过 delegate_task 委派到本地队列。各适配器负责对齐服务商原生事件与本地状态。', ['src/realtime.ts', 'src/gemini-live.ts', 'src/doubao-realtime.ts']),
    node('text', 40, 365, 235, 100, '文字与附件输入', ['消息 · 图片 · 文档引用', '普通发送 / 排队新任务'], '文字通过 chat:ask 进入主进程。附件先导入当前 bot 的资料库，发送时带引用。普通发送优先补充当前活动任务，排队按钮显式创建另一任务。', ['desktop/renderer/message-composer.tsx', 'desktop/main/index.ts']),
    node('queue', 345, 365, 300, 100, '任务队列与 Agent 循环', ['JobQueue → runTurn', '后台 128K 目标 · 自动适配模型'], '文字聊天、子 bot 和通话委派统一默认 128K，按接口模型元数据自动下调。同一 bot 串行执行，默认最多两个工作区并发。每轮在模型调用边界接收补充，通过上下文投影和工具结果循环推进任务。任务先持久化，再调度。', ['src/jobs.ts', 'src/harness.ts']),
    node('llm', 765, 365, 350, 100, '后台 LLM', ['OpenAI 兼容 / Anthropic 接口', '流式文本与工具调用'], '后台适配器使用请求中的 system、messages 和工具定义调用模型。返回文本或结构化工具调用，模型请求的工具由应用执行。', ['src/provider.ts', 'src/stream.ts']),
    node('view', 40, 580, 235, 100, '资料与展示界面', ['PDF.js · HTML Canvas', '页面位置与展示回执'], '界面报告真实可见页面和匹配的图像帧。show_stage 需要页面展示回执；支持视觉的通话接收已发送图片以及图片或 PDF 当前页。', ['desktop/renderer/document-reader.tsx', 'desktop/renderer/canvas-pager.ts', 'desktop/main/index.ts']),
    node('shared', 345, 580, 300, 100, '每个 bot 的共享上下文', ['当前消息 · 可见页面 · 最近任务', 'revision / viewRevision'], 'SharedContexts 按 bot 保存快照。主进程将其更新到通话，任务在受理或接收补充时复制对应快照。独立页面版本帮助拒收迟到画面。', ['src/shared-context.ts', 'src/visual-queue.ts', 'desktop/main/index.ts'], 'teal'),
    node('tools', 765, 580, 350, 100, '工具执行与界面驱动', ['文献 · 文件 · 阅读 · 浏览器', 'show_stage · spawn_bot'], 'executeTool 负责参数处理、工作区文件与资料引用检查，并连接浏览器和展示驱动。Realtime 可直接读取或展示资料；研究任务中的工具结果写回本轮上下文。', ['src/tools.ts', 'src/stage.ts', 'desktop/main/browser.ts']),
    node('store', 345, 770, 300, 90, 'SQLite 事件与元数据', ['消息 · 任务状态 · 资料引用'], 'Store 使用 SQLite WAL。每个 bot 的会话采用追加式事件，任务恢复时读取最新状态；bot 元数据与资料引用分别保存在对应表中。', ['src/store.ts', 'src/types.ts'], 'teal'),
    node('files', 765, 770, 350, 90, '资料库与 bot 工作区', ['原件 · 笔记 · HTML 产物'], '原件按内容哈希去重，每个 bot 持有自己的文件引用。工作区用于保存生成的笔记、HTML 等文件，模型通过工具读取所需内容。', ['src/store.ts', 'src/tools.ts'], 'teal'),
  ],
  edges: [
    edge('audio', 'call', 'M275 184H345', 'PCM', 310, 174),
    edge('call', 'audio', 'M345 221H275', '音频', 310, 239),
    edge('call', 'realtime', 'M645 184H765', 'WebSocket', 705, 174),
    edge('realtime', 'call', 'M765 221H645', '音频 / 事件', 705, 239),
    edge('text', 'queue', 'M275 415H345', '输入', 310, 400),
    edge('call', 'queue', 'M432 250V365', '委派 / 补充', 431, 304),
    edge('queue', 'call', 'M563 365V250', '进度 / 结果', 564, 325),
    edge('queue', 'llm', 'M645 397H765', '模型请求', 705, 385),
    edge('llm', 'queue', 'M765 438H645', '文本 / 工具调用', 705, 457),
    edge('queue', 'tools', 'M645 447H730V605H765', '执行工具', 730, 523),
    edge('tools', 'queue', 'M765 625H703V486H610V465', '工具结果', 704, 552),
    edge('call', 'tools', 'M645 204H684V550H1035V580', '前台工具', 684, 290, 'direct'),
    edge('tools', 'view', 'M765 663H735V717H159V680', '展示与浏览器驱动', 448, 719, 'direct'),
    edge('view', 'shared', 'M275 630H345', '页面', 310, 614, 'data'),
    edge('shared', 'call', 'M345 607H314V286H374V250', '共享状态', 315, 521, 'data'),
    edge('shared', 'queue', 'M493 580V465', '受理 / 补充快照', 493, 548, 'data'),
    edge('shared', 'store', 'M493 680V770', '状态事件', 493, 746, 'data'),
    edge('queue', 'store', 'M645 420H670V815H645', '追加事件', 670, 754, 'data'),
    edge('tools', 'files', 'M940 680V770', '保存 / 引用', 940, 747, 'data'),
    edge('files', 'tools', 'M1045 770V680', '读取资料', 1045, 721, 'data'),
    edge('store', 'queue', 'M345 815H295V486H370V465', '读取历史', 297, 777, 'data'),
  ],
  paths: {
    all: [],
    text: ['text', 'queue', 'llm', 'tools', 'files', 'store', 'shared', 'view'],
    voice: ['audio', 'call', 'realtime', 'queue', 'llm', 'tools', 'files', 'store', 'shared'],
    direct: ['audio', 'call', 'realtime', 'tools', 'view', 'shared'],
  },
};

const loop = {
  title: '后台 Agent loop',
  subtitle: '保存输入 → 接收补充 → 构建上下文 → 推理 → 执行与回写',
  height: 990,
  defaultNode: 'updates',
  viewNodes: { queue: 'queued', cancel: 'cancel' },
  nodes: [
    node('input', 40, 145, 235, 90, '用户请求', ['文字消息或语音委派'], '桌面文字输入和语音委派最终进入 JobQueue，携带 bot、来源、附件与对应的工作区快照。', ['desktop/main/index.ts', 'src/voice-tasks.ts']),
    node('route', 355, 145, 245, 90, '受理与路由', ['保存输入 · 选择任务'], 'submit 默认选择当前运行任务，其次选择当前排队任务作为补充目标。没有活动任务时创建新任务；queueNew=true 显式另排任务。', ['src/jobs.ts']),
    node('queued', 790, 145, 310, 90, '独立任务排队', ['新任务编号 · 等待执行槽位'], '显式排队拥有独立 jobId。同 bot 等待当前执行释放槽位后启动，其他工作区可以在并发上限内执行。', ['src/jobs.ts'], 'orange'),
    node('supplement', 40, 325, 235, 95, '连续补充消息', ['立即保存 · 关联原任务'], '每条补充作为 user_text 保存，其事件编号加入任务 supplementEventIds。多条补充可以在一次模型调用边界合并接收。', ['src/jobs.ts', 'src/types.ts'], 'orange'),
    node('updates', 355, 325, 245, 95, '接收待处理补充', ['readUpdates() · 按事件编号去重'], '循环在模型调用前读取关联补充，仅追加尚未进入本轮 context 的事件。相应快照和页面画面也随补充更新。', ['src/harness.ts', 'desktop/main/index.ts']),
    node('context', 355, 495, 245, 95, '装配本次模型输入', ['投影历史 · 资料目录 · 图像'], 'ContextManager 从事件与快照装配消息；相同模型保留原生 thinking 协议，随后通过 hydrateImages 加载附件图像字节。独立排队任务的输入在当前任务中被排除。', ['src/harness.ts', 'src/project.ts', 'src/attachments.ts']),
    node('model', 355, 665, 245, 95, '调用后台 LLM', ['system + messages + tools'], 'Provider 调用 OpenAI 兼容或 Anthropic 接口，支持流式文本增量和结构化工具调用。桌面任务默认最多调用 40 步。', ['src/provider.ts', 'src/harness.ts']),
    node('parse', 790, 665, 310, 95, '保存并解析模型输出', ['assistant_turn · toolCalls'], '模型返回后先检查取消信号。助手输出和工具调用写入事件；工具调用按返回顺序执行。普通答案进入完成检查。', ['src/harness.ts']),
    node('tool', 790, 495, 310, 95, '执行工具并写回结果', ['tool_result · artifact'], 'executeTool 使用当前 bot、工作区和驱动。每项结果与工具调用编号关联，产物记录另存为 artifact，随后进入下一次调用。', ['src/harness.ts', 'src/tools.ts']),
    node('check', 790, 830, 310, 95, '普通答案的完成检查', ['检查模型执行期间的新补充'], '模型未请求工具时，循环再次查询补充。如果有新内容，本次回答作为中间输出保留并继续调用；无补充才确认最终回复。', ['src/harness.ts']),
    node('cancel', 40, 650, 235, 110, '停止任务', ['停止按钮 / cancel_task', 'AbortSignal 传入执行路径'], '停止操作直接取消任务，通过 AbortSignal 中断支持取消的执行路径。已有事件、补充和产物继续保留，待当前执行退出后释放槽位。', ['src/jobs.ts', 'desktop/main/index.ts'], 'orange'),
    node('done', 355, 830, 245, 95, '回写终态与结果', ['结果 · 产物 · 通知与下一任务'], 'JobQueue 保存终态和结果，释放执行槽位。桌面端更新会话或通话任务记录，语音适配器依据通知设置安排结果回报。', ['src/jobs.ts', 'desktop/main/index.ts'], 'teal'),
  ],
  edges: [
    edge('input', 'route', 'M275 190H355', '输入', 315, 177),
    edge('route', 'queued', 'M600 190H790', '显式排队', 695, 177, 'direct'),
    edge('route', 'updates', 'M478 235V325', '调度执行', 478, 285),
    edge('queued', 'updates', 'M945 235V275H554V325', '获得执行槽位', 818, 276, 'direct'),
    edge('supplement', 'updates', 'M275 372H355', '补充', 315, 358, 'data'),
    edge('updates', 'context', 'M478 420V495'),
    edge('context', 'model', 'M478 590V665'),
    edge('model', 'parse', 'M600 713H790', '返回', 695, 700),
    edge('parse', 'tool', 'M945 665V590', '工具调用', 945, 637),
    edge('tool', 'updates', 'M790 543H675V372H600', '结果进入下一轮', 675, 460),
    edge('parse', 'check', 'M945 760V830', '普通答案', 945, 807),
    edge('check', 'updates', 'M1100 878H1132V372H600', '有补充', 1090, 405, 'data'),
    edge('check', 'done', 'M790 878H600', '无补充', 695, 866),
    edge('cancel', 'done', 'M275 705H313V878H355', '释放槽位', 306, 815, 'direct'),
  ],
  paths: {
    tools: ['input', 'route', 'updates', 'context', 'model', 'parse', 'tool', 'check', 'done'],
    supplement: ['supplement', 'updates', 'context', 'model', 'parse', 'check', 'done'],
    queue: ['input', 'route', 'queued', 'updates', 'context', 'model', 'parse', 'check', 'done'],
    cancel: ['cancel', 'done'],
  },
  sequences: {
    tools: ['input', 'route', 'updates', 'context', 'model', 'parse', 'tool', 'updates', 'context', 'model', 'parse', 'check', 'done'],
    supplement: ['model', 'supplement', 'parse', 'check', 'updates', 'context', 'model', 'parse', 'check', 'done'],
    queue: ['input', 'route', 'queued', 'updates', 'context', 'model', 'parse', 'check', 'done'],
    cancel: ['cancel', 'done'],
  },
};

const context = {
  title: '上下文装配与记忆来源',
  subtitle: '持久化内容与工作区状态，经不同装配路径进入模型',
  height: 850,
  defaultNode: 'projection',
  viewNodes: { realtime: 'brief' },
  nodes: [
    node('history', 40, 150, 245, 110, '会话与执行事件', ['用户 / 助手 / 工具 / 转写', '任务补充与任务状态'], 'SQLite 按 bot 保存追加式事件。模型上下文投影采用语音条目的最新修订，关联工具调用与结果，按预算选择当前输入。', ['src/store.ts', 'src/types.ts', 'src/project.ts'], 'teal'),
    node('identity', 320, 150, 245, 110, '人设与任务身份', ['任务说明 · 基线 · 术语', 'bot 工作区与资料目录'], '共享人设由 personaFor 构建，子 bot 的任务说明和基线提供主题背景。词表在 remember_terms 后持续参与后台输入与通话简报。', ['src/persona.ts', 'src/project.ts', 'src/tools.ts'], 'teal'),
    node('references', 600, 150, 245, 110, '资料与产物', ['图片 / PDF 原件引用', '笔记 · HTML · 阅读工具'], '引用指向当前 bot 有权访问的资料原件。图片按需加载字节，文档使用 read_document 按页或行读取，笔记通过文件工具读入。', ['src/attachments.ts', 'src/store.ts', 'src/documents.ts'], 'teal'),
    node('workspace', 880, 150, 245, 110, '工作区共享状态', ['可见页面 · 已发送图片', '最近任务状态与结果'], 'SharedContexts 保存有界快照，独立 viewRevision 校验页面。任务复制受理时快照，接收补充时更新关联快照；Realtime 收到通话中的动态状态。', ['src/shared-context.ts', 'desktop/main/index.ts'], 'teal'),
    node('projection', 40, 420, 525, 130, '后台上下文装配', ['事件单元 → 投影清单 → 图像装配 → token 预算', '稳定前缀 · 原文引用 · 完整工具关联', '输出与安全预留 / 高水位触发重投影'], 'runTurn 通过 ContextManager 记录状态事件与投影清单，装配实际图像后检查完整预算。高水位触发纯函数重投影，保留当前要求和最新状态，原始事件可通过历史工具反查。', ['src/harness.ts', 'src/context-manager.ts', 'src/token-budget.ts']),
    node('brief', 600, 420, 525, 130, 'Realtime 上下文装配', ['projectVoiceBrief + 通话中的动态更新', '最近 6 段对话 · 目标 · 术语 · 资料目录', '可见画面与后台进度 / 结果按适配器更新'], '开通话时生成简报，随后通过 updateContext、shareVisual 和结果通知发送变化。动态更新的时机、长度和返回通道由服务商适配器处理。', ['src/project.ts', 'desktop/main/index.ts', 'desktop/main/gemini-call.ts']),
    node('request', 40, 665, 525, 100, '本次后台模型请求', ['system + messages + 图像 + tools', '工具结果回写后，再构建下一次输入'], 'Provider 把装配结果转换为 OpenAI 兼容或 Anthropic 的消息与图像格式。模型返回后继续进入 Agent loop。', ['src/provider.ts', 'src/harness.ts']),
    node('session', 600, 665, 525, 100, '实时通话会话', ['语音输入 + 简报 + 动态状态 / 视觉', '音频 · 转写 · 工具调用 · 委派'], 'Realtime 模型处理当前通话。当前视觉共享覆盖 Gemini、OpenAI 和千问。任务结果按通知策略返回，连续讲解由本地播放与展示状态协调。', ['src/realtime.ts', 'src/gemini-session.ts', 'src/visual-queue.ts']),
  ],
  edges: [
    edge('history', 'projection', 'M140 260V330H240V420', '', 0, 0, 'data'),
    edge('identity', 'projection', 'M414 260V353H340V420', '', 0, 0, 'data'),
    edge('references', 'projection', 'M695 260V376H445V420', '', 0, 0, 'data'),
    edge('workspace', 'projection', 'M975 260V399H520V420', '', 0, 0, 'data'),
    edge('history', 'brief', 'M195 260V300H675V420', '', 0, 0, 'data'),
    edge('identity', 'brief', 'M470 260V323H780V420', '', 0, 0, 'data'),
    edge('references', 'brief', 'M752 260V346H890V420', '', 0, 0, 'data'),
    edge('workspace', 'brief', 'M1030 260V420', '', 0, 0, 'data'),
    edge('projection', 'request', 'M302 550V665', '每次模型调用前', 302, 615),
    edge('brief', 'session', 'M862 550V665', '开通话 / 动态更新', 862, 615),
  ],
  paths: {
    all: [],
    llm: ['history', 'identity', 'references', 'workspace', 'projection', 'request'],
    realtime: ['history', 'identity', 'references', 'workspace', 'brief', 'session'],
  },
};

const layers = {
  title: '一次请求的上下文分层', subtitle: '自下而上读取；同一周期内保留已有块，变化追加到尾部', height: 820,
  defaultNode: 'stable', viewNodes: { tail: 'input', memory: 'index' },
  nodes: [
    node('input', 170, 165, 350, 84, '05 · 本次输入', ['用户要求与连续补充 · 图片附件按引用加载'], '本轮用户消息及连续补充保留为独立块。图片引用在发送前加载，文档引用供阅读工具使用。当前任务原始要求与连续补充按输入事件编号保留。', ['src/harness.ts', 'src/context-manager.ts', 'src/attachments.ts'], 'orange'),
    node('state', 170, 270, 350, 84, '04 · 状态增量', ['任务说明 · 术语 · 目录 · 工作区快照'], '变化后的任务背景和共享快照按指纹去重，在新输入边界追加。快照先保存为 context_state，清单只保存事件引用。重投影保留每个状态键的最新准确值。', ['src/project.ts', 'src/context-manager.ts', 'src/harness.ts'], 'orange'),
    node('history', 170, 375, 350, 84, '03 · 历史消息块', ['用户 / 助手 / 完整工具调用与结果'], '按来源事件投影并追加，正常轮次追加消息，达到水位才调整视图。工具调用和对应返回构成一个单元，在重投影时作为一个单元处理。', ['src/project.ts', 'src/context-manager.ts']),
    node('index', 170, 480, 350, 84, '02 · 历史索引与引用', ['归档事件范围 · 固定摘录 · 读取入口'], '历史归档后出现索引层，提供事件范围、数量与历史反查入口。原文仍保存在事件流中。大工具结果采用固定首段摘录，或把整个工具单元替换为可读取的事件引用。', ['src/context-manager.ts', 'src/event-projection.ts', 'src/types.ts'], 'teal'),
    node('stable', 170, 585, 350, 84, '01 · 稳定前缀', ['人设与工作区规则 · 工具定义'], 'system 与 tools 在相同 bot、接口/模型、身份与预算作用域中保持稳定。任务说明、术语和资料目录进入尾部状态块。工具通过独立 API 字段传递，此图展示逻辑层次。', ['src/project.ts', 'src/runtime.ts', 'src/provider.ts']),
    node('reserve', 640, 690, 450, 83, '输出与安全余量另行预留', ['后台自动预算：8,192 输出 + 4,096 安全'], '预算在最终图像装配后检查，同时覆盖 system、tools、messages、图片、输出预留与安全余量。预留空间不作为历史消息发送。', ['src/token-budget.ts']),
  ].map(item => item.id === 'reserve' ? item : { ...item, shape: 'slice' }),
  edges: [], paths: { all: [], prefix: ['stable', 'index', 'history'], tail: ['state', 'input'], memory: ['index', 'history', 'reserve'] },
};
const projection = {
  title: '事件如何投影成模型输入', subtitle: '原始事件保存证据；投影清单记录采用的来源与渲染方式', height: 800,
  defaultNode: 'ledger',
  nodes: [
    node('events', 40, 170, 310, 116, '01 · 读取当前任务的事件', ['按 bot 与任务归属筛选', '接收尚未处理的补充'], 'harness 筛除独立排队任务，接收当前任务的文字与语音补充；原始事件保留在 SQLite。', ['src/harness.ts', 'src/jobs.ts'], 'teal'),
    node('units', 425, 170, 310, 116, '02 · 构造完整消息单元', ['转写采用最新修订', '调用 + 协议 + 对应结果成组'], 'projectContextUnits 从事件恢复用户、助手与工具单元。当前执行路径读取完整工具结果，恢复原生 thinking / 签名、服务商调用编号和原始参数。旧版本缺失协议或切换模型时转为历史数据，原事件不变。', ['src/project.ts']),
    node('ledger', 810, 170, 310, 116, '03 · 追加投影清单', ['来源指纹去重 · 状态增量', '迟到修订作为新证据追加'], 'ContextManager 以来源编号与内容指纹识别新单元。状态快照写入 context_state，context_append 保存精确来源编号与渲染方式。迟到转写修订追加更新说明，已有前缀保持原样。', ['src/context-manager.ts', 'src/event-projection.ts', 'src/types.ts']),
    node('model', 40, 485, 310, 116, '06 · 调用与记录用量', ['原样回传 thinking / 签名', '请求哈希 · 实际 tokens · 缓存用量'], '正常请求保留消息边界，同接口同模型的协议块完整回传。model_usage 保存预算、耗时、服务端 usage 和共同前缀估算。服务端没有报告的字段保留为未知。', ['src/provider.ts', 'src/context-manager.ts']),
    node('budget', 425, 485, 310, 116, '05 · 检查完整预算', ['高水位触发确定性重投影', '仍超上限则保留输入并报错'], '完整输入使用本地 BPE 估算或官方 Anthropic 计数。超过水位后按固定规则选择、摘录与归档，不调用模型。准备期间到达的补充再次合入后，再发起任务推理。', ['src/token-budget.ts', 'src/context-manager.ts', 'src/harness.ts']),
    node('visual', 810, 485, 310, 116, '04 · 装配实际图像', ['图片附件加载原件字节', '加入受理 / 补充关联画面'], 'hydrateImages 在当前 bot 的资料权限内加载图片。页面画面仅在进程内保留，状态事件与检查点不持久化图像字节；状态文字始终说明临时画面的可用范围。', ['src/attachments.ts', 'src/context-manager.ts'], 'teal'),
  ],
  edges: [edge('events', 'units', 'M350 228H425'), edge('units', 'ledger', 'M735 228H810'), edge('ledger', 'visual', 'M965 286V485', '追加后装配', 965, 390), edge('visual', 'budget', 'M810 543H735'), edge('budget', 'model', 'M425 543H350'), edge('model', 'events', 'M195 485V286', '工具结果与新补充', 195, 390, 'data')],
  paths: { all: [], append: ['events', 'units', 'ledger'], send: ['visual', 'budget', 'model'] },
  sequences: { all: ['events', 'units', 'ledger', 'visual', 'budget', 'model'], append: ['events', 'units', 'ledger'], send: ['visual', 'budget', 'model'] },
};
const protocol = {
  title: 'Thinking 协议的完整回放', subtitle: '正文用于交流；原始协议用于同模型续接；旧会话沿用已记录的结果', height: 850,
  defaultNode: 'saved', viewNodes: { native: 'replay', legacy: 'historical' },
  nodes: [
    node('receive', 40, 155, 310, 115, '01 · 接收模型响应', ['JSON / SSE 分片组装', '正文 · reasoning · 原始调用'], 'OpenAI 兼容接口保留 reasoning_content 与 reasoning_details；Anthropic 保留完整 thinking、signature、redacted thinking 和工具内容块。只将正文作为文字增量显示。', ['src/provider.ts']),
    node('saved', 425, 155, 310, 115, '02 · 保存原始事件', ['assistant_turn.protocol', '接口 / 模型身份与本地调用归属'], '协议与正文分别保存。工具调用以本地唯一 ID 关联执行结果，原始服务商 ID 与参数独立保存，避免事件身份与 API 回放身份混淆。', ['src/types.ts', 'src/harness.ts', 'src/store.ts'], 'teal'),
    node('select', 810, 155, 310, 115, '03 · 确定性恢复', ['完整单元 · 原始事件编号', '校验接口与模型身份'], '投影版本 2 从原始事件重建完整助手/工具组。检查点只保存来源与渲染方式。原生协议完整保留或整体转为引用，不截断签名或 thinking。', ['src/project.ts', 'src/event-projection.ts', 'src/protocol-history.ts']),
    node('replay', 810, 440, 310, 115, '04 · 同模型原样回传', ['thinking + 调用 + 工具结果', '协议参与完整输入预算'], '协议身份匹配时，恢复所需字段及原始工具 ID、参数。DeepSeek 携带 tools 的请求回传所选助手轮次的 reasoning_content，包括没有调用工具的回复。', ['src/provider.ts', 'src/protocol-history.ts', 'src/token-budget.ts']),
    node('historical', 425, 440, 310, 115, '旧会话 / 切换模型', ['缺失字段或协议身份不同', '整组作为历史数据引用'], '无法补回旧版本未保存的协议。将正文、调用与结果转为明确标注的历史数据，保留已有成功结果；不补造 reasoning，也不重新执行工具。', ['src/protocol-history.ts', 'test/thinking-protocol.test.ts'], 'orange'),
    node('limit', 40, 440, 310, 115, '输出额度耗尽', ['保留协议与实际用量', '报告未完成，本步工具不执行'], 'length / max_tokens 不是正常完成。输出预留包含 thinking，可单独提高。reasoningTokens 是 outputTokens 的已报告子集，不额外相加。', ['src/harness.ts', 'src/context-manager.ts', 'src/token-budget.ts'], 'orange'),
    node('continue', 425, 685, 695, 90, '下一次模型调用', ['完整协议或明确历史数据 → 预算校验 → 继续研究'], '正常回放沿用前缀并追加尾部；配置或投影版本变化开启新的作用域。恢复和预算维护不调用摘要模型，也不回滚或重放外部副作用。', ['src/context-manager.ts', 'test/thinking-protocol.test.ts'], 'teal'),
  ],
  edges: [edge('receive', 'saved', 'M350 212H425'), edge('saved', 'select', 'M735 212H810'), edge('select', 'replay', 'M965 270V440', '身份匹配', 965, 360), edge('select', 'historical', 'M810 250H770V385H580V440', '缺失 / 不匹配', 690, 373, 'direct'), edge('receive', 'limit', 'M195 270V440', 'length / max_tokens', 195, 360, 'direct'), edge('replay', 'continue', 'M965 555V685'), edge('historical', 'continue', 'M580 555V685')],
  paths: { native: ['receive', 'saved', 'select', 'replay', 'continue'], legacy: ['saved', 'select', 'historical', 'continue', 'limit'] },
  sequences: { native: ['receive', 'saved', 'select', 'replay', 'continue'], legacy: ['select', 'historical', 'continue', 'limit'] },
};
const prefix = {
  title: '连续请求与稳定前缀', subtitle: '同一周期追加尾部；预算触发确定性重投影，开始新的周期', height: 850,
  defaultNode: 'second', viewNodes: { epoch: 'third', metrics: 'actual' },
  nodes: [
    { ...node('first', 140, 175, 950, 95, '请求 1 · 周期 0', [], '首次请求包含固定 system/tools、已有历史和当前输入。初次请求的共同前缀估算为 0，缓存是否命中由服务端响应决定。', ['src/context-manager.ts']), shape: 'prefix', segments: [['S + T', 170, 'blue'], ['历史 H₀', 215, 'blue'], ['输入 U₁', 135, 'orange']] },
    { ...node('second', 140, 350, 950, 95, '请求 2 · 周期 0', [], '请求 1 的消息块保持顺序与内容，后续追加 A₁、新状态和 U₂。适配器保留用户块边界；本地共同前缀估算用于诊断，真实缓存读取数采用服务端 usage。', ['src/context-manager.ts', 'src/provider.ts']), shape: 'prefix', segments: [['S + T', 170, 'blue'], ['历史 H₀', 215, 'blue'], ['输入 U₁', 135, 'blue'], ['回复 A₁', 135, 'orange'], ['状态 / U₂', 175, 'orange']] },
    { ...node('third', 140, 525, 950, 95, '请求 3 · 周期 1', [], '达到高水位后，按固定规则选择事件与渲染方式，建立历史索引和保留片段。system/tools 继续稳定，messages 从变化处重建，周期号与缓存路由键更新。', ['src/context-manager.ts']), shape: 'prefix', segments: [['S + T', 170, 'blue'], ['历史索引 I₁', 235, 'teal'], ['保留的近期块', 240, 'teal'], ['新输入 U₃', 185, 'orange']] },
    node('estimate', 140, 690, 440, 100, '本地共同前缀估算', ['按消息指纹比较 · 每次调用记录', 'prefixTokens ≠ 缓存命中'], '比较当前与前次成功任务请求的消息指纹，估算共同前缀 token。阶段切换或应用重启后，此诊断比较从 0 开始。', ['src/context-manager.ts']),
    node('actual', 630, 690, 460, 100, '服务端实际用量', ['input / output · cache read / write', '未报告字段为 null'], 'OpenAI 读取 cached_tokens，DeepSeek 读取 prompt_cache_hit_tokens；Anthropic 合计普通、缓存创建与读取的输入。CLI stats 按服务端实际值汇总；投影不产生额外推理用量。', ['src/provider.ts', 'src/context-manager.ts', 'src/cli.ts'], 'teal'),
  ], edges: [edge('first', 'second', 'M100 245V420', '追加', 99, 327), edge('second', 'third', 'M100 420V595', '重投影', 99, 503, 'direct')],
  paths: { all: [], epoch: ['second', 'third'], metrics: ['estimate', 'actual'] },
};
const budget = {
  title: '预算、水位与确定性重投影', subtitle: '后台自动预算：总窗口 131,072；输入低 32,768 / 高 98,304，曲线为示意值', height: 900,
  defaultNode: 'high', viewNodes: { rebuild: 'checkpoint', accounting: 'input' },
  nodes: [
    node('input', 40, 145, 620, 94, '输入可用空间 118,784', ['system + tools + messages + images'], '后台目标总窗口 131,072 减去输出 8,192 和安全余量 4,096，输入容量 118,784。文字聊天、子 bot、通话委派共用策略。服务端元数据约束实际预算；未知部署回退 32K。实际请求超过硬上限时不会发送任务推理。', ['src/token-budget.ts']),
    node('output', 685, 145, 200, 94, '输出 8,192', ['含 thinking'], '输出预留自动受模型能力约束，并包含 thinking。max_tokens 耗尽时保留记录、报告未完成，本步工具不执行。投影器不发起摘要请求。', ['src/provider.ts', 'src/token-budget.ts']),
    node('safety', 910, 145, 210, 94, '安全 4,096', ['协议 / 估算余量'], '为协议封装、tokenizer 差异和计数偏差保留安全空间。图片本地计数每张预留 8,192，计入输入预算。', ['src/token-budget.ts'], 'teal'),
    { ...node('start', 155, 540, 0, 0, '24,000', [], '示意初始输入。正常轮次保留已有前缀，追加新的对话、工具结果与状态。', ['src/context-manager.ts']), shape: 'point' },
    { ...node('grow', 345, 476, 0, 0, '50,000', [], '输入逐步增长，不按固定最近 N 条截断；完整工具结果参与预算。', ['src/context-manager.ts']), shape: 'point' },
    { ...node('high', 535, 360, 0, 0, '100,000', [], '后台输入超过独立高水位 98,304 时触发确定性重投影。较小模型自动降低高低水位，模型能力改变时建立新投影作用域。', ['src/context-manager.ts', 'src/token-budget.ts'], 'orange'), shape: 'point' },
    { ...node('reduced', 725, 525, 0, 0, '30,000', [], '后台以独立低水位 32,768 为目标选择旧块，保留当前任务输入、最新状态与最后的对话单元。结果须在硬上限内且比原输入小；必要内容较大时可以高于目标。', ['src/context-manager.ts'], 'teal'), shape: 'point' },
    { ...node('next', 915, 445, 0, 0, '62,000', [], '检查点提交后进入新周期，正常尾部继续追加。下一次触及高水位才再次调整投影。', ['src/context-manager.ts']), shape: 'point' },
    node('index', 40, 680, 310, 120, '01 · 选择与折叠', ['最新状态 + 当前要求 + 工作片段', '固定摘录 + 可读取的原文引用'], '纯函数 rebuildProjection 先移除被取代的旧状态，再为较旧工具结果生成固定摘录，最后按已结束任务优先、其余较旧单元顺序归档。原始事件不修改。', ['src/context-manager.ts']),
    node('validate', 425, 680, 310, 120, '02 · 校验与保留', ['最新要求 · 完整工具单元', '来源引用 / 上限 / 缩小幅度校验'], '当前任务输入与连续补充、每个键的最新状态、最后一个对话单元保留。固定工具摘录保留调用与结果配对；取消或无法满足硬预算时不提交新检查点。', ['src/context-manager.ts', 'test/context-manager.test.ts']),
    node('checkpoint', 810, 680, 310, 120, '03 · 提交新周期', ['context_checkpoint · epoch + 1', '版本 + 来源编号 + 渲染方式'], '检查点保存 projectorVersion、throughEventId、来源清单、状态引用与输入保护集合。重启通过原事件渲染同一视图，不重新调用模型或执行工具。临时页面像素只在当前进程可用。', ['src/context-manager.ts', 'src/event-projection.ts', 'src/types.ts'], 'teal'),
  ],
  edges: [edge('index', 'validate', 'M350 740H425'), edge('validate', 'checkpoint', 'M735 740H810')],
  paths: { all: [], rebuild: ['high', 'reduced', 'index', 'validate', 'checkpoint'], accounting: ['input', 'output', 'safety'] },
  sequences: { all: ['start', 'grow', 'high', 'index', 'validate', 'checkpoint', 'reduced', 'next'], rebuild: ['high', 'index', 'validate', 'checkpoint', 'reduced'], accounting: ['input', 'output', 'safety'] },
};

const svgStyle = `
  text { font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
  .title { font-size: 27px; font-weight: 650; fill: #203453; letter-spacing: -.5px; }
  .subtitle { font-size: 15px; fill: #6b7c94; }
  .footer { font-size: 12px; fill: #8593a8; }
  .wire { fill: none; stroke: #6683be; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .wire.data { stroke: #5e9295; stroke-dasharray: 5 5; }
  .wire.direct { stroke: #a68155; stroke-dasharray: 2 5; }
  .edge-label { font-size: 12px; fill: #7a889f; text-anchor: middle; paint-order: stroke; stroke: #fff; stroke-width: 7px; stroke-linejoin: round; }
  .node { cursor: pointer; outline: none; }
  .node rect { fill: #f7f9fd; stroke: #d8e2f1; stroke-width: 1.2; }
  .node .accent { fill: #2b59c3; stroke: none; }
  .node.teal rect { fill: #f2f8f7; stroke: #d0e4e0; }
  .node.teal .accent { fill: #428c83; }
  .node.orange rect { fill: #fdf8f2; stroke: #eddcc7; }
  .node.orange .accent { fill: #b77b38; }
  .node .node-title { fill: #263f63; font-size: 19px; font-weight: 600; }
  .node .node-line { fill: #71829b; font-size: 13px; }
  .node.selected rect, .node:focus-visible rect { stroke: #2b59c3; stroke-width: 2.5; fill: #edf3ff; }
  .node.selected .node-title { fill: #234fae; }
  .node.dim, .edge.dim { opacity: .2; }
  .node.selected.dim { opacity: 1; }
  .edge.active .wire { stroke: #2b59c3; stroke-width: 2.8; }
  .lane-label { font-size: 12px; fill: #71829b; font-weight: 550; }
  .node.slice .surface { fill: #dce7fc; stroke: #aac1ed; stroke-width: 1.3; }
  .node.slice .cap { fill: #edf3ff; stroke: #aac1ed; stroke-width: 1.3; }
  .node.slice.teal .surface { fill: #dbeeea; stroke: #a6cdc3; }
  .node.slice.teal .cap { fill: #f0f9f6; stroke: #a6cdc3; }
  .node.slice.orange .surface { fill: #f6e4ce; stroke: #dcb78b; }
  .node.slice.orange .cap { fill: #fdf5e9; stroke: #dcb78b; }
  .node.slice.selected .surface, .node.slice.selected .cap, .node.slice:focus-visible .cap { stroke: #2b59c3; stroke-width: 3; }
  .node.point circle { fill: #2b59c3; stroke: white; stroke-width: 4; }
  .node.point.orange circle { fill: #c78543; }
  .node.point.teal circle { fill: #428c83; }
  .node.point.selected circle, .node.point:focus-visible circle { stroke: #95b6ff; stroke-width: 6; }
  .node.prefix.selected .row-label, .node.prefix:focus-visible .row-label { fill: #2b59c3; font-weight: 650; }
  .segment-text { font-size: 16px; font-weight: 550; fill: #35527e; text-anchor: middle; }
  .point-label { font-size: 16px; font-weight: 650; fill: #3d587e; text-anchor: middle; }
  .annotation { font-size: 13px; fill: #71829b; }
`;

function element(tag, attributes = {}, content) {
  const item = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, String(value));
  if (content !== undefined) item.textContent = content;
  return item;
}

function renderDiagram(id, config) {
  const figure = document.querySelector(`[data-diagram="${id}"]`);
  const svg = element('svg', { viewBox: `0 0 1160 ${config.height}`, width: 1160, height: config.height, role: 'group', 'aria-label': config.title });
  svg.append(element('title', {}, config.title), element('desc', {}, config.subtitle));
  const style = element('style', {}, svgStyle);
  svg.append(style, element('rect', { width: 1160, height: config.height, fill: '#ffffff' }));
  const defs = element('defs');
  for (const [kind, color] of [['control', '#6683be'], ['data', '#5e9295'], ['direct', '#a68155']]) {
    const marker = element('marker', { id: `${id}-${kind}`, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    marker.append(element('path', { d: 'M1 1L9 5L1 9', fill: 'none', stroke: color, 'stroke-width': 1.6 }));
    defs.append(marker);
  }
  svg.append(defs);
  svg.append(element('text', { x: 40, y: 48, class: 'title' }, config.title));
  svg.append(element('text', { x: 40, y: 78, class: 'subtitle' }, config.subtitle));
  svg.append(element('path', { d: 'M40 105H1120', stroke: '#e8edf5', 'stroke-width': 1 }));
  if (id === 'overview') {
    [['用户与渲染进程', 40], ['应用协调 · Electron 主进程', 345], ['模型服务与工具执行', 765]].forEach(([text, x]) => svg.append(element('text', { x, y: 130, class: 'lane-label' }, text)));
  }
  if (id === 'layers') {
    svg.append(element('path', { d: 'M100 660V170', class: 'wire', 'marker-end': `url(#${id}-control)` }));
    svg.append(element('text', { x: 82, y: 442, transform: 'rotate(-90 82 442)', class: 'annotation', 'text-anchor': 'middle' }, '请求的逻辑顺序'));
  }
  if (id === 'budget') {
    for (const [y, label, color] of [[315, '输入容量 118,784', '#b3bfd2'], [364, '输入高水位 98,304', '#cca571'], [521, '输入低水位目标 32,768', '#83b2a8']]) {
      svg.append(element('path', { d: `M120 ${y}H1060`, stroke: color, 'stroke-dasharray': '5 6', fill: 'none' }));
      svg.append(element('text', { x: 1060, y: y - 12, class: 'annotation', 'text-anchor': 'end' }, label));
    }
    svg.append(element('path', { d: 'M120 300V600H1060', stroke: '#dce3ef', fill: 'none' }));
    svg.append(element('path', { d: 'M155 540L345 476L535 360', stroke: '#2b59c3', 'stroke-width': 3, fill: 'none' }));
    svg.append(element('path', { d: 'M535 360L725 525', stroke: '#b77b38', 'stroke-width': 3, 'stroke-dasharray': '7 5', fill: 'none' }));
    svg.append(element('path', { d: 'M725 525L915 445', stroke: '#2b59c3', 'stroke-width': 3, fill: 'none' }));
    svg.append(element('text', { x: 620, y: 580, class: 'annotation', 'text-anchor': 'middle' }, '选择 / 摘录 → 校验 → 新周期'));
    svg.append(element('text', { x: 120, y: 628, class: 'annotation' }, '连续模型调用 →'));
  }
  for (const connection of config.edges) {
    const group = element('g', { class: 'edge', 'data-from': connection.from, 'data-to': connection.to });
    group.append(element('path', { class: `wire ${connection.kind}`, d: connection.d, 'marker-end': `url(#${id}-${connection.kind})` }));
    if (connection.label) group.append(element('text', { class: 'edge-label', x: connection.x, y: connection.y }, connection.label));
    svg.append(group);
  }
  for (const item of config.nodes) {
    const group = element('g', { class: `node ${item.tone} ${item.shape || ''}`, 'data-node': item.id, role: 'button', tabindex: 0, 'aria-label': item.title, 'aria-pressed': 'false' });
    if (item.shape === 'slice') {
      const { x, y, w, h } = item, ry = 26;
      group.append(element('path', { class: 'surface', d: `M${x} ${y}v${h}a${w/2} ${ry} 0 0 0 ${w} 0v-${h}Z` }));
      group.append(element('ellipse', { class: 'cap', cx: x + w/2, cy: y, rx: w/2, ry }));
      group.append(element('path', { d: `M${x + w + 20} ${y + 30}H615`, stroke: '#c9d6eb', fill: 'none' }));
      group.append(element('text', { x: 640, y: y + 24, class: 'node-title' }, item.title));
      item.lines.forEach((line, index) => group.append(element('text', { x: 640, y: y + 50 + index * 20, class: 'node-line' }, line)));
      svg.append(group); continue;
    }
    if (item.shape === 'point') {
      group.append(element('circle', { cx: item.x, cy: item.y, r: 10 }));
      group.append(element('text', { x: item.x, y: item.y - 24, class: 'point-label' }, item.title));
      svg.append(group); continue;
    }
    if (item.shape === 'prefix') {
      group.append(element('text', { x: item.x, y: item.y, class: 'node-title row-label' }, item.title));
      let x = item.x;
      for (const [label, width, tone] of item.segments) {
        group.append(element('rect', { x, y: item.y + 22, width: width - 5, height: 63, rx: 7, style: `fill:${({blue:'#edf3ff',teal:'#e4f2ed',orange:'#fbecd9'})[tone]};stroke:${({blue:'#c7d8f5',teal:'#b8d9cd',orange:'#e4c7a0'})[tone]}` }));
        group.append(element('text', { x: x + (width - 5)/2, y: item.y + 61, class: 'segment-text' }, label));
        x += width;
      }
      svg.append(group); continue;
    }
    group.append(element('rect', { x: item.x, y: item.y, width: item.w, height: item.h, rx: 9 }));
    group.append(element('rect', { class: 'accent', x: item.x, y: item.y + 20, width: 3, height: item.h - 40, rx: 1.5 }));
    group.append(element('text', { class: 'node-title', x: item.x + 20, y: item.y + 33 }, item.title));
    item.lines.forEach((line, index) => group.append(element('text', { class: 'node-line', x: item.x + 20, y: item.y + 58 + index * 20 }, line)));
    svg.append(group);
  }
  const footerY = config.height - 25;
  (['layers', 'prefix', 'budget'].includes(id) ? [] : [['控制与模型往返', 'control', 40], ['上下文与持久化', 'data', 275], ['直接工具 / 显式排队', 'direct', 510]]).forEach(([label, kind, x]) => {
    svg.append(element('path', { class: `wire ${kind}`, d: `M${x} ${footerY - 5}h28` }));
    svg.append(element('text', { class: 'footer', x: x + 39, y: footerY }, label));
  });
  svg.append(element('text', { class: 'footer', x: 1120, y: footerY, 'text-anchor': 'end' }, '小王同学 · v0.1.18'));
  figure.querySelector('.diagram-scroll').append(svg);
  const state = { id, config, figure, svg, view: figure.querySelector('[data-view][aria-pressed=true]').dataset.view, step: -1, timer: null };
  diagrams.set(id, state);
  figure.addEventListener('click', event => {
    const nodeButton = event.target.closest('[data-node]');
    if (nodeButton) selectNode(state, nodeButton.dataset.node);
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) setView(state, viewButton.dataset.view);
    const exportButton = event.target.closest('[data-export]');
    if (exportButton) void exportDiagram(state, exportButton.dataset.export);
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'expand') toggleExpanded(state);
    if (action === 'next') { stopPlayback(state); advance(state); }
    if (action === 'play') togglePlayback(state);
  });
  svg.addEventListener('keydown', event => {
    const target = event.target.closest('[data-node]');
    if (target && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      selectNode(state, target.dataset.node);
    }
  });
  setView(state, state.view);
}

function selectNode(state, nodeId) {
  const selected = state.config.nodes.find(item => item.id === nodeId);
  for (const group of state.svg.querySelectorAll('[data-node]')) {
    const active = group.dataset.node === nodeId;
    group.classList.toggle('selected', active);
    group.setAttribute('aria-pressed', String(active));
  }
  const detail = state.figure.querySelector('.node-detail');
  const heading = document.createElement('h3');
  heading.textContent = selected.title;
  const description = document.createElement('p');
  description.textContent = selected.description;
  detail.replaceChildren(heading, description);
  for (const file of selected.sources) {
    const link = document.createElement('a');
    link.href = SOURCE_ROOT + file;
    link.textContent = file + ' ↗';
    detail.append(link);
  }
}

function highlight(state, activeIds, step = false) {
  const active = new Set(activeIds);
  for (const item of state.svg.querySelectorAll('[data-node]')) item.classList.toggle('dim', active.size > 0 && !active.has(item.dataset.node));
  for (const item of state.svg.querySelectorAll('.edge')) {
    const on = active.has(item.dataset.from) && active.has(item.dataset.to);
    item.classList.toggle('dim', active.size > 0 && !on);
    item.classList.toggle('active', on && step);
  }
}

function setView(state, view) {
  stopPlayback(state);
  state.view = view;
  state.step = -1;
  for (const button of state.figure.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  highlight(state, state.config.paths[view]);
  selectNode(state, state.config.viewNodes?.[view] ?? state.config.defaultNode);
}

function advance(state) {
  const steps = state.config.sequences[state.view];
  state.step = (state.step + 1) % steps.length;
  const current = steps[state.step];
  const previous = steps[Math.max(0, state.step - 1)];
  highlight(state, [current, previous], true);
  selectNode(state, current);
  if (state.step === steps.length - 1) stopPlayback(state);
}

function stopPlayback(state) {
  clearInterval(state.timer);
  state.timer = null;
  const button = state.figure.querySelector('[data-action=play]');
  if (button) { button.textContent = '播放流程'; button.setAttribute('aria-pressed', 'false'); }
}

function togglePlayback(state) {
  if (state.timer) { stopPlayback(state); return; }
  const button = state.figure.querySelector('[data-action=play]');
  state.timer = setInterval(() => advance(state), 1500);
  button.textContent = '暂停';
  button.setAttribute('aria-pressed', 'true');
  advance(state);
}

function toggleExpanded(state) {
  const expanded = !state.figure.classList.contains('expanded');
  for (const other of diagrams.values()) {
    other.figure.classList.remove('expanded');
    const button = other.figure.querySelector('[data-action=expand]');
    button.textContent = '放大';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', '放大' + other.config.title);
    other.figure.removeAttribute('role');
    other.figure.removeAttribute('aria-modal');
    other.figure.removeAttribute('aria-label');
  }
  state.figure.classList.toggle('expanded', expanded);
  const expandButton = state.figure.querySelector('[data-action=expand]');
  expandButton.textContent = expanded ? '收起' : '放大';
  expandButton.setAttribute('aria-expanded', String(expanded));
  expandButton.setAttribute('aria-label', (expanded ? '收起' : '放大') + state.config.title);
  if (expanded) {
    state.figure.setAttribute('role', 'dialog');
    state.figure.setAttribute('aria-modal', 'true');
    state.figure.setAttribute('aria-label', state.config.title);
  }
  document.body.style.overflow = expanded ? 'hidden' : '';
  if (expanded) state.svg.querySelector('[data-node]').focus({ preventScroll: true });
}

function serializedDiagram(state, all = false) {
  const clone = state.svg.cloneNode(true);
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('role', 'img');
  for (const group of clone.querySelectorAll('[data-node]')) {
    group.removeAttribute('tabindex');
    group.removeAttribute('role');
    group.removeAttribute('aria-pressed');
  }
  if (all) for (const item of clone.querySelectorAll('.selected,.dim,.active')) item.classList.remove('selected', 'dim', 'active');
  return new XMLSerializer().serializeToString(clone);
}

async function diagramBlob(state, format, all = false) {
  const svg = serializedDiagram(state, all);
  if (format === 'svg') return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  await document.fonts.ready;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 2320;
    canvas.height = state.config.height * 2;
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片编码失败')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

function showStatus(text) {
  const status = document.querySelector('.export-status');
  clearTimeout(statusTimer);
  status.textContent = text;
  statusTimer = setTimeout(() => { status.textContent = ''; }, 3000);
}

async function exportDiagram(state, format) {
  try {
    const blob = await diagramBlob(state, format);
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `xiaowang-${state.id}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showStatus(`已导出 ${format.toUpperCase()} 图片`);
  } catch (error) { showStatus(`导出失败，${error.message}`); }
}

for (const [id, config] of Object.entries({ overview, loop, context, layers, projection, protocol, prefix, budget })) renderDiagram(id, config);
for (const link of document.querySelectorAll('[data-source]')) link.href = SOURCE_ROOT + link.dataset.source;

document.querySelector('#print-document').addEventListener('click', () => {
  for (const state of diagrams.values()) stopPlayback(state);
  window.print();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Tab') {
    const expanded = document.querySelector('.diagram.expanded');
    if (expanded) {
      const focusable = [...expanded.querySelectorAll('button, [tabindex="0"], a[href]')];
      const next = event.shiftKey ? focusable.at(-1) : focusable[0];
      const boundary = event.shiftKey ? focusable[0] : focusable.at(-1);
      if (document.activeElement === boundary) { event.preventDefault(); next.focus(); }
    }
  }
  if (event.key === 'Escape') {
    const state = [...diagrams.values()].find(item => item.figure.classList.contains('expanded'));
    if (state) { toggleExpanded(state); state.figure.querySelector('[data-action=expand]').focus(); }
  }
});
const navLinks = [...document.querySelectorAll('nav a')];
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    navLinks.forEach(link => link.classList.toggle('active', link.hash === '#' + entry.target.id));
  }
}, { rootMargin: '-5% 0px -65% 0px' });
for (const section of document.querySelectorAll('main > [id]')) observer.observe(section);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) for (const state of diagrams.values()) stopPlayback(state);
});

// Used for generating the repository's static images from the same diagram definitions.
window.xiaowangTechnical = {
  async image(id, format = 'png') {
    const blob = await diagramBlob(diagrams.get(id), format, true);
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  },
};
