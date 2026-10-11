import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";

import * as store from "./store";
import * as ui from "./ui";
import {
  ALL_TAIL_FALLBACK,
  ALL_TAIL_SENTINEL,
  ALL_TAIL_UNSUPPORTED_RE,
  GONE_ERROR_RE,
  LOG_TAIL_LADDER,
} from "./types";
import type {
  Container,
  ContainerInfo,
  DockerStatus,
  EventPayload,
  LogLine,
  LogsPayload,
  TailSize,
} from "./types";

type RenderMode = { kind: "bottom" } | { kind: "keep" } | { kind: "anchor"; scrollHeight: number; scrollTop: number };

/** Set while the DOM is rewritten programmatically, so the resulting scroll
 *  events are not mistaken for the user scrolling to the top. */
let suppressScroll = false;
let allTailSupported = true;

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function describeLogError(message: string): string {
  return GONE_ERROR_RE.test(message) ? "容器已删除，日志不可用" : message;
}

function withSuppressedScroll(action: () => void): void {
  suppressScroll = true;
  action();
  const clear = (): void => {
    suppressScroll = false;
  };
  // The frame callback covers the scroll event a rewrite produces; the timer is a
  // fallback for when the window is hidden and animation frames stop firing.
  requestAnimationFrame(clear);
  setTimeout(clear, 150);
}

function render(container: Container, mode: RenderMode): void {
  ui.updateRow(container);
  if (!container.expanded) return;
  withSuppressedScroll(() => {
    ui.renderLogs(container);
    if (mode.kind === "anchor") ui.anchorLogs(container.id, mode);
    else if (mode.kind === "bottom") ui.scrollLogsToBottom(container.id);
  });
}

function nextTail(container: Container): TailSize | null {
  if (container.logsExhausted) return null;
  if (container.pageSize === 0) return LOG_TAIL_LADDER[0];
  if (container.pageSize === ALL_TAIL_SENTINEL) return null;
  const index = LOG_TAIL_LADDER.indexOf(container.pageSize);
  if (index < 0) return LOG_TAIL_LADDER[LOG_TAIL_LADDER.length - 1];
  return index + 1 < LOG_TAIL_LADDER.length ? LOG_TAIL_LADDER[index + 1] : null;
}

async function requestLogs(id: string, tail: TailSize): Promise<LogLine[]> {
  if (tail !== "all") return invoke<LogLine[]>("get_logs", { id, tail, timestamps: true });

  if (allTailSupported) {
    try {
      return await invoke<LogLine[]>("get_logs", { id, tail: "all", timestamps: true });
    } catch (error) {
      if (!ALL_TAIL_UNSUPPORTED_RE.test(errorMessage(error))) throw error;
      allTailSupported = false;
    }
  }
  return invoke<LogLine[]>("get_logs", { id, tail: ALL_TAIL_FALLBACK, timestamps: true });
}

async function loadLogs(container: Container, tail: TailSize, anchor: ui.ScrollAnchor | null): Promise<void> {
  if (container.loading) return;

  container.loading = true;
  container.logsError = null;
  store.notify(container);
  render(container, { kind: "keep" });

  try {
    const lines = await requestLogs(container.id, tail);
    container.logs = lines;
    container.logsLoaded = true;
    container.pageSize = tail === "all" ? ALL_TAIL_SENTINEL : tail;
    if (tail === "all") container.logsExhausted = true;
  } catch (error) {
    const raw = errorMessage(error);
    container.logsError = describeLogError(raw);
    container.logsLoaded = true;
    // A container that is gone will not answer again: stop retrying.
    if (GONE_ERROR_RE.test(raw)) container.logsExhausted = true;
  } finally {
    container.loading = false;
    store.touch(container);
    render(container, anchor ? { kind: "anchor", ...anchor } : { kind: "bottom" });
  }
}

function logKey(line: LogLine): string {
  return `${line.ts ?? ""}\u0000${line.stream}\u0000${line.text}`;
}

/** Append the death capture to the cached lines, dropping the overlapping head. */
function mergeLogLines(cached: readonly LogLine[], incoming: readonly LogLine[]): LogLine[] {
  if (incoming.length === 0) return [...cached];
  if (cached.length === 0) return [...incoming];

  const max = Math.min(cached.length, incoming.length);
  for (let overlap = max; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (logKey(cached[cached.length - overlap + index]) !== logKey(incoming[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return [...cached, ...incoming.slice(overlap)];
  }
  return [...cached, ...incoming];
}

function handleChange(change: store.Change): void {
  if (change.kind === "insert") ui.createRow(change.container, change.position);
  else if (change.kind === "clear") ui.removeAllRows();
  ui.sync(store.getContainers());
}

function onToggle(id: string): void {
  const container = store.findById(id);
  if (!container) return;

  container.expanded = !container.expanded;
  store.notify(container);

  if (!container.expanded) {
    ui.updateRow(container);
    return;
  }

  render(container, { kind: "bottom" });
  if (container.logsLoaded || container.loading || container.logsExhausted) return;
  void loadLogs(container, LOG_TAIL_LADDER[0], null);
}

function onLogScroll(id: string, body: HTMLElement): void {
  if (suppressScroll) return;

  const container = store.findById(id);
  if (!container || !container.expanded) return;
  if (!container.logsLoaded || container.logsExhausted || container.loading) return;
  if (body.scrollTop > 8) return;
  // Nothing above the viewport: there is no earlier line to fetch.
  if (body.scrollHeight - body.clientHeight <= 8) return;

  const tail = nextTail(container);
  if (tail === null) return;

  void loadLogs(container, tail, { scrollHeight: body.scrollHeight, scrollTop: body.scrollTop });
}

const CLEAR_PROMPT = "确定清空所有容器记录与日志吗？";

/** A native message box on top of the always-on-top window, not the webview's own prompt. */
async function confirmClear(): Promise<boolean> {
  try {
    return await ask(CLEAR_PROMPT, {
      title: "Docker Watcher",
      kind: "warning",
      okLabel: "清空",
      cancelLabel: "取消",
    });
  } catch (error) {
    // The plugin is the only way this can fail; keep the button working regardless.
    console.error("系统弹窗不可用，回退到内置确认框", error);
    return window.confirm(CLEAR_PROMPT);
  }
}

function onClear(): void {
  void confirmClear().then((confirmed) => {
    if (!confirmed) return;
    store.clearAll();
    ui.hideBanner();
  });
}

function onClose(): void {
  void getCurrentWindow().hide();
}

function handleEvent(payload: EventPayload): void {
  store.applyEvent(payload);
}

function handleLogs(payload: LogsPayload): void {
  const container = store.findById(payload.id);
  if (!container) return;

  if (payload.lines.length === 0 && payload.error) {
    container.logsError = describeLogError(payload.error);
    if (GONE_ERROR_RE.test(payload.error)) container.logsExhausted = true;
    store.touch(container);
    render(container, { kind: "keep" });
    return;
  }

  container.logs = mergeLogLines(container.logs, payload.lines);
  container.logsLoaded = true;
  container.logsError = null;
  if (container.pageSize !== ALL_TAIL_SENTINEL) {
    container.pageSize = Math.max(container.pageSize, payload.tail);
  }
  store.touch(container);
  render(container, { kind: "keep" });
}

async function bootstrap(): Promise<void> {
  try {
    await listen<EventPayload>("docker://event", (event) => handleEvent(event.payload));
    await listen<LogsPayload>("docker://logs", (event) => handleLogs(event.payload));
    await listen<DockerStatus>("docker://status", (event) => ui.setDockerStatus(event.payload));
  } catch (error) {
    ui.showBanner(`Docker 事件订阅失败：${errorMessage(error)}`);
  }

  try {
    ui.setDockerStatus(await invoke<DockerStatus>("get_docker_status"));
  } catch (error) {
    ui.setDockerStatus({ connected: false, error: errorMessage(error) });
  }

  try {
    store.applySnapshot(await invoke<ContainerInfo[]>("list_containers"));
  } catch (error) {
    ui.showBanner(`容器列表获取失败：${errorMessage(error)}`);
  }
}

function start(): void {
  ui.init({ onToggle, onClear, onClose, onLogScroll });
  store.onBanner((message) => ui.showBanner(message));

  // Render the previous session first, then merge the live snapshot into it.
  store.loadPersisted();
  ui.mountAll(store.getContainers());
  store.subscribe(handleChange);
  ui.sync(store.getContainers());

  void bootstrap();
}

start();
