#!/usr/bin/env node
/**
 * Patches @earendil-works/pi-tui's tui.js to add fixedBottomLineCount support.
 * This pins the editor + footer to the bottom of the terminal.
 *
 * Safe to run multiple times — skips if already patched.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const MARKER = 'this.fixedBottomLineCount';

const CONSTRUCTOR_OLD = `    constructor(terminal, showHardwareCursor) {
        super();
        this.terminal = terminal;`;

const CONSTRUCTOR_NEW = `    constructor(terminal, showHardwareCursor) {
        super();
        this.fixedBottomLineCount = 0;
        this.terminal = terminal;`;

const RENDER_OLD = `        let newLines = this.render(width);
        // Composite overlays`;

const RENDER_NEW = `        let newLines = this.render(width);
        // Fixed-bottom region: pin the last N lines (editor + footer) and apply
        // viewport scrolling only to the remaining top portion.
        if (this.fixedBottomLineCount > 0) {
            const bottomCount = Math.min(this.fixedBottomLineCount, height);
            const topCount = height - bottomCount;
            if (topCount > 0) {
                const topLines = newLines.length > bottomCount ? newLines.slice(0, -bottomCount) : [];
                const bottomLines = newLines.slice(-bottomCount);
                const topStart = Math.max(0, topLines.length - topCount);
                const visibleTop = topLines.slice(topStart, topStart + topCount);
                while (visibleTop.length < topCount) visibleTop.push("");
                newLines = [...visibleTop, ...bottomLines];
            }
        }
        // Composite overlays`;

export function patchPiTui() {
  let tuiPath;
  try {
    const require = createRequire(import.meta.url);
    tuiPath = require.resolve('@earendil-works/pi-tui/dist/tui.js');
  } catch {
    // pi-tui not found — likely a dev install where pnpm handles patches.
    return;
  }

  let src = readFileSync(tuiPath, 'utf8');

  // Already patched?
  if (src.includes(MARKER)) return;

  src = src.replace(CONSTRUCTOR_OLD, CONSTRUCTOR_NEW);
  src = src.replace(RENDER_OLD, RENDER_NEW);

  if (!src.includes(MARKER)) {
    // Patch targets not found — pi-tui version may have changed.
    console.warn('[scream-code] warning: could not patch pi-tui (structure changed?)');
    return;
  }

  writeFileSync(tuiPath, src, 'utf8');
}
