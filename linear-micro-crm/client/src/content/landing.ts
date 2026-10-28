// Owned by the Product Designer (copy reviewed with Marketing & Content). Copy for the public first page
// (`/` when signed out, always at `/welcome`). British English, confident and specific, no hype.
// Facts about the company are limited to what the business has told us or publishes itself: founded 2024,
// Deansgate office, campaign types, the careers line. No statistics are quoted anywhere on this page.
// This page is public: nothing about pay, commission or incentives, and nothing from the internal playbook (the six
// gauges, the benchmarks or the law of averages). content/landing.test.ts checks this.
// Names, legal name and website come from BRAND in shared/src/constants.ts.
/** Icon names resolved to lucide-react icons in pages/Landing.tsx. */
export type LandingIcon =
  | 'Store'
  | 'Briefcase'
  | 'Home'
  | 'HeartHandshake'
  | 'Target'
  | 'Smartphone'
  | 'CalendarDays'
  | 'Trophy'
  | 'UserPlus'
  | 'GraduationCap'
  | 'Users'
  | 'ShieldCheck';

export interface LandingFeature { icon: LandingIcon; title: string; body: string }
/** One level of the public career ladder: its focus, what you learn there and what it takes to move up. */
export interface LandingLadderLevel { title: string; focus: string; learn: readonly string[]; next: readonly string[] }
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
      'Linear MCR runs outsourced face-to-face campaigns for brands and charities across Greater Manchester and the North West: private-site events, B2B, B2C residential and retail, and fundraising. Founded in 2024 and based on Deansgate, we train every representative ourselves and promote from within.',
    primaryCta: 'Sign in',
    secondaryCta: 'See what we do',
    facts: [
      { label: 'Founded', value: '2024' },
      { label: 'Based', value: 'Deansgate, Manchester' },
      { label: 'Campaigns', value: 'B2B · B2C · Charity' },
      { label: 'Promotions', value: '100% internal' },
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
        body: 'Residential canvassing and in-store activity for consumer brands, with every visit planned so the client can see the territory being worked.',
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
    title: 'Trained properly. Coached in the field.',
    intro:
      'Every representative is trained before they speak for a client and keeps learning on the job, alongside someone who has done it. We plan every event with the client, turn up ready and represent their brand the way they would.',
    pillars: [
      {
        icon: 'GraduationCap',
        title: 'Trained, not just briefed',
        body: 'Product knowledge, the pitch and how to hold an honest conversation come first. Nobody represents a client until they are ready.',
      },
      {
        icon: 'Users',
        title: 'Learn it, then teach it back',
        body: 'Training is checked, not assumed: you learn a part of the pack, then teach it back to your leader in your own words.',
      },
      {
        icon: 'Target',
        title: 'Coaching from someone who has done it',
        body: 'Leaders work alongside their teams every day, so feedback is specific, practical and given on the spot.',
      },
      {
        icon: 'CalendarDays',
        title: 'Planned with the client',
        body: 'Every event is agreed with the client and the site in advance, staffed by a team that knows the campaign.',
      },
      {
        icon: 'ShieldCheck',
        title: 'Representing the brand properly',
        body: 'Smart, on time and honest. Customers should understand exactly what they are signing up to, every time.',
      },
      {
        icon: 'Smartphone',
        title: 'Organised on one platform',
        body: 'Events, training and the team’s day are kept in Linear Hub, our own platform, so nothing lives on scraps of paper.',
      },
    ] satisfies LandingFeature[],
  },

  careers: {
    eyebrow: 'Careers',
    /** Linear MCR’s own careers line — quoted verbatim. */
    quote: 'We don’t hire CVs. We develop people.',
    quoteAttribution: 'Linear MCR',
    intro:
      'Our roles are entry level by design. You need no sales experience to start, because the training is the job: product knowledge, the pitch and the fundamentals of a good conversation, taught in the field by someone who has done it. From there the ladder is the same for everyone, all the way to running your own office.',
    principlesHeading: 'Three core principles',
    /** From the training pack's core principles, without anything about pay. */
    principles: [
      {
        icon: 'UserPlus',
        title: '100% internal promotions',
        body: 'Everyone progresses from within. There are unlimited vacancies, so you never wait for someone above you to leave or be promoted.',
      },
      {
        icon: 'Users',
        title: 'No seniority',
        body: 'Progression is criteria based. It does not depend on age, gender, time served or being anyone’s favourite.',
      },
      {
        icon: 'Trophy',
        title: 'Performance decides',
        body: 'How far and how fast you go comes down to your own results, so you stay in control of your progression.',
      },
    ] satisfies LandingFeature[],
    ladderHeading: 'How you develop',
    ladderIntro: 'Eight levels, from your first day to overseeing several offices. Each one has a clear focus, what you learn there and what it takes to move up.',
    /** The training pack's career ladder (pre-management and post-management), public version: no pay, incentives or targets. */
    ladderPhases: [
      {
        title: 'Before management',
        levels: [
          {
            title: 'Entry level',
            focus: 'Master the basic fundamentals.',
            learn: ['The 5 steps to a conversation', 'The 8 working habits', 'The 6 impulse factors'],
            next: ['Consistent results', 'Learn and teach back the training pack'],
          },
          {
            title: 'Leadership',
            focus: 'Learn the 7 key areas of leadership.',
            learn: ['Field', 'Recruitment', 'Training', 'Atmosphere', 'Road trips', 'Networking', 'Development'],
            next: ['Teach and train 3 people from entry level to leadership', 'Show you can train different personalities'],
          },
          {
            title: 'Campaign Manager',
            focus: 'Manage the campaign.',
            learn: ['Run office trips', 'Oversee a medium-sized team'],
            next: ['A strong, consistent team'],
          },
          {
            title: 'Assistant Director',
            focus: 'Learn the back end of the business.',
            learn: ['HR', 'Recruitment', 'Client liaison', 'Design your own brand', 'Manage a team of 10–15'],
            next: ['A profitable team', 'You are ready'],
          },
        ],
      },
      {
        title: 'Management',
        levels: [
          {
            title: 'Senior Director',
            focus: 'Open and run your own office.',
            learn: ['Full control of operations', 'Choice of client, campaign and location', 'Morning and leaders’ meetings', 'Interviews'],
            next: ['Coach and mentor someone from entry level to opening their own office'],
          },
          {
            title: 'Promoting Owner',
            focus: 'Run your own office and oversee at least one other.',
            learn: ['Grow the offices you have mentored'],
            next: ['Coach and mentor 4 first-generation offices'],
          },
          {
            title: 'Regional Consultant',
            focus: 'Consult and oversee more than 4 separate offices.',
            learn: ['Support offices across a region'],
            next: ['Coach and mentor 7 first-generation offices'],
          },
          {
            title: 'National Consultant',
            focus: 'Oversee 7 offices.',
            learn: ['Lead the network nationally'],
            next: [],
          },
        ],
      },
    ],
    ladderLabels: { learn: 'What you learn', next: 'To move up' },
    offersHeading: 'What you can expect',
    offers: [
      { icon: 'GraduationCap', title: 'Full training from day one', body: 'The product, the pitch and the fundamentals, taught in the field.' },
      { icon: 'Users', title: 'A mentor, not a manual', body: 'Someone who has done the job walks the first weeks with you.' },
      { icon: 'UserPlus', title: 'No waiting for a vacancy', body: 'Every role is filled from within, and there is always room for the next leader.' },
      { icon: 'Trophy', title: 'Progression on results', body: 'The same ladder for everyone, from entry level to your own office.' },
    ] satisfies LandingFeature[],
    cta: 'Interested in joining? Visit our website',
  },

  hub: {
    eyebrow: 'Linear Hub',
    title: 'The platform behind the day.',
    intro:
      'Linear Hub is our own team platform. It keeps the team’s day, events, training and recruitment in one place, built around the way Linear already works rather than asking the business to change.',
    features: [
      { icon: 'Smartphone', title: 'The day in seconds', body: 'Each day goes in from a phone between visits, in under a minute.' },
      { icon: 'CalendarDays', title: 'Events and check-ins', body: 'Where the team is working, when to be there and who arrived on time.' },
      { icon: 'GraduationCap', title: 'Training and progress', body: 'The training pack, lessons and teach-backs, with a clear view of the next step up.' },
      { icon: 'Trophy', title: 'Leaderboard', body: 'Friendly competition by week, month and quarter, for people and for teams.' },
      { icon: 'UserPlus', title: 'Recruitment pipeline', body: 'From application to observation day to the first day in the field.' },
      { icon: 'Target', title: 'Coaching that is specific', body: 'Leaders see where each person is doing well and where to help next.' },
    ] satisfies LandingFeature[],
    safetyHeading: 'Private and secure',
    safetyIntro: 'Built for a team, with the office in control.',
    safety: [
      { icon: 'ShieldCheck', title: 'Two-step sign-in', body: 'Every account signs in with a code from an authenticator app as well as its own details.' },
      { icon: 'Users', title: 'Only what your role needs', body: 'Each person sees their own part of the business, and nothing more.' },
      { icon: 'Target', title: 'Every change recorded', body: 'Who changed what, and when, is kept in an audit trail the office can check.' },
      { icon: 'Smartphone', title: 'Nothing to install', body: 'It runs in the browser on any phone or laptop. Access is given by the office.' },
    ] satisfies LandingFeature[],
  },

  cta: {
    signedOut: {
      title: 'Already on the team? Sign in.',
      body: 'Use the sign-in details from your welcome email. New starters receive theirs on their first day.',
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
    rights: 'All rights reserved.',
  },
} as const;
