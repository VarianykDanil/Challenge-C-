// Release 1.2 — L1: renders a lesson's typed sections as real HTML (headings, lists, tables). Section ids are the
// anchors other pages link to (/learning/pack/bullet-theory#no-money); shared LESSON_ANCHORS must all exist.
import { Fragment } from 'react';
import { ArrowDown, ArrowRight, Info, KeyRound, Lightbulb, Quote } from 'lucide-react';
import clsx from 'clsx';
import type { LessonBlock, LessonCard, LessonSection } from '@/content/learning';
import { BulletChamber } from './BulletChamber';
import { CareerLadder } from './CareerLadder';
import { LessonFigure, LessonPlate } from './LessonFigure';
import { RichText } from './RichText';

const DOT = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', primary: 'bg-primary' } as const;

function BulletList({ items, ordered, className }: { items: string[]; ordered?: boolean; className?: string }) {
  if (ordered) {
    return (
      <ol className={clsx('space-y-1.5', className)}>
        {items.map((t, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="mt-px inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold tabular text-primary" aria-hidden>
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="sr-only">{i + 1}. </span>
              <RichText text={t} />
            </span>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ul className={clsx('space-y-1.5', className)}>
      {items.map((t, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" aria-hidden />
          <span className="min-w-0">
            <RichText text={t} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Card({ card }: { card: LessonCard }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-border bg-surface-2/40 p-4">
      {card.image && <LessonPlate image={card.image} size="xs" decorative className="mb-3 h-28" />}
      <h3 className="flex items-center gap-2 font-display text-[15px] font-bold leading-snug text-fg">
        {card.tone && <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', DOT[card.tone])} aria-hidden />}
        {card.title}
      </h3>
      {card.text && (
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          <RichText text={card.text} />
        </p>
      )}
      {card.items && <BulletList items={card.items} ordered={card.ordered} className="mt-2 text-sm leading-relaxed text-fg" />}
      {card.subitems && (
        <div className="mt-3 border-t border-border/70 pt-2">
          {card.subtitle && <div className="text-[11px] font-semibold uppercase tracking-wide text-accent">{card.subtitle}</div>}
          <BulletList items={card.subitems} className="mt-1 text-sm leading-relaxed text-fg" />
        </div>
      )}
    </div>
  );
}

const CALLOUT = {
  key: { icon: KeyRound, cls: 'border-primary/25 bg-primary-soft', iconCls: 'text-primary' },
  tip: { icon: Lightbulb, cls: 'border-info/25 bg-info-soft', iconCls: 'text-info' },
  note: { icon: Info, cls: 'border-warning/25 bg-warning-soft', iconCls: 'text-warning' },
} as const;

const COLS = { 2: 'sm:grid-cols-2', 3: 'md:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' } as const;

export function Block({ block }: { block: LessonBlock }) {
  switch (block.kind) {
    case 'p':
      return (
        <p className={clsx('leading-relaxed', block.tone === 'lead' ? 'text-[15px] font-medium text-fg' : block.tone === 'muted' ? 'text-sm text-muted' : 'text-[15px] text-fg')}>
          <RichText text={block.text} />
        </p>
      );
    case 'list':
      return <BulletList items={block.items} ordered={block.ordered} className="text-[15px] leading-relaxed text-fg" />;
    case 'definition':
      return (
        <p className="text-[15px] leading-relaxed text-fg">
          <span className="font-semibold italic text-accent">Definition: </span>
          <RichText text={block.text} />
        </p>
      );
    case 'quotes':
      return (
        <ul className="space-y-2">
          {block.items.map((q) => (
            <li key={q} className="flex items-start gap-2.5 rounded-lg border-l-[3px] border-primary/60 bg-surface-2/60 py-2 pl-3 pr-3 text-[15px] leading-relaxed text-fg">
              <Quote className="mt-1 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              <q className="min-w-0 [quotes:none]">
                <RichText text={q} />
              </q>
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[16rem] border-collapse text-left text-sm">
            {block.caption && <caption className="px-3 py-2 text-left text-xs text-muted">{block.caption}</caption>}
            <thead>
              <tr className="bg-surface-2">
                {block.columns.map((c) => (
                  <th key={c} scope="col" className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-fg">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-b border-border/60 last:border-0">
                  {row.map((cell, j) => (
                    <td key={j} className="px-3 py-2 align-top text-fg">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'callout': {
      const c = CALLOUT[block.tone];
      const Icon = c.icon;
      return (
        <div className={clsx('flex gap-3 rounded-xl border p-3.5', c.cls)}>
          <Icon className={clsx('mt-0.5 h-4 w-4 shrink-0', c.iconCls)} aria-hidden />
          <div className="min-w-0 text-sm leading-relaxed text-fg">
            {block.title && <div className="font-semibold">{block.title}</div>}
            <div className={clsx(block.title && 'mt-0.5')}>
              <RichText text={block.text} />
            </div>
          </div>
        </div>
      );
    }
    case 'figure':
      return <LessonFigure image={block.image} size={block.size ?? 'md'} />;
    case 'media':
      return (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:items-start">
          <LessonFigure image={block.image} size="md" className="mx-auto w-full max-w-[11rem] sm:mx-0" />
          <div className="min-w-0 space-y-3">
            {block.blocks.map((b, i) => (
              <Block key={i} block={b} />
            ))}
          </div>
        </div>
      );
    case 'acronym':
      return (
        <div>
          <dl className="inline-grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
            {block.letters.map((l, i) => (
              <Fragment key={`${l.letter}${i}`}>
                <dt className={clsx('flex h-8 w-8 items-center justify-center rounded-lg font-display text-base font-extrabold', l.struck ? 'bg-surface-2 text-muted line-through' : 'bg-danger-soft text-danger')}>
                  {l.letter}
                </dt>
                <dd className={clsx('text-[15px]', l.struck ? 'text-muted line-through' : 'text-fg')}>
                  {l.word}
                  {l.struck && <span className="sr-only"> (crossed out)</span>}
                </dd>
              </Fragment>
            ))}
          </dl>
          {block.note && <p className="mt-2 text-xs text-muted">{block.note}</p>}
        </div>
      );
    case 'flow':
      return (
        <ol className="grid gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-stretch">
          {block.steps.map((s, i) => (
            <Fragment key={s.title}>
              {i > 0 && (
                <li aria-hidden className="flex items-center justify-center text-subtle">
                  <ArrowDown className="h-5 w-5 md:hidden" />
                  <ArrowRight className="hidden h-5 w-5 md:block" />
                </li>
              )}
              <li className="min-w-0 rounded-xl border border-border bg-surface-2/40 p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-danger">{s.title}</h3>
                <BulletList items={s.items} className="mt-2 text-sm leading-relaxed text-fg" />
              </li>
            </Fragment>
          ))}
        </ol>
      );
    case 'cards':
      return (
        <div className={clsx('grid gap-3', COLS[block.columns ?? 3])}>
          {block.items.map((c) => (
            <Card key={c.title} card={c} />
          ))}
        </div>
      );
    case 'lines':
      return (
        <dl className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border">
          {block.rows.map((r) => (
            <div key={r.cue} className="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
              <dt className="w-20 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">{r.cue}</dt>
              <dd className="text-[15px] font-medium text-fg">“{r.say}”</dd>
            </div>
          ))}
        </dl>
      );
    case 'bullet-chamber':
      return <BulletChamber />;
    case 'career-ladder':
      return <CareerLadder />;
    default:
      return null;
  }
}

export function LessonSections({ sections }: { sections: LessonSection[] }) {
  return (
    <div className="space-y-8">
      {sections.map((s, i) => (
        <section key={s.id ?? i} id={s.id} className="scroll-mt-24" aria-labelledby={s.title ? `${s.id ?? `section-${i}`}-title` : undefined}>
          {s.title && (
            <h2 id={`${s.id ?? `section-${i}`}-title`} className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-display text-lg font-bold tracking-tight text-fg">
              {s.title}
              {s.meta && <span className="font-sans text-xs font-medium tracking-normal text-muted">{s.meta}</span>}
            </h2>
          )}
          <div className="space-y-4">
            {s.blocks.map((b, j) => (
              <Block key={j} block={b} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
