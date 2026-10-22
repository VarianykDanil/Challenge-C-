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
 * Endpoints (owned by P8):
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
 *
 * What counts (docs/r3/P8-venue-insights.md, "Logic"): a SHIFT is one person's gauge entry at one event (one person-day).
 * Only finished days count: entries dated before today on events that are not live (a half-logged day would drag the
 * averages down). A VISIT is an event at the venue with at least one counted shift.
 */
import type { CampaignSector, EventStatus, EventType, GaugeKey, GaugeTotals, FunnelRatios } from '../types.ts';

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
  /** Re-review fix: booked but on leave now (still booked and counted; the leader may take them off). */
  onLeave?: boolean;
}

/** On SalesEventWithMeta.bookings: how many are booked and whether the caller is. */
export interface EventBookingSummary {
  booked: number;
  me: boolean;
  /**
   * Release 1.3 (P8): the caller's own aim for the day ("120 stops → 42 → 21 → 9 → 6 taps for 5 sales") — on GET /events
   * and GET /events/:id, only when `me` is true, the event is still open (scheduled or live, today or later), there is
   * something to plan from, and LM_SMART is on. The same numbers as GET /events/:id/plan, so a list needs no request
   * per row.
   */
  aim?: EventAim;
}

/** Release 1.3 (P8): the compact plan carried on an event row (EventBookingSummary.aim). */
export interface EventAim {
  targetSales: number;
  steps: EventPlanStep[];
}

/**
 * PUT /events/:id/roster: either the complete list (`userIds`, replaces the roster) or the changes (`add` / `remove`,
 * re-review fix: Edit bookings sends these, so someone who tapped "I'm working this" meanwhile stays booked).
 */
export type EventRosterInput = { userIds: number[] } | { add?: number[]; remove?: number[] };

/** One step of the plan: "about 120 stops" with a range. */
export interface EventPlanStep {
  key: GaugeKey;
  /** What the plan aims for (whole number, rounded up). */
  need: number;
  /** A lucky day / a slow day: the stage count at which the target sits one standard deviation of luck away. */
  low: number;
  high: number;
}

/**
 * Where the plan's sales target came from: the event's target shared among the people booked ('event'), the person's
 * own good day ('good-day': 75th percentile of their sales per shift, last 8 weeks) or, for someone with fewer than 5
 * shifts, a good day at the venue ('venue-good-day'). The higher of the event's share and the good day wins.
 */
export type EventPlanTargetSource = 'event' | 'good-day' | 'venue-good-day';

/** "To make 5 sales at Golden Square you need about 120 stops → 42 to table → 21 presentations → 9 closes → 6 taps". */
export interface EventPlan {
  eventId: number;
  userId: number;
  userName?: string;
  /** Release 1.3 (P8): the person's avatar colour (the leader's list). */
  avatarColor?: string;
  targetSales: number;
  /** Where the target came from: the event's target per person, or the person's own "good day". */
  targetSource: EventPlanTargetSource;
  /** Five steps, stops → taps (empty when there are no gauges anywhere to plan from). */
  steps: EventPlanStep[];
  sentence: string;
  /** 0..1: the weight given to the venue's ratios over the person's own (more when the person has little data). */
  venueWeight: number;
  basis: { ownShifts: number; venueShifts: number };
  /**
   * Release 1.3 (P8): the event's target ÷ the people expected to work it (`sharedAmong`), rounded up (null without a
   * target).
   */
  eventShare?: number | null;
  /**
   * Release 1.3 (P8): how many people the event's target is shared among: the people booked once a leader (or the
   * office) has booked anyone; while only self-bookings exist, the larger of them and the team's usual turnout; on a
   * live event, at least the people who have logged it (shared logic expectedHeadcount).
   */
  sharedAmong?: number | null;
  /**
   * Release 1.3 (P8): true when the event's share is more than 1.5 × the good day and at least 2 sales above it: the
   * plan then aims for the good day and the page says what the event's share is (an aim nobody reaches helps nobody).
   */
  shareAboveGoodDay?: boolean;
  /**
   * Release 1.3 (P8): true when the plan was built from the venue's numbers only, for a leader reading the plan of
   * someone booked from another team (their own numbers and good day are not the leader's to see).
   */
  limited?: boolean;
  /** Release 1.3 (P8): the good day the target was compared with (the person's own, else the venue's; null when thin). */
  goodDay?: number | null;
  /** Release 1.3 (P8): the venue's name as the plan reads it. */
  venueName?: string;
  /** Release 1.3 (P8): the blended stage ratios the steps come from (0..1). */
  ratios?: Record<'stopToTable' | 'tableToPresentation' | 'presentationToClose' | 'closeToTap' | 'tapToSale', number>;
}

export interface VenueSummary {
  key: string;
  venue: string;
  city: string;
  /** Visits: events at the venue with at least one counted shift. */
  eventCount: number;
  /** Person-days with gauges at the venue. */
  shifts: number;
  sales: number;
  salesPerShift: number;
  lastVisit: string | null;
  /** Campaign codes worked or booked at the venue, most shifts first. */
  campaigns: string[];
  /** Release 1.3 (P8): the next scheduled or live event at the venue (today or later), or null. */
  nextVisit?: string | null;
  /** Release 1.3 (P8): total stops (for "stops per sale"). */
  stops?: number;
}

/** One person-day at the venue, anonymous (the scatter). */
export interface VenuePoint {
  stops: number;
  sales: number;
  date: string;
}

/** How steady a ratio is from visit to visit, against what luck alone would give. */
export type VenueStability = 'steady' | 'fairly_steady' | 'varies';

/** One third of the venue's shifts by stops ("Most stops (67–120): 2.9 sales a shift"). */
export interface VenueStopBand {
  band: 'fewest' | 'middle' | 'most';
  minStops: number;
  maxStops: number;
  shifts: number;
  avgStops: number;
  salesPerShift: number;
}

/** A named person's numbers at the venue (admins: everyone; a leader: their own team and themself; never reps). */
export interface VenuePerson {
  userId: number;
  name: string;
  avatarColor: string;
  shifts: number;
  sales: number;
  salesPerShift: number;
  stopsPerSale: number | null;
  lastVisit: string;
}

/** The caller's own numbers at the venue. */
export interface VenueYou {
  shifts: number;
  sales: number;
  salesPerShift: number;
  perShift: GaugeTotals;
  ratios: FunnelRatios;
}

export type VenueStabilityKey = 'stopToTable' | 'tableToPresentation' | 'presentationToClose' | 'closeToTap' | 'tapToSale' | 'overallConversion';

/** Release 1.3 (P8): a group's figures per shift (a campaign or a weekday), at the venue or company-wide. */
export interface VenueGroupFigures {
  shifts: number;
  perShift: GaugeTotals;
  ratios: FunnelRatios;
  salesPerShift: number;
}

export interface VenueProfile extends VenueSummary {
  /** Average per person-day of the six gauges. */
  perShift: GaugeTotals;
  ratios: FunnelRatios;
  company: { perShift: GaugeTotals; ratios: FunnelRatios; shifts?: number; salesPerShift?: number };
  /**
   * Release 1.3 (P8) adds `ratios` (the stage ratios here) and `company` (the same campaign everywhere: every counted
   * shift of that campaign in the company).
   */
  byCampaign: { campaignId: number; code: string; sector: CampaignSector; shifts: number; perShift: GaugeTotals; name?: string; color?: string; salesPerShift?: number; ratios?: FunnelRatios; company?: VenueGroupFigures }[];
  /**
   * ISO weekday: 1 = Monday … 7 = Sunday; only days with shifts. Release 1.3 (P8) adds `perShift` (the six gauges),
   * `ratios` and `company` (the same weekday everywhere in the company).
   */
  byWeekday: { weekday: number; shifts: number; salesPerShift: number; stopsPerShift?: number; perShift?: GaugeTotals; ratios?: FunnelRatios; company?: VenueGroupFigures }[];
  /** Every event at the venue, newest first (upcoming ones too: sales and people 0 until logged). */
  events: { id: number; name: string; date: string; type: EventType; campaignCode: string; sales: number; people: number; status?: EventStatus; teamName?: string; campaignColor?: string; booked?: number }[];
  lawOfAverages: {
    points: VenuePoint[];
    /** Sales per stop from the fitted line through the origin. */
    fittedRate: number;
    /** "At Golden Square, every 24 stops made a sale on average, steady across 41 shifts". */
    sentence: string;
    /** Coefficient of variation per ratio (lower = steadier). */
    stability: Partial<Record<keyof FunnelRatios, number>>;
    /** Release 1.3 (P8): each ratio's CV against luck alone (visits with that stage only; ≥ 3 visits). */
    steadiness?: Partial<Record<VenueStabilityKey, VenueStability>>;
    /** Release 1.3 (P8): the CV luck alone would give (binomial noise), per ratio. */
    chanceCv?: Partial<Record<VenueStabilityKey, number>>;
    /** Release 1.3 (P8): stops per sale (1 ÷ fittedRate), null without sales. */
    stopsPerSale?: number | null;
    /** Release 1.3 (P8): Pearson correlation of stops and sales per shift (null below 3 shifts or with no spread). */
    correlation?: number | null;
    /** Release 1.3 (P8): the shifts in three equal groups by stops (empty below 9 shifts). */
    bands?: VenueStopBand[];
    /** Release 1.3 (P8): the visits the stability is measured over. */
    visits?: number;
    /** Release 1.3 (P8): true when `points` holds only the most recent shifts (the figures use every shift). */
    pointsCapped?: boolean;
  };
  /** Release 1.3 (P8): the caller's own numbers here (absent without a shift at the venue). */
  you?: VenueYou;
  /** Release 1.3 (P8): named people (admins: everyone; a leader: own team and themself). Absent for reps and recruiters. */
  people?: VenuePerson[];
}
