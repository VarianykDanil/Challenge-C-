// True while a CSS media query matches (false where matchMedia is missing). Used where what is shown, or its order,
// changes with the screen: DataTable shows cards on a phone, and the pitch flashcards put the card first there, so the
// reading and focus order follow what is on screen instead of a CSS `order`.
import { useCallback, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}
