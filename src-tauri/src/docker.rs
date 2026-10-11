use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bollard::container::LogOutput;
use bollard::models::{ContainerSummary, EventMessage, EventMessageTypeEnum};
use bollard::query_parameters::{
    EventsOptionsBuilder, ListContainersOptionsBuilder, LogsOptionsBuilder,
};
use bollard::{Docker, API_DEFAULT_VERSION};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const EVENT_CHANNEL: &str = "docker://event";
pub const LOGS_CHANNEL: &str = "docker://logs";
pub const STATUS_CHANNEL: &str = "docker://status";

const DOCKER_DESKTOP_PIPE: &str = "//./pipe/dockerDesktopLinuxEngine";
const DOCKER_LEGACY_PIPE: &str = "npipe:////./pipe/docker_engine";
const CONNECT_TIMEOUT_SECS: u64 = 120;
const RECONNECT_START_SECS: u64 = 1;
const RECONNECT_MAX_SECS: u64 = 30;
const DIE_LOG_TAIL: u32 = 200;
/// Lines kept in memory for every container the watcher has seen, so a container
/// removed with `docker rm -f` can still show its final output.
const TAIL_BUFFER_LINES: usize = DIE_LOG_TAIL as usize;
const CAPTURE_PRUNE_AFTER_SECS: i64 = 600;
const CAPTURE_PRUNE_THRESHOLD: usize = 256;
pub const DEFAULT_LOG_TAIL: u32 = 50;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub ts: Option<String>,
    pub stream: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    pub connected: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPayload {
    pub action: String,
    pub id: String,
    pub name: Option<String>,
    pub image: Option<String>,
    pub ts: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsPayload {
    pub id: String,
    pub lines: Vec<LogLine>,
    pub tail: u32,
    pub error: Option<String>,
}

/// Where the watcher publishes what it finds. `AppHandle` is the real sink; a plain
/// sink lets the event pipeline be driven end to end without a running Tauri app.
pub trait EventSink: Send + Sync {
    fn event(&self, payload: EventPayload);
    fn logs(&self, payload: LogsPayload);
}

impl EventSink for AppHandle {
    fn event(&self, payload: EventPayload) {
        let _ = self.emit(EVENT_CHANNEL, payload);
    }

    fn logs(&self, payload: LogsPayload) {
        let _ = self.emit(LOGS_CHANNEL, payload);
    }
}

/// Shared connection status, updated by the event loop and read by `get_docker_status`.
pub struct DockerState(pub Mutex<DockerStatus>);

impl Default for DockerState {
    fn default() -> Self {
        Self(Mutex::new(DockerStatus {
            connected: false,
            error: None,
        }))
    }
}

pub fn read_status(state: &DockerState) -> DockerStatus {
    match state.0.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

pub fn write_status(state: &DockerState, status: DockerStatus) {
    match state.0.lock() {
        Ok(mut guard) => *guard = status,
        Err(poisoned) => *poisoned.into_inner() = status,
    }
}

/// Connect and ping once, so a caller can learn whether the engine actually answers.
pub async fn probe() -> DockerStatus {
    match connect() {
        Ok(docker) => match docker.ping().await {
            Ok(_) => DockerStatus {
                connected: true,
                error: None,
            },
            Err(e) => DockerStatus {
                connected: false,
                error: Some(format!("Docker 引擎无响应: {e}")),
            },
        },
        Err(e) => DockerStatus {
            connected: false,
            error: Some(e),
        },
    }
}

/// Build a Docker client, trying every local transport we know about.
///
/// 1. a non-empty `DOCKER_HOST`
/// 2. the crate default named pipe (the legacy `docker_engine` pipe)
/// 3. Docker Desktop's `dockerDesktopLinuxEngine` pipe
pub fn connect() -> Result<Docker, String> {
    let mut attempts: Vec<String> = Vec::new();

    if let Ok(host) = std::env::var("DOCKER_HOST") {
        let host = host.trim().to_string();
        if !host.is_empty() {
            match Docker::connect_with_host(&host) {
                Ok(docker) => return Ok(docker),
                Err(e) => attempts.push(format!("DOCKER_HOST={host}: {e}")),
            }
        }
    }

    match Docker::connect_with_named_pipe_defaults() {
        Ok(docker) => return Ok(docker),
        Err(e) => attempts.push(format!("{DOCKER_LEGACY_PIPE}: {e}")),
    }

    match Docker::connect_with_named_pipe(
        DOCKER_DESKTOP_PIPE,
        CONNECT_TIMEOUT_SECS,
        API_DEFAULT_VERSION,
    ) {
        Ok(docker) => return Ok(docker),
        Err(e) => attempts.push(format!("{DOCKER_DESKTOP_PIPE}: {e}")),
    }

    Err(format!(
        "无法连接 Docker 引擎，已尝试: {}",
        attempts.join("; ")
    ))
}

pub async fn list_containers(docker: &Docker) -> Result<Vec<ContainerInfo>, String> {
    let options = ListContainersOptionsBuilder::new().all(true).build();
    let summaries: Vec<ContainerSummary> = docker
        .list_containers(Some(options))
        .await
        .map_err(|e| format!("获取容器列表失败: {e}"))?;

    Ok(summaries
        .into_iter()
        .filter_map(|summary| {
            let id = summary.id.filter(|id| !id.is_empty())?;
            let name = summary
                .names
                .as_ref()
                .and_then(|names| names.first())
                .map(|name| name.trim_start_matches('/').to_string())
                .unwrap_or_default();
            Some(ContainerInfo {
                id,
                name,
                image: summary.image.unwrap_or_default(),
                state: summary.state.map(|state| state.to_string()).unwrap_or_default(),
                status: summary.status.unwrap_or_default(),
            })
        })
        .collect())
}

/// Read a container's logs, reassembling the (possibly split) stdout/stderr frames
/// into whole lines.
pub async fn fetch_logs(
    docker: &Docker,
    id: &str,
    tail: &str,
    with_timestamps: bool,
) -> Result<Vec<LogLine>, String> {
    let options = LogsOptionsBuilder::new()
        .stdout(true)
        .stderr(true)
        .follow(false)
        .tail(tail)
        .timestamps(with_timestamps)
        .build();

    let mut stream = docker.logs(id, Some(options));

    // Docker frames are demuxed per stream and may split or merge lines, so the raw
    // bytes are concatenated and the stream of each line is recovered from the frame
    // that the line starts in.
    let mut buffer: Vec<u8> = Vec::new();
    let mut frames: Vec<(usize, &'static str)> = Vec::new();

    while let Some(item) = stream.next().await {
        let output = item.map_err(|e| describe_log_error(id, e.to_string()))?;
        let (stream_name, message) = match output {
            LogOutput::StdOut { message } => ("stdout", message),
            LogOutput::StdErr { message } => ("stderr", message),
            LogOutput::StdIn { message } => ("stdin", message),
            LogOutput::Console { message } => ("stdout", message),
        };
        frames.push((buffer.len(), stream_name));
        buffer.extend_from_slice(&message);
    }

    let mut lines = Vec::new();
    let mut frame_index = 0usize;
    let mut offset = 0usize;
    for raw in buffer.split(|byte| *byte == b'\n') {
        let start = offset;
        offset += raw.len() + 1;
        if start >= buffer.len() {
            break;
        }
        while frame_index + 1 < frames.len() && frames[frame_index + 1].0 <= start {
            frame_index += 1;
        }
        let stream_name = frames.get(frame_index).map(|(_, name)| *name).unwrap_or("stdout");
        let line = String::from_utf8_lossy(raw);
        let line = line.trim_end_matches('\r');
        let (ts, text) = if with_timestamps {
            split_timestamp(line)
        } else {
            (None, line.to_string())
        };
        lines.push(LogLine {
            ts,
            stream: stream_name.to_string(),
            text,
        });
    }

    Ok(lines)
}

fn split_timestamp(line: &str) -> (Option<String>, String) {
    match line.find(' ') {
        Some(index) => (Some(line[..index].to_string()), line[index + 1..].to_string()),
        None => (None, line.to_string()),
    }
}

fn describe_log_error(id: &str, message: String) -> String {
    if message.contains("404") || message.contains("no such container") {
        format!("容器 {id} 已不存在，无法读取日志")
    } else {
        format!("读取容器 {id} 日志失败: {message}")
    }
}

/// The recent output of one container, shared between its streaming task and the
/// event loop.
type TailBuffer = Arc<Mutex<VecDeque<LogLine>>>;

struct Tail {
    lines: TailBuffer,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// What the frontend was last told about a container's final lines, so that a repeat,
/// or a capture that failed, cannot replace lines it already has cached.
struct Capture {
    at: i64,
    /// the tail's last line: a cheap way to tell whether the output moved on
    last_line: Option<String>,
}

/// State that lives for as long as the event loop does, across reconnects.
#[derive(Default)]
pub struct WatchState {
    /// container id -> its last published final-log capture
    captures: HashMap<String, Capture>,
    tails: HashMap<String, Tail>,
}

impl WatchState {
    /// Start buffering a container's output.
    ///
    /// `docker rm -f` marks the container for removal *before* the `kill` and `die`
    /// events are delivered, and the logs API refuses a container marked for removal
    /// (409), so there is nothing left to fetch by the time we learn it is going away.
    /// Following the container from the moment it starts is the only way to still hold
    /// its final lines. Restarts reuse the container id, so a finished tail is replaced.
    fn watch(&mut self, docker: &Docker, id: &str) {
        if let Some(existing) = self.tails.get(id) {
            if !existing.task.inner().is_finished() {
                return;
            }
        }

        let lines: TailBuffer = Arc::new(Mutex::new(VecDeque::with_capacity(TAIL_BUFFER_LINES)));
        let task = tauri::async_runtime::spawn(tail_logs(
            docker.clone(),
            id.to_string(),
            lines.clone(),
        ));
        self.tails.insert(id.to_string(), Tail { lines, task });
    }

    /// The container is gone: stop following it and drop what was buffered.
    fn forget(&mut self, id: &str) {
        if let Some(tail) = self.tails.remove(id) {
            tail.task.abort();
        }
    }

    /// The lines to publish for a container that is stopping or being removed, or
    /// `None` when there is nothing new to publish.
    ///
    /// `kill`, `die` and `destroy` describe the same shutdown, and the frontend caches
    /// whatever it is sent, so a second capture is only worth sending when it carries a
    /// longer tail — a `docker stop` container may still print while it shuts down. A
    /// capture that failed is never sent on top of lines that were already published.
    async fn final_logs(
        &mut self,
        docker: &Docker,
        id: &str,
    ) -> Option<Result<Vec<LogLine>, String>> {
        let now = now_secs();
        self.prune(now);

        let captured = match self.tails.get(id) {
            Some(tail) => Ok(collect_tail(tail)),
            // A container the watcher never saw start can only be read through the API.
            None => fetch_logs(docker, id, &DIE_LOG_TAIL.to_string(), true).await,
        };
        let last_line = match &captured {
            Ok(lines) => lines.last().map(|line| line.text.clone()),
            Err(_) => None,
        };

        if let Some(published) = self.captures.get(id) {
            if captured.is_err() || published.last_line == last_line {
                return None;
            }
        }

        // Only a successful capture is recorded, so a `kill` that could not be read is
        // still retried by the following `die`.
        if captured.is_ok() {
            self.captures
                .insert(id.to_string(), Capture { at: now, last_line });
        }
        Some(captured)
    }

    fn prune(&mut self, now: i64) {
        if self.captures.len() > CAPTURE_PRUNE_THRESHOLD {
            self.captures
                .retain(|_, capture| now - capture.at < CAPTURE_PRUNE_AFTER_SECS);
        }
        if self.tails.len() > CAPTURE_PRUNE_THRESHOLD {
            // A stopped container's tail is only worth keeping until its logs went out.
            let captures = &self.captures;
            self.tails
                .retain(|id, tail| !(tail.task.inner().is_finished() && captures.contains_key(id)));
        }
    }
}

fn collect_tail(tail: &Tail) -> Vec<LogLine> {
    match tail.lines.lock() {
        Ok(guard) => guard.iter().cloned().collect(),
        Err(poisoned) => poisoned.into_inner().iter().cloned().collect(),
    }
}

/// Follow a container's output until its stream ends, keeping the last
/// `TAIL_BUFFER_LINES` lines. The stream ends with the container, whatever kills it.
async fn tail_logs(docker: Docker, id: String, buffer: TailBuffer) {
    let tail = DIE_LOG_TAIL.to_string();
    let options = LogsOptionsBuilder::new()
        .stdout(true)
        .stderr(true)
        .follow(true)
        .tail(&tail)
        .timestamps(true)
        .build();

    let mut stream = docker.logs(&id, Some(options));
    let mut pending: Vec<u8> = Vec::new();
    let mut pending_stream = "stdout";

    while let Some(item) = stream.next().await {
        let output = match item {
            Ok(output) => output,
            // The container is gone or the stream broke; what was buffered is all we get.
            Err(_) => break,
        };
        let (stream_name, message) = match output {
            LogOutput::StdOut { message } => ("stdout", message),
            LogOutput::StdErr { message } => ("stderr", message),
            LogOutput::StdIn { message } => ("stdin", message),
            LogOutput::Console { message } => ("stdout", message),
        };

        if pending.is_empty() {
            pending_stream = stream_name;
        }
        let mut start = 0usize;
        for (index, byte) in message.iter().enumerate() {
            if *byte == b'\n' {
                pending.extend_from_slice(&message[start..index]);
                push_tail_line(&buffer, &pending, pending_stream);
                pending.clear();
                start = index + 1;
            }
        }
        pending.extend_from_slice(&message[start..]);
    }

    // A container killed mid-line still produced that line.
    if !pending.is_empty() {
        push_tail_line(&buffer, &pending, pending_stream);
    }
}

fn push_tail_line(buffer: &TailBuffer, raw: &[u8], stream_name: &str) {
    let raw = String::from_utf8_lossy(raw);
    let (ts, text) = split_timestamp(raw.trim_end_matches('\r'));

    let mut lines = match buffer.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if lines.len() >= TAIL_BUFFER_LINES {
        lines.pop_front();
    }
    lines.push_back(LogLine {
        ts,
        stream: stream_name.to_string(),
        text,
    });
}

pub fn spawn_event_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = RECONNECT_START_SECS;
        let mut state = WatchState::default();
        loop {
            let (error, received) = match connect() {
                Ok(docker) => match docker.ping().await {
                    Ok(_) => {
                        publish_status(&app, true, None);
                        match stream_events(&app, &docker, &mut state).await {
                            Ok(received) => ("Docker 事件流已结束".to_string(), received),
                            Err(e) => (e, 0),
                        }
                    }
                    Err(e) => (format!("Docker 引擎无响应: {e}"), 0),
                },
                Err(e) => (e, 0),
            };

            publish_status(&app, false, Some(error));
            // A session that actually delivered events was healthy, so start over;
            // otherwise keep backing off.
            if received > 0 {
                backoff = RECONNECT_START_SECS;
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(RECONNECT_MAX_SECS);
        }
    });
}

/// The container events the watcher subscribes to. `kill` is included alongside
/// `die`: `docker rm -f` SIGKILLs the container and then removes it, and `kill` is
/// the earliest sign that its logs are about to become unreadable.
fn event_filters() -> HashMap<String, Vec<String>> {
    let mut filters: HashMap<String, Vec<String>> = HashMap::new();
    filters.insert("type".to_string(), vec!["container".to_string()]);
    filters.insert(
        "event".to_string(),
        vec![
            "create".to_string(),
            "start".to_string(),
            "kill".to_string(),
            "die".to_string(),
            "destroy".to_string(),
            "rename".to_string(),
        ],
    );
    filters
}

pub async fn stream_events<S: EventSink>(
    sink: &S,
    docker: &Docker,
    state: &mut WatchState,
) -> Result<usize, String> {
    // Containers that were already running when the watcher started never emit `start`,
    // so their tails are opened from the snapshot instead.
    if let Ok(containers) = list_containers(docker).await {
        for container in containers {
            if container.state == "running" {
                state.watch(docker, &container.id);
            }
        }
    }

    // No `since`: /events without it only streams new events, the historical
    // snapshot comes from `list_containers`.
    let options = EventsOptionsBuilder::new().filters(&event_filters()).build();
    let mut stream = docker.events(Some(options));

    let mut received = 0usize;
    while let Some(item) = stream.next().await {
        let message = item.map_err(|e| format!("Docker 事件流中断: {e}"))?;
        received += 1;
        handle_event(sink, docker, state, message).await;
    }

    Ok(received)
}

async fn handle_event<S: EventSink>(
    sink: &S,
    docker: &Docker,
    state: &mut WatchState,
    message: EventMessage,
) {
    if message.typ != Some(EventMessageTypeEnum::CONTAINER) {
        return;
    }

    let action = match message.action.as_deref() {
        Some(action) if !action.is_empty() => action.to_string(),
        _ => return,
    };
    if !matches!(
        action.as_str(),
        "create" | "start" | "kill" | "die" | "destroy" | "rename"
    ) {
        return;
    }

    let actor = match message.actor {
        Some(actor) => actor,
        None => return,
    };
    let id = match actor.id {
        Some(id) if !id.is_empty() => id,
        _ => return,
    };

    if action == "start" {
        // A restarted container keeps its id, but the previous run's capture says
        // nothing about this one.
        state.captures.remove(&id);
        state.watch(docker, &id);
    }

    let attributes = actor.attributes.unwrap_or_default();
    let name = attributes.get("name").cloned();
    let image = attributes.get("image").cloned();
    let ts = message.time.unwrap_or_else(now_secs);

    // `kill` exists only to give the log capture a head start; the frontend does not
    // know the action, so it is never forwarded as an event.
    if action != "kill" {
        sink.event(EventPayload {
            action: action.clone(),
            id: id.clone(),
            name,
            image,
            ts,
        });
    }

    // `create` has no output yet: `kill`, `die` and `destroy` are the points at which
    // the container's final lines are still worth publishing.
    if matches!(action.as_str(), "kill" | "die" | "destroy") {
        if let Some(result) = state.final_logs(docker, &id).await {
            let (lines, error) = match result {
                Ok(lines) => (lines, None),
                Err(e) => (Vec::new(), Some(e)),
            };
            sink.logs(LogsPayload {
                id: id.clone(),
                lines,
                tail: DIE_LOG_TAIL,
                error,
            });
        }
    }

    if action == "destroy" {
        state.forget(&id);
    }
}

fn publish_status(app: &AppHandle, connected: bool, error: Option<String>) {
    let status = DockerStatus { connected, error };
    if let Some(state) = app.try_state::<DockerState>() {
        write_status(&state, status.clone());
    }
    let _ = app.emit(STATUS_CHANNEL, status);
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}
