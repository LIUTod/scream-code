/**
 * Covers: FetchURL document conversion path (PDF/Office → markdown).
 *
 * The provider must route convertible documents to the markit engine
 * instead of `response.text()` + Readability (binary garbage). Uses a
 * minimal hand-built PDF so no fixture files are needed.
 */

import { describe, expect, it, vi } from 'vitest';

import { LocalFetchURLProvider } from '../../src/tools/providers/local-fetch-url';

// Minimal one-page PDF with a 24pt title (heading) and 12pt body lines.
function makeTestPdf(): Uint8Array {
  const esc = (s: string): string => s.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const lines = ['Quarterly Report 2026', '', 'Revenue grew 25 percent year over year.', 'The engineering team shipped 14 features.'];
  let stream = `BT /F1 24 Tf 72 720 Td (${esc(lines[0]!)}) Tj ET\n`;
  let y = 680;
  for (const line of lines.slice(1)) {
    stream += `BT /F1 12 Tf 72 ${String(y)} Td (${esc(line)}) Tj ET\n`;
    y -= 20;
  }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}endstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [i, body] of objs.entries()) {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${String(objs.length + 1)}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objs.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function providerWithPdf(pdfBytes: Uint8Array, contentType = 'application/pdf'): LocalFetchURLProvider {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(pdfBytes, {
      status: 200,
      headers: { 'Content-Type': contentType, 'Content-Length': String(pdfBytes.byteLength) },
    }),
  );
  return new LocalFetchURLProvider({ fetchImpl, allowPrivateAddresses: true });
}

describe('LocalFetchURLProvider — document conversion', () => {
  it('converts a PDF response to markdown with heading structure', async () => {
    const provider = providerWithPdf(makeTestPdf());
    const result = await provider.fetch('https://example.com/report.pdf');

    expect(result.kind).toBe('extracted');
    expect(result.content).toContain('# Quarterly Report 2026');
    expect(result.content).toContain('Revenue grew 25 percent year over year.');
  }, 60_000);

  it('detects a document by URL extension when Content-Type is octet-stream', async () => {
    const provider = providerWithPdf(makeTestPdf(), 'application/octet-stream');
    const result = await provider.fetch('https://example.com/files/report.pdf');

    expect(result.kind).toBe('extracted');
    expect(result.content).toContain('# Quarterly Report 2026');
  }, 60_000);

  it('does not take the document path for .pdf-looking query strings', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<html><body><article>plain article text</article></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl, allowPrivateAddresses: true });
    const result = await provider.fetch('https://example.com/search?q=report.pdf');

    expect(result.kind).toBe('extracted');
    expect(result.content).toContain('plain article text');
  });

  it('throws a descriptive error when conversion fails on corrupt bytes', async () => {
    const provider = providerWithPdf(new TextEncoder().encode('%PDF-1.4 corrupted garbage'));
    await expect(provider.fetch('https://example.com/broken.pdf')).rejects.toThrow(
      /Document conversion failed/,
    );
  }, 60_000);
});

describe('LocalFetchURLProvider — document fallback behavior', () => {
  it('falls back to HTML extraction when a .pdf URL serves an HTML page', async () => {
    const html = '<html><body><article>viewer page content</article></body></html>';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl, allowPrivateAddresses: true });
    const result = await provider.fetch('https://example.com/view/report.pdf');

    expect(result.kind).toBe('extracted');
    expect(result.content).toContain('viewer page content');
  });

  it('falls back to HTML extraction when extension-guessed bytes are not a document', async () => {
    const html = '<html><body><article>not actually a pdf</article></body></html>';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(html, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl, allowPrivateAddresses: true });
    const result = await provider.fetch('https://example.com/files/report.pdf');

    expect(result.kind).toBe('extracted');
    expect(result.content).toContain('not actually a pdf');
  }, 60_000);

  it('hard-errors on corrupt bytes when Content-Type declares a document', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new TextEncoder().encode('not a real pdf'), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl, allowPrivateAddresses: true });
    await expect(provider.fetch('https://example.com/anything')).rejects.toThrow(/Document conversion failed/);
  }, 60_000);
});
