// Release 1.2 — L1: the COD pack's illustrations, cropped from high-resolution renders of the pack into
// client/public/cod-pack/*.webp (white turned to transparency so they sit on a light plate in either theme; the two
// framed panels stay opaque). Sizes are the files' own, so the layout reserves the box before the image loads.
// Not public/learning/: a folder named like the /learning page would make the production server's static handler
// redirect /learning to /learning/ on a reload.
import type { LessonImage } from './types.ts';

const img = (name: string, width: number, height: number, alt: string, caption?: string): LessonImage => ({
  src: `/cod-pack/${name}.webp`,
  width,
  height,
  alt,
  caption,
});

export const IMAGES = {
  medal: img('medal', 360, 430, 'A gold medal with a star on red ribbons: the No. 1 Org COD pack.'),
  clipboard: img('checklist-clipboard', 360, 410, 'A clipboard with a pencil and a checklist, three items ticked and one still to do.'),
  trafficLight: img('traffic-light', 300, 704, 'A traffic light: red at the top, amber in the middle, green at the bottom.'),
  gumball: img('gumball-machine', 420, 741, 'A gumball machine full of blue gumballs with just three red ones among them.'),
  abcDays: img(
    'abc-days',
    760,
    172,
    'ABC days: three timelines. On A the three sales come at the start of the day, on B they are spread out, on C they all come at the end.',
    'A, B and C days: same three sales, different times of day.',
  ),
  bamboo: img(
    'bamboo-comic',
    900,
    640,
    'A six-panel comic. Day 1: a smiling person sows seeds from a packet beside a farmer with a pitchfork. Days 2 to 5: sun, time and water but nothing shows above ground; the person is thoughtful, confused, glum under an umbrella, then angry. Day 6: bamboo shoots up and the person jumps for joy.',
    'Days 1 to 5: sun, time and water, nothing to show. Day 6: the bamboo shoots up.',
  ),
  teachSimple: img('teachback-simple', 240, 284, 'A glowing light bulb.'),
  teachRules: img('teachback-rules', 240, 239, 'A green tick in a circle.'),
  teachNotes: img('teachback-notes', 300, 237, 'A spiral notebook full of handwriting next to a pen.'),
  battery: img('attitude-battery', 420, 468, 'Two batteries: one green and 80% full, one red and 20% full.'),
  muscle: img('attitude-muscle', 320, 332, 'A flexed arm showing a strong bicep.'),
  cylinder: img('bullet-cylinder', 520, 509, 'The cylinder of a revolver with six chambers, one for each objection.'),
  bullet: img('bullet', 280, 123, 'A single bullet.'),
  straightLine: img(
    'straight-line',
    1100,
    783,
    'Straight line theory: a wave runs through the middle between the friend zone at the top and the business zone at the bottom, both crossed out. Along the line are the letters I, SS, P, C and C.',
    'I, SS, P, C, C: introduction, short story, presentation, close and consolidation, kept between the two zones.',
  ),
} as const;
