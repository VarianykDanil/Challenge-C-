// Copying text on phones over the office hotspot. Release 1.3.1: moved here from the week-in-review card so the
// Team page's sign-in details can use it too. The Clipboard API where the page is a secure context, otherwise (plain
// http over the hotspot) a hidden textarea + execCommand('copy'). False when both fail: show the text selected instead.

/** Copy through a hidden textarea and execCommand('copy'): works on plain http, where navigator.clipboard is missing. */
export function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const saved = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', ''); // no keyboard on phones
  ta.setAttribute('aria-hidden', 'true');
  // 16 px stops iOS zooming in; off-screen but still selectable
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '-9999px', width: '1px', height: '1px', opacity: '0', fontSize: '16px', border: '0', padding: '0' });
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari ignores select() alone
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
    if (saved && selection) {
      selection.removeAllRanges();
      selection.addRange(saved);
    }
    active?.focus?.({ preventScroll: true });
  }
  return ok;
}

/** navigator.clipboard.writeText when available (secure contexts), else the textarea fallback. True when copied. */
export async function copyText(text: string): Promise<boolean> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clip && typeof clip.writeText === 'function' && (typeof window === 'undefined' || window.isSecureContext !== false)) {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      // permission denied or not focused: fall through to the textarea
    }
  }
  return legacyCopy(text);
}
