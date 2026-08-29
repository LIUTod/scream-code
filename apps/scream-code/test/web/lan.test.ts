import type { NetworkInterfaceInfo } from 'node:os';

import { describe, expect, it } from 'vitest';

import { getLanAddresses } from '#/web/lan';

function iface(
  entries: ReadonlyArray<{ address: string; family: string; internal?: boolean }>,
): readonly NetworkInterfaceInfo[] {
  return entries.map((entry) => ({ internal: false, ...entry })) as unknown as readonly NetworkInterfaceInfo[];
}

describe('getLanAddresses', () => {
  it('keeps reachable IPv4 addresses and filters loopback/IPv6/link-local/CGNAT', () => {
    const mock: Record<string, readonly NetworkInterfaceInfo[]> = {
      lo: iface([{ address: '127.0.0.1', family: 'IPv4', internal: true }]),
      en0: iface([
        { address: '192.168.1.5', family: 'IPv4' },
        { address: 'fe80::1', family: 'IPv6' },
      ]),
      utun: iface([{ address: '100.79.12.3', family: 'IPv4' }]),
      ap: iface([{ address: '169.254.10.2', family: 'IPv4' }]),
      direct: iface([{ address: '203.0.113.7', family: 'IPv4' }]),
    };
    expect(getLanAddresses(mock)).toEqual(['192.168.1.5', '203.0.113.7']);
  });

  it('covers the full CGNAT range (100.64.0.0/10) and private boundaries', () => {
    const mock: Record<string, readonly NetworkInterfaceInfo[]> = {
      a: iface([{ address: '100.127.255.254', family: 'IPv4' }]),
      b: iface([{ address: '100.64.0.1', family: 'IPv4' }]),
      c: iface([{ address: '100.63.255.254', family: 'IPv4' }]),
      d: iface([{ address: '172.31.255.254', family: 'IPv4' }]),
      e: iface([{ address: '10.0.0.1', family: 'IPv4' }]),
    };
    expect(getLanAddresses(mock)).toEqual(['100.63.255.254', '172.31.255.254', '10.0.0.1']);
  });

  it('deduplicates across interfaces and returns [] when nothing matches', () => {
    const mock: Record<string, readonly NetworkInterfaceInfo[]> = {
      en0: iface([{ address: '192.168.1.5', family: 'IPv4' }]),
      en1: iface([{ address: '192.168.1.5', family: 'IPv4' }]),
      lo: iface([{ address: '127.0.0.1', family: 'IPv4', internal: true }]),
    };
    expect(getLanAddresses(mock)).toEqual(['192.168.1.5']);
    expect(getLanAddresses({})).toEqual([]);
  });
});
