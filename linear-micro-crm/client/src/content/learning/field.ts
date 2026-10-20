// Release 1.2 — L1: COD pack lessons, the "in the field" and "attitude" blocks of the leadership checklist
// (pack pages 6–10, 12, 14). Wording follows the pack; obvious typos fixed (sgns → signs, postitve → positive,
// garuntee → guarantee, arrises → arises).
import { IMAGES } from './images';
import type { Lesson } from './types';

export const GREEN_LIGHT: Lesson = {
  key: 'green-light-theory',
  title: 'Green light theory',
  short: 'Green light theory',
  checklist: ['Green light theory'],
  page: '7',
  summary:
    'Not everyone you stop is the same. Spend no time on the 10% who are negative, all your time on the 10% who are positive, and work the 80% in the middle: two no’s and a go.',
  keyPoints: ['10% negative: no see factors, no buying signs, spend no time.', '80% indifferent: some see factors, some buying signs. 2 no’s and a go.', '10% positive: all see factors, all buying signs, all your time.'],
  image: IMAGES.trafficLight,
  sections: [
    {
      blocks: [
        {
          kind: 'media',
          image: IMAGES.trafficLight,
          blocks: [
            {
              kind: 'cards',
              columns: 3,
              items: [
                { title: '10% negative', tone: 'danger', items: ['No see factors', 'No buying signs', 'Spend no time'] },
                { title: '80% indifferent', tone: 'warning', items: ['Some see factors', 'Some buying signs (might smile – but don’t give too much eye contact)', '2 no’s and a go'] },
                { title: '10% positive', tone: 'success', items: ['All see factors', 'All buying signs', 'All your time'] },
              ],
            },
            { kind: 'callout', tone: 'key', text: 'The 80% and the 10%: the people you want to spend time with.' },
          ],
        },
      ],
    },
  ],
  quiz: [
    {
      q: 'What share of the people you stop are indifferent?',
      options: ['10%', '50%', '80%', '90%'],
      answer: 2,
      why: '10% negative, 80% indifferent, 10% positive.',
    },
    {
      q: 'How much time do you spend on the 10% who are negative?',
      options: ['No time', 'All your time', 'Some time', 'Two minutes each'],
      answer: 0,
      why: 'No see factors, no buying signs: spend no time.',
    },
    {
      q: '“2 no’s and a go” is how you treat…',
      options: ['the negative 10%', 'the indifferent 80%', 'the positive 10%', 'your leader'],
      answer: 1,
      why: 'The indifferent 80% show some see factors and some buying signs: 2 no’s and a go.',
    },
  ],
  teachPrompt: 'Draw the traffic light for your leader and explain what you look for in each colour and how much time each one gets.',
  keywords: ['traffic light', 'negative', 'indifferent', 'positive', '10 80 10', 'see factors', 'two nos and a go'],
};

export const GUMBALL: Lesson = {
  key: 'gumball-theory',
  title: 'Gumball theory and ABC days',
  short: 'Gumball theory',
  checklist: ['Gumball theory', 'ABC days'],
  page: '8',
  summary: 'Out of 100 gumballs only 3 are your favourite flavour, and you never know when they will drop. Put in the full £100: give every person 100%.',
  keyPoints: [
    '100 gumballs: 97 bubblegum, 3 strawberry. Each costs £1.',
    'You need to put in £100 to guarantee all 3 of your favourite flavour.',
    'You never know when they drop: early, spread out or right at the end (A, B and C days).',
    'You can’t put 50p in the machine. You can’t give each person 50%.',
  ],
  image: IMAGES.gumball,
  sections: [
    {
      title: 'The machine',
      blocks: [
        {
          kind: 'media',
          image: IMAGES.gumball,
          blocks: [
            { kind: 'p', text: '100 gumballs in a machine:', tone: 'lead' },
            { kind: 'list', items: ['97 – bubblegum', '3 – strawberry', 'Each gumball costs £1'] },
            { kind: 'p', text: 'You need to put in £100 to guarantee all 3 of your favourite flavour gumball.' },
            {
              kind: 'list',
              items: [
                'You also never know when your gumballs will drop.',
                'They could come all at the same time. They could drop early. Or they can come right at the end.',
                'You can’t put 50p in to the machine. You can’t give each person 50%.',
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'abc-days',
      title: 'ABC days',
      blocks: [
        { kind: 'figure', image: IMAGES.abcDays, size: 'lg' },
        {
          kind: 'list',
          items: ['**A day:** the sales drop early.', '**B day:** they are spread through the day.', '**C day:** they all come right at the end.'],
        },
      ],
    },
  ],
  quiz: [
    { q: 'How many of the 100 gumballs are strawberry?', options: ['97', '10', '3', '50'], answer: 2, why: '97 bubblegum, 3 strawberry.' },
    {
      q: 'On a C day, when do the sales come?',
      options: ['Early in the day', 'Spread through the day', 'Right at the end', 'They don’t'],
      answer: 2,
      why: 'Same sales, different timing: on a C day they all drop right at the end, so keep giving every person 100%.',
    },
    {
      q: 'What does “you can’t put 50p in the machine” mean in the field?',
      options: ['You can’t give each person 50%', 'Charge more per sale', 'Only stop half the people', 'Take longer breaks'],
      answer: 0,
      why: 'You can’t put 50p in to the machine. You can’t give each person 50%.',
    },
  ],
  teachPrompt: 'Explain gumball theory and ABC days to a trainee who has had no sales by lunchtime.',
  keywords: ['gumball', 'strawberry', 'ABC days', 'A day', 'B day', 'C day', '100%'],
};

export const CAN_CANT: Lesson = {
  key: 'can-cant-controls',
  title: 'Can and can’t controls',
  short: 'Can / can’t controls',
  checklist: ['Can / can’t controls'],
  page: '10',
  summary: 'Put your energy into what you can control: your pitch, your pace and your attitude. The weather, the territory’s footflow and the people are not yours to control.',
  keyPoints: ['Can controls: pitch, pace, attitude.', 'Can’t controls: weather, territory (footflow), people.'],
  sections: [
    {
      blocks: [
        {
          kind: 'table',
          columns: ['Can controls', 'Can’t controls'],
          rows: [
            ['Pitch', 'Weather'],
            ['Pace', 'Territory (footflow)'],
            ['Attitude', 'People'],
          ],
        },
      ],
    },
  ],
  quiz: [
    { q: 'Which of these is a can control?', options: ['The weather', 'Footflow', 'Your pace', 'The people'], answer: 2, why: 'Can controls: pitch, pace and attitude.' },
    { q: 'Which of these is a can’t control?', options: ['Your pitch', 'Your attitude', 'Your pace', 'The weather'], answer: 3, why: 'Can’t controls: weather, territory (footflow) and people.' },
    {
      q: 'Name the three can controls.',
      options: ['Weather, territory, people', 'Pitch, pace, attitude', 'Pitch, weather, people', 'Pace, territory, attitude'],
      answer: 1,
      why: 'Pitch, pace and attitude are yours. The rest is not.',
    },
  ],
  teachPrompt: 'List the can and can’t controls, then tell your leader about a day when a can’t control got to you and what you could have controlled instead.',
  keywords: ['controls', 'weather', 'footfall', 'footflow', 'pitch', 'pace', 'attitude'],
};

export const BUYING_SIGNS: Lesson = {
  key: 'buying-signs',
  title: 'Buying and non-buying signs',
  short: 'Buying signs',
  checklist: ['Buying / non-buying signs'],
  page: '9',
  summary: 'Read the person in front of you. Buying signs tell you they are engaged; non-buying signs are doing the opposite.',
  keyPoints: ['See factors, nodding, positive questions, facing the stand.', 'Leaning into conversation, open body language, engaged.', 'Avoiding distractions (babies / dog).', 'Non-buying signs: doing the opposite of buying signs.'],
  sections: [
    {
      blocks: [
        {
          kind: 'cards',
          columns: 2,
          items: [
            {
              title: 'Buying signs',
              tone: 'success',
              items: [
                'See factors',
                'Avoiding distractions (babies / dog)',
                'Nodding',
                'Positive questions',
                'Facing the stand',
                'Leaning into conversation',
                'Open body language',
                'Engaged',
              ],
            },
            { title: 'Non-buying signs', tone: 'danger', items: ['Doing the opposite of buying signs'] },
          ],
        },
      ],
    },
  ],
  quiz: [
    {
      q: 'Which of these is a buying sign?',
      options: ['Looking at their phone', 'Arms folded, facing away', 'Leaning into the conversation', 'Walking off mid-sentence'],
      answer: 2,
      why: 'Leaning into conversation is a buying sign, with nodding, positive questions, facing the stand and open body language.',
    },
    {
      q: 'What are non-buying signs?',
      options: ['Doing the opposite of buying signs', 'Asking positive questions', 'Nodding along', 'Facing the stand'],
      answer: 0,
      why: 'Non-buying signs: doing the opposite of buying signs.',
    },
    {
      q: 'Someone keeps their attention on you while their dog pulls on the lead. That is…',
      options: ['a non-buying sign', 'a can’t control', 'avoiding distractions: a buying sign', 'fear of loss'],
      answer: 2,
      why: 'Avoiding distractions (babies / dog) is a buying sign.',
    },
  ],
  teachPrompt: 'Name the buying signs and describe how you spot a non-buying sign within the first ten seconds.',
  keywords: ['body language', 'nodding', 'engaged', 'signals', 'see factors'],
};

export const STRATEGIC_PAUSE: Lesson = {
  key: 'strategic-pause',
  title: 'Strategic pause',
  short: 'Strategic pause',
  checklist: ['Strategic pause'],
  page: '6',
  summary: 'Pausing to add effect. A pause in the right place shows confidence and lets the important line land.',
  keyPoints: ['Pausing to add effect.', 'Shows confidence.', 'Use strategic pauses in the presentation.'],
  sections: [
    {
      blocks: [
        { kind: 'definition', text: 'Pausing to add effect.' },
        { kind: 'p', text: 'Shows confidence.', tone: 'lead' },
        {
          kind: 'callout',
          tone: 'tip',
          title: 'In your pitch',
          text: 'Pitch scripts mark a pause as “(Pause – 1 second)”: hold it, keep eye contact, let the line land, then carry on.',
        },
      ],
    },
  ],
  quiz: [
    { q: 'What is a strategic pause?', options: ['A break between stops', 'Pausing to add effect', 'Waiting for them to talk first', 'Stopping when it rains'], answer: 1, why: 'Pausing to add effect.' },
    { q: 'What does a strategic pause show?', options: ['Nerves', 'That you forgot the words', 'Confidence', 'Urgency'], answer: 2, why: 'A strategic pause shows confidence.' },
    {
      q: 'In the 5 steps, which step tells you to use strategic pauses?',
      options: ['The presentation', 'Only the close', 'None of them', 'The welcome call'],
      answer: 0,
      why: 'The presentation: stand by their side, use strategic pauses, keep your SEE and KISS principles.',
    },
  ],
  teachPrompt: 'Deliver the opening lines of your pitch to your leader with the pauses in, then explain why each pause is where it is.',
  keywords: ['pause', 'silence', 'confidence', 'effect'],
};

export const PRE_EMPTIVE_STRIKE: Lesson = {
  key: 'pre-emptive-strike',
  title: 'Pre-emptive strike',
  short: 'Pre-emptive strike',
  checklist: ['Pre-emptive strike'],
  page: '6',
  summary: 'Attacking the negative before it arises: name the objection first, then always follow up with urgency.',
  keyPoints: ['Attacking the negative before it arises.', '“I know you’re busy.”', 'Always follow up with urgency!'],
  sections: [
    {
      blocks: [
        { kind: 'definition', text: 'Attacking the negative before it arises.' },
        { kind: 'quotes', items: ['I know you’re busy', 'I know you’re on the phone', 'I know you support a few charities', 'I can see you’re walking your dog'] },
        { kind: 'callout', tone: 'key', text: 'Always follow up with urgency!' },
      ],
    },
  ],
  quiz: [
    {
      q: 'What is a pre-emptive strike?',
      options: ['Closing before the presentation', 'Attacking the negative before it arises', 'Stopping two people at once', 'Asking for bank details first'],
      answer: 1,
      why: 'Attacking the negative before it arises.',
    },
    { q: 'Which line is a pre-emptive strike?', options: ['“Pretty amazing, right?”', '“Does that make sense?”', '“Takes 30 seconds.”', '“I know you’re busy.”'], answer: 3, why: '“I know you’re busy”, “I know you’re on the phone”, “I know you support a few charities”…' },
    { q: 'What do you always follow a pre-emptive strike with?', options: ['Urgency', 'A long pause', 'A joke', 'The close'], answer: 0, why: 'Always follow up with urgency!' },
  ],
  teachPrompt: 'Write three pre-emptive strikes you would use on your campaign and say which objection each one gets ahead of.',
  keywords: ['pre-empt', 'objection', 'busy', 'urgency'],
};

export const BAMBOO: Lesson = {
  key: 'bamboo-theory',
  title: 'Bamboo theory',
  short: 'Bamboo theory',
  checklist: ['Bamboo theory'],
  page: '12',
  summary: 'Although results may not show on the surface, growth is still taking place. Be patient, do what’s required and trust the process.',
  keyPoints: ['Growth is still taking place, even when results don’t show.', 'Be patient. Do what’s required.', 'Advice may feel repetitive: keep applying the fundamentals.', 'Trust the process.'],
  image: IMAGES.bamboo,
  sections: [
    {
      title: 'The bamboo effect',
      blocks: [
        {
          kind: 'list',
          items: [
            'Although ‘on the surface’ results may not show, growth is still taking place.',
            'Be patient. Do what’s required.',
            'Sometimes advice may feel repetitive but that’s because you need to continue to apply the fundamentals.',
            'Trust the process.',
          ],
        },
        { kind: 'figure', image: IMAGES.bamboo, size: 'lg' },
      ],
    },
  ],
  quiz: [
    {
      q: 'What does the bamboo effect say?',
      options: ['If results don’t show, change everything', 'Bamboo grows fastest in the rain', 'Growth is still taking place even when results don’t show on the surface', 'Only results on the surface count'],
      answer: 2,
      why: 'Although results may not show on the surface, growth is still taking place.',
    },
    {
      q: 'Why might advice feel repetitive?',
      options: ['You need to continue to apply the fundamentals', 'Your leader has run out of ideas', 'It is a mistake', 'Nobody listens'],
      answer: 0,
      why: 'Sometimes advice may feel repetitive but that’s because you need to continue to apply the fundamentals.',
    },
    { q: 'What does the pack tell you to do?', options: ['Give up after five days', 'Change territory', 'Skip the fundamentals', 'Trust the process'], answer: 3, why: 'Be patient, do what’s required, trust the process.' },
  ],
  teachPrompt: 'Tell the bamboo story to someone who has had a slow week, and say which fundamentals they should keep doing.',
  keywords: ['patience', 'growth', 'trust the process', 'fundamentals'],
};

export const ATTITUDE_REGAIN: Lesson = {
  key: 'attitude-regain',
  title: 'Attitude regain theory',
  short: 'Attitude regain',
  checklist: ['Attitude muscle', 'Attitude regain theory'],
  page: '14',
  summary: 'Notice when your attitude is slipping and recharge it early. Your attitude is a battery, and it is a muscle: every time you lose and regain it, it grows stronger.',
  keyPoints: [
    'Losing attitude: rejection, weather, can’t controls, outside negatives.',
    'Notice it: forced see factors, no urgency, sarcasm at the no’s, watching the clock.',
    'Regain it: a break, food, your leader, music, quality people.',
    'Recharge at 80%, not 20%.',
  ],
  image: IMAGES.battery,
  sections: [
    {
      blocks: [
        {
          kind: 'flow',
          steps: [
            { title: 'Losing attitude', items: ['Rejection – a lot of no’s', 'Weather', 'Can’t controls', 'Outside negatives (personal issues)'] },
            { title: 'How to notice', items: ['See factors feel forced', 'Lack of urgency', 'Being sarcastic at the no’s', 'Watching the time till you’re off rotation'] },
            {
              title: 'Regain attitude',
              items: ['Take a break', 'Grab some food', 'Talk to your leader', 'Listen to music / podcast', 'Spend quality time with quality people', 'Recharge your battery'],
            },
          ],
        },
      ],
    },
    {
      id: 'battery',
      title: 'Your attitude is a battery',
      blocks: [
        {
          kind: 'media',
          image: IMAGES.battery,
          blocks: [{ kind: 'p', text: 'It’s quicker to charge your phone up from 80% to 100% than it is from 20%. Make sure you regain / recharge sooner rather than later!' }],
        },
      ],
    },
    {
      id: 'muscle',
      title: 'Your attitude is a muscle',
      blocks: [
        {
          kind: 'media',
          image: IMAGES.muscle,
          blocks: [
            {
              kind: 'p',
              text: 'Every time you lose and regain your attitude it grows stronger like a muscle. You will become more resilient to rejections, but you must surround yourself with people who have positive attitudes.',
            },
          ],
        },
      ],
    },
  ],
  quiz: [
    {
      q: 'Why recharge your attitude at 80% rather than 20%?',
      options: ['Your leader says so', 'It’s quicker to charge from 80% to 100% than from 20%', 'Phones last longer', 'It doesn’t matter when'],
      answer: 1,
      why: 'Your attitude is a battery: recharge sooner rather than later.',
    },
    {
      q: 'Which is a sign you are losing your attitude?',
      options: ['Asking positive questions', 'Taking a break', 'Watching the time till you’re off rotation', 'Talking to your leader'],
      answer: 2,
      why: 'How to notice: see factors feel forced, lack of urgency, sarcasm at the no’s, watching the time till you’re off rotation.',
    },
    {
      q: 'What makes your attitude muscle stronger?',
      options: ['Losing and regaining it, around people with positive attitudes', 'Avoiding all rejection', 'Working alone', 'Never taking a break'],
      answer: 0,
      why: 'Every time you lose and regain your attitude it grows stronger, but surround yourself with people who have positive attitudes.',
    },
  ],
  teachPrompt: 'Explain the battery and the muscle, then tell your leader the first sign you notice when your own attitude starts to drop and what you do about it.',
  keywords: ['attitude', 'battery', 'muscle', 'rejection', 'recharge', 'resilience'],
};
