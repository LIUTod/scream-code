import { Command, Option } from 'commander';

import { CLI_COMMAND_NAME } from '#/constant/app';

import type { CLIOptions } from './options';
import { registerExportCommand } from './sub/export';

export type MainCommandHandler = (opts: CLIOptions) => void;
export type PluginNodeRunnerHandler = (entry: string, args: readonly string[]) => void;
export type StreamJsonHandler = (opts: {
  resume?: string;
  model?: string;
  permissionMode?: string;
  skillsDirs: string[];
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  systemPrompt?: string;
  allowedTools?: string;
  disallowedTools?: string;
  effort?: string;
  maxContextTokens?: string;
  pluginDirs: string[];
}) => void;

export type LineCommandHandler = (action: 'run' | 'start' | 'stop' | 'status') => void;

export function createProgram(
  version: string,
  onMain: MainCommandHandler,
  onPluginNodeRunner: PluginNodeRunnerHandler = () => {},
  onStreamJson: StreamJsonHandler = () => {},
  onLine: LineCommandHandler = () => {},
): Command {
  const program = new Command(CLI_COMMAND_NAME)
    .description('下一代智能体的起点')
    .version(version, '-V, --version')
    .allowUnknownOption(false)
    .configureHelp({ helpWidth: 100 })
    .helpOption('-h, --help', '显示帮助。')
    .addHelpText(
      'after',
      '\n文档：        https://scream-cli.github.io/scream-code/\n'
    );

  program
    .addOption(
      new Option(
        '-S, --session [id]',
        '恢复会话。带 ID：恢复该会话。不带 ID：交互式选择。',
      ).argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .addOption(
      new Option('-r, --resume [id]')
        .hideHelp()
        .argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .option('-C, --continue', '继续当前工作目录的上一个会话。', false)
    .option('-y, --yolo', '自动批准所有操作。', false)
    .option('--auto', '以自动权限模式启动。', false)
    .addOption(
      new Option(
        '-m, --model <model>',
        '本次调用使用的 LLM 模型别名。默认使用 config.toml 中的 default_model。',
      ),
    )
    .addOption(
      new Option(
        '-p, --prompt <prompt>',
        '非交互式运行一条提示并打印响应。',
      ),
    )
    .addOption(
      new Option(
        '--output-format <format>',
        '提示模式的输出格式。默认为 text。',
      ).choices(['text', 'stream-json']),
    )
    .addOption(
      new Option(
        '--skills-dir <dir>',
        '从该目录加载技能，而不是自动发现的用户和项目目录。可多次指定。',
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(new Option('--yes').hideHelp().default(false))
    .addOption(new Option('--auto-approve').hideHelp().default(false))
    .option('--plan', '以计划模式启动。', false)
    .option('--wolfpack', '启动时默认开启 WolfPack 批量并发模式。', false);

  registerExportCommand(program);

  // Hidden subcommand for the stream-json protocol stream-json protocol.
  // the external client spawns: scream stream-json --output-format stream-json --input-format stream-json
  //   --permission-prompt-tool stdio --replay-user-messages --verbose ...
  // Flag set mirrors the external client's agent invocation (v1.3.2+); keep it in sync
  // so Commander never rejects a flag the external client may pass.
  // Flags we actually use: --input-format, --output-format, --resume, --model, --permission-mode,
  //   --append-system-prompt, --append-system-prompt-file, --system-prompt, --skills-dir,
  //   --allowedTools, --disallowedTools, --effort.
  // Flags accepted but no-op: --permission-prompt-tool, --replay-user-messages, --verbose,
  //   --max-context-tokens, --plugin-dir (scream-code manages MCP via config.toml).
  program
    .command('stream-json', { hidden: true })
    .option('--input-format <fmt>', 'stream-json')
    .option('--output-format <fmt>', 'stream-json')
    .option('--resume <id>', 'resume a previous session')
    .option('--model <model>', 'model to use')
    .option('--permission-mode <mode>', 'permission mode')
    .option('--permission-prompt-tool <mode>', '(ignored for compatibility)')
    .option('--replay-user-messages', '(ignored for compatibility)')
    .option('--verbose', '(ignored for compatibility)')
    .option('--system-prompt <text>', '(passed through to agent system prompt)')
    .option('--append-system-prompt <text>', '(passed through to agent)')
    .option('--append-system-prompt-file <path>', '(passed through to agent; file contents are read and merged)')
    .option('--allowedTools <list>', '(comma-separated tool whitelist)')
    .option('--disallowedTools <list>', '(comma-separated tool blacklist)')
    .option('--effort <value>', '(reasoning effort: low/medium/high/max)')
    .option('--max-context-tokens <N>', '(ignored for compatibility)')
    .option(
      '--skills-dir <dir>',
      'additional skills directory (repeatable)',
      (value: string, previous: string[]) => [...(previous ?? []), value],
      [] as string[],
    )
    .option(
      '--plugin-dir <dir>',
      '(ignored, compatibility flag; repeatable)',
      (value: string, previous: string[]) => [...(previous ?? []), value],
      [] as string[],
    )
    .action((subOpts: Record<string, unknown>) => {
      onStreamJson({
        resume: subOpts['resume'] as string | undefined,
        model: subOpts['model'] as string | undefined,
        permissionMode: subOpts['permissionMode'] as string | undefined,
        skillsDirs: (subOpts['skillsDir'] as string[]) ?? [],
        appendSystemPrompt: subOpts['appendSystemPrompt'] as string | undefined,
        appendSystemPromptFile: subOpts['appendSystemPromptFile'] as string | undefined,
        systemPrompt: subOpts['systemPrompt'] as string | undefined,
        allowedTools: subOpts['allowedTools'] as string | undefined,
        disallowedTools: subOpts['disallowedTools'] as string | undefined,
        effort: subOpts['effort'] as string | undefined,
        maxContextTokens: subOpts['maxContextTokens'] as string | undefined,
        pluginDirs: (subOpts['pluginDir'] as string[]) ?? [],
      });
    });

  // `scream line` - native IM channel daemon (configured via /line in the TUI).
  const lineCmd = program
    .command('line')
    .description('IM 原生通道守护进程（飞书/Lark、微信；在 TUI 里用 /line 配置）')
    .action(() => {
      onLine('run');
    });
  lineCmd
    .command('run')
    .description('前台运行守护进程（调试用）')
    .action(() => {
      onLine('run');
    });
  lineCmd
    .command('start')
    .description('后台启动守护进程')
    .action(() => {
      onLine('start');
    });
  lineCmd
    .command('stop')
    .description('停止守护进程')
    .action(() => {
      onLine('stop');
    });
  lineCmd
    .command('status')
    .description('查看守护进程状态')
    .action(() => {
      onLine('status');
    });

  program
    .command('__plugin_run_node', { hidden: true })
    .argument('<entry>')
    .argument('[args...]')
    .allowUnknownOption(true)
    .action((entry: string, args: string[]) => {
      onPluginNodeRunner(entry, args);
    });

  program.action(() => {
    const raw = program.opts<Record<string, unknown>>();

    const rawSession = raw['session'] ?? raw['resume'];
    const sessionValue = rawSession === true ? '' : (rawSession as string | undefined);
    const yoloValue = raw['yes'] === true || raw['yolo'] === true || raw['autoApprove'] === true;
    const autoValue = raw['auto'] === true;

    const opts: CLIOptions = {
      session: sessionValue,
      continue: raw['continue'] as boolean,
      yolo: yoloValue,
      auto: autoValue,
      plan: raw['plan'] as boolean,
      wolfpack: raw['wolfpack'] as boolean,
      model: raw['model'] as string | undefined,
      outputFormat: raw['outputFormat'] as CLIOptions['outputFormat'],
      prompt: raw['prompt'] as string | undefined,
      skillsDirs: raw['skillsDir'] as string[],
    };

    onMain(opts);
  });

  return program;
}
