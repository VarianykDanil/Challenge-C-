// Owned by the Frontend Developer. Sets `document.title` for the current page.
// Smart release 1.1 (p5): `setTitleBadge(n)` prefixes the unread Needs-attention count, so a background tab reads
// "(2) Dashboard · Linear Hub". The page part and the badge are kept apart, so either can change without the other.
import { useEffect } from 'react';
import { BRAND } from '@lm/shared';

let pageTitle: string = typeof document === 'undefined' ? BRAND.product : document.title || BRAND.product;
let badge = 0;

function render(): void {
  if (typeof document === 'undefined') return;
  document.title = badge > 0 ? `(${badge > 99 ? '99+' : badge}) ${pageTitle}` : pageTitle;
}

/** Shows `n` unread items in front of the tab title; 0 (or less) removes the badge. */
export function setTitleBadge(n: number): void {
  const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (next === badge) return;
  badge = next;
  render();
}

export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    const prev = pageTitle;
    pageTitle = title ? `${title} · ${BRAND.product}` : BRAND.product;
    render();
    return () => {
      pageTitle = prev;
      render();
    };
  }, [title]);
}
