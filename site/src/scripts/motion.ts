/**
 * Entrance motion, once per page view. Runs only when the inline <head> script added .anim (JavaScript
 * available, no reduced-motion preference, not a back/forward navigation); otherwise the server-rendered
 * final state stays untouched.
 *
 * - [data-reveal] elements get .is-in when they enter the viewport (CSS fades and lifts them). With
 *   data-reveal="stagger" the children are staggered through --i.
 * - [data-grow] containers grow their .grow-bar elements from zero (CSS), staggered by the --i of the row.
 *   Numbers are never animated: they show their final value from the first frame they are visible.
 * - Every list finishes its entrance within about 800 ms whatever its length: each item takes 500 ms and the
 *   stagger is capped so that the last item starts within 300 ms.
 * - .is-done ends the entrance (CSS drops the animations), after it has played or as soon as the visitor
 *   focuses, clicks or changes something inside (sorting, filtering, switching the metric), so re-renders or
 *   display changes (a theme switch, resizing across a breakpoint) never replay it.
 * - If anything here fails, .anim is removed so the final state shows; .anim-ready is set only after every
 *   target is registered (the <head> script falls back to the final state after 3 s without it).
 */
const root = document.documentElement;
const ENTRANCE_MS = 500;
const MAX_STAGGER_MS = 40;
const LAST_START_MS = 300;

function finish(el: HTMLElement) {
  el.classList.add('is-in', 'is-done');
}

function play(el: HTMLElement) {
  if (el.classList.contains('is-done')) return;
  const stagger = el.dataset.reveal === 'stagger';
  if (stagger) Array.from(el.children).forEach((child, i) => (child as HTMLElement).style.setProperty('--i', String(i)));
  // The stagger runs over the staggered children or the rows that carry an --i index.
  const steps = stagger ? el.children.length : el.querySelectorAll('[style*="--i"]').length;
  const step = steps > 1 ? Math.min(MAX_STAGGER_MS, LAST_START_MS / (steps - 1)) : 0;
  el.style.setProperty('--stagger', `${step.toFixed(1)}ms`);
  el.classList.add('is-in');
  window.setTimeout(() => finish(el), ENTRANCE_MS + step * Math.max(0, steps - 1) + 50);
}

function fail(error: unknown) {
  root.classList.remove('anim', 'anim-ready');
  console.error('Entrance motion disabled:', error);
}

function start() {
  const io = new IntersectionObserver(
    (entries) => {
      try {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          play(e.target as HTMLElement);
        }
      } catch (error) {
        fail(error);
      }
    },
    { threshold: 0 },
  );
  document.querySelectorAll<HTMLElement>('[data-reveal], [data-grow]').forEach((el) => {
    // Interacting (or moving focus inside) ends the entrance at once, before an island re-renders, so bars
    // and numbers stay in step and a focused item is never half transparent.
    const end = () => finish(el);
    for (const type of ['click', 'change', 'input', 'focusin']) el.addEventListener(type, end, { capture: true, once: true });
    io.observe(el);
  });
  root.classList.add('anim-ready');
}

if (root.classList.contains('anim')) {
  try {
    start();
  } catch (error) {
    fail(error);
  }
}
