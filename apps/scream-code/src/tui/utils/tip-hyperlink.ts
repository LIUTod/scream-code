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

/** Probability that a rotation lands on the offer tip (the first ad with a
 *  url — the product's own placement). Repeats are allowed on this branch,
 *  which is what keeps the on-screen share at the full 80%: the line simply
 *  stays put across rotations while the roll keeps favoring it. The 20%
 *  remainder picks uniformly from every tip except the currently visible one,
 *  so non-ad rotations always change the line. */
export const OFFER_TIP_PROBABILITY = 0.8;

/**
 * Weighted rotation pick: `OFFER_TIP_PROBABILITY` of the rolls select the
 * offer tip (regardless of what is currently shown — a re-pick keeps the ad
 * line up), everything else picks uniformly excluding the current tip.
 */
export function pickTipIndex(tips: readonly SessionTip[], current: number | undefined): number {
  if (tips.length <= 1) return Math.max(0, current ?? 0);
  const offerIndex = tips.findIndex((tip) => tip.isAd && tip.url !== undefined);
  if (offerIndex !== -1 && Math.random() < OFFER_TIP_PROBABILITY) return offerIndex;
  let next: number;
  do {
    next = Math.floor(Math.random() * tips.length);
  } while (next === current);
  return next;
}

