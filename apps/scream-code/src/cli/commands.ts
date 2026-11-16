import { Command, Option } from 'commander';
import { t } from '@scream-code/config';

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
    .description(t('cli.help.description'))
    .version(version, '-V, --version')
    .allowUnknownOption(false)
    .configureHelp({ helpWidth: 100 })
    .helpOption('-h, --help', t('cli.help.help'))
    .addHelpText(
      'after',
      `\n${t('cli.help.docs')}        https://scream-cli.github.io/scream-code/\n`
    );

  program
    .addOption(
      new Option(
        '-S, --session [id]',
        t('cli.opt.session'),
      ).argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .addOption(
      new Option('-r, --resume [id]')
        .hideHelp()
        .argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .option('-C, --continue', t('cli.opt.continue'), false)
    .option('-y, --yolo', t('cli.opt.yolo'), false)
    .option('--auto', t('cli.opt.auto'), false)
    .addOption(
      new Option(
        '-m, --model <model>',
        t('cli.opt.model'),
      ),
    )
    .addOption(
      new Option(
        '-p, --prompt <prompt>',
        t('cli.opt.prompt'),
      ),
    )
    .addOption(
      new Option(
        '--output-format <format>',
        t('cli.opt.output_format'),
      ).choices(['text', 'stream-json']),
    )
    .addOption(
      new Option(
        '--skills-dir <dir>',
        t('cli.opt.skills_dir'),
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(new Option('--yes').hideHelp().default(false))
    .addOption(new Option('--auto-approve').hideHelp().default(false))
    .option('--plan', t('cli.opt.plan'), false)
    .option('--wolfpack', t('cli.opt.wolfpack'), false);

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
    .description(t('cli.line.description'))
    .action(() => {
      onLine('run');
    });
  lineCmd
    .command('run')
    .description(t('cli.line.cmd_run'))
    .action(() => {
      onLine('run');
    });
  lineCmd
    .command('start')
    .description(t('cli.line.cmd_start'))
    .action(() => {
      onLine('start');
    });
  lineCmd
    .command('stop')
    .description(t('cli.line.cmd_stop'))
    .action(() => {
      onLine('stop');
    });
  lineCmd
    .command('status')
    .description(t('cli.line.cmd_status'))
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
