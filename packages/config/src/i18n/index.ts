import { zh } from './locale/zh';
import { en } from './locale/en';
import type { Locale } from './locale/types';

export type { Locale } from './locale/types';

const dictionaries: Record<Locale, Record<string, string>> = { zh, en };

let currentLocale: Locale = 'zh';

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
