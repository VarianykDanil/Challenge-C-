import { Router } from 'express';
import { z } from 'zod';
import type { Campaign } from '@lm/shared';
import { all, run, type Db } from '../db/connection.ts';
import { CAMPAIGN_SELECT, Where, getCampaign, mapCampaign } from '../db/queries.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { hexColor, idParam, isoDate } from '../lib/validate.ts';
import { requireRole } from '../middleware/auth.ts';
import { todayISO } from '../lib/dates.ts';

const campaignBody = z.object({
  name: z.string().trim().min(1),
  code: z.string().trim().min(2).max(6).transform((s) => s.toUpperCase()),
  sector: z.enum(['charity', 'energy', 'telecoms', 'broadband', 'other']),
  type: z.enum(['fundraising', 'b2c', 'b2b']),
  payoutPerSale: z.number().min(0),
  repCommissionPerSale: z.number().min(0),
  color: hexColor,
  active: z.boolean().default(true),
  startDate: isoDate.default(() => todayISO()),
  description: z.string().nullable().optional().default(null),
});

export function campaignsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const where = new Where();
    const active = req.query.active;
    if (active === 'true') where.add('c.active = 1');
    else if (active === 'false') where.add('c.active = 0');
    const rows = all<Campaign>(db, `${CAMPAIGN_SELECT} ${where} ORDER BY c.active DESC, c.name ASC`, where.params).map(mapCampaign);
    res.json(rows);
  });

  router.post('/', requireRole('admin'), (req, res) => {
    const body = campaignBody.parse(req.body);
    if (all(db, `SELECT 1 FROM campaigns WHERE lower(code) = lower(?)`, [body.code]).length) throw conflict(`Campaign code ${body.code} already exists`);
    const r = run(
      db,
      `INSERT INTO campaigns (name, code, sector, type, payout_per_sale, rep_commission_per_sale, color, active, start_date, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [body.name, body.code, body.sector, body.type, body.payoutPerSale, body.repCommissionPerSale, body.color, body.active, body.startDate, body.description],
    );
    res.status(201).json(getCampaign(db, r.lastInsertRowid));
  });

  router.patch('/:id', requireRole('admin'), (req, res) => {
    const id = idParam(req);
    const existing = getCampaign(db, id);
    if (!existing) throw notFound('Campaign');
    const patch = campaignBody.partial().parse(req.body);
    if (patch.code && patch.code.toLowerCase() !== existing.code.toLowerCase()) {
      if (all(db, `SELECT 1 FROM campaigns WHERE lower(code) = lower(?) AND id <> ?`, [patch.code, id]).length) throw conflict(`Campaign code ${patch.code} already exists`);
    }
    const next = { ...existing, ...patch };
    run(
      db,
      `UPDATE campaigns SET name = ?, code = ?, sector = ?, type = ?, payout_per_sale = ?, rep_commission_per_sale = ?, color = ?, active = ?, start_date = ?, description = ? WHERE id = ?`,
      [next.name, next.code, next.sector, next.type, next.payoutPerSale, next.repCommissionPerSale, next.color, next.active, next.startDate, next.description, id],
    );
    res.json(getCampaign(db, id));
  });

  return router;
}
