/**
 * Release 1.3 — /pay (the 1.3 pay rule: settings, campaign rates, the week's breakdown, bonuses and adjustments) —
 * OWNED BY P1 pay-rule.
 *
 *  GET    /pay/settings                          → PayRuleSettings (admin)
 *  PUT    /pay/settings  PayRuleSettingsInput    → PayRuleSettings (admin; unpaid runs it moves are recalculated)
 *  GET    /pay/rates?campaignId=                 → CampaignRate[] (admin, leader; newest first)
 *  POST   /pay/rates     CampaignRateInput       → 201 CampaignRate (admin; unpaid weeks from the date recalculate)
 *  GET    /pay/breakdown?userId=&weekStart=      → WeekPayBreakdown (own; leader: own team; admin: anyone) — cached
 *  GET    /pay/adjustments?userId=&weekStart=    → PayAdjustment[] (same scoping; weekStart = the week they land on)
 *  POST   /pay/bonuses   BonusInput              → 201 PayAdjustment (admin; kind 'bonus', an unpaid week)
 *  POST   /pay/adjustments ManualAdjustmentInput → 201 PayAdjustment (admin; kind 'manual', an unpaid week)
 *  DELETE /pay/adjustments/:id                   → 204 (admin; a bonus or manual line on an unpaid week)
 * Types: shared/src/types/pay.ts. Helpers: lib/payRule.ts. Audit specs: lib/audit/paySpecs.ts. A client account never
 * gets here (the client guard answers 403 first).
 */
import { Router } from 'express';
import { z } from 'zod';
import { MONEY_MAX, type UserWithTeam } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { getUser } from '../db/queries.ts';
import { addDays, mondayOf, todayISO } from '../lib/dates.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import {
  addCampaignRate,
  addPayAdjustment,
  listCampaignRates,
  listPayAdjustments,
  payRuleSettings,
  removePayAdjustment,
  updatePaySettings,
  weekPayBreakdown,
} from '../lib/payRule.ts';
import { idParam, isoDate, moneyAmount, moneyRate, optionalIdQuery, optionalString } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const note = z.string().trim().min(1, 'Say what it is for (the person sees it on their pay)').max(300, 'Keep the note under 300 characters');

const settingsBody = z.object({
  dayRate: z.number().finite().positive().max(500).optional(),
  ruleFrom: isoDate.optional(),
}).strict();

const rateBody = z.object({
  campaignId: z.number().int().positive(),
  repRate: moneyRate,
  payoutRate: moneyAmount,
  effectiveFrom: isoDate,
});

const bonusBody = z.object({
  userId: z.number().int().positive(),
  weekStart: isoDate,
  amount: moneyAmount,
  note,
});

const adjustmentBody = z.object({
  userId: z.number().int().positive(),
  targetWeekStart: isoDate,
  sourceWeekStart: isoDate.nullable().optional(),
  amount: z.number().finite().refine((n) => n !== 0, 'The amount cannot be £0').refine((n) => Math.abs(n) <= MONEY_MAX, 'That amount is too large'),
  note,
});

/** Whose pay `me` may read: their own; a leader their own team's; an admin anyone's. 403 otherwise. */
function assertCanSeePay(me: UserWithTeam, target: UserWithTeam): void {
  if (me.role === 'admin' || me.id === target.id) return;
  if (me.role === 'leader' && me.teamId !== null && target.teamId === me.teamId) return;
  throw forbidden(me.role === 'leader' ? "Leaders can only see their own team's pay" : 'You can only see your own pay');
}

/** The person a pay read is about (default: the caller); 404 for an unknown person or a client account. */
function targetOf(db: Db, me: UserWithTeam, raw: unknown): UserWithTeam {
  const id = optionalIdQuery(raw, 'userId') ?? me.id;
  const target = id === me.id ? me : getUser(db, id);
  if (!target || target.role === 'client') throw notFound('User');
  assertCanSeePay(me, target);
  return target;
}

export function payRouter(db: Db): Router {
  const router = Router();

  router.get('/settings', requireRole('admin'), (_req, res) => {
    res.json(payRuleSettings(db));
  });

  router.put('/settings', requireRole('admin'), (req, res) => {
    const body = settingsBody.parse(req.body ?? {});
    res.json(updatePaySettings(db, body));
  });

  router.get('/rates', requireRole('admin', 'leader'), (req, res) => {
    const campaignId = optionalIdQuery(req.query.campaignId, 'campaignId');
    res.json(listCampaignRates(db, campaignId ?? null));
  });

  router.post('/rates', requireRole('admin'), (req, res) => {
    const body = rateBody.parse(req.body);
    res.status(201).json(addCampaignRate(db, { ...body, source: 'admin' }, currentUser(req).id));
  });

  router.get('/breakdown', (req, res) => {
    const me = currentUser(req);
    const target = targetOf(db, me, req.query.userId);
    const today = todayISO();
    const raw = optionalString(req.query.weekStart);
    const week = raw === undefined ? mondayOf(today) : isoDate.parse(raw);
    if (mondayOf(week) > addDays(mondayOf(today), 28)) throw badRequest('That week is too far ahead');
    const b = weekPayBreakdown(db, target.id, week, { viewerId: me.id, today });
    if (!b) throw notFound('Pay week');
    res.json(b);
  });

  router.get('/adjustments', (req, res) => {
    const me = currentUser(req);
    const raw = optionalString(req.query.weekStart);
    const weekStart = raw === undefined ? undefined : isoDate.parse(raw);
    if (req.query.userId !== undefined && req.query.userId !== '') {
      const target = targetOf(db, me, req.query.userId);
      return res.json(listPayAdjustments(db, { userIds: [target.id], weekStart }));
    }
    if (me.role === 'admin') return res.json(listPayAdjustments(db, { weekStart }));
    // a leader's team includes the leader; a leader without a team, a rep and a recruiter see their own lines
    if (me.role === 'leader' && me.teamId !== null) return res.json(listPayAdjustments(db, { teamId: me.teamId, weekStart }));
    res.json(listPayAdjustments(db, { userIds: [me.id], weekStart }));
  });

  router.post('/bonuses', requireRole('admin'), (req, res) => {
    const body = bonusBody.parse(req.body);
    const created = addPayAdjustment(db, { userId: body.userId, targetWeekStart: body.weekStart, sourceWeekStart: null, kind: 'bonus', amount: body.amount, note: body.note }, currentUser(req).id);
    res.status(201).json(created);
  });

  router.post('/adjustments', requireRole('admin'), (req, res) => {
    const body = adjustmentBody.parse(req.body);
    const created = addPayAdjustment(
      db,
      { userId: body.userId, targetWeekStart: body.targetWeekStart, sourceWeekStart: body.sourceWeekStart ?? null, kind: 'manual', amount: body.amount, note: body.note },
      currentUser(req).id,
    );
    res.status(201).json(created);
  });

  router.delete('/adjustments/:id', requireRole('admin'), (req, res) => {
    removePayAdjustment(db, idParam(req));
    res.status(204).end();
  });

  return router;
}
