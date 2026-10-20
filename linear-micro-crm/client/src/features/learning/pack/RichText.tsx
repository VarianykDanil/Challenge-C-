// Release 1.2 — L1: inline text of the COD pack lessons. `**bold**` marks the pack's own emphasis; nothing else is
// parsed (lesson content is typed data, never HTML).
import { Fragment } from 'react';

export function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.length > 4 && p.startsWith('**') && p.endsWith('**') ? (
          <strong key={i} className="font-semibold text-fg">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** Plain text of a rich string (for accessible names and search). */
export function plainText(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1');
}
