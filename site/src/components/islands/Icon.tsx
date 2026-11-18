import { ICONS, type IconName } from '../../lib/icons';

interface Props {
  name: IconName;
  size?: number;
  class?: string;
  strokeWidth?: number;
}

/** Decorative icon for islands; meaning is always carried by adjacent text. */
export function Icon({ name, size = 16, class: className, strokeWidth = 1.75 }: Props) {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
