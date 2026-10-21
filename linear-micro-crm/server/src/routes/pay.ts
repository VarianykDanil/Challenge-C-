/**
 * Release 1.3 — /pay (the 1.3 pay rule: settings, campaign rates, the week's breakdown, bonuses and adjustments) —
 * OWNED BY P1 pay-rule (laid down by r3-foundation as a stub: reads answer empty data, writes 501).
 *
 *  GET    /pay/settings                          → PayRuleSettings (admin)
 *  PUT    /pay/settings  PayRuleSettingsInput    → PayRuleSettings (admin)
 *  GET    /pay/rates?campaignId=                 → CampaignRate[] (admin, leader)
 *  POST   /pay/rates     CampaignRateInput       → 201 CampaignRate (admin)
 *  GET    /pay/breakdown?userId=&weekStart=      → WeekPayBreakdown (own; leader: own team; admin: anyone) — cached
 *  GET    /pay/adjustments?userId=&weekStart=    → PayAdjustment[] (same scoping)
 *  POST   /pay/bonuses   BonusInput              → 201 PayAdjustment (admin)
 *  POST   /pay/adjustments ManualAdjustmentInput → 201 PayAdjustment (admin)
 *  DELETE /pay/adjustments/:id                   → 204 (admin; unpaid target week only)
 * Types: shared/src/types/pay.ts. Helpers: lib/payRule.ts. Audit specs: lib/audit/paySpecs.ts.
 */
import { Router } from 'express';
import type { CampaignRate, PayAdjustment } from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { HttpError } from '../lib/errors.ts';
import { payRuleSettings } from '../lib/payRule.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const notYet = () => {
  throw new HttpError(501, 'The 1.3 pay rule is not available yet');
};

export function payRouter(db: Db): Router {
  const router = Router();
  router.get('/settings', requireRole('admin'), (_req, res) => {
    res.json(payRuleSettings(db));
  });
  router.put('/settings', requireRole('admin'), notYet);
  router.get('/rates', requireRole('admin', 'leader'), (_req, res) => {
    const rows: CampaignRate[] = [];
    res.json(rows);
  });
  router.post('/rates', requireRole('admin'), notYet);
  router.get('/breakdown', (req) => {
    currentUser(req);
    notYet();
  });
  router.get('/adjustments', (req, res) => {
    currentUser(req);
    const rows: PayAdjustment[] = [];
    res.json(rows);
  });
  router.post('/bonuses', requireRole('admin'), notYet);
  router.post('/adjustments', requireRole('admin'), notYet);
  router.delete('/adjustments/:id', requireRole('admin'), notYet);
  return router;
}
