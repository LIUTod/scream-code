import type { Component } from '@liutod-scream/pi-tui';
import { resetCapabilitiesCache, setCapabilities } from '@liutod-scream/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseReadMediaOutput,
  readMediaChip,
  readMediaSummary,
} from '#/tui/components/messages/tool-renderers/media';
import { darkColors } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function joinRender(components: Component[], width = 100): string {
  return components.flatMap((c) => c.render(width)).join('\n');
}

function call(name: string, args: Record<string, unknown> = {}): ToolCallBlockData {
  return { id: 'tc', name, args };
}

function result(output: string, isError = false): ToolResultBlockData {
  return { tool_call_id: 'tc', output, is_error: isError };
}

const ctx = { expanded: false, colors: darkColors };
const expandedCtx = { expanded: true, colors: darkColors };

// 1x1 transparent png base64 (≈70 bytes once decoded)
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

function imageOutput(path: string, b64 = PNG_B64, mime = 'image/png'): string {
  return JSON.stringify([
    { type: 'text', text: `<image path="${path}">` },
    { type: 'image_url', imageUrl: { url: `data:${mime};base64,${b64}` } },
    { type: 'text', text: '</image>' },
    { type: 'text', text: `Loaded image file "${path}" (${mime}, 70 bytes, original size 1x1px).` },
  ]);
}

function videoOutput(path: string, mime = 'video/mp4'): string {
  return JSON.stringify([
    { type: 'text', text: `<video path="${path}">` },
    { type: 'video_url', videoUrl: { url: `data:${mime};base64,YWJj` } },
    { type: 'text', text: '</video>' },
  ]);
}

describe('parseReadMediaOutput', () => {
  it('extracts kind, path, mime type, and bytes from an image data URL', () => {
    const m = parseReadMediaOutput(imageOutput('/tmp/a.png'));
    expect(m).not.toBeNull();
    expect(m?.kind).toBe('image');
    expect(m?.path).toBe('/tmp/a.png');
    expect(m?.mimeType).toBe('image/png');
    expect(m?.bytes).toBeGreaterThan(0);
    expect(m?.base64).toBe(PNG_B64);
    expect(m?.originalSize).toBe('1x1px');
  });

  it('extracts video kind and mime', () => {
    const m = parseReadMediaOutput(videoOutput('/tmp/a.mp4'));
    expect(m?.kind).toBe('video');
    expect(m?.mimeType).toBe('video/mp4');
  });

  it('captures non-data video URL when uploader was used', () => {
    const out = JSON.stringify([
      { type: 'text', text: `<video path="/tmp/a.mp4">` },
      { type: 'video_url', videoUrl: { url: 'https://cdn.example/v/abc' } },
      { type: 'text', text: '</video>' },
    ]);
    const m = parseReadMediaOutput(out);
    expect(m?.kind).toBe('video');
    expect(m?.url).toBe('https://cdn.example/v/abc');
    expect(m?.bytes).toBeUndefined();
  });

  it('returns null for non-JSON output', () => {
    expect(parseReadMediaOutput('not json')).toBeNull();
  });

  it('returns null when no media part is present', () => {
    expect(parseReadMediaOutput(JSON.stringify([{ type: 'text', text: 'hi' }]))).toBeNull();
  });
});

describe('readMediaChip', () => {
  it('returns a compact summary for an image', () => {
    const text = strip(readMediaChip(call('ReadMediaFile'), result(imageOutput('/tmp/a.png'))));
    expect(text).toMatch(/image/);
    expect(text).toContain('image/png');
    expect(text).toMatch(/B|KB|MB/);
  });

  it('returns empty string on error so the truncated body shows the error', () => {
    expect(readMediaChip(call('ReadMediaFile'), result('boom', true))).toBe('');
  });

  it('returns empty string when output is unparseable', () => {
    expect(readMediaChip(call('ReadMediaFile'), result('garbage'))).toBe('');
  });
});

describe('readMediaSummary renderer', () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  it('renders an empty body when collapsed on terminals without image protocol', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const out = joinRender(
      readMediaSummary(call('ReadMediaFile'), result(imageOutput('/tmp/a.png')), ctx),
    );
    expect(out.trim()).toBe('');
  });

  it('renders the inline image even when collapsed on kitty-capable terminals', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const components = readMediaSummary(
      call('ReadMediaFile'),
      result(imageOutput('/tmp/a.png')),
      ctx,
    );
    const renders = components.map((c) => c.render(100).join('\n'));
    const hasImage = renders.some((r) => r.includes('\x1b_G'));
    expect(hasImage).toBe(true);
    // Path/meta text is suppressed when collapsed (chip carries it)
    expect(renders.join('\n')).not.toContain('/tmp/a.png');
  });

  it('renders path + meta line when expanded — never the base64 blob', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const out = strip(
      joinRender(
        readMediaSummary(call('ReadMediaFile'), result(imageOutput('/tmp/a.png')), expandedCtx),
      ),
    );
    expect(out).toContain('/tmp/a.png');
    expect(out).toContain('image/png');
    // Crucially: the base64 must never reach the screen.
    expect(out).not.toContain(PNG_B64);
    expect(out).not.toContain(PNG_DATA_URL);
  });

  it('renders an inline image component on kitty-capable terminals when expanded', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const components = readMediaSummary(
      call('ReadMediaFile'),
      result(imageOutput('/tmp/a.png')),
      expandedCtx,
    );
    // At least one component carries the kitty graphics escape — that is
    // the inline image. The base64 travels inside the escape, which is
    // correct: it is image data, not human-readable text.
    const renders = components.map((c) => c.render(100).join('\n'));
    const hasImage = renders.some((r) => r.includes('\x1b_G'));
    expect(hasImage).toBe(true);
    // The data-URL prefix must never leak as readable text.
    expect(renders.join('\n')).not.toContain(PNG_DATA_URL);
  });

  it('falls back to a placeholder text on terminals without image protocol', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const components = readMediaSummary(
      call('ReadMediaFile'),
      result(imageOutput('/tmp/a.png')),
      expandedCtx,
    );
    const out = strip(joinRender(components));
    // No kitty graphics escape emitted.
    expect(out).not.toContain('\x1b_G');
    // A readable image label is shown instead.
    expect(out).toContain('image/png');
  });

  it('falls back to truncated renderer for errors', () => {
    const out = strip(
      joinRender(
        readMediaSummary(
          call('ReadMediaFile', { path: '/tmp/x.png' }),
          result('File not found', true),
          ctx,
        ),
      ),
    );
    expect(out).toContain('File not found');
  });

  it('falls back to truncated renderer when the output is not the media envelope', () => {
    const out = strip(
      joinRender(
        readMediaSummary(call('ReadMediaFile'), result('"some plain string output"'), ctx),
      ),
    );
    expect(out).toContain('some plain string output');
  });
});
