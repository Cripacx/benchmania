/**
 * Coloured monogram of an implementation's language (mapping in lib/languages.ts). Used by islands and,
 * rendered statically, by Astro pages. Decorative: the language is always named in text nearby.
 */
import { languageChip } from '../../lib/languages';

export function LangChip({ language }: { language: string | null | undefined }) {
  const chip = languageChip(language);
  return (
    <span
      class={`lang-chip${chip.known ? '' : ' is-neutral'}${chip.mono.length > 2 ? ' is-wide' : ''}`}
      style={{ '--chip-c': chip.bg, '--chip-t': chip.fg }}
      title={language ?? undefined}
      aria-hidden="true"
    >
      {chip.mono}
    </span>
  );
}
