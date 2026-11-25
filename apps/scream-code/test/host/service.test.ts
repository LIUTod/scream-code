import { describe, expect, it } from 'vitest';

import {
  LAUNCHER_FORMAT,
  launcherEnv,
  parseLauncher,
  planLauncherRefresh,
  renderLaunchAgent,
  renderLauncher,
  renderSystemdUnit,
  serviceManagerFor,
} from '#/host/service';

const input = {
  node: '/Users/me/.nvm/versions/node/v24.1.0/bin/node',
  execArgv: [] as string[],
  entry: "/Users/me/lib/node_modules/scream-code/dist/main.mjs",
  home: "/Users/me/it's home/.scream-code",
  path: '/usr/local/bin:/usr/bin:/bin',
  log: '/Users/me/.scream-code/host/host.log',
};

describe('serviceManagerFor', () => {
  it('maps each platform to its per-user service manager', () => {
    expect(serviceManagerFor('darwin')).toBe('launchd');
    expect(serviceManagerFor('linux')).toBe('systemd');
    expect(serviceManagerFor('win32')).toBe('schtasks');
    expect(serviceManagerFor('aix')).toBeUndefined();
  });
});

describe('renderLauncher', () => {
  it('pins node, entry, home and PATH for a POSIX service, quoting every value', () => {
    const script = renderLauncher('launchd', input);
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain("PATH='/usr/local/bin:/usr/bin:/bin'");
    expect(script).toContain("SCREAM_CODE_HOME='/Users/me/it'\\''s home/.scream-code'");
    expect(script).toContain('SCREAM_CODE_HOST_SERVICE=1');
    // "$@": `scream-host.sh check` runs the check; no arguments runs the host.
    expect(script).toContain(
      `exec '/Users/me/.nvm/versions/node/v24.1.0/bin/node' '/Users/me/lib/node_modules/scream-code/dist/main.mjs' host "$@" >> '/Users/me/.scream-code/host/host.log' 2>&1`,
    );
    expect(script).toContain(`scream-launcher-format ${String(LAUNCHER_FORMAT)}`);
  });

  it('carries the network settings it was given, each exported', () => {
    const script = renderLauncher('launchd', { ...input, env: { NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem' } });
    expect(script).toContain("NODE_EXTRA_CA_CERTS='/etc/corp-ca.pem'\nexport NODE_EXTRA_CA_CERTS");
  });

  it('writes a cmd launcher with CRLF line ends on Windows', () => {
    const script = renderLauncher('schtasks', {
      ...input,
      node: 'C:\\Program Files\\nodejs\\node.exe',
      entry: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\scream-code\\dist\\main.mjs',
      home: 'C:\\Users\\me\\.scream-code',
      log: 'C:\\Users\\me\\.scream-code\\host\\host.log',
    });
    expect(script.split('\r\n')[0]).toBe('@echo off');
    expect(script).toContain('set "SCREAM_CODE_HOME=C:\\Users\\me\\.scream-code"');
    expect(script).toContain(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\scream-code\\dist\\main.mjs" host %* >> "C:\\Users\\me\\.scream-code\\host\\host.log" 2>&1',
    );
  });
});

describe('service definitions', () => {
  it('restarts the host after a crash but not after a clean stop (macOS)', () => {
    const plist = renderLaunchAgent('dev.scream-code.host.abc', '/h/bin/scream-host.sh');
    expect(plist).toContain('<string>dev.scream-code.host.abc</string>');
    expect(plist).toContain('<string>/h/bin/scream-host.sh</string>');
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it('restarts the host on failure only, and quotes a launcher path with spaces (Linux)', () => {
    expect(renderSystemdUnit('/home/me/.scream-code/bin/scream-host.sh')).toContain(
      'ExecStart=/bin/sh /home/me/.scream-code/bin/scream-host.sh',
    );
    const unit = renderSystemdUnit('/home/me/my home/bin/scream-host.sh');
    expect(unit).toContain('ExecStart=/bin/sh "/home/me/my home/bin/scream-host.sh"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });
});

describe('Windows launcher encoding', () => {
  it('switches cmd.exe to UTF-8 before any path appears', async () => {
    const { renderLauncher } = await import('#/host/service');
    const script = renderLauncher('schtasks', {
      node: 'C:\\Program Files\\nodejs\\node.exe',
      execArgv: [],
      entry: 'C:\\Users\\张三\\scream\\bin.mjs',
      home: 'C:\\Users\\张三\\.scream-code',
      path: 'C:\\Windows',
      log: 'C:\\Users\\张三\\.scream-code\\host\\host.log',
    });
    const lines = script.split('\r\n');
    expect(lines[1]).toBe('chcp 65001 >nul');
    const firstPath = lines.findIndex((line) => line.includes('张三'));
    expect(firstPath).toBeGreaterThan(1);
  });
});

describe('launcherEnv', () => {
  it('passes on CA, proxy and locale settings, and never a proxy with a password in it', () => {
    expect(
      launcherEnv(
        {
          NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
          HTTPS_PROXY: 'http://proxy.corp:3128',
          HTTP_PROXY: 'http://me:secret@proxy.corp:3128',
          LANG: 'zh_CN.UTF-8',
          OPENAI_API_KEY: 'sk-never',
          NO_PROXY: '',
        },
        'darwin',
      ),
    ).toEqual({ NODE_EXTRA_CA_CERTS: '/etc/ca.pem', HTTPS_PROXY: 'http://proxy.corp:3128', LANG: 'zh_CN.UTF-8' });
  });

  it('uses one spelling on Windows, where the names are case-insensitive', () => {
    expect(launcherEnv({ HTTPS_PROXY: 'http://p:1', https_proxy: 'http://p:1' }, 'win32')).toEqual({
      HTTPS_PROXY: 'http://p:1',
    });
  });
});

describe('parseLauncher', () => {
  it('reads back what a POSIX launcher runs, quotes included', () => {
    const script = renderLauncher('launchd', { ...input, execArgv: ['--import', "/opt/it's/loader.mjs"] });
    expect(parseLauncher(script, 'launchd')).toEqual({
      format: LAUNCHER_FORMAT,
      node: input.node,
      execArgv: ['--import', "/opt/it's/loader.mjs"],
      entry: input.entry,
      path: input.path,
    });
  });

  it('reads back a Windows launcher', () => {
    const script = renderLauncher('schtasks', {
      ...input,
      node: 'C:\\nodejs\\node.exe',
      entry: 'C:\\scream\\main.mjs',
      path: 'C:\\Windows;C:\\100%\\bin',
    });
    expect(parseLauncher(script, 'schtasks')).toMatchObject({
      node: 'C:\\nodejs\\node.exe',
      entry: 'C:\\scream\\main.mjs',
      path: 'C:\\Windows;C:\\100%\\bin',
    });
  });

  it('reads a launcher written before the format mark as format 1', () => {
    const old = [
      '#!/bin/sh',
      "PATH='/usr/bin'",
      'export PATH',
      "exec '/usr/local/bin/node' '/opt/scream/main.mjs' host >> '/h/host.log' 2>&1",
      '',
    ].join('\n');
    expect(parseLauncher(old, 'launchd')).toEqual({
      format: 1,
      node: '/usr/local/bin/node',
      execArgv: [],
      entry: '/opt/scream/main.mjs',
      path: '/usr/bin',
    });
    expect(parseLauncher('echo hi', 'launchd')).toBeUndefined();
  });
});

describe('planLauncherRefresh', () => {
  const installed = renderLauncher('launchd', input);
  const everything = (): boolean => true;
  const nothing = (): boolean => false;

  it('keeps a working launcher, also when another scream is the one starting', () => {
    const other = { ...input, entry: '/elsewhere/scream/dist/main.mjs' };
    expect(planLauncherRefresh(installed, 'launchd', other, everything)).toEqual({ kind: 'keep' });
  });

  it('never points the service at a checkout run from its sources', () => {
    const source = { ...input, entry: '/Users/me/scream-code/apps/scream-code/src/main.ts' };
    expect(planLauncherRefresh(installed, 'launchd', source, nothing)).toEqual({ kind: 'keep' });
    expect(planLauncherRefresh(undefined, 'launchd', source, nothing)).toEqual({ kind: 'keep' });
  });

  it('repairs a launcher whose node or entry is gone, or that is missing, with the current install', () => {
    const current = { ...input, node: '/usr/local/bin/node' };
    expect(planLauncherRefresh(installed, 'launchd', current, nothing)).toEqual({ kind: 'write', input: current, reason: 'broken' });
    expect(planLauncherRefresh(undefined, 'launchd', current, everything)).toEqual({
      kind: 'write',
      input: current,
      reason: 'missing',
    });
  });

  it('brings an old launcher to the current format around what it already runs', () => {
    const old = "#!/bin/sh\nPATH='/opt/bin'\nexport PATH\nexec '/old/node' '/old/main.mjs' host >> '/h/host.log' 2>&1\n";
    const plan = planLauncherRefresh(old, 'launchd', { ...input, env: { LANG: 'C' } }, everything);
    expect(plan).toMatchObject({
      kind: 'write',
      reason: 'format',
      input: { node: '/old/node', entry: '/old/main.mjs', path: '/opt/bin', env: { LANG: 'C' } },
    });
  });
});
