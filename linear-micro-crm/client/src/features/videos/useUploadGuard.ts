// Release 1.3 — P5 learning-videos: while a video uploads, leaving the page asks first instead of cancelling the
// upload without a word (a 2 GB file over a hotspot can take an hour).
//  - Closing the tab, reloading or typing another address: the browser's own "Leave site?" (beforeunload).
//  - Back (the browser's button, a phone's swipe): while the upload runs, a copy of this page's history entry sits on
//    top, so Back stays on the page and `onBack` asks "Stop the upload?" (the copy goes back on top each time). The
//    app uses a BrowserRouter, which has no useBlocker; the copy carries the same URL and router state, so the router
//    sees no change of page.
// When the upload ends: `replaceNext()` is true while the copy is on top (navigate with { replace: true } over it after
// a successful upload); `drop()` takes the copy off (cancelled or refused); `leave()` stops guarding and goes back
// past the page, as the Back that was asked about meant to.
import { useCallback, useEffect, useRef } from 'react';

const MARK = 'lmUploadGuard';

const copyOnTop = (): boolean => {
  const s: unknown = window.history.state;
  return !!s && typeof s === 'object' && (s as Record<string, unknown>)[MARK] === true;
};

export interface UploadGuard {
  /** The upload's copy of this page is the current history entry (navigate over it with replace). */
  replaceNext(): boolean;
  /** Takes the copy off (an upload that was cancelled or refused). */
  drop(): void;
  /** Stops guarding and goes back past this page (Stop the upload, after Back). */
  leave(): void;
}

export function useUploadGuard(active: boolean, onBack: () => void): UploadGuard {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const guarding = useRef(false);

  useEffect(() => {
    if (!active) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!guarding.current) return; // Stop the upload, then leave(): no second question
      e.preventDefault();
      e.returnValue = '';
    };
    const pushCopy = () => {
      const state: unknown = window.history.state;
      window.history.pushState({ ...(state && typeof state === 'object' ? state : {}), [MARK]: true }, '', window.location.href);
    };
    const onPop = () => {
      if (!guarding.current || copyOnTop()) return;
      // Back took the copy off: put it back, and ask
      pushCopy();
      onBackRef.current();
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('popstate', onPop);
    if (!copyOnTop()) pushCopy();
    guarding.current = true;
    return () => {
      guarding.current = false;
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('popstate', onPop);
    };
  }, [active]);

  const replaceNext = useCallback(() => copyOnTop(), []);
  const drop = useCallback(() => {
    guarding.current = false;
    if (copyOnTop()) window.history.back();
  }, []);
  const leave = useCallback(() => {
    guarding.current = false;
    window.history.go(copyOnTop() ? -2 : -1);
  }, []);
  return { replaceNext, drop, leave };
}
