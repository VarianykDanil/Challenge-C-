/**
 * Event forecasts — OWNED BY p6-event-forecasts-roster.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p6 replaces the bodies.
 *
 * eventForecasts(db, events, today): scheduled / live events only (completed and cancelled get none); exactly 2
 * grouped queries per call whatever the number of events; returns eventId → forecast. GET /events and
 * GET /events/:id attach `forecast` for every event id present in the Map.
 * forecastFor(db, params, today): backs GET /events/forecast (route, validation and role check wired by P1).
 */
import type { EventForecast, EventType, SalesEventWithMeta } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import { smartEnabled } from './enabled.ts';

export interface ForecastParams {
  campaignId: number;
  teamId: number;
  type: EventType;
  /** The target being considered (repsNeeded / flag); omitted → no target yet. */
  targetSales?: number;
}

export function eventForecasts(db: Db, events: readonly SalesEventWithMeta[], today: string): Map<number, EventForecast> {
  void db;
  void events;
  void today;
  if (!smartEnabled()) return new Map();
  return new Map();
}

export function forecastFor(db: Db, params: ForecastParams, today: string): EventForecast | null {
  void db;
  void params;
  void today;
  if (!smartEnabled()) return null;
  return null;
}
