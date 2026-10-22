/**
 * Release 1.3 — OWNED BY P7 recruitment-plus. The default interview question bank (Settings → Recruitment starts with
 * these on every database) and the demo seed's sample answers.
 *
 * Plain, lawful questions only: about the job, the person's experience, availability and getting to work. Nothing about
 * age, health, family, religion, nationality or any other protected characteristic (Equality Act 2010); the shared
 * `questionTopicWarning` check passes every one of them (tested).
 */
import type { InterviewType, Position } from '@lm/shared';

export interface DefaultQuestion {
  type: InterviewType;
  text: string;
  /** null: every position. */
  position: Position | null;
}

const q = (type: InterviewType, text: string, position: Position | null = null): DefaultQuestion => ({ type, text, position });

/** In order within each type (sort = the position in this list within the type, from 0). */
export const DEFAULT_INTERVIEW_QUESTIONS: readonly DefaultQuestion[] = [
  // Phone screen
  q('phone', 'What made you apply to work with Linear?'),
  q('phone', 'Have you done any face-to-face, sales or customer service work before? Tell me about it.'),
  q('phone', 'Which days and hours could you work each week?'),
  q('phone', 'Our teams work at venues across Greater Manchester. How would you get to a 9:00 start in Bolton or Stockport?'),
  q('phone', 'The role is self-employed: a base for each day worked, or commission when that is more. What would you like to know about how pay works?'),
  q('phone', 'When could you start?'),
  // First interview
  q('first', 'Tell me about a time you persuaded someone to change their mind.'),
  q('first', 'Someone says "not today" and keeps walking. What do you do next?'),
  q('first', 'Tell me about a time you kept going after a setback.'),
  q('first', 'What do you know about the charities and companies we work for?'),
  q('first', 'Give an example of working in a team towards a target.'),
  q('first', 'How do you like to get feedback, and what do you do with it?'),
  q('first', 'Where would you like to be in three months, and what would you do to get there?'),
  q('first', 'Tell me about a time you led a group of people towards a goal.', 'team_leader'),
  // Observation day
  q('observation', 'What did you enjoy most about today?'),
  q('observation', 'What did you find hardest, and how did you handle it?'),
  q('observation', 'Which part of the pitch felt natural, and which part would you practise?'),
  q('observation', 'Observer: how did they open conversations (energy, smile, first line)?'),
  q('observation', 'Observer: did they follow the fundraising code (no blocking, no pressure, clear about the regular gift)?'),
  q('observation', 'If you joined the team, what would you want to learn first?'),
  // Final interview
  q('final', 'What have you learned about the role since your observation day?'),
  q('final', 'Which team or area would suit you best, and why?'),
  q('final', 'What support would help you most in your first two weeks?'),
  q('final', 'You would be self-employed: Linear issues a self-billing invoice for you each week and you pay your own tax and National Insurance. What would you like us to explain?'),
  q('final', 'What would make you want to stay with us for a year?'),
];

/** Demo answers per default question (by its text), picked by the extension seed's own random stream. */
export const DEMO_ANSWERS: Readonly<Record<string, readonly string[]>> = {
  'What made you apply to work with Linear?': [
    'Saw the advert on Indeed. Wants work where effort shows in the pay, and likes talking to people.',
    'A friend works on the BCN team and said the training is good. Wants to get better at speaking to strangers.',
    'Finished uni in the summer and wants something active while deciding on a career. Likes that it is for charities.',
  ],
  'Have you done any face-to-face, sales or customer service work before? Tell me about it.': [
    'Two years in a coffee shop, busy weekend shifts, handled complaints. No sales as such.',
    'Three months selling phone contracts in a shopping centre. Enjoyed it, left when the stand closed.',
    'Retail in a clothes shop over two Christmases, tills and the shop floor.',
  ],
  'Which days and hours could you work each week?': [
    'Monday to Friday, any hours. Saturdays some weeks.',
    'Wednesday to Sunday. Has a lecture on Monday and Tuesday mornings.',
    'Four days a week, ideally Thursday to Sunday.',
  ],
  'Our teams work at venues across Greater Manchester. How would you get to a 9:00 start in Bolton or Stockport?': [
    'Train from Piccadilly; has worked out the times. Fine with an early start.',
    'Drives, happy to give others a lift.',
    'Tram and bus; would check the route the night before.',
  ],
  'The role is self-employed: a base for each day worked, or commission when that is more. What would you like to know about how pay works?': [
    'Asked how quickly commission is paid and what happens when a donor cancels. Explained the weekly invoice.',
    'Wanted to know about tax. Explained they register as self-employed and we show everything on the weekly invoice.',
    'No questions; understood base or commission straight away.',
  ],
  'When could you start?': ['Next Monday.', 'In two weeks, after notice at the current job.', 'Straight away.'],
  'Tell me about a time you persuaded someone to change their mind.': [
    'Talked a regular round from a free coffee to a loyalty card by showing the saving. Clear and natural.',
    'Got the student society to change a social to a fundraiser. Listened first, then made the case.',
    'Struggled to think of an example; mentioned convincing a sibling to revise. Some prompting needed.',
  ],
  'Someone says "not today" and keeps walking. What do you do next?': [
    'Smile, thank them, move on to the next person. Does not take it personally.',
    'Would try one light line to get a laugh, then let them go. Good instinct, kept it respectful.',
    'Said they would follow them to explain. Talked through why we never do that; took it on board.',
  ],
  'Tell me about a time you kept going after a setback.': [
    'Failed the first year of a course, resat and passed with a merit.',
    'Dropped from a football team, trained over the summer and got back in.',
    'Lost a job when a shop closed; had another within a fortnight.',
  ],
  'What do you know about the charities and companies we work for?': [
    'Had read up on Breast Cancer Now and knew about regular giving. Good preparation.',
    'Knew the names, not much more. Keen to learn.',
    'Knew Volt Energy from adverts; not the charities.',
  ],
  'Give an example of working in a team towards a target.': [
    'Weekend team at a café hitting a sales target on cakes; organised who upsold at the till.',
    'Group project at uni; took on the presentation and kept everyone to deadlines.',
    'Five-a-side league; clear about their own part.',
  ],
  'How do you like to get feedback, and what do you do with it?': [
    'Straight away and honest. Writes it down and tries it on the next shift.',
    'Prefers it in private. Gave an example of changing how they handled refunds after feedback.',
    'Not sure; said they would like to be told what to do better.',
  ],
  'Where would you like to be in three months, and what would you do to get there?': [
    'Making commission most weeks and helping train new starters.',
    'Consistent four days a week, two sales a day.',
    'Wants to be a team leader within a year; asked what the steps are.',
  ],
  'Tell me about a time you led a group of people towards a goal.': [
    'Ran a shift of six at a bar on busy nights; set targets and covered breaks.',
    'Captain of a netball team for two seasons.',
  ],
  'What did you enjoy most about today?': [
    'The buzz when the team cheered the first sale.',
    'Talking to people; was surprised how many stopped.',
    'Seeing how the leader opened conversations.',
  ],
  'What did you find hardest, and how did you handle it?': [
    'The cold in the afternoon; kept moving and kept smiling.',
    'Being ignored at first. Got easier after lunch.',
    'Remembering the pitch; used the card.',
  ],
  'Which part of the pitch felt natural, and which part would you practise?': [
    'The opening is natural. Wants to practise asking for the regular gift.',
    'The story about the research felt natural; the close felt rushed.',
    'Practise the whole thing; nervous today.',
  ],
  'Observer: how did they open conversations (energy, smile, first line)?': [
    'Great energy, smiled at everyone, used a clear first line.',
    'Quiet for the first hour, much better by the afternoon.',
    'Friendly but stood too far back; coached on position.',
  ],
  'Observer: did they follow the fundraising code (no blocking, no pressure, clear about the regular gift)?': [
    'Yes throughout. Clear that it is a monthly gift.',
    'Yes. Once stepped into someone\'s path; corrected straight away.',
    'Mostly; needed reminding to say the gift is monthly.',
  ],
  'If you joined the team, what would you want to learn first?': [
    'How to handle "I already give to charity".',
    'The close, and how to read the tablet sign-up.',
    'How the best people keep their energy all day.',
  ],
  'What have you learned about the role since your observation day?': [
    'That the numbers come from the number of conversations; it is a numbers game.',
    'That it is harder than it looks and the team is supportive.',
  ],
  'Which team or area would suit you best, and why?': [
    'City centre; close to home and busy.',
    'Happy anywhere; prefers retail sites over doors.',
  ],
  'What support would help you most in your first two weeks?': [
    'Pairing with a strong fundraiser for the first few days.',
    'Daily feedback from the leader.',
  ],
  'You would be self-employed: Linear issues a self-billing invoice for you each week and you pay your own tax and National Insurance. What would you like us to explain?': [
    'How to register with HMRC. Pointed to the guide.',
    'Nothing; has been self-employed before.',
  ],
  'What would make you want to stay with us for a year?': [
    'Earning well and a route to leading a team.',
    'A good team and being recognised for effort.',
  ],
};
