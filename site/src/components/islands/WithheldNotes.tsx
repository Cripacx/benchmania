/**
 * Why a derived value is missing, as visible lines next to the ranking or table that shows "no index" (the lines come
 * from withheldLines in lib/model.ts). Renders nothing when nothing is withheld. Usable in islands and, rendered on
 * the server, in .astro components.
 */
import { Icon } from './Icon';

export function WithheldNotes({ lines, class: className }: { lines: string[]; class?: string }) {
  if (!lines.length) return null;
  return (
    <div class={`withheld-notes${className ? ` ${className}` : ''}`} role="note">
      {lines.map((line) => (
        <p key={line}>
          <Icon name="info" size={14} />
          <span>{line}</span>
        </p>
      ))}
    </div>
  );
}
