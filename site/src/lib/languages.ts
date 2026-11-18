/**
 * Language identity chips: a small monogram in the language's recognisable colour, shown next to an
 * implementation wherever implementations are listed. The chip only repeats identity that the text
 * already carries (the implementation name or language label), so it is decorative for assistive
 * technology. Every pair below keeps the monogram at WCAG AA (4.5:1) against its own chip colour.
 *
 * A language the site has never seen gets a neutral, theme-aware chip with a derived monogram.
 */

export interface LanguageChip {
  /** One to three characters, e.g. "Rs", "C#", "TS". */
  mono: string;
  /** CSS colours (hex for known languages, theme tokens for the fallback). */
  bg: string;
  fg: string;
  /** False for the neutral fallback. */
  known: boolean;
}

interface KnownLanguage {
  mono: string;
  bg: string;
  fg: string;
}

// Contrast of fg on bg (WCAG): Rust 8.6, Go 6.9, TypeScript 5.0, C# 7.9, Java 6.0, Python 5.1, PHP 4.8, Elixir 10.3.
const KNOWN: Record<string, KnownLanguage> = {
  rust: { mono: 'Rs', bg: '#dea584', fg: '#1d1209' },
  go: { mono: 'Go', bg: '#00add8', fg: '#04181e' },
  typescript: { mono: 'TS', bg: '#2f71bb', fg: '#ffffff' },
  'c#': { mono: 'C#', bg: '#512bd4', fg: '#ffffff' },
  java: { mono: 'Jv', bg: '#e76f00', fg: '#1d0e00' },
  python: { mono: 'Py', bg: '#3572a5', fg: '#ffffff' },
  php: { mono: 'php', bg: '#777bb4', fg: '#0d0e1c' },
  elixir: { mono: 'Ex', bg: '#4e2a8e', fg: '#ffffff' },
};

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  csharp: 'c#',
  'c sharp': 'c#',
  golang: 'go',
};

/** Monogram for a language without a known chip: "Kotlin" → "Ko", "Visual Basic" → "VB", "C++" → "C++". */
export function monogram(language: string): string {
  const name = language.trim();
  if (!name) return '?';
  if (name.length <= 3) return name;
  const words = name.split(/[\s._/-]+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
  const letters = name.replace(/[^\p{L}\p{N}#+]/gu, '');
  return (letters.charAt(0).toUpperCase() + letters.charAt(1).toLowerCase()) || '?';
}

export function languageChip(language: string | null | undefined): LanguageChip {
  const key = (language ?? '').trim().toLowerCase();
  const known = KNOWN[ALIASES[key] ?? key];
  if (known) return { ...known, known: true };
  const unknown = !key || key === 'unknown';
  return { mono: unknown ? '?' : monogram(language ?? ''), bg: 'var(--chip-bg)', fg: 'var(--chip-fg)', known: false };
}
