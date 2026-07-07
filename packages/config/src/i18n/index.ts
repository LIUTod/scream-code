import { zh } from './locale/zh';
import { en } from './locale/en';
import type { Locale } from './locale/types';

export type { Locale } from './locale/types';

const dictionaries: Record<Locale, Record<string, string>> = { zh, en };

function detectSystemLocale(): Locale {
  // 1. Unix/macOS: standard locale environment variables
  const env = process.env;
  const envLang = (env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE || '').toLowerCase();
  if (envLang.startsWith('zh')) return 'zh';
  if (envLang.length > 0) return 'en';

  // 2. Cross-platform: Intl API (works on Windows, macOS, Linux)
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale.toLowerCase().startsWith('zh')) return 'zh';
  } catch {
    // Intl not available — fall through
  }

  // 3. Windows: check process.env.LANG set by some Node distributions
  if (process.platform === 'win32') {
    const winLang = (env.LANG || '').toLowerCase();
    if (winLang.startsWith('zh')) return 'zh';
  }

  return 'en';
}

let currentLocale: Locale = detectSystemLocale();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (dictionaries[locale]) {
    currentLocale = locale;
  }
}

export function t(key: string, params?: Record<string, string | number>): string {
  let text = dictionaries[currentLocale][key] ?? dictionaries.zh[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
