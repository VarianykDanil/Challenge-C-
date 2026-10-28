// Owned by the Product Designer (copy reviewed with Marketing & Content). Copy for the public first page
// (`/` when signed out, always at `/welcome`). British English, confident and specific, no hype.
// Facts about the company are limited to what the business has told us or publishes itself: founded 2024,
// Deansgate office, campaign types, the careers line. No statistics are quoted anywhere on this page.
// Names, legal name and website come from BRAND in shared/src/constants.ts.
import type { Position } from '@lm/shared';

/** Icon names resolved to lucide-react icons in pages/Landing.tsx. */
export type LandingIcon =
  | 'Store'
  | 'Briefcase'
  | 'Home'
  | 'HeartHandshake'
  | 'Target'
  | 'Wallet'
  | 'Smartphone'
  | 'Gauge'
  | 'CalendarDays'
  | 'Trophy'
  | 'UserPlus'
  | 'GraduationCap'
  | 'Users'
  | 'PoundSterling'
  | 'ShieldCheck';

export interface LandingFeature { icon: LandingIcon; title: string; body: string }
export interface LandingSectionId { id: 'what-we-do' | 'how-we-work' | 'careers' | 'linear-hub'; label: string }

export const LANDING = {
  /** Anchor links in the top bar and footer, in page order. */
  nav: [
    { id: 'what-we-do', label: 'What we do' },
    { id: 'how-we-work', label: 'How we work' },
    { id: 'careers', label: 'Careers' },
    { id: 'linear-hub', label: 'Linear Hub' },
  ] satisfies LandingSectionId[],

  hero: {
    eyebrow: 'Face-to-face sales · Manchester',
    headline: 'Face-to-face sales, done properly.',
    subheadline:
      'Linear MCR runs outsourced face-to-face campaigns for brands and charities across Greater Manchester and the North West: private-site events, B2B, B2C residential and retail, and fundraising. Founded in 2024 and based on Deansgate, we measure every day the same way and pay every week.',
    primaryCta: 'Sign in',
    secondaryCta: 'See what we do',
    facts: [
      { label: 'Founded', value: '2024' },
      { label: 'Based', value: 'Deansgate, Manchester' },
      { label: 'Campaigns', value: 'B2B · B2C · Charity' },
      { label: 'Pay', value: 'Weekly' },
    ],
    previewLabel: 'Illustrative',
    previewCaption: 'A representative’s week in Linear Hub. Illustrative figures, not live data.',
  },

  whatWeDo: {
    eyebrow: 'What we do',
    title: 'Campaigns that need a conversation, not a click.',
    intro:
      'Clients bring us to the places their customers already are. Our representatives have the conversation, present properly and close on the day, so the client gains a customer who understood what they signed up to.',
    items: [
      {
        icon: 'Store',
        title: 'Private-site events',
        body: 'Stands in shopping centres, retail parks, stations and venues, agreed with the site in advance. Steady footfall, a full pitch and a result the client can audit.',
      },
      {
        icon: 'Briefcase',
        title: 'B2B',
        body: 'Visits to small and medium businesses, led by representatives who know the product and respect the owner’s time.',
      },
      {
        icon: 'Home',
        title: 'B2C residential and retail',
        body: 'Residential canvassing and in-store activity for consumer brands, with every stop logged so the client can see the territory being worked.',
      },
      {
        icon: 'HeartHandshake',
        title: 'Charity fundraising',
        body: 'Regular-giving campaigns for charities such as Breast Cancer Now, including Breast Cancer Awareness Month activity in October. Fundraising runs on trust, so our representatives are trained for it, not just briefed.',
      },
    ] satisfies LandingFeature[],
  },

  howWeWork: {
    eyebrow: 'How we work',
    title: 'Six numbers, logged every day.',
    intro:
      'Every representative on every event records the same six gauges, in funnel order. Each stage is a subset of the one before, so the numbers cannot drift and the ratios between them show exactly where a day went right or wrong.',
    gaugesHeading: 'The six gauges',
    lawOfAverages: {
      title: 'The law of averages',
      /** `{stopsPerSale}` and `{overall}` are filled in by the page from the company benchmarks. */
      body:
        'The company benchmark for each stage is the ratio a trained representative hits on an ordinary day. Hit all five and roughly one stop in {stopsPerSale} becomes a sale ({overall} overall). Fall short on one and the coaching conversation starts there, not with a hunch.',
      chipsLabel: 'Benchmarks, stage to stage',
    },
    pillars: [
      {
        icon: 'Target',
        title: 'Coaching on ratios, not opinions',
        body: 'Leaders see every representative’s stage-to-stage ratios against the benchmarks, graded on track, watch or below, so feedback is specific: more presentations, a cleaner close, a firmer ask.',
      },
      {
        icon: 'Wallet',
        title: 'Weekly pay you can see',
        body: 'Pay weeks run Monday to Sunday and are paid the following Friday. Every payslip is itemised against the pay plan, and every payday is tracked for punctuality.',
      },
      {
        icon: 'Smartphone',
        title: 'Logged where it happens',
        body: 'Gauges go in from a phone between stops, in under a minute, with the funnel rule enforced as you type.',
      },
    ] satisfies LandingFeature[],
  },

  careers: {
    eyebrow: 'Careers',
    /** Linear MCR’s own careers line — quoted verbatim. */
    quote: 'We don’t hire CVs. We develop people.',
    quoteAttribution: 'Linear MCR',
    intro:
      'Our roles are entry level by design. You need no sales experience to start, because the training is the job: product knowledge, the pitch, the gauges and the law of averages, taught in the field by someone who has done it. From there the ladder is the same for everyone, and progression is earned on results rather than time served.',
    ladderHeading: 'The progression ladder',
    /** Field positions in order; labels come from POSITION_LABELS. */
    ladder: ['trainee', 'field_rep', 'team_leader', 'crew_leader', 'assistant_owner', 'owner'] satisfies Position[],
    ladderNotes: {
      trainee: 'Learn the pitch and the gauges alongside a mentor.',
      field_rep: 'Run your own stops and own your ratios.',
      team_leader: 'Coach a small team and run its events.',
      crew_leader: 'Lead several teams across campaigns.',
      assistant_owner: 'Run the office side: recruitment, clients and pay.',
      owner: 'Lead the business and develop its next leaders.',
    } satisfies Partial<Record<Position, string>>,
    offersHeading: 'What you can expect',
    offers: [
      { icon: 'GraduationCap', title: 'Full training from day one', body: 'Product, pitch and the six gauges, taught in the field.' },
      { icon: 'Users', title: 'A mentor, not a manual', body: 'Someone who has done the job walks the first weeks with you.' },
      { icon: 'PoundSterling', title: 'Weekly pay, itemised', body: 'Paid the Friday after each week, with every line explained.' },
      { icon: 'Trophy', title: 'Progression on results', body: 'The same ladder for everyone, from trainee to owner.' },
    ] satisfies LandingFeature[],
    cta: 'Interested in joining? Visit our website',
  },

  hub: {
    eyebrow: 'Linear Hub',
    title: 'The platform behind the day.',
    intro:
      'Linear Hub is our own team platform. It puts the gauges, the people and the money in one place, built around the way Linear already works rather than asking the business to change.',
    features: [
      { icon: 'Gauge', title: 'Gauges in seconds', body: 'Six numbers in funnel order, validated as you type, from a phone between stops.' },
      { icon: 'Target', title: 'Ratios against the benchmarks', body: 'Every stage graded against the law of averages, for you and for your leader.' },
      { icon: 'CalendarDays', title: 'Events and check-ins', body: 'Where the team is working, when to be there and who arrived on time.' },
      { icon: 'Trophy', title: 'Leaderboard', body: 'Sales and conversion by week, month and quarter, by person and by team.' },
      { icon: 'UserPlus', title: 'Recruitment pipeline', body: 'Application to observation day to hire, with a representative account created the moment someone joins.' },
      { icon: 'Wallet', title: 'Pay and punctuality', body: 'Itemised payslips, tracked paydays and campaign payouts the office can reconcile.' },
    ] satisfies LandingFeature[],
    rolesHeading: 'One sign-in per person',
    rolesIntro: 'What you see depends on your role.',
    signInNote: 'Signing in needs your work email and employee ID. There is nothing to download.',
  },

  cta: {
    signedOut: {
      title: 'Already on the team? Sign in.',
      body: 'Use your work email and the employee ID from your welcome email. New starters receive theirs on observation day.',
      button: 'Sign in',
    },
    signedIn: {
      title: 'You are signed in.',
      body: 'This is the public page people see before signing in. Your dashboard is one click away.',
      button: 'Open dashboard',
    },
  },

  footer: {
    madeIn: 'Made in Manchester',
    /** Office address as the company writes it on its own site. */
    address: '1 North Parade, Deansgate, Manchester',
    websiteLabel: 'linear-mcr.co.uk',
    contactHeading: 'Find us',
    exploreHeading: 'Explore',
    signIn: 'Sign in',
    publicPage: 'Public page',
  },
} as const;
