import { Command, InvalidArgumentError, Option } from 'commander';
import { t } from '@scream-code/config';

import { CLI_COMMAND_NAME } from '#/constant/app';

import type { CLIOptions } from './options';
import { registerExportCommand } from './sub/export';
import { registerReportCommand } from './sub/report';
import { parseDurationMs } from './duration';

export type MainCommandHandler = (opts: CLIOptions) => void;
export type ServiceCommandHandler = (action: 'install' | 'uninstall' | 'status' | 'restart' | 'logs') => void;
export type PluginNodeRunnerHandler = (entry: string, args: readonly string[]) => void;

export type LineCommandHandler = (
  action: 'run' | 'start' | 'stop' | 'status' | 'restart' | 'pause',
  surface?: 'line' | 'host',
) => void;

export function createProgram(
  version: string,
  onMain: MainCommandHandler,
  onPluginNodeRunner: PluginNodeRunnerHandler = () => {},
  onLine: LineCommandHandler = () => {},
  onService: ServiceCommandHandler = () => {},
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
      new Option('--max-time <duration>', t('cli.opt.max_time')).argParser((value: string) => {
        const ms = parseDurationMs(value);
        if (ms === undefined) throw new InvalidArgumentError(t('cli.err.max_time_invalid', { value }));
        return ms;
      }),
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
  registerReportCommand(program);

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

  // `scream host` - the background host itself (the line daemon is the same
  // process; it also runs without a chat channel).
  const hostCmd = program
    .command('host')
    .description(t('cli.host.description'))
    .action(() => {
      onLine('run', 'host');
    });
  const hostActions = [
    ['run', t('cli.line.cmd_run')],
    ['start', t('cli.line.cmd_start')],
    ['stop', t('cli.line.cmd_stop')],
    ['status', t('cli.line.cmd_status')],
    ['restart', t('cli.line.cmd_restart')],
    ['pause', t('cli.host.cmd_pause')],
  ] as const;
  for (const [action, description] of hostActions) {
    hostCmd
      .command(action)
      .description(description)
      .action(() => {
        onLine(action, 'host');
      });
  }

  // `scream service` - install the background host as a per-user service.
  const serviceCmd = program
    .command('service')
    .description(t('cli.service.description'))
    .action(() => {
      onService('status');
    });
  const serviceActions = [
    ['install', t('cli.service.cmd_install')],
    ['uninstall', t('cli.service.cmd_uninstall')],
    ['status', t('cli.service.cmd_status')],
    ['restart', t('cli.service.cmd_restart')],
    ['logs', t('cli.service.cmd_logs')],
  ] as const;
  for (const [action, description] of serviceActions) {
    serviceCmd
      .command(action)
      .description(description)
      .action(() => {
        onService(action);
      });
  }

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
      maxTimeMs: raw['maxTime'] as number | undefined,
    };

    onMain(opts);
  });

  return program;
}
