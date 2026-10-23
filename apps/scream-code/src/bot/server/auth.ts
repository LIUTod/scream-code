/**
 * Gateway guard.
 *
 * Localhost is trusted so `scream bot` works without a key. LAN mode requires
 * a bearer token (header or `?token=`); loopback stays exempt. This is the
 * minimal M0/M1 policy — no cookie sessions, no key file: the CLI passes the
 * token it generated.
 */
import { timingSafeEqual } from 'node:crypto';

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';

export interface AuthPolicy {
  readonly lan: boolean;
  readonly token: string | undefined;
}

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized.startsWith('127.')
  );
}

function remoteAddress(context: Context): string | undefined {
  try {
    return getConnInfo(context).remote.address;
  } catch {
    // Test clients (`app.request`) have no socket; treat as local.
    return undefined;
  }
}

function presentedToken(context: Context): string | undefined {
  const header = context.req.header('authorization');
  if (header !== undefined && header.toLowerCase().startsWith('bearer ')) {
    return header.slice('bearer '.length).trim();
  }
  const query = context.req.query('token');
  return query === undefined || query.length === 0 ? undefined : query;
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function unauthorized(message: string): ApiErrorBody {
  return { error: { code: 'unauthorized', message } };
}

export function createAuthGuard(policy: AuthPolicy): MiddlewareHandler {
  return async (context, next) => {
    const address = remoteAddress(context);
    // No socket (tests) or a genuine loopback peer: trusted.
    if (address === undefined || isLoopbackAddress(address)) return next();

    if (!policy.lan) {
      return context.json(unauthorized('Gateway is bound to localhost'), 403);
    }
    if (policy.token === undefined || policy.token.length === 0) {
      return context.json(unauthorized('LAN access requires a token'), 401);
    }
    if (!tokenMatches(presentedToken(context), policy.token)) {
      return context.json(unauthorized('Invalid gateway token'), 401);
    }
    return next();
  };
}

/** Machine-readable status for non-loopback callers (used by the CLI banner). */
export function describeAccess(policy: AuthPolicy): string {
  if (!policy.lan) return 'localhost only';
  return policy.token === undefined ? 'LAN (token required, none set)' : 'LAN (token required)';
}
