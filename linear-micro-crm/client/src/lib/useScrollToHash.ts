// Release 1.4 (review fix): a link like /team/10#bank-details or /settings#payments lands on its card even when the card
// mounts after its data or lazy chunk has loaded (the browser's own jump to the anchor happens before that and
// misses). Once per navigation, and never against the person: scrolling away afterwards is left alone.
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

/** Scrolls the element with this `id` into view when the address's hash names it, once `ready` (its content shown). */
export function useScrollToHash(id: string, ready: boolean): void {
  const location = useLocation();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || location.hash !== `#${id}` || done.current === location.key) return;
    const key = location.key;
    let settle: number | undefined;
    // after this render's layout, so the card is in place
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      done.current = key;
      el.scrollIntoView({ block: 'start' });
      const at = window.scrollY;
      // cards above it may still be loading and push it down: land on it again, unless the person scrolled since
      settle = window.setTimeout(() => {
        if (Math.abs(window.scrollY - at) < 2) document.getElementById(id)?.scrollIntoView({ block: 'start' });
      }, 600);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (settle !== undefined) window.clearTimeout(settle);
    };
  }, [id, ready, location.hash, location.key]);
}
