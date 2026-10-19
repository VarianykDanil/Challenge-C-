// Smart release 1.1 dashboard slots (p1 lays them down; each file names its owning package).
// The dashboard-only components are exported as their on-demand wrappers (./lazy.tsx: LazyAttentionCard,
// LazyWeekPayStrip, LazyBaselineNote, LazyCheckInList, LazyTeamCoaching, LazyWeekInReview); re-exporting the components
// themselves here would pull them back into whichever chunk imports this file. AttentionRow is global (the bell).
export * from './AttentionRow';
export * from './lazy';
export * from './streakHint';
