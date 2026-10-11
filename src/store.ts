import {
  MAX_PERSISTED_LOGS,
  STATE_KEY,
  STATE_VERSION,
} from "./types";
import type {
  Container,
  ContainerInfo,
  EventAction,
  EventPayload,
  LogLine,
  PersistedContainer,
  PersistedState,
  StreamName,
} from "./types";

export type Change =
  | { kind: "insert"; container: Container; position: "top" | "bottom" }
  | { kind: "update"; container: Container }
  | { kind: "clear" };

type Listener = (change: Change) => void;
type BannerListener = (message: string) => void;

const containers: Container[] = [];
const listeners = new Set<Listener>();
let bannerListener: BannerListener | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function subscribe(listener: Listener): void {
  listeners.add(listener);
}

export function onBanner(listener: BannerListener): void {
  bannerListener = listener;
}

export function getContainers(): readonly Container[] {
  return containers;
}

export function findById(id: string): Container | undefined {
  return containers.find((container) => container.id === id);
}

function emit(change: Change): void {
  for (const listener of listeners) listener(change);
}

/** Notify the UI without touching localStorage (view-only state changed). */
export function notify(container: Container): void {
  emit({ kind: "update", container });
}

/** Notify the UI and schedule a persisted write. */
export function touch(container: Container): void {
  emit({ kind: "update", container });
  scheduleSave();
}

function blank(id: string): Container {
  return {
    id,
    name: "",
    image: "",
    state: "",
    status: "",
    deleted: false,
    lastAction: null,
    logs: [],
    pageSize: 0,
    logsLoaded: false,
    logsExhausted: false,
    expanded: false,
    loading: false,
    logsError: null,
  };
}

function insert(container: Container, position: "top" | "bottom"): Container {
  if (position === "top") containers.unshift(container);
  else containers.push(container);
  emit({ kind: "insert", container, position });
  scheduleSave();
  return container;
}

function applyInfo(container: Container, info: ContainerInfo): void {
  if (info.name) container.name = info.name.replace(/^\//, "");
  if (info.image) container.image = info.image;
  container.state = info.state || container.state;
  container.status = info.status || container.status;
}

export function applySnapshot(infos: readonly ContainerInfo[]): void {
  for (const info of infos) {
    if (!info.id) continue;
    const existing = findById(info.id);
    if (existing) {
      applyInfo(existing, info);
      touch(existing);
    } else {
      const container = blank(info.id);
      applyInfo(container, info);
      insert(container, "bottom");
    }
  }
}

function statusForAction(action: EventAction): { state?: string; status?: string } {
  switch (action) {
    case "create":
      return { state: "created", status: "已创建" };
    case "start":
      return { state: "running", status: "运行中" };
    case "die":
      return { state: "exited", status: "已退出" };
    case "destroy":
      return { state: "removed", status: "已删除" };
    case "rename":
      return {};
    default:
      return {};
  }
}

export function applyEvent(payload: EventPayload): Container {
  const existing = findById(payload.id);
  const container = existing ?? blank(payload.id);

  if (payload.name) container.name = payload.name.replace(/^\//, "");
  if (payload.image) container.image = payload.image;
  container.lastAction = payload.action;

  const derived = statusForAction(payload.action);
  if (derived.state) container.state = derived.state;
  if (derived.status) container.status = derived.status;
  if (payload.action === "destroy") container.deleted = true;

  // A brand new row is inserted only once it carries its fields, so the first
  // paint of that row is already complete.
  if (existing) touch(container);
  else insert(container, "top");
  return container;
}

export function clearAll(): void {
  containers.length = 0;
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  emit({ kind: "clear" });
  try {
    localStorage.removeItem(STATE_KEY);
  } catch {
    // Ignore: an unwritable store just means nothing is cached.
  }
}

export function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function toPersisted(container: Container): PersistedContainer {
  return {
    id: container.id,
    name: container.name,
    image: container.image,
    state: container.state,
    status: container.status,
    deleted: container.deleted,
    lastAction: container.lastAction,
    logs: container.logs.slice(-MAX_PERSISTED_LOGS),
    pageSize: container.pageSize,
    logsLoaded: container.logsLoaded,
    logsExhausted: container.logsExhausted,
  };
}

/** Drop an entry's cached logs; returns false when there was nothing left to drop. */
function dropLogs(entry: PersistedContainer): boolean {
  if (entry.logs.length === 0 && !entry.logsLoaded && entry.pageSize === 0) return false;
  entry.logs = [];
  entry.logsLoaded = false;
  entry.pageSize = 0;
  entry.logsExhausted = false;
  return true;
}

function write(entries: PersistedContainer[]): boolean {
  const state: PersistedState = { version: STATE_VERSION, containers: entries };
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function saveNow(): void {
  saveTimer = null;
  const entries = containers.map((container) => toPersisted(container));
  if (write(entries)) return;

  // Quota exceeded: shed the oldest containers' logs one by one (oldest = last inserted).
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (!dropLogs(entries[index])) continue;
    if (write(entries)) {
      bannerListener?.("日志过大，未能全部缓存到本地");
      return;
    }
  }

  for (const entry of entries) dropLogs(entry);
  if (write(entries)) {
    bannerListener?.("日志过大，未能全部缓存到本地");
  } else {
    bannerListener?.("本地缓存写入失败：存储空间不足");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asAction(value: unknown): EventAction | null {
  return value === "create" ||
    value === "start" ||
    value === "die" ||
    value === "destroy" ||
    value === "rename"
    ? value
    : null;
}

function asStream(value: unknown): StreamName {
  return value === "stderr" || value === "stdin" ? value : "stdout";
}

function asLog(value: unknown): LogLine | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  return {
    ts: typeof value.ts === "string" ? value.ts : null,
    stream: asStream(value.stream),
    text: value.text,
  };
}

function asPersisted(value: unknown): PersistedContainer | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (typeof id !== "string" || id.length === 0) return null;
  return {
    id,
    name: asString(value.name),
    image: asString(value.image),
    state: asString(value.state),
    status: asString(value.status),
    deleted: value.deleted === true,
    lastAction: asAction(value.lastAction),
    logs: Array.isArray(value.logs)
      ? value.logs.map(asLog).filter((line): line is LogLine => line !== null)
      : [],
    pageSize: typeof value.pageSize === "number" && Number.isFinite(value.pageSize) ? value.pageSize : 0,
    logsLoaded: value.logsLoaded === true,
    logsExhausted: value.logsExhausted === true,
  };
}

/** Restore the previous session's list; every container comes back collapsed. */
export function loadPersisted(): void {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STATE_KEY);
  } catch {
    return;
  }
  if (!raw) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(parsed) || parsed.version !== STATE_VERSION || !Array.isArray(parsed.containers)) {
    return;
  }

  for (const item of parsed.containers) {
    const entry = asPersisted(item);
    if (!entry || findById(entry.id)) continue;
    containers.push({
      ...entry,
      expanded: false,
      loading: false,
      logsError: null,
    });
  }
}
