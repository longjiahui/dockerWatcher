# Docker Watcher

常驻系统托盘的 Docker 容器监听器：一个无边框、始终置顶的小窗，实时显示容器的
create / start / die / destroy / rename 事件，按容器 id 去重，每条容器可折叠查看日志。

## 运行截图

![Docker Watcher 运行截图](./screenshot.png)

## 运行

```bash
npm install
npm run tauri dev          # 开发（Vite + cargo）
npm run tauri build        # 打包；网络受限时可加 `-- --no-bundle` 只出二进制
```

## 行为

- 托盘图标左键：显示 / 隐藏窗口；右键菜单：显示 / 隐藏监听窗口、退出。
- 窗口的 × 只把窗口隐藏到托盘，进程继续常驻；只有托盘菜单的「退出」才会结束进程。
- 标题栏（`data-tauri-drag-region`）可拖拽，窗口可缩放、始终置顶、不占任务栏。
- 容器被删除时只标记为「已删除」，条目与其最后一次抓到的日志都保留。
- 日志按需读取：展开时取最后 50 行，在日志区向上滚动按 50 → 200 → 1000 → 全部
  逐级加载，并保持视觉位置不跳动。
- 列表状态与日志缓存在 `localStorage`（`dockerwather.state.v1`，单容器上限 2000 行，
  超配额自动降级）；右上角「清空」会清空列表与缓存。

## 结构

| 路径 | 作用 |
| --- | --- |
| `src-tauri/src/docker.rs` | Docker Engine 事件流（bollard）、每容器跟随日志的有界缓冲、`list_containers` / `get_logs` / `get_docker_status` |
| `src-tauri/src/tray.rs` | 托盘图标与右键菜单 |
| `src-tauri/src/lib.rs` | 窗口配置组装、命令注册、关窗隐藏 |
| `src/store.ts` | 容器列表状态、事件归约、localStorage 持久化 |
| `src/ui.ts` | 行与日志的 DOM 渲染 |
| `src/main.ts` | IPC 接线与日志的分页加载 |

> `docker rm -f` 会在发出的信号之前就把容器标记为待删除，此时 Docker 的日志接口会拒绝
> 读日志（409），所以后端从容器 `start` 起就跟随其日志流，在容器消失时发布缓冲的最后
> 200 行（`docker.rs` 中的 `WatchState`）。
