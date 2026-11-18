/**
 * Rows glide to their new position when the order changes (FLIP with the Web Animations API, so no
 * style attribute is shared with Preact). Rows are the elements with data-flip="<key>" inside the
 * container; new rows fade in.
 *
 * "First" is measured in the render phase, before Preact touches the DOM, with getBoundingClientRect()
 * relative to the container, so it is where the rows are on screen right now (including a glide that is
 * still running). The layout effect cancels this hook's running animations, measures the new layout and
 * animates from the difference. No positions are kept across renders. Nothing moves for viewers who
 * prefer reduced motion.
 */
import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

function canAnimate(): boolean {
  return (
    typeof window !== 'undefined' &&
    'animate' in Element.prototype &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function positions(container: HTMLElement): Map<string, number> {
  const top = container.getBoundingClientRect().top;
  const out = new Map<string, number>();
  container.querySelectorAll<HTMLElement>('[data-flip]').forEach((row) => {
    out.set(row.dataset.flip ?? '', row.getBoundingClientRect().top - top);
  });
  return out;
}

export function useFlip(container: RefObject<HTMLElement | null>, order: string) {
  const shown = useRef<string | null>(null); // the order on screen (not a position)
  const running = useRef<Animation[]>([]);
  // Render phase: measure only when the order is about to change.
  const before = shown.current !== null && shown.current !== order && container.current && canAnimate() ? positions(container.current) : null;

  useLayoutEffect(() => {
    shown.current = order;
    const el = container.current;
    if (!el || !before) return;
    running.current.forEach((a) => a.cancel());
    running.current = [];
    const after = positions(el);
    el.querySelectorAll<HTMLElement>('[data-flip]').forEach((row) => {
      const key = row.dataset.flip ?? '';
      const was = before.get(key);
      const now = after.get(key) ?? 0;
      if (was === undefined) {
        running.current.push(row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' }));
      } else if (Math.abs(was - now) > 0.5) {
        running.current.push(
          row.animate([{ transform: `translateY(${was - now}px)` }, { transform: 'none' }], {
            duration: 420,
            easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
          }),
        );
      }
    });
  }, [order]);
}
