/** Static reference data for the seed. Dynamic dates (recent starters, leavers) are expressed in weeks ago. */
import type { CampaignSector, CampaignType, EventType, Position, Role, UserStatus } from '@lm/shared';

export const AVATAR_PALETTE = [
  '#4F46E5', '#0891B2', '#059669', '#D97706', '#DC2626', '#7C3AED', '#DB2777',
  '#2563EB', '#0D9488', '#CA8A04', '#EA580C', '#9333EA', '#16A34A', '#BE185D',
];

export interface TeamSeed {
  name: string;
  color: string;
  /** Campaign code → weight for picking the day's campaign. */
  campaignMix: [string, number][];
}

export const TEAMS: TeamSeed[] = [
  { name: 'Northern Lights', color: '#2563EB', campaignMix: [['BCN', 50], ['CHN', 20], ['FCB', 20], ['VLT', 10]] },
  { name: 'Deansgate', color: '#DC2626', campaignMix: [['VLT', 45], ['FCB', 25], ['BCN', 30]] },
  { name: 'Spinningfields', color: '#059669', campaignMix: [['CHN', 45], ['BCN', 25], ['FCB', 30]] },
  { name: 'Ancoats', color: '#D97706', campaignMix: [['FCB', 45], ['VLT', 25], ['BCN', 30]] },
];

export interface PayPlanSeed {
  name: string;
  position: Position;
  basePerDay: number;
  commissionPerSale: number;
  bonusThreshold: number;
  bonusAmount: number;
  overridePerTeamSale: number;
}

export const PAY_PLANS: PayPlanSeed[] = [
  { name: 'Trainee plan', position: 'trainee', basePerDay: 80, commissionPerSale: 25, bonusThreshold: 10, bonusAmount: 50, overridePerTeamSale: 0 },
  { name: 'Field rep plan', position: 'field_rep', basePerDay: 60, commissionPerSale: 45, bonusThreshold: 12, bonusAmount: 75, overridePerTeamSale: 0 },
  { name: 'Team leader plan', position: 'team_leader', basePerDay: 70, commissionPerSale: 45, bonusThreshold: 12, bonusAmount: 100, overridePerTeamSale: 8 },
  { name: 'Crew leader plan', position: 'crew_leader', basePerDay: 90, commissionPerSale: 45, bonusThreshold: 15, bonusAmount: 150, overridePerTeamSale: 12 },
  { name: 'Assistant owner plan', position: 'assistant_owner', basePerDay: 120, commissionPerSale: 40, bonusThreshold: 0, bonusAmount: 0, overridePerTeamSale: 15 },
  { name: 'Owner (salaried)', position: 'owner', basePerDay: 0, commissionPerSale: 0, bonusThreshold: 0, bonusAmount: 0, overridePerTeamSale: 20 },
];

export interface CampaignSeed {
  name: string;
  code: string;
  sector: CampaignSector;
  type: CampaignType;
  payoutPerSale: number;
  repCommissionPerSale: number;
  color: string;
  startDate: string;
  description: string;
  /** Event types this campaign runs, weighted. */
  eventTypes: [EventType, number][];
}

export const CAMPAIGNS: CampaignSeed[] = [
  {
    name: 'Breast Cancer Now', code: 'BCN', sector: 'charity', type: 'fundraising', payoutPerSale: 120, repCommissionPerSale: 45,
    color: '#EC4899', startDate: '2024-03-04',
    description: 'Regular-giving sign-ups for Breast Cancer Now at private sites and shopping centres across the North West.',
    eventTypes: [['private_site', 60], ['retail', 40]],
  },
  {
    name: "Children's Hospice North", code: 'CHN', sector: 'charity', type: 'fundraising', payoutPerSale: 110, repCommissionPerSale: 45,
    color: '#8B5CF6', startDate: '2024-09-02',
    description: 'Monthly donor acquisition for the regional children\'s hospice network at public events and venues.',
    eventTypes: [['event', 50], ['retail', 30], ['private_site', 20]],
  },
  {
    name: 'Volt Energy', code: 'VLT', sector: 'energy', type: 'b2b', payoutPerSale: 150, repCommissionPerSale: 55,
    color: '#F59E0B', startDate: '2025-01-13',
    description: 'Business energy switching for SMEs — business parks and high streets across Greater Manchester.',
    eventTypes: [['b2b', 100]],
  },
  {
    name: 'FibreCity Broadband', code: 'FCB', sector: 'broadband', type: 'b2c', payoutPerSale: 95, repCommissionPerSale: 40,
    color: '#06B6D4', startDate: '2025-06-02',
    description: 'Full-fibre broadband sign-ups in newly enabled residential patches, plus retail pop-ups.',
    eventTypes: [['residential', 60], ['retail', 40]],
  },
];

export interface VenueSeed {
  venue: string;
  city: string;
}

export const VENUES: Record<EventType, VenueSeed[]> = {
  retail: [
    { venue: 'Trafford Centre', city: 'Manchester' },
    { venue: 'Manchester Arndale', city: 'Manchester' },
    { venue: 'Bolton Market Place', city: 'Bolton' },
    { venue: 'Stockport Merseyway', city: 'Stockport' },
    { venue: 'Preston Fishergate', city: 'Preston' },
    { venue: 'Leeds Trinity', city: 'Leeds' },
    { venue: 'Liverpool ONE', city: 'Liverpool' },
    { venue: 'Lowry Outlet, Salford Quays', city: 'Salford' },
    { venue: 'Middlebrook Retail Park', city: 'Bolton' },
    { venue: 'Golden Square', city: 'Warrington' },
    { venue: 'Grand Arcade', city: 'Wigan' },
    { venue: 'Spindles Town Square', city: 'Oldham' },
    { venue: 'Rochdale Riverside', city: 'Rochdale' },
    { venue: 'Mill Gate', city: 'Bury' },
  ],
  private_site: [
    { venue: 'Manchester Piccadilly station', city: 'Manchester' },
    { venue: 'Manchester Victoria station', city: 'Manchester' },
    { venue: 'Tesco Extra Stretford', city: 'Manchester' },
    { venue: 'Asda Hulme', city: 'Manchester' },
    { venue: "Sainsbury's Fallowfield", city: 'Manchester' },
    { venue: 'Morrisons Chorlton', city: 'Manchester' },
    { venue: 'MediaCity Piazza', city: 'Salford' },
    { venue: 'St Peter\'s Square', city: 'Manchester' },
    { venue: 'Market Street', city: 'Manchester' },
    { venue: 'Tesco Extra Walkden', city: 'Salford' },
    { venue: 'Asda Ashton-under-Lyne', city: 'Ashton-under-Lyne' },
    { venue: 'Bolton Interchange', city: 'Bolton' },
  ],
  event: [
    { venue: 'Heaton Park', city: 'Manchester' },
    { venue: 'Etihad Campus fan zone', city: 'Manchester' },
    { venue: 'Albert Square', city: 'Manchester' },
    { venue: 'Didsbury Festival', city: 'Manchester' },
    { venue: 'Salford Food & Drink Festival', city: 'Salford' },
    { venue: 'Chorlton Arts Festival', city: 'Manchester' },
    { venue: 'Castlefield Bowl', city: 'Manchester' },
    { venue: 'Tatton Park', city: 'Knutsford' },
    { venue: 'Sale Waterside', city: 'Sale' },
    { venue: 'Platt Fields Park', city: 'Manchester' },
    { venue: 'Bury Market', city: 'Bury' },
    { venue: 'Southport Promenade', city: 'Southport' },
  ],
  b2b: [
    { venue: 'Trafford Park', city: 'Manchester' },
    { venue: 'MediaCityUK', city: 'Salford' },
    { venue: 'Manchester Business Park', city: 'Manchester' },
    { venue: 'Birchwood Park', city: 'Warrington' },
    { venue: 'Wavertree Technology Park', city: 'Liverpool' },
    { venue: 'Middlebrook Business Park', city: 'Bolton' },
    { venue: 'Spinningfields', city: 'Manchester' },
    { venue: 'Cheadle Royal Business Park', city: 'Cheadle' },
    { venue: 'Stockport town centre', city: 'Stockport' },
    { venue: 'Ancoats & Northern Quarter', city: 'Manchester' },
    { venue: 'Altrincham town centre', city: 'Altrincham' },
    { venue: 'Thorpe Park Leeds', city: 'Leeds' },
  ],
  residential: [
    { venue: 'Didsbury', city: 'Manchester' },
    { venue: 'Chorlton', city: 'Manchester' },
    { venue: 'Sale', city: 'Sale' },
    { venue: 'Altrincham', city: 'Altrincham' },
    { venue: 'Prestwich', city: 'Manchester' },
    { venue: 'Heaton Moor', city: 'Stockport' },
    { venue: 'Cheadle Hulme', city: 'Stockport' },
    { venue: 'Urmston', city: 'Manchester' },
    { venue: 'Worsley', city: 'Salford' },
    { venue: 'Bramhall', city: 'Stockport' },
    { venue: 'Wilmslow', city: 'Wilmslow' },
    { venue: 'Timperley', city: 'Altrincham' },
    { venue: 'Monton', city: 'Salford' },
    { venue: 'Whitefield', city: 'Bury' },
  ],
};

export const EVENT_TIMES: Record<EventType, [string, string][]> = {
  retail: [['10:00', '18:00'], ['09:30', '17:30'], ['10:00', '17:00']],
  private_site: [['10:00', '18:00'], ['09:00', '17:00'], ['08:30', '16:30']],
  event: [['11:00', '19:00'], ['10:00', '17:00'], ['12:00', '20:00']],
  b2b: [['09:00', '17:00'], ['09:30', '17:30']],
  residential: [['12:00', '20:00'], ['13:00', '20:30'], ['11:00', '19:00']],
};

export interface UserSeed {
  no: number; // employee number → LM-XXXX, also the row id
  firstName: string;
  lastName: string;
  email?: string;
  role: Role;
  position: Position;
  team: string | null;
  /** fixed ISO date or weeks before today */
  start: string | { weeksAgo: number };
  status: UserStatus;
  city: string;
  /** Multiplier on funnel ratios (1 = benchmark). */
  skill: number;
  /** Skill at the end of the window (linear trend) when different from `skill`. */
  skillEnd?: number;
  /** For `left` users: weeks ago they stopped attending. For `on_leave`: weeks ago the leave began. */
  stoppedWeeksAgo?: number;
  /** Per-event attendance probability override (used for owners with no team). */
  attendance?: number;
  leadsTeam?: boolean;
}

export const USERS: UserSeed[] = [
  { no: 1, firstName: 'Danil', lastName: 'Varianyk', email: 'danil@linear-mcr.co.uk', role: 'admin', position: 'owner', team: null, start: '2024-02-27', status: 'active', city: 'Manchester', skill: 1.3, attendance: 0.04 },
  { no: 2, firstName: 'Amelia', lastName: 'Hart', role: 'leader', position: 'crew_leader', team: 'Northern Lights', start: '2024-03-04', status: 'active', city: 'Salford', skill: 1.2, leadsTeam: true },
  { no: 3, firstName: 'Priya', lastName: 'Shah', role: 'recruiter', position: 'field_rep', team: null, start: '2024-06-10', status: 'active', city: 'Manchester', skill: 1, attendance: 0 },
  { no: 4, firstName: 'Marcus', lastName: 'Doyle', role: 'admin', position: 'assistant_owner', team: null, start: '2024-04-15', status: 'active', city: 'Manchester', skill: 1.2, attendance: 0.08 },
  { no: 5, firstName: 'Oliver', lastName: 'Bennett', role: 'leader', position: 'team_leader', team: 'Northern Lights', start: '2024-05-13', status: 'active', city: 'Stockport', skill: 1.12 },
  { no: 6, firstName: 'Thomas', lastName: 'Grainger', role: 'leader', position: 'team_leader', team: 'Deansgate', start: '2024-07-01', status: 'active', city: 'Manchester', skill: 1.15, leadsTeam: true },
  { no: 7, firstName: 'Olivia', lastName: 'Kaur', role: 'leader', position: 'team_leader', team: 'Spinningfields', start: '2024-09-16', status: 'active', city: 'Bolton', skill: 1.18, leadsTeam: true },
  { no: 8, firstName: 'Rhys', lastName: 'Morgan', role: 'leader', position: 'team_leader', team: 'Ancoats', start: '2025-01-06', status: 'active', city: 'Oldham', skill: 1.1, leadsTeam: true },
  { no: 9, firstName: 'Chloe', lastName: 'Whitfield', role: 'rep', position: 'field_rep', team: 'Northern Lights', start: '2024-08-05', status: 'active', city: 'Manchester', skill: 1.05 },
  { no: 10, firstName: 'Jordan', lastName: 'Lee', role: 'rep', position: 'field_rep', team: 'Northern Lights', start: '2025-03-10', status: 'active', city: 'Manchester', skill: 0.82, skillEnd: 1.22 },
  { no: 11, firstName: 'Harry', lastName: 'Donnelly', role: 'rep', position: 'field_rep', team: 'Northern Lights', start: '2025-06-02', status: 'active', city: 'Salford', skill: 1 },
  { no: 12, firstName: 'Sophie', lastName: 'Marsh', role: 'rep', position: 'trainee', team: 'Northern Lights', start: { weeksAgo: 13 }, status: 'active', city: 'Manchester', skill: 0.8 },
  { no: 13, firstName: 'Callum', lastName: 'Reid', role: 'rep', position: 'trainee', team: 'Northern Lights', start: { weeksAgo: 5 }, status: 'active', city: 'Bury', skill: 0.75 },
  { no: 14, firstName: 'Megan', lastName: 'Price', role: 'rep', position: 'field_rep', team: 'Northern Lights', start: '2025-02-03', status: 'on_leave', city: 'Rochdale', skill: 1, stoppedWeeksAgo: 6 },
  { no: 15, firstName: 'Isla', lastName: 'Moran', role: 'rep', position: 'field_rep', team: 'Deansgate', start: '2024-10-07', status: 'active', city: 'Manchester', skill: 1.1 },
  { no: 16, firstName: 'Ethan', lastName: 'Clarke', role: 'rep', position: 'field_rep', team: 'Deansgate', start: '2025-01-20', status: 'active', city: 'Manchester', skill: 1.18, skillEnd: 0.74 },
  { no: 17, firstName: 'Freya', lastName: 'Dawson', role: 'rep', position: 'field_rep', team: 'Deansgate', start: '2025-05-12', status: 'active', city: 'Sale', skill: 1 },
  { no: 18, firstName: 'Liam', lastName: 'Hughes', role: 'rep', position: 'trainee', team: 'Deansgate', start: { weeksAgo: 9 }, status: 'active', city: 'Wigan', skill: 0.8 },
  { no: 19, firstName: 'Grace', lastName: 'Patel', role: 'rep', position: 'field_rep', team: 'Deansgate', start: { weeksAgo: 21 }, status: 'active', city: 'Manchester', skill: 0.95 },
  { no: 20, firstName: 'Ben', lastName: 'Ashworth', role: 'rep', position: 'field_rep', team: 'Deansgate', start: '2025-04-07', status: 'left', city: 'Bolton', skill: 0.95, stoppedWeeksAgo: 10 },
  { no: 21, firstName: 'Jack', lastName: 'Thornton', role: 'rep', position: 'field_rep', team: 'Spinningfields', start: '2024-11-04', status: 'active', city: 'Manchester', skill: 1.05 },
  { no: 22, firstName: 'Ruby', lastName: 'Fletcher', role: 'rep', position: 'field_rep', team: 'Spinningfields', start: '2025-03-24', status: 'active', city: 'Stockport', skill: 1.1 },
  { no: 23, firstName: 'Noah', lastName: 'Simmons', role: 'rep', position: 'trainee', team: 'Spinningfields', start: { weeksAgo: 7 }, status: 'active', city: 'Salford', skill: 0.8 },
  { no: 24, firstName: 'Ella', lastName: 'Brooks', role: 'rep', position: 'field_rep', team: 'Spinningfields', start: '2025-07-14', status: 'active', city: 'Altrincham', skill: 1 },
  { no: 25, firstName: 'Aaron', lastName: 'Okafor', role: 'rep', position: 'field_rep', team: 'Spinningfields', start: { weeksAgo: 19 }, status: 'active', city: 'Manchester', skill: 0.95 },
  { no: 26, firstName: 'Daisy', lastName: 'Holt', role: 'rep', position: 'trainee', team: 'Spinningfields', start: { weeksAgo: 3 }, status: 'active', city: 'Preston', skill: 0.75 },
  { no: 27, firstName: 'Lucy', lastName: 'Chambers', role: 'rep', position: 'field_rep', team: 'Ancoats', start: '2025-02-17', status: 'active', city: 'Manchester', skill: 1.05 },
  { no: 28, firstName: 'Mohammed', lastName: 'Iqbal', role: 'rep', position: 'field_rep', team: 'Ancoats', start: '2025-04-28', status: 'active', city: 'Oldham', skill: 1.1 },
  { no: 29, firstName: 'Hannah', lastName: 'Rowe', role: 'rep', position: 'field_rep', team: 'Ancoats', start: '2025-09-08', status: 'active', city: 'Ashton-under-Lyne', skill: 1 },
  { no: 30, firstName: 'George', lastName: 'Wilde', role: 'rep', position: 'trainee', team: 'Ancoats', start: { weeksAgo: 11 }, status: 'active', city: 'Manchester', skill: 0.8 },
  { no: 31, firstName: 'Zara', lastName: 'Ahmed', role: 'rep', position: 'field_rep', team: 'Ancoats', start: { weeksAgo: 23 }, status: 'active', city: 'Manchester', skill: 1 },
  { no: 32, firstName: 'Kieran', lastName: 'Walsh', role: 'rep', position: 'field_rep', team: 'Ancoats', start: '2025-08-18', status: 'left', city: 'Leigh', skill: 0.9, stoppedWeeksAgo: 5 },
  { no: 33, firstName: 'Tyler', lastName: 'Brennan', role: 'rep', position: 'trainee', team: 'Deansgate', start: { weeksAgo: 17 }, status: 'left', city: 'Manchester', skill: 0.7, stoppedWeeksAgo: 8 },
  { no: 34, firstName: 'Amber', lastName: 'Gill', role: 'rep', position: 'trainee', team: 'Ancoats', start: { weeksAgo: 14 }, status: 'left', city: 'Stockport', skill: 0.7, stoppedWeeksAgo: 4 },
];

export const CANDIDATE_FIRST_NAMES = [
  'Alfie', 'Amara', 'Archie', 'Ayesha', 'Bethany', 'Billy', 'Cameron', 'Charlotte', 'Connor', 'Courtney', 'Declan', 'Demi',
  'Dylan', 'Eleanor', 'Elliot', 'Emily', 'Evie', 'Finley', 'Georgia', 'Hamza', 'Holly', 'Imogen', 'Isaac', 'Jade', 'Jamie',
  'Jasmine', 'Jayden', 'Jessica', 'Joel', 'Josh', 'Kayleigh', 'Kyle', 'Lauren', 'Leah', 'Lewis', 'Louie', 'Maisie', 'Mason',
  'Matilda', 'Maya', 'Mia', 'Molly', 'Nathan', 'Niamh', 'Owen', 'Paige', 'Poppy', 'Reece', 'Rhiannon', 'Rosie', 'Ryan',
  'Sam', 'Scarlett', 'Sean', 'Shannon', 'Sienna', 'Taylor', 'Theo', 'Toby', 'Yasmin', 'Zach', 'Ibrahim', 'Fatima', 'Kwame', 'Aisha',
];

export const CANDIDATE_LAST_NAMES = [
  'Adams', 'Ali', 'Atkinson', 'Bailey', 'Barker', 'Begum', 'Bell', 'Booth', 'Bradley', 'Burke', 'Carter', 'Collins', 'Cooper',
  'Cox', 'Dixon', 'Doherty', 'Ellis', 'Evans', 'Fisher', 'Foster', 'Gibson', 'Graham', 'Griffiths', 'Hall', 'Harrison',
  'Hassan', 'Hill', 'Howard', 'Hussain', 'Jenkins', 'Johnson', 'Jones', 'Kelly', 'Khan', 'King', 'Knight', 'Lawson', 'Lloyd',
  'Marshall', 'Mason', 'McCarthy', 'Mills', 'Mitchell', 'Murphy', 'Murray', 'Nolan', 'O\'Brien', 'Owen', 'Palmer', 'Parker',
  'Pearson', 'Powell', 'Quinn', 'Rahman', 'Richards', 'Robinson', 'Rogers', 'Ryan', 'Saunders', 'Shaw', 'Stewart', 'Sykes',
  'Taylor', 'Turner', 'Walker', 'Ward', 'Watson', 'Webb', 'West', 'Wood', 'Wright', 'Young',
];

export const CANDIDATE_CITIES = [
  'Manchester', 'Salford', 'Stockport', 'Bolton', 'Bury', 'Oldham', 'Rochdale', 'Wigan', 'Trafford', 'Tameside', 'Warrington',
  'Altrincham', 'Sale', 'Stretford', 'Prestwich', 'Eccles', 'Ashton-under-Lyne', 'Leigh',
];

export const EMAIL_DOMAINS = ['gmail.com', 'outlook.com', 'hotmail.co.uk', 'icloud.com', 'yahoo.co.uk'];

export const GAUGE_NOTES = [
  'Busy footfall after lunch, slow start.',
  'Rain all morning — moved under cover at 1pm.',
  'New opener landing well, lots of tables.',
  'Security moved the stand at 3pm, lost an hour.',
  'Great energy today, two referrals from one family.',
  'Lots of browsers, few decision makers.',
  'Half day — doctor\'s appointment in the afternoon.',
  'Trained a new starter for the first two hours.',
  'Site manager asked us to keep to the east entrance.',
  'Strong close rate, taps let me down.',
];

export const STAGE_NOTES: Record<string, string[]> = {
  screening: ['Good phone manner, keen to start.', 'Available immediately, has retail experience.', 'Some sales background at a call centre.', 'Student looking for full-time over summer.'],
  interview: ['Confident in the role play, needs work on objection handling.', 'Great attitude; coachable.', 'Quiet but thoughtful, asked good questions.', 'Strong communicator — fast-tracked.'],
  observation: ['Shadowed the team at Trafford Centre; got stuck in.', 'Observation day at Arndale went well, 2 tables of their own.', 'Enjoyed the day, comfortable approaching the public.'],
  offer: ['Verbal offer made, start date agreed.', 'Offer sent — awaiting signed paperwork.'],
  hired: ['Started induction. Welcome aboard!', 'Onboarded, first field day booked.'],
  rejected: ['Not the right fit for a field role.', 'Unable to commit to the hours.', 'Did not pass the phone screen.', 'No show for the observation day.', 'Struggled with the role play.'],
  withdrawn: ['Accepted another role.', 'Changed mind about commuting.', 'Going back to university.', 'Family circumstances.'],
};

export const NEXT_ACTIONS: Record<string, string> = {
  applied: 'Phone screen',
  screening: 'Book first interview',
  interview: 'Schedule observation day',
  observation: 'Decision & offer call',
  offer: 'Chase offer acceptance',
};

export const CANDIDATE_NOTES = [
  'Heard about us from a friend who works at a competitor.',
  'Looking for progression into a leadership role.',
  'Recently relocated to Manchester.',
  'Has a full UK driving licence.',
  'Prefers weekday shifts.',
  'Charity work experience with a local food bank.',
];
