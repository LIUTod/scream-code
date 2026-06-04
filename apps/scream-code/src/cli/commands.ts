import { Command, Option } from 'commander';

import { CLI_COMMAND_NAME } from '#/constant/app';

import { registerMigrateCommand } from '#/migration/index';

import type { CLIOptions } from './options';
import { registerExportCommand } from './sub/export';

export type MainCommandHandler = (opts: CLIOptions) => void;
export type MigrateCommandHandler = () => void;
export type PluginNodeRunnerHandler = (entry: string, args: readonly string[]) => void;
export type StreamJsonHandler = (opts: {
  resume?: string;
  model?: string;
  permissionMode?: string;
  skillsDirs: string[];
  appendSystemPrompt?: string;
}) => void;

export type ChannelSetupHandler = () => void;

export function createProgram(
  version: string,
  onMain: MainCommandHandler,
  onMigrate: MigrateCommandHandler,
  onPluginNodeRunner: PluginNodeRunnerHandler = () => {},
  onStreamJson: StreamJsonHandler = () => {},
  onChannelSetup: ChannelSetupHandler = () => {},
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
    .option('--plan', '以计划模式启动。', false);

  registerExportCommand(program);
  registerMigrateCommand(program, onMigrate);

  // Hidden subcommand for cc-connect / Claude Code stream-json protocol.
  // cc-connect spawns: scream stream-json --output-format stream-json --input-format stream-json
  //   --permission-prompt-tool stdio --replay-user-messages --verbose ...
  // We register all flags cc-connect may pass so Commander doesn't reject them.
  // Flags we actually use: --input-format, --output-format, --resume, --model, --permission-mode.
  // Flags accepted but ignored: --permission-prompt-tool, --replay-user-messages, --verbose,
  //   --system-prompt, --append-system-prompt, --allowedTools, --disallowedTools, --effort,
  //   --max-context-tokens.
  program
    .command('stream-json', { hidden: true })
    .option('--input-format <fmt>', 'stream-json')
    .option('--output-format <fmt>', 'stream-json')
    .option('--resume <id>', 'resume a previous session')
    .option('--model <model>', 'model to use')
    .option('--permission-mode <mode>', 'permission mode')
    .option('--permission-prompt-tool <mode>', '(ignored, cc-connect compat)')
    .option('--replay-user-messages', '(ignored, cc-connect compat)')
    .option('--verbose', '(ignored, cc-connect compat)')
    .option('--system-prompt <text>', '(ignored, cc-connect compat)')
    .option('--append-system-prompt <text>', '(passed through to agent)')
    .option('--allowedTools <list>', '(ignored, cc-connect compat)')
    .option('--disallowedTools <list>', '(ignored, cc-connect compat)')
    .option('--effort <value>', '(ignored, cc-connect compat)')
    .option('--max-context-tokens <N>', '(ignored, cc-connect compat)')
    .option(
      '--skills-dir <dir>',
      'additional skills directory (repeatable)',
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
      });
    });

  // `scream channel setup` — interactive cc-connect platform configuration wizard.
  const channelCmd = program
    .command('channel')
    .description('管理 cc-connect 消息平台通道');
  channelCmd
    .command('setup')
    .description('配置 cc-connect 并选择要连接的平台')
    .action(() => {
      onChannelSetup();
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
      model: raw['model'] as string | undefined,
      outputFormat: raw['outputFormat'] as CLIOptions['outputFormat'],
      prompt: raw['prompt'] as string | undefined,
      skillsDirs: raw['skillsDir'] as string[],
    };

    onMain(opts);
  });

  return program;
}
