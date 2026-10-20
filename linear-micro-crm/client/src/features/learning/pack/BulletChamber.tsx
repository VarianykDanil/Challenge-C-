// Release 1.2 — L1: bullet theory's cylinder (COD pack page 15) rebuilt as HTML: the pack's cylinder illustration in
// the middle, the six objections around it in the pack's layout, each a link to its overturn further down the lesson.
import clsx from 'clsx';
import { BULLET_OBJECTIONS, IMAGES } from '@/content/learning';
import { LessonPlate } from './LessonFigure';

const CELL: Record<(typeof BULLET_OBJECTIONS)[number]['position'], string> = {
  'top-left': 'col-start-1 row-start-1 justify-self-end self-end',
  top: 'col-start-2 row-start-1 justify-self-center self-end',
  'top-right': 'col-start-3 row-start-1 justify-self-start self-end',
  'bottom-left': 'col-start-1 row-start-3 justify-self-end self-start',
  bottom: 'col-start-2 row-start-3 justify-self-center self-start',
  'bottom-right': 'col-start-3 row-start-3 justify-self-start self-start',
};

export function BulletChamber({ className }: { className?: string }) {
  return (
    <nav aria-label="The six objections" className={clsx('my-2', className)}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] grid-rows-[auto_auto_auto] items-center gap-x-1 gap-y-2 sm:gap-x-4">
        <LessonPlate image={IMAGES.cylinder} size="sm" decorative className="col-start-2 row-start-2 h-28 w-28 min-[400px]:h-36 min-[400px]:w-36 sm:h-44 sm:w-44" plateClassName="rounded-full !p-2" />
        {BULLET_OBJECTIONS.map((o) => (
          <a
            key={o.id}
            href={`#${o.id}`}
            className={clsx(
              'focus-ring inline-flex min-h-10 max-w-full items-center justify-center rounded-lg px-1.5 py-1.5 text-center font-display text-xs font-extrabold uppercase leading-tight tracking-tight text-danger transition-colors [overflow-wrap:anywhere] hover:bg-danger-soft min-[400px]:px-2.5 min-[400px]:text-sm sm:text-base',
              CELL[o.position],
            )}
          >
            {o.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
