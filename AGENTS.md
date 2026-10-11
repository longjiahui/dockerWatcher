# AGENTS.md

给开发者与编码代理看的项目说明（仅中文）。面向使用者的文档是 `README.md`（英文，默认）与
`README.zh-CN.md`；本文件里的环境、构建、结构与实现约束不要重复写进 README。

## 项目概览

Tauri v2 桌面应用：Rust 后端通过 bollard 监听 Docker Engine 事件流，前端（Vite +
TypeScript，无框架）渲染一个无边框置顶悬浮窗，常驻系统托盘。窗口标签固定为 `main`
（capability 与前端都按这个标签定位）。

## 环境要求

- Windows + Node / npm（实测 Node v25.2.1、npm 11.14.0）
- Rust stable + MSVC 工具链（实测 rustc 1.91.1，`x86_64-pc-windows-msvc`）
- Docker Desktop 正在运行（`docker ps` 可用）
- WebView2 运行时（Win10/11 一般已随系统安装）

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装前端依赖 |
| `npm run tauri dev` | 开发模式：Vite dev server（:1420）+ cargo debug 构建并启动 |
| `npm run tauri build` | release 构建并打包安装包 |
| `npm run tauri build -- --no-bundle` | 只出 release 二进制（拿不到 NSIS/WiX 时用） |
| `npm run build` | 只构建前端（`tsc && vite build` → `dist/`） |
| `cd src-tauri && cargo build` | 只构建 Rust |

首次构建要下载并编译整棵 Tauri 依赖树（约 450 个 crate），debug 约 3 分钟、release 约
2.5 分钟；之后增量构建在 30 秒内。

**调试前端**：给 WebView2 打开 DevTools 远程调试端口再启动，然后用 CDP 客户端连接
（不需要动鼠标，适合在真实窗口里做交互验证）：

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" npm run tauri dev
curl http://127.0.0.1:9223/json/list        # 取页面目标的 webSocketDebuggerUrl
```

## 代码结构

| 路径 | 作用 |
| --- | --- |
| `src-tauri/src/docker.rs` | Docker Engine 事件流、每容器跟随日志的有界缓冲、三个命令的实现 |
| `src-tauri/src/tray.rs` | 托盘图标与右键菜单、窗口显示/隐藏切换 |
| `src-tauri/src/lib.rs` | 状态管理、命令注册、`CloseRequested` → 隐藏窗口 |
| `src-tauri/tauri.conf.json` | 窗口配置：`label=main`、无边框、置顶、`skipTaskbar`、可缩放 |
| `src-tauri/capabilities/default.json` | 前端所需的窗口权限（`start-dragging` / `hide` / `show` / `close`） |
| `src/types.ts` | 前后端契约类型、`localStorage` 键与分页档位 |
| `src/store.ts` | 容器列表状态、事件归约、快照合并与重启对账、持久化 |
| `src/ansi.ts` | 日志里 ANSI 转义序列的解析（纯文本处理，不碰 DOM） |
| `src/ui.ts` | 行与日志的 DOM 渲染（含日志区标题文案、ANSI 样式落盘） |
| `src/main.ts` | IPC 接线、日志分页加载、上滚锚定 |

## 前后端契约

命令（`@tauri-apps/api/core` 的 `invoke`）：

| 命令 | 签名 | 说明 |
| --- | --- | --- |
| `list_containers` | `() -> Result<Vec<ContainerInfo>, String>` | `all=true`，含已停止容器；名字去掉前导 `/` |
| `get_logs` | `(id: String, tail: Option<Value>, timestamps: Option<bool>) -> Result<Vec<LogLine>, String>` | `tail` 默认 50，同时接受数字与字符串 `"all"` |
| `get_docker_status` | `() -> Result<DockerStatus, String>` | 断开时按需重新探测 |

事件（`@tauri-apps/api/event` 的 `listen`，注意名字里的 `//`）：

| 事件 | 载荷 |
| --- | --- |
| `docker://event` | `{ action: "create"\|"start"\|"die"\|"destroy"\|"rename", id, name, image, ts }` |
| `docker://logs` | `{ id, lines: LogLine[], tail, error }`，容器消失时发布缓冲的日志 |
| `docker://status` | `{ connected: boolean, error: string \| null }` |

```ts
type ContainerInfo = { id: string; name: string; image: string; state: string; status: string };
type LogLine       = { ts: string | null; stream: "stdout" | "stderr" | "stdin"; text: string };
type DockerStatus  = { connected: boolean; error: string | null };
```

## 实现约束（改动前先读，都是踩过的坑）

1. **bollard 0.20+ 的 API 换位置了**：所有 `*Options` 移到了 `bollard::query_parameters`
   并且是 builder（`EventsOptionsBuilder` / `LogsOptionsBuilder` / `ListContainersOptionsBuilder`）；
   `EventMessage.action` 是 `Option<String>`（没有 `EventMessage::Create` 这类枚举），容器类型
   枚举是 `EventMessageTypeEnum::CONTAINER`。网上旧教程的写法编译不过。
2. **容器停用事件是 `destroy`，不是 `remove`**；`remove` 只出现在 network / service / node 等对象上。
3. **`create` 时容器还没有任何日志**，日志只能在展开时懒读，不要在 create 事件里读。
4. **`docker rm -f` 会在发出信号之前就把容器标记为待删除**，此时 `/containers/{id}/logs`
   直接返回 409，等 `kill` / `die` 事件到达再读就已经晚了。所以后端从 `start` 起就 `follow`
   每个运行中容器的日志流，用 `WatchState` 的有界缓冲保留最后 200 行，容器消失时发布；
   应用启动时已在运行的容器由启动快照补开缓冲。对应用启动前就已退出、或应用未运行期间被
   删除的容器，任何方式都拿不到日志（前端会显示「容器已删除，日志不可用」）。
5. **Windows 连接兜底**：bollard 在 Windows 的默认管道写死 `npipe:////./pipe/docker_engine`，
   而现代 Docker Desktop 的 active context 通常是 `dockerDesktopLinuxEngine`；
   `connect_with_defaults()` 在未设置 `DOCKER_HOST` 时还会掉进 Unix socket 分支报错。
   `docker.rs` 的 `connect()` 按 `DOCKER_HOST` → 默认管道 → `dockerDesktopLinuxEngine` 依次尝试。
6. **事件流不重放历史**：`/events` 不带 `since` 时只推新事件，历史状态靠启动时的
   `list_containers` 快照补齐——不要给 `since` 传值，也不要把开日志缓冲这件事依赖在历史事件上。
7. **托盘**：必须 `show_menu_on_left_click(false)` 左键才会走 `on_tray_icon_event`（匹配
   `MouseButton::Left` + `MouseButtonState::Up`）；菜单项靠比对 `event.id` 分发。
8. **`tail` 必须同时接受数字与 `"all"`**（`lib.rs` 的 `resolve_tail`）。前端分页最后一档会传
   字符串 `"all"`，把它改回 `u32` 会让「加载全部」静默降级。
9. **日志区标题不能在已经有行时显示「不可用」**：容器已删除的报文可能晚于前端自己抓到的日志
   到达（顺序不定），`ui.ts` 的 `logsHeaderText` 对此做了处理，改动时别退回去。
10. **持久化**：键 `dockerwather.state.v1`，单容器最多 2000 行、写入 debounce 300ms、超配额按
    最旧优先丢弃日志；`expanded` 不持久化（每次启动都收起）；`logsError` 不持久化。
11. **日志文本原样保存，颜色在渲染层还原**：容器输出里的 ANSI 转义序列（`src/ansi.ts`）只在
    `ui.ts` 渲染时解析成 span，`localStorage` 里留原始文本，所以改渲染策略不用重新拉日志；
    顺手把 `\r` 折叠成终端实际显示的那一段、把非 SGR 的转义（`ESC[2K` 等）丢掉。没有转义的行
    必须走单文本节点的快路径，否则每行多一个 span 节点。
12. **重启对账只在快照成功时做**：`store.ts` 的 `applySnapshot` 会把「快照里没有的 id」标记为
    已删除（快照是 `all=true`，已停止但仍存在的容器也在里面，所以差集就等于已删除）。因此
    **绝不能把失败的快照传给它**——拿不到列表会被当成「所有容器都没了」。已知局限：切换
    Docker context / 连到另一个引擎时，旧引擎的条目会被全部标成已删除。

## 验证

- 真实事件链路：
  ```bash
  docker run -d --name dw-test --entrypoint sh redis:7-alpine \
    -c 'for i in $(seq 1 300); do echo "line $i"; sleep 0.05; done; sleep 600'
  ```
  列表应新增条目且不重复；展开应默认 50 行、向上滚动依次 200 / 1000 / 全部，最终显示
  「已到最顶端 · 共 300 行」；`docker rm -f dw-test` 后条目只被标记为「已删除」且日志仍在。
- 关闭窗口后进程应继续存活（托盘常驻），托盘左键应能切换窗口显示。
- 提交前跑：`npx tsc --noEmit`、`npm run build`、`cd src-tauri && cargo build`。
