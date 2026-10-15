// Owned by the Frontend Developer. Sets `document.title` for the current page.
import { useEffect } from 'react';
import { BRAND } from '@lm/shared';

export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    const prev = document.title;
    document.title = title ? `${title} · ${BRAND.product}` : BRAND.product;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
