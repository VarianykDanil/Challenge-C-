// Owned by Marketing & Content. All user-facing microcopy lives here. Keep existing keys.
import type { GaugeKey } from '@lm/shared';

export const COPY = {
  product: 'Linear Hub',
  tagline: 'Every stop counts.',
  login: {
    headline: 'Your day, in one place.',
    subheadline: 'Gauges, pay and progression for the Linear MCR team.',
    emailLabel: 'Work email',
    employeeIdLabel: 'Employee ID',
    submit: 'Sign in',
    demoTitle: 'Try a demo account',
    valueProps: [
      { title: 'Log gauges in seconds', body: 'Stops, table, presentations, closes, taps and sales — straight from the field.' },
      { title: 'Know your numbers', body: 'Live ratios against the law of averages, so coaching is specific.' },
      { title: 'Pay you can trust', body: 'Every payslip itemised, every payday tracked for punctuality.' },
    ],
  },

  /** Page titles and one-line descriptions for <PageHeader />, keyed by route name. */
  nav: {
    dashboard: {
      title: 'Dashboard',
      description: 'Your numbers for the week, what is coming up and what the office wants you to know.',
    },
    events: {
      title: 'Events',
      description: 'Where the team is working, when to be there and how each day is going.',
    },
    gauges: {
      title: 'Gauges',
      description: 'Stops to sales for every event — log your day, check your ratios, spot the stage to work on.',
    },
    leaderboard: {
      title: 'Leaderboard',
      description: 'Who is leading on sales and conversion this week, month and quarter.',
    },
    recruitment: {
      title: 'Recruitment',
      description: 'Every candidate from application to first day, with nothing slipping between the cracks.',
    },
    finance: {
      title: 'Finance',
      description: 'Pay, paydays and punctuality — itemised for you, summarised for the business.',
    },
    campaigns: {
      title: 'Campaigns',
      description: 'The clients you represent, what each sale pays and which campaigns are live.',
    },
    team: {
      title: 'Team',
      description: 'The people of Linear MCR — who they are, where they sit and how they are progressing.',
    },
    settings: {
      title: 'Settings',
      description: 'Your profile, appearance and sign-in details.',
    },
    about: {
      title: 'About Linear Hub',
      description: 'The story behind the platform, what it tracks and the squad who built it.',
    },
  },

  /** Empty-state copy for lists that have nothing to show yet. */
  empty: {
    events: {
      title: 'No events in this range',
      description: 'Nothing is scheduled for these dates. Leaders can create an event, or widen the date range to see more.',
    },
    gauges: {
      title: 'No gauges logged yet',
      description: 'When a day is done, log your stops through to sales and your ratios will appear here.',
    },
    candidates: {
      title: 'No candidates here',
      description: 'Add a candidate to start the pipeline, or clear the filters to see everyone.',
    },
    payroll: {
      title: 'No pay runs yet',
      description: 'Pay runs appear once a week has been worked and closed. Check back after your first payday.',
    },
    announcements: {
      title: 'Nothing new from the office',
      description: 'Announcements from leaders and the office will show here as soon as they are posted.',
    },
  },

  /** One plain-English sentence per gauge, in funnel order. */
  gaugeHelp: {
    stops: 'Every person you stopped and spoke to — the top of the funnel and the number that drives all the others.',
    table: 'Stops who came over to the table or stand to hear more.',
    presentations: 'Full pitches delivered, start to finish.',
    closes: 'Presentations where you asked for the sale.',
    taps: 'Closes where the customer tapped, signed or confirmed their details.',
    sales: 'Confirmed sales that count towards your commission and the campaign.',
  },

  /** Short lines for dashboards and loading screens. Rotate; never repeat two in a row. */
  motivation: [
    'The next stop is the only one you can control.',
    'Ratios do not lie. Work the stage that is behind.',
    'Twenty-six stops a sale. Count them, do not guess them.',
    'Early to the pitch, early to the table.',
    'A slow morning is data, not a verdict.',
    'Say the whole pitch. Every time.',
    'Ask for the sale. Then stop talking.',
    'Your average is built on the days you did not feel like it.',
    'Log it while it is fresh. Memory rounds down.',
    'Lead the day you want your team to copy.',
    'Small ratio, big difference: one more table in ten changes your week.',
    'Finish strong. The last hour counts the same as the first.',
  ],

  /** Greetings by time of day. Use `greetingFor()` to pick one for the current hour. */
  greetings: {
    morning: 'Good morning',
    afternoon: 'Good afternoon',
    evening: 'Good evening',
    night: 'Working late',
  },
} as const;

/** Typed handle on the gauge help text, in funnel order. */
export const GAUGE_HELP: Record<GaugeKey, string> = COPY.gaugeHelp;

export type TimeOfDay = keyof typeof COPY.greetings;

/** 05:00–11:59 morning · 12:00–17:59 afternoon · 18:00–21:59 evening · otherwise night. */
export function timeOfDay(date: Date = new Date()): TimeOfDay {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  if (h >= 18 && h < 22) return 'evening';
  return 'night';
}

/** Greeting for the current hour, optionally personalised: `greetingFor(now, 'Jordan')` → "Good morning, Jordan". */
export function greetingFor(date: Date = new Date(), firstName?: string | null): string {
  const base = COPY.greetings[timeOfDay(date)];
  return firstName ? `${base}, ${firstName}` : base;
}

/** A deterministic motivation line for a given day, so everyone sees the same one and it changes daily. */
export function motivationForDate(date: Date = new Date()): string {
  const dayIndex = Math.floor(date.getTime() / 86_400_000);
  return COPY.motivation[dayIndex % COPY.motivation.length]!;
}
