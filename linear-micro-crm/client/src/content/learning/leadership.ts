// Release 1.2 — L1: COD pack lessons, the leadership block (pack pages 11, 13, 17–20) and the two practical tasks
// from the checklist ("Run an impact", "Go on a roadtrip"), which the pack lists but does not describe: those two say so
// and send the person to their leader, inventing no procedure. Wording follows the pack; obvious typos fixed
// (politcs → politics, compeition → competition, dependant → dependent, some → someone, liason → liaison,
// comission → commission). One deliberate change: the pack's dress code ("Ladies – … heels in the office. Men – …")
// is one rule for everyone, as UK guidance on equivalent dress codes for men and women expects. The app's own sentences
// write "teach-back"; the pack's names keep "teachback" (the lesson title, "3 rules of the teachback").
import { IMAGES } from './images.ts';
import type { LadderLevel, Lesson } from './types.ts';

/** The pack's career ladder: pre-management structure (page 18) and post-management (page 19). */
export const CAREER_LADDER: LadderLevel[] = [
  {
    level: 'entry',
    phase: 'pre',
    focus: 'Master the basic fundamentals',
    learn: ['LOA (law of averages)', '5 steps to a convo', '8 working habits', '6 impulse factors'],
    criteria: ['14 sales / week or 12 × 2 weeks in a row', 'Learn and teach back the COD pack'],
  },
  {
    level: 'leadership',
    phase: 'pre',
    focus: 'Learn the 7 key areas of leadership',
    learn: ['Field', 'Recruitment', 'Training', 'Atmosphere', 'Road trips', 'Networking', 'Development'],
    criteria: ['Teach & train 3 people to go from entry level to leadership', 'Prove you can train different personalities'],
  },
  {
    level: 'campaign_manager',
    phase: 'pre',
    focus: 'Manage the campaign',
    learn: ['Run office trips', 'Oversee a medium sized team', '10% team incentive'],
    criteria: ['4 + 1 or 3 + 2', 'Team generates 100 sales × 2 weeks in a row', 'Show consistency'],
  },
  {
    level: 'assistant_director',
    phase: 'pre',
    focus: 'Learn the backend of the business',
    learn: ['HR', 'Recruitment', 'Client liaison', 'Design your own brand', 'Manage team 10–15', 'Double commission', '20% team incentive'],
    criteria: ['Team is profitable', 'You’re ready'],
  },
  {
    level: 'senior_director',
    phase: 'post',
    focus: 'Open and run your own office',
    learn: ['Full control of operations', 'Choice of client, campaign & location', 'Morning meetings', 'Leaders meetings', 'Interviews'],
    criteria: ['Coach and mentor someone to go from entry level through to successfully opening up their own office'],
  },
  {
    level: 'promoting_owner',
    phase: 'post',
    focus: 'Run your own office and oversee at least one other',
    learn: ['4% G.I.R (growth incentive rebate) – paid by the client'],
    criteria: ['Coach and mentor 4 first generation offices', 'As a collective hit a £50,000 wire 4 weeks in a row'],
  },
  {
    level: 'regional_consultant',
    phase: 'post',
    focus: 'Consult and oversee over 4 separate offices',
    learn: ['6% G.I.R', 'Cartier watch incentive'],
    criteria: ['Coach and mentor 7 first generation offices', 'As a collective hit a £75,000 wire 8 weeks in a row'],
  },
  {
    level: 'national_consultant',
    phase: 'post',
    focus: 'Oversee 7 offices',
    learn: ['8% G.I.R', '7 streams of income', '£30,000 watch incentive'],
    criteria: [],
  },
];

export const CORE_PRINCIPLES: Lesson = {
  key: 'core-principles',
  title: '3 core principles',
  short: '3 core principles',
  checklist: ['3 core principles'],
  page: '17',
  summary: 'Three principles run the business: 100% internal promotions, no seniority, and everything comes down to performance.',
  keyPoints: [
    '100% internal promotions: everyone progresses organically.',
    'No seniority: everyone is on the same level playing field.',
    'Performance: progression and pay both come down to it.',
  ],
  sections: [
    {
      blocks: [
        {
          kind: 'cards',
          columns: 3,
          items: [
            {
              title: '100% internal promotions',
              text: 'We would never get a senior manager from a different industry to be a senior manager from our industry. For us everyone progresses organically.',
              subtitle: 'Benefits',
              subitems: [
                'More accountable coaching.',
                'Unlimited vacancies = don’t have to wait for someone above you to leave or get promoted for a vacancy to become available.',
              ],
            },
            {
              title: 'No seniority',
              text: 'Everyone is on the same level playing field, regardless of what position they’re at within the business.',
              subtitle: 'Benefits',
              subitems: [
                'More positive team environment.',
                'Less office politics.',
                'Progression is criteria based so it’s not dependent on age, gender, boss’s favourite etc.',
                'Creates friendly competition.',
              ],
            },
            {
              title: 'Performance',
              text: 'Everything comes down to performance: progression and pay.',
              subtitle: 'Benefits',
              subitems: ['Uncapped earnings.', 'Control over pay & progression.', 'Filters out the lazy people.'],
            },
          ],
        },
      ],
    },
  ],
  quiz: [
    { q: 'Which of these is one of the 3 core principles?', options: ['Seniority first', '100% internal promotions', 'Senior managers from other industries', 'Fixed pay'], answer: 1, why: '100% internal promotions, no seniority, performance.' },
    { q: 'What does “no seniority” create?', options: ['Office politics', 'Longer waits for promotion', 'Friendly competition', 'Capped earnings'], answer: 2, why: 'A more positive team environment, less office politics, criteria-based progression and friendly competition.' },
    { q: 'Everything comes down to…', options: ['Performance', 'Who you know', 'Time served', 'Age'], answer: 0, why: 'Everything comes down to performance: progression and pay.' },
  ],
  teachPrompt: 'Explain the three core principles and the benefit of each that matters most to you.',
  keywords: ['internal promotions', 'no seniority', 'performance', 'uncapped', 'principles'],
};

export const PROGRESSION_STRUCTURE: Lesson = {
  key: 'progression-structure',
  title: 'Pre- and post-management progression structure',
  short: 'Progression structure',
  checklist: ['Pre-management criteria', 'Post-management criteria'],
  page: '18–19',
  summary: 'The ladder from entry level to national consultant: what you learn at each level and the criteria to progress. Every step is criteria based.',
  keyPoints: [
    'Entry level → leadership: 14 sales a week or 12 two weeks in a row, and the COD pack learned and taught back.',
    'Leadership → campaign manager: teach and train 3 people from entry level to leadership.',
    'Campaign manager → assistant director: 4 + 1 or 3 + 2, and the team on 100 sales two weeks in a row.',
    'Post-management: open, run and then oversee offices.',
  ],
  sections: [
    {
      blocks: [
        { kind: 'career-ladder' },
        {
          kind: 'callout',
          tone: 'tip',
          title: 'Where are you?',
          text: 'The Progress page shows your level, the next one and how close you are, from your own gauges and lessons.',
        },
      ],
    },
  ],
  quiz: [
    {
      q: 'What does entry level need to progress?',
      options: ['A year in the job', '100 team sales', '14 sales a week or 12 two weeks in a row, and the COD pack learned and taught back', 'Running office trips'],
      answer: 2,
      why: '14 sales / week or 12 × 2 weeks in a row; learn and teach back the COD pack.',
    },
    {
      q: 'To go from leadership to campaign manager you…',
      options: ['Teach and train 3 people from entry level to leadership', 'Hit a £50,000 wire', 'Design your own brand', 'Make 14 sales'],
      answer: 0,
      why: 'Teach & train 3 people to go from entry level to leadership, and prove you can train different personalities.',
    },
    {
      q: 'Which level learns the backend of the business (HR, recruitment, client liaison)?',
      options: ['Leadership', 'Campaign manager', 'National consultant', 'Assistant director'],
      answer: 3,
      why: 'Assistant director: learn the backend of the business.',
    },
  ],
  teachPrompt: 'Walk through the ladder from entry level to senior director: what each level learns and what it takes to move up.',
  keywords: ['ladder', 'promotion', 'criteria', 'leadership', 'campaign manager', 'director', 'consultant', 'GIR', 'pre-management', 'post-management'],
};

export const DIRECT_INDIRECT: Lesson = {
  key: 'direct-indirect-marketing',
  title: 'Direct vs indirect marketing',
  short: 'Direct vs indirect',
  checklist: ['Direct vs indirect marketing'],
  page: '20',
  summary: 'Direct marketing: events, business to business, residential (door to door) and telesales. Indirect marketing: billboards, social media, newspapers, TV ads and radio.',
  keyPoints: ['Direct: events, B2B, residential (door to door), telesales.', 'Indirect: billboard, social media, newspaper, TV ads, radio.'],
  sections: [
    {
      blocks: [
        {
          kind: 'table',
          columns: ['Direct', 'Indirect'],
          rows: [
            ['Events', 'Billboard'],
            ['Business to business (B2B)', 'Social media'],
            ['Residential (door to door)', 'Newspaper'],
            ['Telesales', 'TV ads'],
            ['', 'Radio'],
          ],
        },
      ],
    },
  ],
  quiz: [
    { q: 'Which of these is direct marketing?', options: ['Billboard', 'Radio', 'Newspaper', 'Events'], answer: 3, why: 'Direct: events, B2B, residential (door to door), telesales.' },
    { q: 'Which of these is indirect marketing?', options: ['Social media', 'Telesales', 'Door to door', 'B2B'], answer: 0, why: 'Indirect: billboard, social media, newspaper, TV ads, radio.' },
    { q: 'Door to door is also called…', options: ['B2B', 'Residential', 'Telesales', 'Indirect'], answer: 1, why: 'Residential (door to door) is direct marketing.' },
  ],
  teachPrompt: 'Explain the difference between direct and indirect marketing with two examples of each, and say which one we do.',
  keywords: ['marketing', 'direct', 'indirect', 'B2B', 'door to door', 'residential', 'telesales'],
};

export const ASSUMING_THE_ROLE: Lesson = {
  key: 'assuming-the-role',
  title: 'Assuming the role',
  short: 'Assuming the role',
  checklist: ['Assuming the role'],
  page: '11',
  summary: 'Leadership is more than just a title: act like a leader before you take on the role.',
  keyPoints: ['Progression is criteria based, but we look for people who act like a leader first.', 'Image, helping the leaders, and being a problem solver.'],
  sections: [
    {
      blocks: [
        {
          kind: 'p',
          text: 'Most trainees are looking to progress into a leadership position. The progression is criteria based but we are also looking for people to act like a leader before they take on that role. Leadership is more than just a title which is why it’s really important to assume the role before you get there.',
          tone: 'lead',
        },
        { kind: 'p', text: 'There are a few things to think about if you are looking to progress:' },
        {
          kind: 'list',
          items: [
            '**Image.** A professional image in the office: smart and well presented, for example a clean ironed shirt and tie, or equivalent smart office wear.',
            'Helping the leaders with responsibilities, i.e. helping out the team that day; on the event, organising tablets and merchandise.',
            'Be a problem solver not a problem finder.',
          ],
        },
      ],
    },
  ],
  quiz: [
    {
      q: 'Why assume the role before you get there?',
      options: ['It pays more straight away', 'Leadership is more than just a title', 'Leaders don’t work in the field', 'Nobody else will'],
      answer: 1,
      why: 'Leadership is more than just a title, which is why it’s important to assume the role before you get there.',
    },
    {
      q: 'Which of these is helping the leaders with responsibilities?',
      options: ['Leaving early', 'Changing the pitch', 'Organising tablets and merchandise on the event', 'Skipping the morning meeting'],
      answer: 2,
      why: 'Helping out the team that day; on the event, organising tablets and merchandise.',
    },
    { q: 'Be a problem ___, not a problem ___.', options: ['solver / finder', 'finder / solver', 'maker / taker', 'owner / sharer'], answer: 0, why: 'Be a problem solver not a problem finder.' },
  ],
  teachPrompt: 'Describe three things you did this week that showed you assuming the role.',
  keywords: ['leadership', 'image', 'role', 'problem solver', 'responsibility'],
};

export const THEORY_OF_TEACHBACK: Lesson = {
  key: 'theory-of-teachback',
  title: 'Theory of teachback',
  short: 'Theory of teachback',
  checklist: ['Theory of teachback'],
  page: '13',
  summary: 'How to teach a theory back so it sticks: keep it simple, follow the three rules, and make sure everyone takes notes.',
  keyPoints: ['Keep it simple: “Does that make sense?” “Any questions?”', 'Write the theory at the top of the whiteboard and underline it.', 'Never make someone feel silly; a conversation, not a pitch.', 'Make sure everyone takes notes.'],
  image: IMAGES.teachRules,
  sections: [
    {
      blocks: [
        {
          kind: 'cards',
          columns: 3,
          items: [
            { title: 'Keep it simple', image: IMAGES.teachSimple, items: ['Always make sure people understand what you’re saying.', '“Does that make sense?”', '“Any questions?”'] },
            {
              title: '3 rules of the teachback',
              image: IMAGES.teachRules,
              ordered: true,
              items: [
                'Write the theory you’re teaching at the top of the whiteboard and underline it!',
                'Never make someone feel silly for giving the wrong answer.',
                'Make sure it’s a conversation and not a pitch.',
              ],
            },
            { title: 'Take notes', image: IMAGES.teachNotes, items: ['Make sure everyone’s taking notes.', 'Write down all the details because then they will too!'] },
          ],
        },
      ],
    },
  ],
  quiz: [
    {
      q: 'What is rule 1 of the teach-back?',
      options: ['Talk for as long as possible', 'Write the theory at the top of the whiteboard and underline it', 'Ask the newest person first', 'Hand out the pack'],
      answer: 1,
      why: 'Write the theory you’re teaching at the top of the whiteboard and underline it!',
    },
    { q: 'Someone gives the wrong answer. What do you do?', options: ['Correct them in front of everyone', 'Move on without them', 'Never make them feel silly', 'Ask them to leave'], answer: 2, why: 'Never make someone feel silly for giving the wrong answer.' },
    { q: 'A teach-back should be…', options: ['a conversation, not a pitch', 'a pitch', 'a test', 'silent'], answer: 0, why: 'Make sure it’s a conversation and not a pitch.' },
  ],
  teachPrompt: 'Plan a five-minute teach-back of any lesson in this pack using the three rules. What goes on the whiteboard, and what questions will you ask?',
  keywords: ['teachback', 'teach back', 'whiteboard', 'notes', 'training'],
};

export const RUN_AN_IMPACT: Lesson = {
  key: 'run-an-impact',
  title: 'Run an impact',
  short: 'Run an impact',
  checklist: ['Run an impact'],
  page: null,
  task: true,
  summary:
    'A practical task on the leadership checklist. The COD pack lists it but does not describe it: ask your leader what it involves, then tick it as done and say how it went so they can sign it off.',
  keyPoints: ['A task on the leadership checklist: the pack has no theory for it.', 'Ask your leader what it involves.', 'Tick it as done, write how it went; your leader signs it off.'],
  sections: [
    {
      blocks: [
        { kind: 'callout', tone: 'note', text: 'The COD pack lists this task but does not describe it. Ask your leader to walk you through one.' },
        {
          kind: 'list',
          ordered: true,
          items: ['Ask your leader what an impact involves and when you can run one.', 'Do it.', 'Tick it as done and write a few lines on how it went.'],
        },
      ],
    },
  ],
  quiz: [],
  teachPrompt: 'How did it go? What did you do, what worked, and what would you change next time?',
  keywords: ['impact', 'task'],
};

export const GO_ON_A_ROADTRIP: Lesson = {
  key: 'go-on-a-roadtrip',
  title: 'Go on a roadtrip',
  short: 'Go on a roadtrip',
  checklist: ['Go on a roadtrip'],
  page: null,
  task: true,
  summary:
    'A practical task on the leadership checklist: road trips are one of the 7 key areas of leadership. Ask your leader when the next one is, then tick it as done and say what you learned.',
  keyPoints: ['Road trips are one of the 7 key areas of leadership.', 'Ask your leader when the next one is.', 'Write what you learned below; your leader signs it off.'],
  sections: [
    {
      blocks: [
        { kind: 'callout', tone: 'note', text: 'The COD pack lists this task but does not describe it. Ask your leader when the next road trip is.' },
        { kind: 'list', ordered: true, items: ['Ask your leader about the next road trip.', 'Go on it.', 'Tick it as done and write what you learned.'] },
      ],
    },
  ],
  quiz: [],
  teachPrompt: 'Where did you go, and what did you learn?',
  keywords: ['roadtrip', 'road trip', 'travel', 'task'],
};
