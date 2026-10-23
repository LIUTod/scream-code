import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type Lang = "zh" | "en";

const en = {
  "app.inbox": "Inbox",
  "app.bots": "Bots",
  "app.rooms": "Rooms",
  "app.settings": "Settings",
  "app.newBot": "New Bot",
  "app.search": "Open command menu",
  "app.noRooms": "No rooms yet.",
  "app.theme": "Theme: {theme}",
  "app.waiting": "{count} waiting on you",
  "app.unread": "{count} unread",

  "landing.kicker": "Bot workbench",
  "landing.title": "Pick up where you left off",
  "landing.body":
    "Each Bot runs a complete Scream conversation in its workspace. Work together, exchange tasks and track progress here. Bots use the shared experience library.",
  "landing.open": "Open {name}",
  "landing.openFallback": "Open a Bot",
  "landing.command": "K opens the command menu",

  "composer.suggestion1": "Run the tests and fix what fails",
  "composer.suggestion2": "List the Bots I can work with",
  "composer.suggestion3": "Ask me what you need before you start",
  "composer.placeholder": "Message {name}…",
  "composer.paused": "{name} is paused",
  "composer.waiting": "Waiting on your decision above",
  "composer.hint": "Enter to send · Shift+Enter for a new line",
  "composer.send": "Send",
  "composer.stop": "Stop this run",
  "composer.sendFailed": "The message was not confirmed. Your draft is still here.",
  "composer.stopFailed": "Could not stop this run. Check its status before trying again.",
  "composer.cancelQueued": "Cancel queued task",
  "composer.cancelFailed": "Could not cancel the queued task.",
  "composer.retry": "Retry",
  "composer.steer": "Correct this run",
  "composer.recoveredDraft": "An unconfirmed draft was recovered. Check the transcript before resending.",
  "composer.unconfirmed": "This request may already have been accepted. Retry the same request to check it without creating another task; new text stays in your draft.",
  "composer.retryRequest": "Retry original request",
  "composer.unconfirmedText": "Unconfirmed request",
  "composer.dismissRequest": "Keep draft and dismiss notice",
  "transcript.loadFailed": "Could not load this conversation.",
  "transcript.retry": "Retry",
  "transcript.copyCode": "Copy code",
  "transcript.copied": "Copied",
  "transcript.copyFailed": "Copy failed",
  "transcript.expand": "Show more",
  "transcript.collapse": "Collapse",
  "transcript.tools": "{count} tools",
  "transcript.toolRenderFailed": "Could not display {name}.",
  "transcript.input": "Input",
  "transcript.output": "Output",
  "transcript.runFailed": "This run failed",
  "transcript.interrupted": "This run was interrupted",
  "run.interrupted": "interrupted",
  "connection.connected": "Connected",
  "connection.connecting": "Connecting…",
  "connection.reconnecting": "Reconnecting…",
  "connection.offline": "Offline — changes will sync after reconnecting",
  "connection.error": "Connection failed",
  "connection.retryIn": "Retrying in {seconds}s",
  "connection.disconnected": "Disconnected",
  "connection.local": "Local preview",
  "recovery.title": "Execution was interrupted",
  "recovery.description": "Some actions may already have happened. This conversation's queue is paused until you decide.",
  "recovery.continue": "Continue queued tasks",
  "recovery.retry": "Run this task again",
  "recovery.cancel": "Cancel queued tasks",
  "recovery.retryConfirm": "This task may already have changed files or external systems. Run it again anyway?",
  "recovery.failed": "Could not apply the recovery decision.",
  "common.unknownTime": "Unknown time",
  "files.root": "Workspace root",
  "drawer.thread": "Conversation {id}",
  "drawer.run": "Run {id}",
  "palette.title": "Command menu",
  "palette.description": "Jump to a Bot, a room, the inbox or settings.",
  "palette.search": "Search Bots, rooms and pages…",
  "palette.noMatches": "Nothing matches “{query}”.",
  "palette.openRoom": "Open #{name}",
  "palette.open": "Open {name}",
  "palette.goTo": "Go to {name}",
  "common.retry": "Retry",
  "common.loading": "Loading…",
  "common.loadFailed": "Could not load this content.",
  "files.truncated": "Preview truncated. Only the beginning of this file is shown.",
  "files.refresh": "Refresh",
  "files.parent": "Parent directory",
  "files.path": "Current directory",
  "files.readFailed": "Could not read this file.",
  "files.listFailed": "Could not list this directory.",
  "room.missing": "That room does not exist.",
  "room.loading": "Loading room…",
  "room.loadFailed": "Could not load this room.",
  "room.waiting": "Waiting for replies…",
  "room.replying": "replying…",
  "room.sending": "sending…",
  "question.otherAria": "Other answer for {id}",
  "question.expired": "This question expired. Your answers are kept.",
  "question.answered": "Answers submitted",
  "bot.settings.pending": "Saved — applies before the next run",
  "bot.settings.applyFailed": "Saved, but not applied to this conversation",
  "bot.settings.actualWorkspace": "This conversation uses {workspace}",
  "bot.settings.workspaceNext": "A workspace change applies to new conversations. Existing conversations keep their directory.",
  "bot.settings.sharedMemory": "Bots use the shared Scream experience library; this is not private Bot memory.",

  "transcript.working": "Working",
  "transcript.start": "Start with {name}",
  "transcript.loading": "Loading the transcript",

  "inbox.title": "Inbox",
  "inbox.description":
    "Every decision and every hand-off that is waiting on you, across all Bots.",
  "inbox.needsYou": "Needs you",
  "inbox.needsYouCount": "Needs you ({count})",
  "inbox.empty":
    "Nothing is waiting on you. Bots keep working until something needs a person.",
  "inbox.handoffs": "Hand-offs",
  "inbox.handoffsDescription":
    "Work one Bot handed to another. The answer lands in the other Bot's thread.",
  "inbox.noHandoffs": "No hand-off is in flight.",
  "inbox.openThread": "Open thread",

  "settings.title": "Settings",
  "settings.description":
    "One person, one machine. These are the only preferences the workbench keeps.",
  "settings.appearance": "Appearance",
  "settings.language": "Language",
  "settings.languageDescription": "The interface switches immediately and is remembered here.",
  "settings.theme": "Theme",
  "settings.themeDescription":
    "System follows your desktop. The choice is remembered in this browser.",
  "settings.light": "Light",
  "settings.dark": "Dark",
  "settings.system": "System",
  "settings.opens": "Where the workbench opens",
  "settings.opensDescription":
    "It reopens on the Bot you last had on screen. Forgetting that returns you to the welcome page.",
  "settings.forget": "Forget last Bot",
  "settings.keyboard": "Keyboard",
  "settings.command": "Command menu",
  "settings.commandDescription": "Jump to a Bot, a room, the inbox or this page.",
  "settings.composer": "Composer",
  "settings.composerDescription": "Enter sends; Shift+Enter writes a new line.",
  "settings.transport": "Transport",
  "settings.dataSource": "Data source",
  "settings.dataSourceDescription":
    "This build runs the UI against the local Bot gateway. Threads, approvals and hand-offs are persisted by the gateway.",
  "settings.local": "local",
  "settings.singleUser": "Single user",
  "settings.singleUserDescription":
    "No sign-in, no teams. Every Bot in the rail belongs to this machine.",
  "settings.footer": "Scream Bot",

  "bot.new.title": "New Bot",
  "bot.new.description":
    "A Bot gets its own thread, workspace and model. It can hand work to other Bots.",
  "bot.new.name": "Name",
  "bot.new.role": "Role",
  "bot.new.workspace": "Workspace",
  "bot.new.permissions": "Permissions",
  "bot.new.instructions": "Instructions",
  "bot.new.namePlaceholder": "Research",
  "bot.new.rolePlaceholder": "Investigator",
  "bot.new.workspacePlaceholder": "~/Projects/research",
  "bot.new.instructionsPlaceholder": "What this Bot is for, and how it should behave.",
  "bot.new.create": "Create Bot",
  "bot.new.cancel": "Cancel",
  "bot.permission.bot": "Safe — reversible actions only, risky ones refused",
  "bot.permission.auto": "Full auto — allows everything, use with care",
  "bot.settings.title": "Bot settings",
  "bot.settings.delete": "Delete this Bot",
  "bot.delete": "Delete {name}",
  "bot.deleteConfirm":
    "Delete {name}? Its conversations and pending decisions go with it. This cannot be undone.",
  "bot.settings.save": "Save",
  "bot.settings.saveChanges": "Save changes",
  "bot.settings.cancel": "Cancel",

  "approval.allowOnce": "Allow once",
  "approval.allowSession": "Allow for this session",
  "approval.deny": "Deny",
  "approval.feedback": "Tell the Bot why (optional)",
  "approval.pending": "Waiting on you",
  "approval.command": "{name} wants to run a command",
  "approval.changeFile": "{name} wants to change a file",
  "approval.useTool": "{name} wants to use {tool}",
  "approval.asked": "Asked {time}",
  "approval.expired": "expired",
  "question.submit": "Submit answers",
  "question.other": "Something else…",
  "question.title": "{name} needs a decision",
  "question.paused": "the run is paused until you answer",
  "question.many": "{count} questions",

  "room.empty": "Nothing said yet. Mention a Bot with @name.",
  "room.placeholder": "Message #{room} — @{bot} to address one Bot",
  "room.send": "Send",
  "room.new": "New room",
  "room.newDescription":
    "A room is a shared transcript. Pick the Bots; @name chooses who answers.",
  "room.name": "Room name",
  "room.namePlaceholder": "project-room",
  "room.members": "Members",
  "room.membersHint": "At least one Bot. Without @, the lead Bot answers.",
  "room.leadLabel": "Lead Bot",
  "room.create": "Create room",
  "room.creating": "Creating…",
  "room.cancel": "Cancel",
  "room.delete": "Delete room",
  "room.deleteConfirm": "Delete this room and its shared transcript? This cannot be undone.",

  "status.idle": "Idle",
  "status.working": "Working",
  "status.needs_you": "Needs you",
  "status.paused": "Paused",
  "status.error": "Error",

  "cockpit.details": "Details",
  "cockpit.openNav": "Open sidebar",
  "cockpit.noThread": "No thread",
  "cockpit.newConversation": "New conversation",
  "cockpit.inbox": "Inbox",
  "cockpit.botSettings": "Bot settings",
  "cockpit.resumeBot": "Resume Bot",
  "cockpit.pauseBot": "Pause Bot",
  "cockpit.missing": "That Bot does not exist.",
  "thread.delete": "Delete conversation",
  "thread.deleteConfirm":
    "Delete this conversation? Its messages disappear from the workbench. This cannot be undone.",
  "cockpit.activity": "Activity",
  "cockpit.approvals": "Approvals",
  "cockpit.files": "Files",
  "drawer.empty": "Nothing has happened in this Bot yet.",
  "drawer.notWaiting": "{name} is not waiting on you.",
  "drawer.coreSession": "core session",
  "drawer.loading": "Loading…",
  "drawer.files": "Files",
  "drawer.emptyWorkspace": "This workspace is empty.",
  "transcript.scrollEnd": "Scroll to end",
  "transcript.scrollStart": "Scroll to start",
  "run.queued": "queued",
  "run.running": "running",
  "run.waiting_user": "waiting on you",
  "run.done": "done",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "actor.person": "You",
  "actor.system": "System",
  "audit.botCreated": "Bot created",
  "audit.botUpdated": "Bot updated",
  "audit.botDeleted": "Bot deleted",
  "audit.botPaused": "Bot paused",
  "audit.botResumed": "Bot resumed",
  "audit.runStarted": "Run started",
  "audit.runDone": "Run done",
  "audit.runFailed": "Run failed",
  "audit.runInterrupted": "Run interrupted",
  "audit.messagePrompted": "Message prompted",
  "audit.threadCreated": "Thread created",
  "audit.approvalRequested": "Approval requested",
  "audit.approvalDecided": "Approval decided",
  "audit.approvalExpired": "Approval expired",
  "audit.questionRequested": "Question asked",
  "audit.questionAnswered": "Question answered",
  "audit.questionExpired": "Question expired",

  "bot.new.creating": "Creating…",
  "bot.new.roleHint": "One line, shown under the name in the rail.",
  "bot.new.workspaceHint": "Default directory for new conversations. Tool access follows the selected permission mode.",
  "bot.settings.description": "The Bot's identity, its workspace and what it may do without asking.",
  "bot.settings.workspaceHint": "Changes apply to new conversations; existing conversations keep their directory. This is not a sandbox.",
  "bot.settings.pausedTitle": "This Bot is paused",
  "bot.settings.pauseTitle": "Pause this Bot",
  "bot.settings.pauseDescription":
    "Pausing stops new runs. Threads and pending decisions stay where they are.",
  "bot.settings.resume": "Resume",
  "bot.settings.pause": "Pause",
  "bot.settings.deleteDescription":
    "Its threads and pending decisions go with it. The workbench keeps at least one Bot.",
  "bot.settings.deletePermanently": "Delete permanently",
  "bot.settings.deleting": "Deleting…",
  "bot.settings.deleteTrigger": "Delete…",
  "bot.settings.saving": "Saving…",

  "question.one": "One question",
  "question.sending": "Sending…",

  "room.lead": "{name} leads",
  "room.noLead": "No lead Bot",
  "room.shared": "shared transcript",
  "room.you": "You",
  "room.bot": "Bot",
  "room.viaHandoff": "via hand-off",
  "room.messageAria": "Message #{room}",

  "handoff.handedTo": "Handed to {name}",
  "handoff.anotherBot": "another Bot",
  "handoff.delivered": "Answered",
  "handoff.failed": "Did not come back",
  "handoff.queued": "Queued",
  "handoff.refused": "Refused",
  "handoff.running": "Working on it",
  "handoff.awaiting_relay": "Answered — waiting to relay",
  "handoff.interrupted": "Interrupted — needs confirmation",
  "handoff.cancelled": "Cancelled",
  "handoff.deliveredNote":
    "{name} answered in their own conversation; the result was relayed here.",
  "handoff.open": "Open thread",
} as const;

type Key = keyof typeof en;

const zh: Record<Key, string> = {
  "app.inbox": "收件箱",
  "app.bots": "Bot",
  "app.rooms": "群聊",
  "app.settings": "设置",
  "app.newBot": "新建 Bot",
  "app.search": "打开命令菜单",
  "app.noRooms": "还没有群聊。",
  "app.theme": "主题：{theme}",
  "app.waiting": "{count} 项等你处理",
  "app.unread": "{count} 条未读",

  "landing.kicker": "Bot 工作台",
  "landing.title": "从上次的地方继续",
  "landing.body":
    "每个 Bot 在自己的工作区运行完整的 Scream 会话。在这里沟通、交接任务并查看进度；经验库由 Bot 共享。",
  "landing.open": "打开 {name}",
  "landing.openFallback": "打开一个 Bot",
  "landing.command": "按 K 打开命令菜单",

  "composer.suggestion1": "跑一遍测试，把失败的修掉",
  "composer.suggestion2": "看看有哪些可以协作的 Bot",
  "composer.suggestion3": "开始前先问我还需要什么",
  "composer.placeholder": "给 {name} 发消息…",
  "composer.paused": "{name} 已暂停",
  "composer.waiting": "等你先处理上面的决定",
  "composer.hint": "Enter 发送 · Shift+Enter 换行",
  "composer.send": "发送",
  "composer.stop": "停止本次运行",
  "composer.sendFailed": "消息尚未确认接收，草稿已保留。",
  "composer.stopFailed": "未能停止本次运行，请核对任务状态后重试。",
  "composer.cancelQueued": "取消排队任务",
  "composer.cancelFailed": "未能取消排队任务。",
  "composer.retry": "重试",
  "composer.steer": "纠正当前任务",
  "composer.recoveredDraft": "已恢复未确认接收的草稿，请先核对会话记录再发送。",
  "composer.unconfirmed": "此请求可能已被接收。使用原请求重试可避免创建重复任务，新输入仍保留在草稿中。",
  "composer.retryRequest": "重试原请求",
  "composer.unconfirmedText": "未确认请求",
  "composer.dismissRequest": "保留草稿并关闭提示",
  "transcript.loadFailed": "无法加载会话记录。",
  "transcript.retry": "重试",
  "transcript.copyCode": "复制代码",
  "transcript.copied": "已复制",
  "transcript.copyFailed": "复制失败",
  "transcript.expand": "展开更多",
  "transcript.collapse": "收起",
  "transcript.tools": "{count} 个工具",
  "transcript.toolRenderFailed": "无法显示 {name}。",
  "transcript.input": "输入",
  "transcript.output": "输出",
  "transcript.runFailed": "本次运行失败",
  "transcript.interrupted": "本次运行已中断",
  "run.interrupted": "已中断",
  "connection.connected": "已连接",
  "connection.connecting": "正在连接…",
  "connection.reconnecting": "正在重连…",
  "connection.offline": "连接已断开，重连后将同步状态",
  "connection.error": "连接失败",
  "connection.retryIn": "{seconds} 秒后重试",
  "connection.disconnected": "连接已断开",
  "connection.local": "本地预览",
  "recovery.title": "执行已中断",
  "recovery.description": "部分操作可能已经发生。本会话的后续队列已暂停，等待你确认。",
  "recovery.continue": "继续后续排队任务",
  "recovery.retry": "重新执行此任务",
  "recovery.cancel": "取消后续排队任务",
  "recovery.retryConfirm": "此任务可能已修改文件或外部系统，仍要重新执行吗？",
  "recovery.failed": "未能应用恢复决定。",
  "common.unknownTime": "时间未知",
  "files.root": "工作区根目录",
  "drawer.thread": "会话 {id}",
  "drawer.run": "任务 {id}",
  "palette.title": "命令菜单",
  "palette.description": "跳转到 Bot、群聊、收件箱或设置。",
  "palette.search": "搜索 Bot、群聊和页面…",
  "palette.noMatches": "没有匹配“{query}”的结果。",
  "palette.openRoom": "打开 #{name}",
  "palette.open": "打开 {name}",
  "palette.goTo": "前往{name}",
  "common.retry": "重试",
  "common.loading": "正在加载…",
  "common.loadFailed": "无法加载内容。",
  "files.truncated": "预览已截断，仅显示文件开头部分。",
  "files.refresh": "刷新",
  "files.parent": "上级目录",
  "files.path": "当前目录",
  "files.readFailed": "无法读取文件。",
  "files.listFailed": "无法列出此目录。",
  "room.missing": "这个群聊不存在。",
  "room.loading": "正在加载群聊…",
  "room.loadFailed": "无法加载群聊。",
  "room.waiting": "正在等待回复…",
  "room.replying": "正在回复…",
  "room.sending": "发送中…",
  "question.otherAria": "问题 {id} 的自定义答案",
  "question.expired": "问题已过期，你的答案已保留。",
  "question.answered": "答案已提交",
  "bot.settings.pending": "已保存，将在下次运行前应用",
  "bot.settings.applyFailed": "已保存，但尚未应用到此会话",
  "bot.settings.actualWorkspace": "本会话使用 {workspace}",
  "bot.settings.workspaceNext": "工作区变更仅用于新会话，已有会话保留原目录。",
  "bot.settings.sharedMemory": "Bot 使用 Scream 共享经验库，不是每个 Bot 的私有记忆。",

  "transcript.working": "工作中",
  "transcript.start": "和 {name} 开始",
  "transcript.loading": "正在加载会话",

  "inbox.title": "收件箱",
  "inbox.description": "所有 Bot 等你做的决定和等你接手的转交。",
  "inbox.needsYou": "需要你",
  "inbox.needsYouCount": "需要你（{count}）",
  "inbox.empty": "现在没有等你的事。Bot 会继续工作，直到需要人介入。",
  "inbox.handoffs": "转交",
  "inbox.handoffsDescription": "一个 Bot 交给另一个 Bot 的活，答案会落在对方的会话里。",
  "inbox.noHandoffs": "没有进行中的转交。",
  "inbox.openThread": "打开会话",

  "settings.title": "设置",
  "settings.description": "一个人，一台机器。工作台只记住这些偏好。",
  "settings.appearance": "外观",
  "settings.language": "语言",
  "settings.languageDescription": "切换后立即生效，并记住在这台浏览器里。",
  "settings.theme": "主题",
  "settings.themeDescription": "跟随系统会使用桌面主题；选择会记在这个浏览器里。",
  "settings.light": "浅色",
  "settings.dark": "深色",
  "settings.system": "跟随系统",
  "settings.opens": "工作台从哪打开",
  "settings.opensDescription": "下次打开会回到你最后停留的 Bot；忘记后回到欢迎页。",
  "settings.forget": "忘记上一个 Bot",
  "settings.keyboard": "键盘",
  "settings.command": "命令菜单",
  "settings.commandDescription": "跳转到 Bot、群聊、收件箱或本页。",
  "settings.composer": "输入框",
  "settings.composerDescription": "Enter 发送；Shift+Enter 换行。",
  "settings.transport": "连接",
  "settings.dataSource": "数据源",
  "settings.dataSourceDescription":
    "当前界面连接本地 Bot 网关；会话、审批和转交都由网关持久化保存。",
  "settings.local": "本地",
  "settings.singleUser": "单用户",
  "settings.singleUserDescription": "没有登录，没有团队。侧栏里的每个 Bot 都属于这台机器。",
  "settings.footer": "Scream Bot",

  "bot.new.title": "新建 Bot",
  "bot.new.description": "每个 Bot 有自己的会话、工作区和模型，也可以把活交给别的 Bot。",
  "bot.new.name": "名字",
  "bot.new.role": "职位",
  "bot.new.workspace": "工作区",
  "bot.new.permissions": "权限",
  "bot.new.instructions": "角色说明",
  "bot.new.namePlaceholder": "Research",
  "bot.new.rolePlaceholder": "调查员",
  "bot.new.workspacePlaceholder": "~/Projects/research",
  "bot.new.instructionsPlaceholder": "这个 Bot 负责什么，以及它应该怎么工作。",
  "bot.new.create": "创建 Bot",
  "bot.new.cancel": "取消",
  "bot.permission.bot": "安全 —— 只做可逆操作，危险操作直接拒绝",
  "bot.permission.auto": "全自动 —— 放行一切，谨慎使用",
  "bot.settings.title": "Bot 设置",
  "bot.settings.delete": "删除这个 Bot",
  "bot.delete": "删除 {name}",
  "bot.deleteConfirm": "删除 {name}？它的会话和待处理决定会一起删除，无法恢复。",
  "bot.settings.save": "保存",
  "bot.settings.saveChanges": "保存修改",
  "bot.settings.cancel": "取消",

  "approval.allowOnce": "允许一次",
  "approval.allowSession": "本会话允许",
  "approval.deny": "拒绝",
  "approval.feedback": "告诉 Bot 原因（可选）",
  "approval.pending": "等你处理",
  "approval.command": "{name} 想执行一条命令",
  "approval.changeFile": "{name} 想改一个文件",
  "approval.useTool": "{name} 想使用 {tool}",
  "approval.asked": "{time} 请求",
  "approval.expired": "已过期",
  "question.submit": "提交答案",
  "question.other": "其他…",
  "question.title": "{name} 需要你决定",
  "question.paused": "你回答前，这次运行会暂停",
  "question.many": "{count} 个问题",

  "room.empty": "还没有人说话。用 @名字 叫一个 Bot。",
  "room.placeholder": "发到 #{room} — 用 @{bot} 指定一个 Bot",
  "room.send": "发送",
  "room.new": "新建群聊",
  "room.newDescription": "群聊是一份共享会话记录。选成员；用 @名字 指定谁回答。",
  "room.name": "群聊名称",
  "room.namePlaceholder": "project-room",
  "room.members": "成员",
  "room.membersHint": "至少一个 Bot。不写 @ 时由负责的 Bot 回答。",
  "room.leadLabel": "负责的 Bot",
  "room.create": "创建群聊",
  "room.creating": "创建中…",
  "room.cancel": "取消",
  "room.delete": "删除群聊",
  "room.deleteConfirm": "删除这个群聊和共享记录？无法恢复。",

  "status.idle": "空闲",
  "status.working": "工作中",
  "status.needs_you": "需要你",
  "status.paused": "已暂停",
  "status.error": "出错",

  "cockpit.details": "详情",
  "cockpit.openNav": "打开侧栏",
  "cockpit.noThread": "没有会话",
  "cockpit.newConversation": "新会话",
  "cockpit.inbox": "收件箱",
  "cockpit.botSettings": "Bot 设置",
  "cockpit.resumeBot": "恢复 Bot",
  "cockpit.pauseBot": "暂停 Bot",
  "cockpit.missing": "这个 Bot 不存在。",
  "thread.delete": "删除会话",
  "thread.deleteConfirm": "删除这个会话？消息会从工作台消失，无法恢复。",
  "cockpit.activity": "动态",
  "cockpit.approvals": "审批",
  "cockpit.files": "文件",
  "drawer.empty": "这个 Bot 还没有任何动静。",
  "drawer.notWaiting": "{name} 没有等你处理的事。",
  "drawer.coreSession": "核心会话",
  "drawer.loading": "加载中…",
  "drawer.files": "文件",
  "drawer.emptyWorkspace": "这个工作区还是空的。",
  "transcript.scrollEnd": "回到底部",
  "transcript.scrollStart": "回到顶部",
  "run.queued": "排队中",
  "run.running": "运行中",
  "run.waiting_user": "等你决定",
  "run.done": "已完成",
  "run.failed": "失败",
  "run.cancelled": "已取消",
  "actor.person": "你",
  "actor.system": "系统",
  "audit.botCreated": "创建 Bot",
  "audit.botUpdated": "更新 Bot",
  "audit.botDeleted": "删除 Bot",
  "audit.botPaused": "暂停 Bot",
  "audit.botResumed": "恢复 Bot",
  "audit.runStarted": "开始运行",
  "audit.runDone": "运行完成",
  "audit.runFailed": "运行失败",
  "audit.runInterrupted": "运行中断",
  "audit.messagePrompted": "发送消息",
  "audit.threadCreated": "新建会话",
  "audit.approvalRequested": "请求审批",
  "audit.approvalDecided": "审批决定",
  "audit.approvalExpired": "审批过期",
  "audit.questionRequested": "提出问题",
  "audit.questionAnswered": "回答问题",
  "audit.questionExpired": "问题过期",

  "bot.new.creating": "创建中…",
  "bot.new.roleHint": "一行字，显示在侧栏名字下面。",
  "bot.new.workspaceHint": "新会话的默认目录；工具访问范围由所选权限模式决定。",
  "bot.settings.description": "Bot 的身份、工作区，以及哪些事可以不问就做。",
  "bot.settings.workspaceHint": "变更仅用于新会话，已有会话保留原目录。工作区不是隔离沙箱。",
  "bot.settings.pausedTitle": "这个 Bot 已暂停",
  "bot.settings.pauseTitle": "暂停这个 Bot",
  "bot.settings.pauseDescription": "暂停会停止新的运行；会话和待处理的决定都保留。",
  "bot.settings.resume": "恢复",
  "bot.settings.pause": "暂停",
  "bot.settings.deleteDescription": "会话和待处理的决定会一起删除。工作台至少保留一个 Bot。",
  "bot.settings.deletePermanently": "永久删除",
  "bot.settings.deleting": "删除中…",
  "bot.settings.deleteTrigger": "删除…",
  "bot.settings.saving": "保存中…",

  "question.one": "一个问题",
  "question.sending": "提交中…",

  "room.lead": "{name} 负责",
  "room.noLead": "没有负责的 Bot",
  "room.shared": "共享会话记录",
  "room.you": "你",
  "room.bot": "Bot",
  "room.viaHandoff": "转交",
  "room.messageAria": "发到 #{room}",

  "handoff.handedTo": "已交给 {name}",
  "handoff.anotherBot": "另一个 Bot",
  "handoff.delivered": "已回答",
  "handoff.failed": "没回来",
  "handoff.queued": "排队中",
  "handoff.refused": "已拒绝",
  "handoff.running": "处理中",
  "handoff.awaiting_relay": "已回答，等待回传",
  "handoff.interrupted": "已中断，等待确认",
  "handoff.cancelled": "已取消",
  "handoff.deliveredNote": "{name} 在自己的会话中完成了回答，结果已回传到这里。",
  "handoff.open": "打开会话",
};

const dictionaries: Record<Lang, Record<Key, string>> = { en, zh };

const STORAGE_KEY = "scream.bot.lang";

function detectLang(): Lang {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  }
  if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")) {
    return "zh";
  }
  return "en";
}

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

interface I18nValue {
  readonly lang: Lang;
  readonly setLang: (lang: Lang) => void;
  readonly t: (key: Key, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang());

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Storage can be unavailable in private windows; the choice is still live.
    }
  }, [lang]);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      setLang: setLangState,
      t: (key, vars) => interpolate(dictionaries[lang][key], vars),
    }),
    [lang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return value;
}

export function LangToggle() {
  const { lang, setLang } = useI18n();
  const base =
    "rounded-md px-1.5 py-0.5 text-[11px] transition-colors border border-border";
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Language / 语言">
      <button
        aria-pressed={lang === "zh"}
        className={`${base} ${lang === "zh" ? "bg-sidebar-accent text-foreground" : "text-muted-foreground"}`}
        onClick={() => setLang("zh")}
        type="button"
      >
        中文
      </button>
      <button
        aria-pressed={lang === "en"}
        className={`${base} ${lang === "en" ? "bg-sidebar-accent text-foreground" : "text-muted-foreground"}`}
        onClick={() => setLang("en")}
        type="button"
      >
        EN
      </button>
    </div>
  );
}
