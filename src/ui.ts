import type { AnsiStyle } from "./ansi";
import { isStyled, parseAnsi } from "./ansi";
import type { Container, DockerStatus, LogLine } from "./types";

export interface UiHandlers {
  onToggle(id: string): void;
  onClear(): void;
  onClose(): void;
  onLogScroll(id: string, body: HTMLElement): void;
}

export interface ScrollAnchor {
  scrollHeight: number;
  scrollTop: number;
}

interface RowRefs {
  root: HTMLElement;
  head: HTMLElement;
  dot: HTMLElement;
  name: HTMLElement;
  image: HTMLElement;
  status: HTMLElement;
  badge: HTMLElement;
  logs: HTMLElement;
  logsHead: HTMLElement;
  logsBody: HTMLElement;
}

const rows = new Map<string, RowRefs>();

let listEl: HTMLElement;
let countEl: HTMLElement;
let emptyEl: HTMLElement;
let dockerDotEl: HTMLElement;
let dockerErrorEl: HTMLElement;
let bannerEl: HTMLElement;
let bannerTimer: ReturnType<typeof setTimeout> | null = null;

function mustFind<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`缺少必要的元素: ${selector}`);
  return element;
}

export function init(handlers: UiHandlers): void {
  listEl = mustFind("#list");
  countEl = mustFind("#count");
  emptyEl = mustFind("#empty");
  dockerDotEl = mustFind("#docker-dot");
  dockerErrorEl = mustFind("#docker-error");
  bannerEl = mustFind("#banner");

  mustFind("#clear-btn").addEventListener("click", () => handlers.onClear());
  mustFind("#close-btn").addEventListener("click", () => handlers.onClose());

  listEl.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // Text inside the log area is selectable: clicking it must not collapse the row.
    if (target.closest(".logs")) return;
    const rowElement = target.closest<HTMLElement>(".row");
    const id = rowElement?.dataset.id;
    if (id) handlers.onToggle(id);
  });

  // `scroll` does not bubble, so it is observed in the capture phase.
  listEl.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("logs-body")) return;
      const id = target.closest<HTMLElement>(".row")?.dataset.id;
      if (id) handlers.onLogScroll(id, target);
    },
    true,
  );

  bannerEl.addEventListener("click", () => hideBanner());
}

function buildRow(container: Container): RowRefs {
  const root = document.createElement("div");
  root.className = "row";
  root.dataset.id = container.id;

  const head = document.createElement("div");
  head.className = "row-head";

  const dot = document.createElement("span");
  dot.className = "dot";

  const main = document.createElement("div");
  main.className = "row-main";

  const nameLine = document.createElement("div");
  nameLine.className = "name-line";
  const name = document.createElement("span");
  name.className = "name";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = "已删除";
  badge.hidden = true;
  nameLine.append(name, badge);

  const image = document.createElement("div");
  image.className = "image";
  main.append(nameLine, image);

  const meta = document.createElement("div");
  meta.className = "row-meta";
  const status = document.createElement("span");
  status.className = "status";
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = "▸";
  meta.append(status, chevron);

  head.append(dot, main, meta);

  const logs = document.createElement("div");
  logs.className = "logs";
  const logsHead = document.createElement("div");
  logsHead.className = "logs-head";
  const logsBody = document.createElement("div");
  logsBody.className = "logs-body";
  logs.append(logsHead, logsBody);

  root.append(head, logs);

  return { root, head, dot, name, image, status, badge, logs, logsHead, logsBody };
}

function stateClass(container: Container): string {
  if (container.deleted) return "state-deleted";
  switch (container.state) {
    case "running":
      return "state-running";
    case "paused":
    case "restarting":
    case "stopping":
      return "state-warn";
    case "exited":
    case "dead":
    case "removing":
    case "removed":
      return "state-dead";
    default:
      return "state-idle";
  }
}

function statusText(container: Container): string {
  if (container.deleted) return container.status || "已删除";
  return container.status || container.state || "未知";
}

function formatTs(ts: string | null): string {
  if (!ts) return "";
  const full = /T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?/.exec(ts);
  if (full) return full[2] ? `${full[1]}.${full[2].padEnd(3, "0")}` : full[1];
  const timeOnly = /^(\d{2}:\d{2}:\d{2})/.exec(ts);
  if (timeOnly) return timeOnly[1];
  return ts.length > 24 ? ts.slice(0, 24) : ts;
}

/** Paint one parsed run: everything the program asked for, on top of the pane's own colours. */
function applyAnsiStyle(element: HTMLElement, style: AnsiStyle): void {
  if (!isStyled(style)) return;
  if (style.fg) element.style.color = style.fg;
  if (style.bg) element.style.backgroundColor = style.bg;
  if (style.bold) element.style.fontWeight = "600";
  if (style.dim) element.style.opacity = "0.7";
  if (style.italic) element.style.fontStyle = "italic";
  if (style.underline) element.style.textDecoration = "underline";
}

function buildLogLine(line: LogLine): HTMLElement {
  const element = document.createElement("div");
  element.className = `log-line ${line.stream}`;

  const ts = document.createElement("span");
  ts.className = "log-ts";
  const label = formatTs(line.ts);
  ts.textContent = label;
  ts.hidden = label.length === 0;

  const text = document.createElement("span");
  text.className = "log-text";
  const runs = parseAnsi(line.text);
  // Plain lines (no escape sequences) stay a single text node — the common case should not
  // pay for a child span per line.
  if (runs.length === 1 && !isStyled(runs[0].style)) {
    text.textContent = runs[0].text;
  } else {
    for (const run of runs) {
      const piece = document.createElement("span");
      piece.textContent = run.text;
      applyAnsiStyle(piece, run.style);
      text.append(piece);
    }
  }

  element.append(ts, text);
  return element;
}

function logsHeaderText(container: Container): string {
  if (container.loading) {
    return container.logs.length > 0 ? `正在加载更多…（已有 ${container.logs.length} 行）` : "正在加载日志…";
  }
  if (container.logs.length > 0) {
    // A "container is gone" payload can arrive after the lines were already fetched,
    // so never claim the logs are unavailable while they are on screen.
    const reachedTop = container.logsExhausted && !container.logsError;
    const base = reachedTop
      ? `已到最顶端 · 共 ${container.logs.length} 行`
      : `已加载最后 ${container.logs.length} 行`;
    return container.logsError ? `${base}（${container.logsError}）` : base;
  }
  if (container.logsError) return container.logsError;
  if (container.logsExhausted) return "已到最顶端 · 共 0 行";
  if (container.logsLoaded) return "暂无日志输出";
  if (container.pageSize > 0) return `已加载最后 ${container.pageSize} 行`;
  return "尚未加载日志";
}

export function createRow(container: Container, position: "top" | "bottom"): void {
  const refs = buildRow(container);
  rows.set(container.id, refs);
  if (position === "top") listEl.prepend(refs.root);
  else listEl.append(refs.root);
  updateRow(container);
}

export function mountAll(containers: readonly Container[]): void {
  for (const container of containers) createRow(container, "bottom");
}

export function removeAllRows(): void {
  rows.clear();
  listEl.replaceChildren();
}

export function updateRow(container: Container): void {
  const refs = rows.get(container.id);
  if (!refs) return;

  refs.root.classList.toggle("expanded", container.expanded);
  refs.root.classList.toggle("deleted", container.deleted);
  refs.root.classList.toggle("loading", container.loading);

  refs.dot.className = `dot ${stateClass(container)}`;

  const name = container.name || "(未命名)";
  refs.name.textContent = name;
  refs.name.title = name;

  refs.image.textContent = container.image || "—";
  refs.image.title = container.image;

  refs.status.textContent = statusText(container);
  refs.status.title = container.status;

  refs.badge.hidden = !container.deleted;
}

export function renderLogs(container: Container): void {
  const refs = rows.get(container.id);
  if (!refs) return;

  refs.logsHead.textContent = logsHeaderText(container);
  refs.logsHead.classList.toggle("error", Boolean(container.logsError) && container.logs.length === 0);

  const fragment = document.createDocumentFragment();
  for (const line of container.logs) fragment.append(buildLogLine(line));
  refs.logsBody.replaceChildren(fragment);
}

export function logBody(id: string): HTMLElement | null {
  return rows.get(id)?.logsBody ?? null;
}

export function scrollLogsToBottom(id: string): void {
  const body = logBody(id);
  if (body) body.scrollTop = body.scrollHeight;
}

export function anchorLogs(id: string, anchor: ScrollAnchor): void {
  const body = logBody(id);
  if (!body) return;
  body.scrollTop = anchor.scrollTop + (body.scrollHeight - anchor.scrollHeight);
}

export function sync(containers: readonly Container[]): void {
  for (const container of containers) updateRow(container);

  const total = containers.length;
  const deleted = containers.reduce((sum, container) => sum + (container.deleted ? 1 : 0), 0);
  countEl.textContent = deleted > 0 ? `${total} 项 · ${deleted} 已删` : `${total} 项`;
  emptyEl.hidden = total > 0;
}

export function setDockerStatus(status: DockerStatus): void {
  dockerDotEl.className = `docker-dot ${status.connected ? "online" : "offline"}`;
  dockerDotEl.title = status.connected ? "Docker 已连接" : status.error || "Docker 未连接";
  dockerErrorEl.hidden = status.connected;
  dockerErrorEl.textContent = status.connected ? "" : status.error || "Docker 未连接";
}

export function showBanner(message: string): void {
  bannerEl.textContent = message;
  bannerEl.hidden = false;
  if (bannerTimer !== null) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => hideBanner(), 12000);
}

export function hideBanner(): void {
  if (bannerTimer !== null) {
    clearTimeout(bannerTimer);
    bannerTimer = null;
  }
  bannerEl.hidden = true;
  bannerEl.textContent = "";
}
