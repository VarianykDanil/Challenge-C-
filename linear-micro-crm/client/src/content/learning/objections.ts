// Release 1.2 — L1: COD pack lessons, the objections block (pack pages 15–16): bullet theory and straight line theory.
// Wording follows the pack; obvious typos fixed (minimim → minimum). The pack gives no overturn for direct debit, so the
// lesson says so rather than inventing one.
import { IMAGES } from './images.ts';
import type { Lesson } from './types.ts';

/** The six chambers, in the pack's layout order around the cylinder (top, then clockwise). */
export const BULLET_OBJECTIONS = [
  { id: 'direct-debit', label: 'Direct debit', position: 'top' },
  { id: 'no-time', label: 'No time', position: 'top-right' },
  { id: 'bank-details', label: 'Bank details', position: 'bottom-right' },
  { id: 'cows', label: 'C.O.W.S', position: 'bottom' },
  { id: 'other-charities', label: 'Other charities', position: 'bottom-left' },
  { id: 'no-money', label: 'No money', position: 'top-left' },
] as const;

export const BULLET_THEORY: Lesson = {
  key: 'bullet-theory',
  title: 'Bullet theory',
  short: 'Bullet theory',
  checklist: ['Bullet theory'],
  page: '15',
  summary:
    'Bullet theory is what we use to handle objections in the field. There are 6 main objections you’ll come across: load the right overturn, then always be closing.',
  keyPoints: [
    'Six objections: no money, no time, other charities, bank details, direct debit and C.O.W.S.',
    'AIR for no money; feel, felt, found for other charities; the short version for no time.',
    'RRR: read, relax, relate.',
    'ABC: always be closing with every overturn. No dead air space.',
  ],
  image: IMAGES.cylinder,
  sections: [
    {
      // The pack's opening sentence ("Bullet theory is what we use to handle objections in the field…") is the summary
      // at the top of the page, so the lesson starts with the chamber rather than repeating it.
      blocks: [
        { kind: 'bullet-chamber' },
        {
          kind: 'callout',
          tone: 'key',
          title: 'ABC (Always Be Closing) with every overturn',
          text: 'It’s really important to close them after and leave no ‘dead air space’ → this leads to loss of impulse.',
        },
      ],
    },
    {
      id: 'no-money',
      title: 'No money',
      blocks: [{ kind: 'p', text: 'Overturn with **AIR** (stop → short story): acknowledge, ignore, resume.' }],
    },
    {
      id: 'no-time',
      title: 'No time',
      blocks: [
        {
          kind: 'lines',
          rows: [
            { cue: 'Stop', say: 'Short version' },
            { cue: 'Table', say: 'I’ll keep it short for you' },
            { cue: 'Close', say: 'Takes 30 seconds' },
            { cue: 'Tab', say: 'On the last page now' },
          ],
        },
      ],
    },
    {
      id: 'other-charities',
      title: 'Other charities',
      blocks: [{ kind: 'p', text: 'Overturn with **feel, felt, found** (pres → tab).' }],
    },
    {
      id: 'bank-details',
      title: 'Bank details',
      blocks: [
        { kind: 'list', items: ['More of a prevention than a cure.', 'Do more to make them trust you (eye contact and relationship building).', 'Can use phrases such as:'] },
        { kind: 'quotes', items: ['Data protected', 'Non-sensitive'] },
      ],
    },
    {
      id: 'cows',
      title: 'C.O.W.S',
      blocks: [
        {
          // The pack draws a single bullet beside C.O.W.S (page 15).
          kind: 'media',
          image: IMAGES.bullet,
          blocks: [
            { kind: 'quotes', items: ['I’m sure your partner is just as lovely as yourself and wouldn’t mind contributing the bare minimum'] },
            { kind: 'p', text: '→ **Close!**' },
          ],
        },
      ],
    },
    {
      id: 'direct-debit',
      title: 'Direct debit',
      blocks: [
        {
          kind: 'p',
          text: 'One of the six chambers. The pack doesn’t print an overturn for it: ask your leader for the one your campaign uses, then close straight after it.',
          tone: 'muted',
        },
      ],
    },
    {
      id: 'air',
      title: 'AIR',
      meta: 'Stop → short story',
      blocks: [
        {
          kind: 'acronym',
          letters: [
            { letter: 'A', word: 'Acknowledge' },
            { letter: 'I', word: 'Ignore' },
            { letter: 'R', word: 'Resume' },
          ],
        },
      ],
    },
    {
      id: 'feel-felt-found',
      title: 'Feel, felt, found',
      meta: 'Pres → tab',
      blocks: [{ kind: 'quotes', items: ['I know exactly how you **feel**. A lot of people today have **felt** the exact same. However, when they **found** out…'] }],
    },
    {
      id: 'rrr',
      title: 'RRR',
      blocks: [
        {
          kind: 'list',
          items: ['**Read** – know if they feel uncomfortable.', '**Relax** – be indifferent and deliver the overturn.', '**Relate** – tonality!'],
        },
      ],
    },
  ],
  quiz: [
    { q: 'How many main objections does bullet theory cover?', options: ['3', '4', '6', '8'], answer: 2, why: 'There are 6 main objections you’ll come across: six chambers in the cylinder.' },
    {
      q: 'What does AIR stand for?',
      options: ['Ask, inform, repeat', 'Acknowledge, ignore, resume', 'Attitude, impulse, rapport', 'Agree, interrupt, restart'],
      answer: 1,
      why: 'AIR (stop → short story): acknowledge, ignore, resume.',
    },
    {
      q: 'What must you do straight after every overturn?',
      options: ['Wait for them to speak', 'Start the pitch again', 'Close: always be closing, no dead air space', 'Hand them a leaflet'],
      answer: 2,
      why: 'ABC with every overturn: close them after and leave no dead air space, which leads to loss of impulse.',
    },
  ],
  teachPrompt: 'Load the cylinder: name the six objections and give your overturn for each, then show how you close straight after one of them.',
  keywords: ['objections', 'overturn', 'no money', 'no time', 'other charities', 'bank details', 'direct debit', 'COWS', 'AIR', 'feel felt found', 'RRR', 'ABC', 'always be closing'],
};

export const STRAIGHT_LINE: Lesson = {
  key: 'straight-line-theory',
  title: 'Straight line theory',
  short: 'Straight line theory',
  checklist: ['Straight line theory'],
  page: '16',
  summary:
    'Keep the conversation on the line between the friend zone and the business zone. Use FORM to find hotspots and 2:1 to manage your relationship building.',
  keyPoints: [
    'Only stop and pitch, with no friendship: the business zone (they’ll say no).',
    'Become best friends: the friend zone (they’ll find it too easy to tell you no).',
    'FORM finds hotspots: family, occupation, recreation.',
    '2:1: find out two things about them, tell them one about you, back to the pitch.',
  ],
  image: IMAGES.straightLine,
  sections: [
    {
      blocks: [
        {
          kind: 'list',
          items: [
            'If all you do is stop the person and pitch without establishing any level of friendship = you’ll end up in the business zone (they’ll say no).',
            'If you become best friends with the customer = you’ll end up in the friend zone (they’ll find it too easy to tell you no).',
          ],
        },
        { kind: 'figure', image: IMAGES.straightLine, size: 'lg' },
        { kind: 'p', text: 'Which is why we use **FORM** to find hotspots and **2:1** to manage our relationship building.', tone: 'lead' },
      ],
    },
    {
      id: 'form',
      title: 'FORM',
      blocks: [
        {
          kind: 'acronym',
          letters: [
            { letter: 'F', word: 'Family' },
            { letter: 'O', word: 'Occupation' },
            { letter: 'R', word: 'Recreation' },
            { letter: 'M', word: 'Motivation', struck: true },
          ],
          note: 'The pack crosses out Motivation.',
        },
      ],
    },
    {
      id: 'two-to-one',
      title: '2:1',
      blocks: [{ kind: 'p', text: 'Find out two things about them, tell them 1 thing about you. Then return to the pitch.' }],
    },
  ],
  quiz: [
    {
      q: 'You stop someone and pitch with no friendship at all. Where do you end up?',
      options: ['The friend zone: they find it too easy to say no', 'The business zone: they’ll say no', 'On the line', 'At the close'],
      answer: 1,
      why: 'Without any level of friendship you end up in the business zone, and they’ll say no.',
    },
    {
      q: 'What is 2:1?',
      options: ['Two pitches for every sale', 'Two closes, then one pause', 'Find out two things about them, tell them one about you, then return to the pitch', 'Two stops a minute'],
      answer: 2,
      why: 'Find out two things about them, tell them 1 thing about you. Then return to the pitch.',
    },
    { q: 'What do you use FORM for?', options: ['To find hotspots', 'To fill in the sign-up form', 'To close', 'To handle bank details'], answer: 0, why: 'We use FORM to find hotspots: family, occupation, recreation.' },
  ],
  teachPrompt: 'Explain the two zones and how FORM and 2:1 keep you on the line. Give an example of a FORM question you would ask.',
  keywords: ['friend zone', 'business zone', 'FORM', '2:1', 'rapport', 'hotspots', 'relationship'],
};
