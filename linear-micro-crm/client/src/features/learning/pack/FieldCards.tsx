// Release 1.2 — L1: "Field cards": the 5 steps and the six objections, each on one phone screen, for a quick look
// between stops. Opened from the Learning hub (`/learning?card=steps|objections` opens one directly).
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Footprints, ShieldQuestion } from 'lucide-react';
import { Modal, SegmentedControl } from '@/components/ui';
import { FIELD_OBJECTIONS, FIELD_STEPS } from '@/content/learning';

export type FieldCardKind = 'steps' | 'objections';

export interface FieldCardsProps {
  open: FieldCardKind | null;
  onChange: (kind: FieldCardKind | null) => void;
}

export function FieldCards({ open, onChange }: FieldCardsProps) {
  const kind = open ?? 'steps';
  // Focus lands on the card itself (not on the first segment, which may not be the chosen one).
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <Modal
      initialFocusRef={bodyRef}
      open={open !== null}
      onClose={() => onChange(null)}
      size="md"
      title="Field cards"
      description={kind === 'steps' ? 'The 5 steps to a conversation.' : 'Bullet theory: the six objections and your overturn.'}
      icon={kind === 'steps' ? <Footprints /> : <ShieldQuestion />}
    >
      <SegmentedControl<FieldCardKind>
        aria-label="Which card"
        fullWidth
        value={kind}
        onChange={(v) => onChange(v)}
        options={[
          { value: 'steps', label: '5 steps' },
          { value: 'objections', label: 'Objections' },
        ]}
      />
      <div ref={bodyRef} tabIndex={-1} className="outline-none">
      {kind === 'steps' ? (
        <ol className="mt-3 divide-y divide-border/70">
          {FIELD_STEPS.map((s, i) => (
            <li key={s.anchor}>
              <Link to={`/learning/pack/five-steps#${s.anchor}`} onClick={() => onChange(null)} className="focus-ring group flex items-start gap-3 rounded-lg px-1 py-2.5">
                <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-fg" aria-hidden>
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="font-display text-[15px] font-bold text-fg">{s.title}</span>
                    {s.time && <span className="text-xs tabular text-muted">{s.time}</span>}
                  </span>
                  <span className="block text-sm leading-snug text-muted">{s.line}</span>
                </span>
                <ChevronRight className="mt-1.5 h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-border/70">
            {FIELD_OBJECTIONS.map((o) => (
              <li key={o.anchor}>
                <Link to={`/learning/pack/bullet-theory#${o.anchor}`} onClick={() => onChange(null)} className="focus-ring group flex items-start gap-3 rounded-lg px-1 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block font-display text-[15px] font-extrabold uppercase tracking-tight text-danger">{o.title}</span>
                    <span className="block text-sm leading-snug text-fg">{o.line}</span>
                  </span>
                  <ChevronRight className="mt-1.5 h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 rounded-lg bg-surface-2/70 px-3 py-2 text-xs leading-relaxed text-muted">
            <strong className="text-fg">RRR:</strong> read, relax, relate. <strong className="text-fg">ABC:</strong> always be closing after every overturn; no dead air space.
          </p>
        </>
      )}
      </div>
    </Modal>
  );
}
