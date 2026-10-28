import chalk from 'chalk';

import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import type { SessionTip } from '../constant/scream-tui';

/**
 * Composes the idle tip line shown above the editor: the raw i18n text, with
 * an optional clickable domain for tips that carry a `url`.
 *
 * A tip whose text mentions its bare domain inline gets that domain wrapped as
 * an OSC 8 hyperlink (link color + underline) so it reads as a link against
 * the dimmed cue text. Clicking opens through the alt-screen openUrl callback;
 * Ctrl+F targets the same destination for terminals without mouse reporting.
 * Tips without a `url`, or whose text does not mention the domain, render
 * unchanged (e.g. the GitHub tip is keyboard-only and has no inline URL).
 */
export function composeTipLabel(raw: string, tip: SessionTip, linkColor: string): string {
  if (tip.url === undefined) return raw;
  const domain = tip.url.replace(/^https?:\/\//iu, '');
  if (!raw.includes(domain)) return raw;
  const link = toTerminalHyperlink(chalk.hex(linkColor).underline(domain), tip.url);
  return raw.replace(domain, link);
}

/** Index of the boot-default tip: the first ad that carries a url (the
 *  product's own placement). Falls back to `0` when no such tip exists. */
export function findOfferTipIndex(tips: readonly SessionTip[]): number {
  const index = tips.findIndex((tip) => tip.isAd && tip.url !== undefined);
  return index === -1 ? 0 : index;
}

/**
 * Rotation pick. `current === undefined` is the boot call and returns the
 * offer tip, so a fresh screen opens on the ad line. Every later pick is
 * uniform across the whole pool — ads included — excluding the tip currently
 * on screen, so consecutive rotations always change the line.
 */
export function pickTipIndex(tips: readonly SessionTip[], current: number | undefined): number {
  if (tips.length === 0) return 0;
  if (current === undefined) return findOfferTipIndex(tips);
  if (tips.length === 1) return 0;
  let next: number;
  do {
    next = Math.floor(Math.random() * tips.length);
  } while (next === current);
  return next;
}

