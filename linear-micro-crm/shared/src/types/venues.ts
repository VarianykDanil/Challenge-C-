/**
 * Release 1.3 — P8 venue-insights contracts (laid down by r3-foundation; OWNED BY P8, which may add fields and types).
 *
 * Owner's decision 9 (quote): "Venues repeat: analyse all data per venue (stops, tables, presentations, closes, taps,
 * sales) to PROVE the law of averages, and help every person booked on an event see, from their own and everyone's
 * stats at that venue, exactly how many stops etc. they need for a good number of sales."
 * Lead decision: events get a ROSTER (who is booked). Leaders book their team members; a rep can tap "I'm working
 * this" for their team's events. The venue plan is shown to everyone booked.
 *
 * Venue key: shared `venueKey(venue, city)` (logic/venues.ts, foundation, STABLE) — "golden-square--manchester".
 *
 * Endpoints (owned by P8; stubs: reads empty, writes 501):
 *  routes/venues.ts, mounted at /venues (every staff role; reps see aggregated numbers only, never other named reps):
 *   - GET /venues?sort=sales_per_shift|shifts|last_visit  → VenueSummary[] — cached
 *   - GET /venues/:key                                    → VenueProfile — cached
 *  routes/eventPlans.ts, mounted at /events BEFORE the events router:
 *   - GET    /events/:id/plan[?userId=]        → EventPlan[] (yours; a leader / admin: every booked person) — cached
 *   - GET    /events/:id/roster                → EventBooking[]
 *   - PUT    /events/:id/roster  EventRosterInput → EventBooking[] (leader of the event's team / admin)
 *   - POST   /events/:id/roster/me             → EventBooking[] ("I'm working this": a rep of the event's team)
 *   - DELETE /events/:id/roster/me             → EventBooking[]
 * P8 also owns routes/events.ts (to attach SalesEventWithMeta.bookings) and lib/smart/eventForecast.ts (bookings feed
 * forecasts).
 * Table (server/src/db/extensions/venues.ts): event_roster.
 */
import type { CampaignSector, EventType, GaugeKey, GaugeTotals, FunnelRatios } from '../types.ts';

export type RosterSource = 'leader' | 'self';

export interface EventBooking {
  eventId: number;
  userId: number;
  userName: string;
  avatarColor: string;
  bookedBy: number | null;
  bookedByName?: string | null;
  bookedAt: string;
  source: RosterSource;
}

/** On SalesEventWithMeta.bookings: how many are booked and whether the caller is. */
export interface EventBookingSummary {
  booked: number;
  me: boolean;
}

export interface EventRosterInput {
  /** The complete list of people booked (replaces the leader-booked list; self-bookings stay unless removed here). */
  userIds: number[];
}

/** One step of the plan: "about 120 stops" with a range. */
export interface EventPlanStep {
  key: GaugeKey;
  need: number;
  low: number;
  high: number;
}

/** "To make 5 sales at Golden Square you need about 120 stops → 42 to table → 21 presentations → 9 closes → 6 taps". */
export interface EventPlan {
  eventId: number;
  userId: number;
  userName?: string;
  targetSales: number;
  /** Where the target came from: the event's target per person, or the person's own "good day". */
  targetSource: 'event' | 'good-day';
  steps: EventPlanStep[];
  sentence: string;
  /** 0..1: the weight given to the venue's ratios over the person's own (more when the person has little data). */
  venueWeight: number;
  basis: { ownShifts: number; venueShifts: number };
}

export interface VenueSummary {
  key: string;
  venue: string;
  city: string;
  eventCount: number;
  /** Person-days with gauges at the venue. */
  shifts: number;
  sales: number;
  salesPerShift: number;
  lastVisit: string | null;
  campaigns: string[];
}

/** One person-day at the venue, anonymous (the scatter). */
export interface VenuePoint {
  stops: number;
  sales: number;
  date: string;
}

export interface VenueProfile extends VenueSummary {
  /** Average per person-day of the six gauges. */
  perShift: GaugeTotals;
  ratios: FunnelRatios;
  company: { perShift: GaugeTotals; ratios: FunnelRatios };
  byCampaign: { campaignId: number; code: string; sector: CampaignSector; shifts: number; perShift: GaugeTotals }[];
  byWeekday: { weekday: number; shifts: number; salesPerShift: number }[];
  events: { id: number; name: string; date: string; type: EventType; campaignCode: string; sales: number; people: number }[];
  lawOfAverages: {
    points: VenuePoint[];
    /** Sales per stop from the fitted line through the origin. */
    fittedRate: number;
    /** "At Golden Square, every 24 stops made a sale on average, steady across 41 shifts". */
    sentence: string;
    /** Coefficient of variation per ratio (lower = steadier). */
    stability: Partial<Record<keyof FunnelRatios, number>>;
  };
}
