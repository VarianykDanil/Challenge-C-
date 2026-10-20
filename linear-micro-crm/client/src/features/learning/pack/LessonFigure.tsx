// Release 1.2 — L1: one COD pack illustration on a light "plate". The art is transparent (white turned to alpha when it
// was cropped), so it sits on the card surface in light mode and on a light plate in dark mode, where black line art
// would otherwise disappear. The caption sits outside the plate so it keeps the theme's text colours.
import clsx from 'clsx';
import type { LessonImage } from '@/content/learning';

const MAX_H = { xs: 'max-h-24', sm: 'max-h-40', md: 'max-h-72', lg: 'max-h-[34rem]' } as const;

export interface LessonFigureProps {
  image: LessonImage;
  size?: keyof typeof MAX_H;
  /** Decorative use (a card thumbnail): empty alt, no caption. */
  decorative?: boolean;
  /** Load straight away (the lesson's cover); everything else is lazy. */
  eager?: boolean;
  className?: string;
  plateClassName?: string;
}

export function LessonPlate({ image, size = 'md', decorative, eager, className, plateClassName }: LessonFigureProps) {
  return (
    <div className={clsx('flex items-center justify-center rounded-xl border border-border bg-surface p-3 dark:border-transparent dark:bg-ink-fg', plateClassName, className)}>
      <img
        src={image.src}
        alt={decorative ? '' : image.alt}
        width={image.width}
        height={image.height}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className={clsx('h-auto w-auto max-w-full object-contain', MAX_H[size])}
      />
    </div>
  );
}

export function LessonFigure({ image, size = 'md', className, eager }: LessonFigureProps) {
  return (
    <figure className={clsx('min-w-0', className)}>
      <LessonPlate image={image} size={size} eager={eager} />
      {image.caption && <figcaption className="mt-2 text-center text-xs leading-relaxed text-muted">{image.caption}</figcaption>}
    </figure>
  );
}
