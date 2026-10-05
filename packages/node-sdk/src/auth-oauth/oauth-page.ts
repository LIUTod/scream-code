/**
 * Minimal HTML pages shown in the browser at the end of loopback OAuth flows.
 * No external assets; adapts to light/dark color schemes.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(title: string, tone: 'success' | 'error', body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: Canvas; color: CanvasText;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    max-width: 30rem; padding: 2rem 2.5rem; border-radius: 0.75rem;
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    text-align: center;
  }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { margin: 0.5rem 0 0; color: color-mix(in srgb, CanvasText 75%, transparent); }
  .badge { font-size: 2rem; line-height: 1; }
</style>
</head>
<body>
<main>
<div class="badge">${tone === 'success' ? '&#10003;' : '&#9888;'}</div>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
  return page('Success', 'success', `<p>${escapeHtml(message)}</p>`);
}

export function oauthErrorHtml(title: string, detail?: string): string {
  const detailHtml =
    detail === undefined || detail.length === 0 ? '' : `<p>${escapeHtml(detail)}</p>`;
  return page(title, 'error', detailHtml);
}
