/**
 * LAN address enumeration for `scream web --lan`.
 *
 * Collects IPv4 addresses that LAN peers can actually reach. Excludes the
 * loopback interface, IPv6 (the first version targets IPv4 LANs), link-local
 * autoconfiguration (169.254.0.0/16) and carrier-grade NAT space
 * (100.64.0.0/10, where inbound routing is not possible). Addresses outside
 * the private ranges are kept — a machine with a directly routed public IPv4
 * is reachable as-is.
 */

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export function getLanAddresses(
  interfaces: Record<string, readonly NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): string[] {
  const seen = new Set<string>();
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const ip = info.address;
      if (inCidr(ip, '169.254.0.0', 16)) continue; // link-local
      if (inCidr(ip, '100.64.0.0', 10)) continue; // carrier-grade NAT
      // RFC 2544 benchmark block: surfaced by macOS utun interfaces, not a
      // reachable LAN address.
      if (inCidr(ip, '198.18.0.0', 15)) continue;
      seen.add(ip);
    }
  }
  return [...seen];
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (bits <= 0) return true;
  if (bits >= 32) return ipInt === baseInt;
  // Bitwise ops coerce to int32; comparing both sides against the same mask
  // keeps the equality correct without unsigned conversion.
  const mask = 0xffffffff << (32 - bits);
  return (ipInt & mask) === (baseInt & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value;
}
