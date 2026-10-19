// The dashboard-only smart components, gathered so React.lazy fetches them as ONE small chunk (one request over a
// mobile hotspot) after the dashboard page itself. Import them through ./lazy.tsx, never directly from a page: a static
// import anywhere would pull them back into that page's chunk (or the main one).
export { AttentionCard } from './AttentionCard';
export { BaselineNote } from './BaselineNote';
export { CheckInList } from './CheckInList';
export { TeamCoaching } from './TeamCoaching';
export { WeekInReview } from './WeekInReview';
export { WeekPayStrip } from './WeekPayStrip';
