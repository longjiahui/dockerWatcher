export type StreamName = "stdout" | "stderr" | "stdin";

export type EventAction = "create" | "start" | "die" | "destroy" | "rename";

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface LogLine {
  ts: string | null;
  stream: StreamName;
  text: string;
}

export interface DockerStatus {
  connected: boolean;
  error: string | null;
}

export interface EventPayload {
  action: EventAction;
  id: string;
  name: string | null;
  image: string | null;
  ts: number;
}

export interface LogsPayload {
  id: string;
  lines: LogLine[];
  tail: number;
  error: string | null;
}

/** A `tail` argument accepted by the `get_logs` command: a line count or the literal "all". */
export type TailSize = number | "all";

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  deleted: boolean;
  lastAction: EventAction | null;
  logs: LogLine[];
  /** Tail size the current `logs` were fetched with; 0 until the first load, -1 once "all" was requested. */
  pageSize: number;
  logsLoaded: boolean;
  logsExhausted: boolean;
  /** View-only state, never persisted. */
  expanded: boolean;
  /** View-only state, never persisted. */
  loading: boolean;
  /** View-only state, never persisted. */
  logsError: string | null;
}

export interface PersistedContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  deleted: boolean;
  lastAction: EventAction | null;
  logs: LogLine[];
  pageSize: number;
  logsLoaded: boolean;
  logsExhausted: boolean;
}

export interface PersistedState {
  version: 1;
  containers: PersistedContainer[];
}

export const STATE_KEY = "dockerwather.state.v1";
export const STATE_VERSION = 1;

export const LOG_TAIL_LADDER: readonly TailSize[] = [50, 200, 1000, "all"];
export const ALL_TAIL_SENTINEL = -1;
/**
 * The Rust `get_logs` command takes `tail: Option<u32>`, so the literal "all" is
 * tried first (forward compatible) and this count is used when it is rejected.
 */
export const ALL_TAIL_FALLBACK = 100000;

export const MAX_PERSISTED_LOGS = 2000;

export const GONE_ERROR_RE = /已不存在|no such container|404/i;
export const ALL_TAIL_UNSUPPORTED_RE = /invalid args|invalid type|expected u32/i;
