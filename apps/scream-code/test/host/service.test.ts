import { describe, expect, it } from 'vitest';

import { renderLaunchAgent, renderLauncher, renderSystemdUnit, serviceManagerFor } from '#/host/service';

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
    expect(script).toContain(
      "exec '/Users/me/.nvm/versions/node/v24.1.0/bin/node' '/Users/me/lib/node_modules/scream-code/dist/main.mjs' host >> '/Users/me/.scream-code/host/host.log' 2>&1",
    );
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
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\scream-code\\dist\\main.mjs" host >> "C:\\Users\\me\\.scream-code\\host\\host.log" 2>&1',
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
