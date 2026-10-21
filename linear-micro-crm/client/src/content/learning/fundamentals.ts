// Release 1.2 — L1: COD pack lessons, "fundamentals" block of the leadership checklist (pack pages 3–6).
// Wording follows the pack; only obvious typos are fixed (excitment → excitement, consolodation → consolidation, the
// consolidation step numbered 5, uou / omn → you / on, exciutment → excitement, buyers → buyer’s). Nothing the pack does
// not say: the law of averages keeps its numbers as printed and asks the leader to explain them.
import type { Lesson } from './types.ts';

export const FIVE_STEPS: Lesson = {
  key: 'five-steps',
  title: '5 steps to a conversation',
  short: '5 steps',
  checklist: ['5 steps to a conversation'],
  page: '3',
  summary:
    'Every conversation in the field follows the same five steps: introduction, short story, presentation, close and consolidation. The introduction (7 to 10 seconds) is the most important step: the 1st impression.',
  keyPoints: [
    'Introduction (7 to 10 seconds): the most important step. Smile, eye contact, excitement.',
    'Short story (10 to 15 seconds): answer who, what and why as soon as possible.',
    'Presentation: create the problem and be the solution.',
    'Close: an assumptive statement that generates a yes / no answer.',
    'Consolidation: remind them why they signed up and use feel good factors to reduce buyer’s remorse.',
  ],
  sections: [
    {
      id: 'introduction',
      title: '1. Introduction',
      meta: '7 to 10 seconds',
      blocks: [
        { kind: 'p', text: 'Most important step. 1st impression.', tone: 'lead' },
        { kind: 'p', text: '**3 non-verbals:**' },
        {
          kind: 'list',
          items: [
            '**Smile** – mirror effect.',
            '**Eye contact** – establishes trust and shows confidence.',
            '**Excitement** – if you’re not, why should they be? Always be 10% more excited!',
          ],
        },
      ],
    },
    {
      id: 'short-story',
      title: '2. Short story',
      meta: '10 to 15 seconds',
      blocks: [
        { kind: 'p', text: 'Who? What? Why?', tone: 'lead' },
        {
          kind: 'list',
          items: ['Answer 3 W’s ASAP.', 'Removes uncertainty and maintain control of conversation.', 'Read buying / non-buying signs.', 'Tonality.'],
        },
        {
          kind: 'acronym',
          letters: [
            { letter: 'K', word: 'Keep' },
            { letter: 'I', word: 'It' },
            { letter: 'S', word: 'Short' },
            { letter: 'S', word: 'Simple' },
          ],
        },
      ],
    },
    {
      id: 'presentation',
      title: '3. Presentation',
      blocks: [
        { kind: 'p', text: 'Problem and solution (create the problem and be the solution).', tone: 'lead' },
        {
          kind: 'list',
          items: ['Stand by their side (when possible) // Be on their level (reasonable man).', 'Use strategic pauses.', 'Maintain your SEE and KISS principles.'],
        },
        {
          kind: 'list',
          items: [
            '**Use buzzwords:** Unfortunately, Obviously, However.',
            '**Speak in past tense:** Everyone nice enough to stop said they’d LOVE to help out…',
            '**Use group effect:** “Everyone”, “When we ALL come together”, “everyone else”…',
          ],
        },
      ],
    },
    {
      id: 'close',
      title: '4. Close',
      blocks: [
        { kind: 'p', text: 'An assumptive statement that generates a yes / no answer.', tone: 'lead' },
        { kind: 'p', text: 'Assumptive because we’re assuming they are going to say YES!' },
        {
          kind: 'list',
          items: ['Close @ the height of impulse.', 'Stand still = confidence.', 'No dead airspace.', 'Clarity (no beating around the bush).', 'Excitement.'],
        },
      ],
    },
    {
      id: 'consolidation',
      title: '5. Consolidation',
      blocks: [
        {
          kind: 'list',
          items: [
            'Remind them **why they signed up** and use **feel good factors** to reduce **buyer’s remorse**.',
            'Pre-empt next steps (welcome call).',
            'Rehash long term support: “Ideally you could’ve given for a lifetime, but everyone who signed today said they do it for at least 2 years.”',
          ],
        },
      ],
    },
  ],
  quiz: [
    {
      q: 'How long should your introduction take?',
      options: ['30 seconds', '7 to 10 seconds', '10 to 15 seconds', 'As long as it takes'],
      answer: 1,
      why: 'The introduction gets 7 to 10 seconds: it is the 1st impression and the most important step. The short story gets 10 to 15.',
    },
    {
      q: 'What are the 3 non-verbals of the introduction?',
      options: ['Handshake, name badge, smile', 'Tonality, pace, posture', 'Smile, eye contact, excitement', 'Nodding, leaning in, open arms'],
      answer: 2,
      why: 'Smile (mirror effect), eye contact (trust and confidence) and excitement: always be 10% more excited.',
    },
    {
      q: 'What makes a close “assumptive”?',
      options: ['We assume they are going to say yes', 'We ask if they would like time to think', 'We list every benefit first', 'We wait for them to offer'],
      answer: 0,
      why: 'An assumptive statement that generates a yes / no answer: assumptive because we’re assuming they are going to say YES.',
    },
  ],
  teachPrompt: 'Walk your leader through the five steps in order. For each one, say what it is for and one thing you do in it.',
  keywords: ['intro', 'introduction', 'short story', 'presentation', 'close', 'consolidation', 'KISS', 'SEE', 'non-verbals', 'buzzwords'],
};

export const WORKING_HABITS: Lesson = {
  key: 'working-habits',
  title: '8 working habits',
  short: 'Working habits',
  checklist: ['Working habits'],
  page: '4',
  summary: 'Eight habits that decide how your day, your week and your future go: from having a great attitude to taking control.',
  keyPoints: [
    'Have a great attitude, and maintain it: each “no” brings you closer to a “yes”.',
    'Be on time and be prepared: if you’re not early, you’re late.',
    'Work your full 8 hours and work your territory correctly.',
    'Know your whats and why’s, and take control.',
  ],
  sections: [
    {
      blocks: [
        {
          kind: 'cards',
          columns: 2,
          items: [
            {
              title: '1. Have a great attitude',
              items: [
                'Attitude is how you respond.',
                'The way you make other people feel, regardless of how you feel yourself.',
                'Attitude and enthusiasm is absolutely everything and it’s the reason they’ll sign up!',
              ],
            },
            { title: '2. Be on time', items: ['If you’re not early, you’re late.', 'Timing is essential for management.'] },
            {
              title: '3. Be prepared',
              items: ['Fail to prepare, prepare to fail.', 'Physically – notepads, pens, training manuals etc.', 'Mentally – have a game plan to work towards that day / week.'],
            },
            { title: '4. Work your full 8 hours', items: ['Successful people don’t just work half a day.', 'Work a full 8 hours or as many as it takes to achieve your goals.'] },
            {
              title: '5. Work your territory correctly',
              items: [
                '10-5 rule.',
                'Figure of 8.',
                'Treat everything as your territory. The event, the office, the atmosphere room, when you’re at home or even at the gym as well.',
              ],
            },
            { title: '6. Maintain a great attitude', items: ['Protect your attitude. Each “NO” brings you closer to a “YES”.'] },
            {
              title: '7. Know your whats and why’s',
              items: ['Sometimes it can be easy to lose sight of your goals.', 'Remind yourself of your WHY.', 'Have a big enough ‘WHY’ and the ‘WHAT’ is irrelevant.'],
            },
            { title: '8. Take control', items: ['Of your conversations in the field.', 'Of your day / week / month / year.', 'Of your situation and your future.'] },
          ],
        },
      ],
    },
  ],
  quiz: [
    {
      q: 'Complete the habit: “If you’re not early…”',
      options: ['…call your leader.', '…you’re on time.', '…skip the morning meeting.', '…you’re late.'],
      answer: 3,
      why: 'Be on time: if you’re not early, you’re late. Timing is essential for management.',
    },
    {
      q: 'Working your territory correctly includes…',
      options: ['The 10-5 rule and the figure of 8', 'Waiting for people to come to you', 'Staying on one spot all day', 'Only the event itself'],
      answer: 0,
      why: 'The 10-5 rule, the figure of 8, and treating everything as your territory: the event, the office, the atmosphere room, even home and the gym.',
    },
    {
      q: 'According to the pack, what makes the ‘what’ irrelevant?',
      options: ['A good territory', 'A big enough ‘why’', 'Working 8 hours', 'A bonus'],
      answer: 1,
      why: 'Know your whats and why’s: have a big enough ‘WHY’ and the ‘WHAT’ is irrelevant.',
    },
  ],
  teachPrompt: 'Name the 8 working habits and pick the two you find hardest. What will you do this week to work on them?',
  keywords: ['attitude', 'on time', 'prepared', '8 hours', 'territory', 'figure of 8', '10-5 rule', 'why', 'control'],
};

export const LAW_OF_AVERAGES: Lesson = {
  key: 'law-of-averages',
  title: 'Law of averages',
  short: 'Law of averages',
  checklist: ['Law of averages'],
  page: '6',
  // Our own words: the pack's definition and football line open the lesson below, so the summary does not repeat them.
  summary: 'Results come from repetition, good or bad: keep taking shots on target and the goals follow. Your gauges count every shot.',
  keyPoints: [
    'The more you repeat an action, the more a positive / negative outcome will occur.',
    'The more shots you take on target, the more goals you score.',
    'Your six gauges in Linear Hub (stops, to table, presentations, closes, taps and sales) count your shots on target.',
  ],
  sections: [
    {
      blocks: [
        { kind: 'definition', text: 'The more you repeat an action the more a positive / negative outcome will occur.' },
        { kind: 'p', text: 'The more shots you take on target, the more goals you score.', tone: 'lead' },
        { kind: 'callout', tone: 'key', title: 'The pack’s numbers', text: '00/50/40/30/10 = 3–5' },
        { kind: 'callout', tone: 'note', text: 'Ask your leader to walk you through the pack’s numbers for your campaign.' },
        {
          kind: 'callout',
          tone: 'tip',
          title: 'In Linear Hub',
          text: 'Your gauges are the law of averages in numbers. The Gauges page and your dashboard show your ratios against the company benchmarks.',
        },
      ],
    },
  ],
  quiz: [
    {
      q: 'What does the law of averages say?',
      options: ['Every person you stop will sign up', 'Only the best pitch gets results', 'The more you repeat an action, the more a positive / negative outcome will occur', 'Averages don’t matter in the field'],
      answer: 2,
      why: 'The more you repeat an action the more a positive / negative outcome will occur.',
    },
    {
      q: 'Which line from the pack explains it?',
      options: ['The more shots you take on target, the more goals you score', 'Fail to prepare, prepare to fail', 'Nobody wants to be first', 'Trust the process'],
      answer: 0,
      why: 'The more shots you take on target, the more goals you score.',
    },
    {
      q: 'Under the law of averages, what brings more sales?',
      options: ['Waiting for the right person', 'Talking to fewer people for longer', 'Changing your pitch every hour', 'Taking more shots on target: more stops, more conversations'],
      answer: 3,
      why: 'Repeat the action: more shots on target, more goals.',
    },
  ],
  teachPrompt: 'Explain the law of averages to a new starter using the football line from the pack, then show them how their own gauges tell the same story.',
  keywords: ['LOA', 'averages', 'numbers', 'gauges', 'ratios', 'stops'],
};

export const IMPULSE_FACTORS: Lesson = {
  key: 'impulse-factors',
  title: '6 impulse factors (GIFGUP)',
  short: '6 impulse factors',
  checklist: ['6 impulse factors'],
  page: '5',
  summary:
    'GIFGUP is how you remember the six impulse factors, in order: greed, indifference, fear of loss, group effect, urgency and power of suggestion. Each one raises someone’s excitement.',
  keyPoints: [
    'Greed is the most important impulse factor: increase value, decrease cost.',
    'Indifference: a take it or leave it approach. Be relaxed.',
    'Fear of loss goes at the end of the pitch, in the qualifying questions.',
    'Group effect, urgency and the power of suggestion (“I’m sure…, yeah?”).',
  ],
  sections: [
    {
      blocks: [
        { kind: 'definition', text: 'Impulse is someone’s natural level of excitement.' },
        { kind: 'list', items: ['6 impulse factors designed to increase someone’s natural level of excitement.', 'GIFGUP (how we remember them in order).'] },
        {
          kind: 'acronym',
          letters: [
            { letter: 'G', word: 'Greed' },
            { letter: 'I', word: 'Indifference' },
            { letter: 'F', word: 'Fear of loss' },
            { letter: 'G', word: 'Group effect' },
            { letter: 'U', word: 'Urgency' },
            { letter: 'P', word: 'Power of suggestion' },
          ],
        },
      ],
    },
    {
      id: 'greed',
      title: '1. Greed',
      blocks: [
        { kind: 'definition', text: 'Everyone wants something for nothing.' },
        {
          kind: 'list',
          items: [
            'Most important impulse factor.',
            'Without greed nobody would change their provider / sign up to a charity.',
            'We increase value (USPs of the charity, price).',
            'Decrease cost (time and effort).',
          ],
        },
      ],
    },
    {
      id: 'indifference',
      title: '2. Indifference',
      blocks: [
        { kind: 'definition', text: 'Take it or leave it approach.' },
        { kind: 'list', items: ['Be relaxed, lean on your back foot.', 'SW3 = N.'] },
        { kind: 'p', text: 'SW3 = N is usually read as “some will, some won’t, so what… next”: check with your leader.', tone: 'muted' },
      ],
    },
    {
      id: 'fear-of-loss',
      title: '3. Fear of loss',
      blocks: [
        { kind: 'definition', text: 'Fear of loss is greater than the need to gain.' },
        { kind: 'list', items: ['Use this at the end of the pitch (in the qualifying questions).'] },
      ],
    },
    {
      id: 'group-effect',
      title: '4. Group effect',
      blocks: [
        { kind: 'definition', text: 'People put more value in the buying decisions of others.' },
        { kind: 'list', items: ['Nobody wants to be first. Nobody wants to be last.', 'Use words like “everybody”, when we “all” come together, count on your support “as well”.'] },
      ],
    },
    {
      id: 'urgency',
      title: '5. Urgency',
      blocks: [
        { kind: 'definition', text: 'Pace about your day.' },
        {
          kind: 'list',
          items: [
            'Be urgent between customers, not at the customers.',
            'Be quick to find a new potential donor, but when you’re speaking to someone, take your time with them.',
            'Urgency isn’t just how quick you are on the field. It’s also how quick do you get to the field?',
          ],
        },
      ],
    },
    {
      id: 'power-of-suggestion',
      title: '6. Power of suggestion',
      blocks: [
        { kind: 'definition', text: 'Using suggestive language to get a desired result.' },
        { kind: 'list', items: ['Start a sentence with “I’m sure” and end it with “yeah”.', 'Jedi nods.', 'Yes train.'] },
      ],
    },
  ],
  quiz: [
    {
      q: 'What does GIFGUP stand for?',
      options: [
        'Greeting, introduction, focus, goal, urgency, pitch',
        'Greed, interest, fear, gain, urgency, pace',
        'Greed, indifference, fear of loss, group effect, urgency, power of suggestion',
        'Group, impulse, fear, greed, urgency, pause',
      ],
      answer: 2,
      why: 'GIFGUP is how we remember the six impulse factors in order.',
    },
    {
      q: 'Which impulse factor is the most important?',
      options: ['Urgency', 'Greed', 'Group effect', 'Indifference'],
      answer: 1,
      why: 'Greed: without it nobody would change their provider or sign up to a charity.',
    },
    {
      q: 'Where in the pitch do you use fear of loss?',
      options: ['In the introduction', 'During the short story', 'At the end, in the qualifying questions', 'Never'],
      answer: 2,
      why: 'Fear of loss is greater than the need to gain: use it at the end of the pitch, in the qualifying questions.',
    },
  ],
  teachPrompt: 'Teach GIFGUP back: name each impulse factor in order, give its definition and one line you would actually say for it.',
  keywords: ['GIFGUP', 'greed', 'indifference', 'fear of loss', 'group effect', 'urgency', 'power of suggestion', 'impulse', 'jedi nods', 'yes train', 'SW3'],
};
