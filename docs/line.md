# Line — native channels (Feishu and WeChat)

`/line` connects Scream Code to an IM app: a setup wizard plus a background daemon. Both platforms use **official interfaces** and need no public IP:
- **Feishu (Lark)**: the open platform's WebSocket long connection
- **WeChat**: the official ilink bot gateway (`getupdates` long polling, `sendmessage` to reply — WeChat's official bot interface)

## Quick start

1. In the TUI run `/line` and pick "set up Feishu (wizard)" or "set up WeChat (wizard)".
2. Feishu: choose **"create the app with the wizard (recommended)"** — it walks you through the official steps (create an app → enable the bot → grant permissions → long-connection subscription → publish → paste the credentials; about 3 minutes, no public IP), with a direct link and an explanation for each step. WeChat: choose **"log in by scanning (recommended)"** — the terminal shows a login link; open it in WeChat on your phone and confirm, and the token and allow-list are written for you.
   Already have credentials? Choose "enter manually" and paste them (see below for WeChat tokens).
3. Once the credentials pass a live check they are written to `~/.scream-code/line/config.json` (mode 0600).
4. Choose "start now": the daemon starts and the footer shows `◆ Line: Lark` / `◆ Line: Wechat`; when the daemon is not running it shows the channel as not connected.
5. Message the bot in the IM app; scream handles it in that chat's session and replies.

## One channel at a time

`/line` serves **one** channel at a time: with Feishu set up, the WeChat wizard cannot be chosen (and the other way round). To switch: `/line` → **uninstall** (stops the daemon and clears `~/.scream-code/line/`), then run the other platform's wizard. A config file edited by hand to hold both platforms is refused at daemon start (fail-fast, never two channels quietly). After a switch the old platform's sessions stay in `/sessions` (their own namespace) but the new channel no longer uses them.

## TUI and CLI commands

| Command | What it does |
|---|---|
| `/line` | Wizard, plus start / stop / restart / uninstall (in the TUI) |
| `scream line` | Run the daemon in the foreground (for debugging) |
| `scream line start` / `stop` / `status` | Start, stop and query it in the background |

## Configuration file

`~/.scream-code/line/config.json` (0600). Feishu option names follow the Feishu open platform's usual naming; WeChat option names follow the ilink gateway's fields.

### Common fields

| Field | Default | Meaning |
|---|---|---|
| `permissionMode` | `auto` | Permission mode of chat sessions (see below); `auto` by default for IM |
| `autoStart` | true | Start the daemon when the TUI starts |
| `workDir` | The daemon's start directory | Working directory of chat sessions |

### Feishu (`feishu`)

| Field | Default | Meaning |
|---|---|---|
| `app_id` / `app_secret` | Required | The Feishu app's credentials |
| `allow_from` | Empty = everyone | Allow-list of user IDs (comma-separated). **Recommended** |
| `allow_chat` | Empty = every group | Allow-list of group chat IDs (group chats only) |
| `group_only` | false | Answer group chats only |
| `require_mention` | true | In groups, answer only when the bot is @-mentioned (`false`: answer every group message) |
| `share_session_in_channel` | false | One session per group (by default one per group and user) |
| `reaction_emoji` | `OnIt` | Reaction added when a message arrives; `none` turns it off |
| `done_emoji` | Off | Reaction added when done (e.g. `THUMBSUP`); `none` turns it off |
| `domain` | `https://open.feishu.cn` | For international Lark use `https://open.larksuite.com` |

### WeChat (`weixin`)

| Field | Default | Meaning |
|---|---|---|
| `token` | Required | ilink bot bearer token |
| `base_url` | `https://ilinkai.weixin.qq.com` | Gateway root (change only if your operator differs) |
| `allow_from` | Empty = everyone | Allow-list of ilink user IDs (like `xxx@im.wechat`). **Recommended** |
| `route_tag` | Empty | The `SKRouteTag` request header some operators require |
| `long_poll_timeout_ms` | 35000 | Long-polling timeout |
| `dedup_window_seconds` | 300 | De-duplication window (ilink may resend a message when an ACK is late) |
| `cdn_base_url` | `https://novac2c.cdn.weixin.qq.com/c2c` | Media CDN root (change only if the gateway moves domain) |

**Getting a WeChat token** — logging in by scanning is the main path, done entirely inside the `/line` wizard, **nothing else to install**:
1. `/line` → "set up WeChat (wizard)" → **"log in by scanning (recommended)"**: the wizard asks the official gateway for a login link → you open it in WeChat on your phone and confirm → the token is written to the config and your WeChat ID is added to `allow_from`.
2. Already have a token (from an operator)? "Enter the token manually" and paste it.

**First activation**: when the token is valid but the session has expired (errcode -14), start the daemon and **send the bot one message** from an allowed WeChat account; that links the session (context_token: a reply must carry the context_token of the other side's message).

**What WeChat supports**: text, quotes (a `[引用: …]` prefix), voice transcribed to text, and **images / files / voice / video both ways** (see "Media"); replies are split into 3800-character chunks without breaking code fences; the "typing…" indicator is turned on and off automatically.

## Media

Both platforms carry **images and files both ways**: the model sees the images you send and can send images and files from the working directory back to you.

| Direction | Feishu | WeChat |
|---|---|---|
| Incoming images | `image` messages and images inside rich-text `post`; several images sent in a row are merged into one turn within 800 ms (**a reply to a message is sent at once, not batched**, so the quoted text is not lost) | `image_item`, CDN download + AES-128-ECB decryption |
| Incoming files | `file` / `audio` / `media` (video) and the `files[]` of a rich-text `post` → saved to disk and the path given to the model | `file_item` / `video_item` / `voice_item` without a transcript → same |
| Outgoing | Uploaded with `image.create` / `file.create`, then sent as an `image` / `file` message | `getuploadurl` → encrypted CDN upload → a `sendmessage` media item (image / file / video / **voice**) |
| Size limits | Incoming images 8 MiB; incoming attachments 32 MiB; outgoing 25 MiB | Same (incoming CDN hard limit 100 MiB per package) |
| Large files | Downloaded in `Range` chunks (avoiding the official SDK's truncation around 2 MiB), up to 512 MiB | Directly from the CDN |

- **Quoted messages**: replying to a message brings the quoted content into the turn as `[引用: …]` (cut at 500 characters); images in the quoted message (up to 2) are fetched too, and **files only when the quoting and the quoted message come from the same sender** (so a group member cannot pull someone else's file into their own session).
- **Where incoming attachments are saved**: `~/.scream-code/line/inbox/<session key>/<timestamp>-<file name>` (0600; never inside your project).
- **How images reach the model**: as `image_url` content parts directly in the turn, with no need for the model to read a file; attachments are given as paths, which the model opens with `ReadMediaFile` / `Read`.
- **Sending tool**: the model-side tool `line_send_media` (visible in IM sessions only). It sends only ordinary files **inside the working directory** (realpath checked against directory traversal and symlink escapes), up to 25 MiB each; `.png/.jpg/.gif/.webp/.bmp` go as images, `.amr/.wav/.mp3/.m4a/.aac/.ogg/.oga/.opus/.silk/.flac` as voice, anything else as a file; `kind` (`image` / `file` / `audio`) can also be given explicitly.
- **Outgoing voice (WeChat)**: the gateway accepts **AMR-NB** only (8 kHz, mono, 12.2 kbps). Other audio is transcoded with **ffmpeg** first (through stdin/stdout, no temporary file); without ffmpeg, or with an ffmpeg lacking the AMR-NB encoder, it **falls back to a file message**, with the reason in the tool result, and the turn does not fail.
  - macOS: `brew install ffmpeg` (Homebrew's official build **may not include** `libopencore_amrnb`; check with `ffmpeg -encoders | grep amr`).
  - Ubuntu/Debian: `sudo apt install ffmpeg`.
  - Windows: download an ffmpeg build with `libopencore-amr` from ffmpeg.org and put `ffmpeg.exe` on `PATH`.
  - Only **AMR-NB** (`#!AMR\n`) is sent as it is; AMR-WB (`#!AMR-WB`) and other formats are transcoded first.
  - On Feishu voice is always sent as a **file** (voice bubbles are WeChat-only); the tool result says so.
- **Failure replies**: when an image or attachment cannot be downloaded the bot replies `图片下载失败，请重新发送一次。` ("the image could not be downloaded, please send it again") instead of dropping it silently.

## Commands in the chat

Slash commands sent in the chat are handled by the daemon and **never reach the model** (no tokens spent). Replies from the bot are in Chinese.

| Command | What it does |
|---|---|
| `/status` | Current model, permission / plan / wolfpack / RLM mode, context use and thinking level |
| `/model <name>` | Switch model; without a name, show the current one |
| `/compact` | Compact the context |
| `/stop` | Stop the turn **in progress** and drop this chat's queued messages (the IM equivalent of Esc; works while busy); replies `已停止当前任务。` ("stopped the current task"). If it cannot stop within 10 seconds (a hung tool), the live session is closed and the next message resumes the same session |
| `/cancel` | Stop and start a new session (`/stop` + `/new`; works while busy) |
| `/cron` | This chat's reminders (with "silent / muted" marks and "last failure"); `/cron add [--silent\|--mute] <min hour day month weekday> <what to do>` adds one; `/cron rm <id>` deletes one |
| `/new` | Drop the current session; the next message starts a new one |
| `/jobs` | Background jobs: each job's schedule, last result and whether it is on |
| `/brief` | Turn on the daily brief (every day at 08:30 to this chat: what got done, what failed, what waits for you) |
| `/project [number]` | Show or switch this chat's project folder (from recently used projects) |
| `/stop all` | Pause all background work: stop runs in progress and switch every job off |
| `/inbox` | List what waits for you (approvals, questions) |
| `/approve <id> [always]` | Approve once (`always`: allow the same action unattended from now on) |
| `/approve <id> session` | Allow the same action for the rest of that session |
| `/reject <id>` | Reject |
| `/mine <id>` | You did it yourself (a password, say): tell the work it is done |
| `/answer <id> <answer>` | Answer a question from background work |
| `同意` / `拒绝` / `以后都同意` | Approve / reject / always approve. With one pushed approval waiting, just reply one of these words, no id needed; with several waiting, the bot lists their ids. Only these exact words count, so normal chatting is unaffected |
| `/help` | The command list (custom commands included) |
| `/<name>` | Commands you define yourself in the config (`prompt` or `exec`) |

- `/cron add` options: `--silent` sends only the result, without the `⏰` "fired" line; `--mute` sends nothing (pure background maintenance). The model-side `CronCreate` has the same `silent` / `mute` parameters. A failed task leaves a "last failure: …" line in `/cron`, cleared by the next success.
- While a turn is running, `/model`, `/compact` and `/new` reply "wait for this turn to finish (reply /stop to abort)" so they do not race the running turn; `/stop` itself **is never blocked**.
- A message queued behind others gets an immediate `收到，前面还有 N 条在处理中。回复 /stop 可中止当前任务。` ("received; N ahead of it; reply /stop to abort") instead of waiting silently.
- **Reminders come back to the chat**: when `cron.fired` triggers in a session the daemon first sends a `⏰` line naming the task, then the turn's final answer once it ends. Delivery uses the remembered chat target: Feishu's session → group mapping in `line/feishu/chats.json`, WeChat's locally saved context_token (`line/weixin/context_tokens.json`).
- **Reminders keep firing after a daemon restart**: on start it reopens chat sessions with reminders (even after the working directory changed), without waiting for your next message; a fire missed while it was down is delivered once after the restart (a repeating task says how many it merged). Feishu pushes directly; WeChat pushes with the context_token saved before the restart, and if WeChat considers it expired you need to send one message to restore pushing (the log says so). A fire that lands while your own turn runs is folded into that turn's reply, not pushed twice.
- `/status` ends with the voice capability found at start (whether ffmpeg / the AMR-NB encoder is available); a missing encoder means voice falls back to files.
- **Custom commands**: defined in the config's `commands` array. A `prompt` command sends its template as a turn (`{args}` is replaced; without a placeholder the arguments are appended); an `exec` command runs a shell in the daemon (`/bin/sh -c` on macOS/Linux, `%ComSpec% /d /s /c` on Windows; 30 s timeout, output cut at 8 KiB, arguments in the `LINE_ARGS` environment variable, `work_dir` must be inside the working directory). On Windows the `{args}` placeholder is **not supported** (command-injection safety); read `%LINE_ARGS%` in the script. Command names must not repeat or clash with built-in commands.
- **Unknown commands go to the model as usual**; commands that need the interactive UI (`/theme`, the `/line` wizard, `/model` without a name, `/sessions`) reply that they must be run in scream in a terminal.

## How the model knows the channel

When a session is created or resumed, the daemon gives it a channel note (runtime system prompt, not part of the conversation): Lark or WeChat, what it can receive and send, **no desktop screenshots**, long replies split into chunks. So the model does not offer to "take a screenshot" or claim to see attachments you never sent.

## Limits

- **60 minutes per turn** (`turnTimeoutMinutes` changes it): past it the turn is cancelled and the bot replies that the turn timed out, so one stuck request cannot hold the chat's queue forever.
- **`/new` is exclusive**: a message arriving during the reset is told the session is being reset and to resend shortly; a turn already running finishes before the storage is deleted.
- **Shutdown**: turns in progress are allowed to finish first (up to 60 seconds, logged while waiting), then the transports and sessions close.

## Permissions and safety

- `permissionMode: auto` (**default**) = after the deny rules, everything is allowed, with no interactive surface (no questions, no plan reviews) — the best fit for IM.
- `permissionMode: yolo` = also fully automatic, but keeps plan review (ExitPlanMode) as an interactive path; not recommended for IM.
- `permissionMode: dontAsk` = bot mode: reversible work runs; irreversible actions (publishing, pushing, deleting, sensitive files and so on) are refused and wait for your approval (see "Waiting for you" in [`host.md`](host.md)).
- No mode bypasses `deny` rules; a value written explicitly in an older config is kept as it is, never replaced by the default.
- Feishu's group @-filter **fails closed**: if the bot's identity cannot be fetched, it answers nothing rather than every group message.
- Without a WeChat `allow_from`, any private-chat user can spend your model tokens — **always set an allow-list** (ilink user IDs look like `xxx@im.wechat`).
- Secrets and tokens are stored with mode 0600; logs contain no credentials.
- Remote sessions and local TUI sessions are separate; they are listed in `/sessions` (`source: line`).

## The daemon

- The channel runs inside the **background host** (`scream host`; `scream line` is its older name), see [`host.md`](host.md). Quitting the TUI does not affect the channel. There is one background host per Scream home: while it runs it holds a lock owned by the operating system (an abstract socket on Linux, a socket file on macOS, a named pipe on Windows), released however the process ends — nothing is left behind, and a reused pid is never mistaken for it.
- Log: `~/.scream-code/host/host.log` (checked every 10 minutes while running; past 5 MB its content moves to `host.log.1` and the file is emptied).
- WeChat state: `~/.scream-code/line/weixin/` (long-polling cursor and context_token cache, both 0600; keep them private).
- With `autoStart: true` it starts with the TUI; to have it start at login and restart after a crash, turn on the resident service with `/service`.
- Graceful shutdown: `scream line stop`, or stop in `/line`, lets turns in progress finish (up to 60 seconds) before exiting, on Windows too; only then is it forced. SIGTERM/SIGINT wait the same way.

## Channel ownership

- `/line` is Scream's only remote channel: **Feishu (Lark) or WeChat, one of the two**, with the wizard and daemon built in and no third-party bridge.
- A configured channel's sessions are marked `line-feishu` / `line-weixin` in `/sessions` and managed by the channel (they cannot be deleted from the TUI, so they never race the daemon).
