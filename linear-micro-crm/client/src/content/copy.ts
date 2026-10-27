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
      description: 'The story behind the platform, what it tracks and how it was built.',
    },
    // Release 1.2 (r2-foundation): the new pages' titles; each page's owner may reword its own entry.
    learning: {
      title: 'Learning',
      description: 'The COD pack and your campaign pitches: learn it, practise it, teach it back.',
    },
    audit: {
      title: 'Audit trail',
      description: 'Who changed what and when, across pay, gauges, people and settings.',
    },
    bulkGauges: {
      title: 'Bulk entry',
      description: "Log the whole team's gauges for one event in one go, or paste them from WhatsApp.",
    },
    // Release 1.3 (r3-foundation): the new pages' titles. Packages put the rest of their copy in their own files and do
    // not edit this one (the lead may reword an entry).
    venues: {
      title: 'Venues',
      description: 'Every venue the team has worked, with the numbers that show what a good day there takes.',
    },
    statements: {
      title: 'Statements',
      description: "The clients' commission statements: what each charity confirmed, and the corrections to pay.",
    },
    interviewSchedule: {
      title: 'Interview schedule',
      description: 'Every interview by day, with the interviewer and the candidate.',
    },
    interviewSheet: {
      title: 'Interview',
      description: "The questions asked and the candidate's answers, in the interviewer's words.",
    },
    learningVideo: {
      title: 'Video',
      description: 'Recorded interviews and talks to watch as part of learning.',
    },
    campaignPage: {
      title: 'Campaign',
      description: "The client's brief, their updates and announcements, and how the campaign is going.",
    },
    clientPortal: {
      title: 'Updates',
      description: 'Post an update, an announcement or a commission change for the Linear MCR team.',
    },
    clientSecurity: {
      title: 'Security',
      description: 'Your sign-in PIN and two-step verification.',
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
  /** Settings → Security and the second sign-in step (two-step verification). */
  security: {
    title: 'Security',
    description: 'How you prove it is you when you sign in.',
    twoFactor: {
      title: 'Two-step verification',
      description: 'Add a 6-digit code from an authenticator app each time you sign in, so an email and employee ID alone are never enough.',
      on: 'On',
      off: 'Off',
      setUp: 'Set up',
      turnOff: 'Turn off',
      newCodes: 'New recovery codes',
      offHint: 'Right now anyone with your email and employee ID could sign in as you. Turn this on to add a second step.',
      pendingHint: 'You started setting this up but did not finish. Set up again to get a fresh code.',
      lowCodesHint: 'You are running low on recovery codes. Generate a new set before you need one.',
      apps: 'Works with Google Authenticator, Microsoft Authenticator, 1Password and Authy.',
      /** Release 1.4 (package S): two-step verification is required for every account but the demo sign-in ones. */
      required: 'Required',
      staff: {
        description: 'A 6-digit code from an authenticator app each time you sign in, so an email and employee ID alone are never enough.',
        offHint: 'Right now anyone with your email and employee ID could sign in as you. Turn this on to add a second step.',
        requiredHint: 'Required for every account, so it stays on. Lost your phone? Sign in with a recovery code, or ask an administrator to reset it.',
      },
      client: {
        description: 'A 6-digit code from an authenticator app each time you sign in, after your email, access code and PIN.',
        offHint: 'Right now your email, access code and PIN are enough to sign in. Turn this on to add a second step.',
        requiredHint: 'Required for client accounts, so it stays on. Lost your phone? Sign in with a recovery code, or ask Linear MCR to reset it.',
      },
    },
    setup: {
      title: 'Set up two-step verification',
      steps: ['Scan', 'Verify', 'Save codes'],
      scanTitle: 'Scan this code with your authenticator app',
      scanBody: 'Open the app, choose “Add account” or the plus button, then point your camera at the code.',
      manualTitle: 'Can’t scan? Enter this key instead',
      manualBody: 'Choose “Enter a setup key” in your app. Account name: Linear Hub. Type: time based.',
      openInApp: 'Open in authenticator app',
      copyKey: 'Copy key',
      verifyTitle: 'Enter the 6-digit code from your app',
      verifyBody: 'This checks the app is set up correctly before we turn it on.',
      turnOn: 'Turn on',
      codesTitle: 'Save your recovery codes',
      codesBody: 'If you lose your phone, a recovery code lets you sign in. Each one works once.',
      enabledToast: 'Two-step verification is on',
      enabledToastBody: 'From now on you will need a code from your app to sign in. Other devices have been signed out.',
    },
    recovery: {
      warning: 'Keep these somewhere safe — each code works once and we cannot show them again.',
      copyAll: 'Copy all',
      download: 'Download .txt',
      saved: 'I have saved these codes',
      done: 'Done',
      copied: 'Recovery codes copied',
      regenerateTitle: 'New recovery codes',
      regenerateBody: 'Enter the code from your authenticator app to generate a fresh set. Your old codes will stop working.',
      regenerate: 'Generate new codes',
      regeneratedToast: 'New recovery codes ready',
    },
    disable: {
      title: 'Turn off two-step verification',
      body: 'You will sign in with just your email and employee ID again. Enter the code from your app to confirm.',
      bodyRecovery: 'You will sign in with just your email and employee ID again. Enter one of your recovery codes to confirm.',
      confirm: 'Turn off',
      toast: 'Two-step verification is off',
      toastBody: 'You can turn it on again at any time from Settings.',
    },
    login: {
      heading: 'Enter your verification code',
      body: 'Enter the 6-digit code from your authenticator app.',
      bodyRecovery: 'Enter one of the recovery codes you saved when you set this up.',
      signingInAs: 'Signing in as',
      codeLabel: 'Verification code',
      codeHint: 'Six digits, from your authenticator app.',
      recoveryLabel: 'Recovery code',
      recoveryHint: 'Recovery codes look like xxxx-xxxx. Each works once.',
      useRecovery: 'Use a recovery code instead',
      useApp: 'Use your authenticator app instead',
      verify: 'Verify',
      /** The only way back on the two-step step (the header's "Back" to the public page shows on step one only). */
      back: 'Back to email and employee ID',
      /** Release 1.4: a client account signs in with an access code. */
      backClient: 'Back to email and access code',
      expired: 'That sign-in attempt expired. Enter your details again to get a new code.',
      invalid: 'That code is not valid. Check your app and try again.',
      tooMany: 'Too many attempts. Wait a few minutes before trying again.',
    },
    admin: {
      title: 'Two-step verification',
      body: 'Reset this if they have lost their phone. They are signed out everywhere and set it up again, with a new code, when they next sign in.',
      reset: 'Reset two-step verification',
      confirmTitle: 'Reset two-step verification?',
      confirmBody: 'will be signed out of every device and will set up two-step verification again, with a new authenticator code, when they next sign in.',
      toast: 'Two-step verification reset',
      notSetUp: 'Not set up',
    },
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
