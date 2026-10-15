// Wrap interactive cells inside clickable DataTable rows so clicks and key presses on nested
// controls — and on dialogs they open (React events bubble through portals) — never fire the row action.
import type { HTMLAttributes, SyntheticEvent } from 'react';

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function StopRowEvents({ children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} onClick={stop} onKeyDown={stop} onKeyUp={stop}>
      {children}
    </div>
  );
}
