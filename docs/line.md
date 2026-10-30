# Line — 原生通道（飞书 + 微信）

用 `/line` 把 Scream Code 连到 IM：配置向导 + 后台守护进程。两个平台均为**官方接口**，无需公网 IP：
- **飞书**：开放平台 WebSocket 长连接
- **微信**：官方 ilink 机器人网关（`getupdates` 长轮询 + `sendmessage` 下发，微信官方 bot 开放接口）

## 快速开始

1. 在 TUI 里运行 `/line` → 选择「配置飞书（向导）」或「配置微信（向导）」
2. 飞书：选**「跟着向导创建应用（推荐）」**——向导分步带你走完官方流程（创建应用 → 启用机器人 → 开通权限 → 长连接订阅 → 发布 → 粘贴凭证，约 3 分钟，无需公网 IP），每步都有直达链接与说明；微信：选**「扫码登录（推荐）」**——终端显示登录链接，手机微信打开确认即可，token 与白名单自动写入。
   已有现成凭证 → 直接「手动输入」粘贴（微信的现成 token 获取见下文）。
3. 凭证实测校验通过后写入 `~/.scream-code/line/config.json`（权限 0600）。
4. 选择「立即启动」→ 后台守护进程拉起，footer 状态段显示 `◆ Line: Lark` / `◆ Line: Wechat`；守护没跑时显示 `◆ Line: 未连接`。
5. 在 IM 里给机器人发消息，scream 会在对应会话里处理并回复。

## 单通道约束

`/line` 一次只服务**一个**通道：配置飞书后，微信向导不可再选（反之亦然）。要切换平台：`/line` → **卸载**（停守护 + 清 `~/.scream-code/line/`），再运行另一平台的向导。直接手改配置文件塞进两个平台会被守护进程拒绝启动（fail-fast，不会静默双跑）。切换后，旧平台的会话仍保留在 `/sessions` 里（独立命名空间，互不干扰），只是不再被新通道使用。

## 命令

| 命令 | 作用 |
|---|---|
| `/line` | 向导 + 启动 / 停止 / 重启 / 卸载（TUI 内） |
| `scream line` | 前台运行守护进程（调试用） |
| `scream line start` / `stop` / `status` | 后台启停与状态查询 |

## 配置文件

`~/.scream-code/line/config.json`（0600）。飞书选项名与飞书开放平台/业界惯用命名对齐，微信选项名与 ilink 网关字段对齐：

### 通用字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `permissionMode` | `yolo` | 无人值守权限模式（见下节） |
| `autoStart` | true | TUI 启动时自动拉起守护进程 |
| `workDir` | 守护启动目录 | 会话工作目录 |

### 飞书（`feishu`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `app_id` / `app_secret` | 必填 | 飞书应用凭证 |
| `allow_from` | 空 = 允许所有人 | 用户 ID 白名单（逗号分隔）。**建议配置** |
| `allow_chat` | 空 = 允许所有群 | 群聊 ID 白名单（仅群聊生效） |
| `group_only` | false | 只响应群聊 |
| `require_mention` | true | 群聊必须 @机器人（`false` 表示群内消息全部响应） |
| `share_session_in_channel` | false | 会话按「群」共享（默认按「群 + 用户」隔离） |
| `reaction_emoji` | `OnIt` | 收到消息的回应表情；`none` 关闭 |
| `done_emoji` | 关 | 完成后的表情（如 `THUMBSUP`）；`none` 关闭 |
| `domain` | `https://open.feishu.cn` | Lark 国际版填 `https://open.larksuite.com` |

### 微信（`weixin`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `token` | 必填 | ilink bot Bearer token |
| `base_url` | `https://ilinkai.weixin.qq.com` | 网关根地址（运营商不一致时才改） |
| `allow_from` | 空 = 允许所有人 | ilink 用户 ID 白名单（形如 `xxx@im.wechat`）。**建议配置** |
| `route_tag` | 空 | 运营商要求的 `SKRouteTag` 请求头 |
| `long_poll_timeout_ms` | 35000 | 长轮询超时 |
| `dedup_window_seconds` | 300 | 去重窗口（ilink 可能因 ACK 延迟重发同一消息） |

**微信 token 获取**——扫码登录是主路径，全程在 `/line` 向导内完成，**无需安装任何其他工具**：
1. `/line` → 「配置微信（向导）」→ **「扫码登录（推荐）」**：向导向官方网关申请登录链接 → 你在手机微信中打开并确认 → token 自动写入配置，你的微信 ID 自动加入 `allow_from` 白名单
2. 已有现成 token（运营商提供）→ 「手动输入 token」粘贴

**首次激活**：token 有效但会话过期（errcode -14）时，启动守护进程后用允许的微信账号给机器人**发一条消息**即可完成会话关联（context_token 机制——回复必须携带对方消息里的 context_token）。

**微信能力边界**：支持文字、引用（`[引用: …]` 前缀）、语音转写文本；图片/文件/视频收到时提示改用文字（媒体下载为后续能力）；回复按 3800 字符分块、代码围栏感知切分；typing「对方正在输入」指示自动开启/结束。

## 权限与安全

- `permissionMode: yolo`（默认）= 自动批准工具调用，即无人值守语义；`dontAsk` = 默认拒绝（谨慎模式）。
- 飞书群聊 @ 过滤是 **fail-closed**：机器人身份获取失败时宁可不响应，也不会抢答所有群消息。
- 微信 `allow_from` 未配置时任何私聊用户都能触发你的模型计费——**建议始终配置白名单**（ilink 用户 ID 形如 `xxx@im.wechat`）。
- Secret/token 以 0600 权限落盘；日志不含凭证。
- 远程会话与本地 TUI 会话互相独立，可在 `/sessions` 中查看（`source: line`）。

## 守护进程

- 独立进程：TUI 退出不影响通道；pidfile `~/.scream-code/line/daemon.pid`（防双开 + 陈旧清理）。
- 日志：`~/.scream-code/line/daemon.log`（超 5MB 轮转为 `daemon.log.1`）。
- 微信状态：`~/.scream-code/line/weixin/`（长轮询游标 + context_token 缓存，均 0600，勿手动泄露）。
- `autoStart: true` 时随 TUI 启动自动拉起；崩溃后下次启动自动恢复。
- 优雅关停：SIGTERM/SIGINT（等待进行中的回合，最多 10 秒）。

## 通道归属

- `/line` 是 Scream 唯一的远程通道：**飞书（Lark）与微信（WeChat）二选一**，配置向导与守护进程全部内置，不依赖任何第三方桥接工具。
- 已配置的通道会话在 `/sessions` 里标记 `line-feishu` / `line-weixin`，由通道管理（不可在 TUI 中删除，避免与守护进程争用）。
