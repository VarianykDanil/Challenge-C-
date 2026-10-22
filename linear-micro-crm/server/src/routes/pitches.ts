/**
 * Release 1.2 — /pitches — OWNED BY L2 learning-pitch.
 *
 *  GET /pitches                → PitchListItem[] (every signed-in role): one row per campaign, active first — cached
 *  GET /pitches/:campaignCode  → CampaignPitch (every signed-in role); 404 "Campaign not found" for an unknown code,
 *                                404 "Pitch not found" when the campaign has no pitch yet — cached
 *  PUT /pitches/:campaignCode  PitchUpsertInput → CampaignPitch (admin, leader): creates (201) or replaces (200) the
 *                                campaign's pitch and records who saved it. `facts` left out keeps the saved notes;
 *                                null or blank clears them. Only an admin (the office) may change `facts`: a leader's
 *                                PUT that would change them (clearing included) is 403 "Only the office can change the
 *                                fact-check notes" and saves nothing; left out or sent back unchanged is fine.
 * Pitches are company-wide training material (campaigns are not team-scoped), so every role reads every pitch.
 * Types: shared/src/types/pitches.ts. Mounted in app.ts with requireAuth; '/pitches' is in CACHED_PATHS, and every
 * PUT bumps the data version (app.ts), so the next read is fresh. U3's audit middleware records the edits.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  PITCH_BODY_MAX,
  PITCH_FACTS_MAX,
  PITCH_FACTS_OFFICE_ONLY,
  PITCH_TITLE_MAX,
  type CampaignPitch,
  type PitchListItem,
} from '@lm/shared';
import { all, get, type Db } from '../db/connection.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { nowISO } from '../lib/dates.ts';
import { requireRole } from '../middleware/auth.ts';

const normaliseText = (s: string) => s.replace(/\r\n?/g, '\n').trim();

const pitchBody = z.object({
  title: z.string().transform((s) => s.replace(/\s+/g, ' ').trim()).pipe(z.string().min(1, 'Give the pitch a title').max(PITCH_TITLE_MAX)),
  body: z.string().transform(normaliseText).pipe(z.string().min(1, 'Write the pitch first').max(PITCH_BODY_MAX)),
  facts: z
    .string()
    .transform(normaliseText)
    .pipe(z.string().max(PITCH_FACTS_MAX))
    .nullable()
    .optional(),
});

/** Campaign codes are 2–6 letters or digits (routes/campaigns.ts). */
const CODE_RE = /^[A-Za-z0-9]{2,6}$/;

const PITCH_SELECT = `
  SELECT p.id, p.campaign_id AS campaignId, c.code AS campaignCode, c.name AS campaignName, c.color AS campaignColor,
         p.title, p.body, p.facts, p.updated_by AS updatedBy,
         CASE WHEN u.id IS NULL THEN NULL ELSE TRIM(u.first_name || ' ' || u.last_name) END AS updatedByName,
         p.updated_at AS updatedAt
    FROM campaign_pitches p
    JOIN campaigns c ON c.id = p.campaign_id
    LEFT JOIN users u ON u.id = p.updated_by`;

interface CampaignRef {
  id: number;
  code: string;
}

function campaignByCode(db: Db, code: string): CampaignRef | undefined {
  if (!CODE_RE.test(code)) return undefined;
  return get<CampaignRef>(db, `SELECT id, code FROM campaigns WHERE code = ? COLLATE NOCASE`, [code]);
}

function pitchFor(db: Db, campaignId: number): CampaignPitch | undefined {
  return get<CampaignPitch>(db, `${PITCH_SELECT} WHERE p.campaign_id = ?`, [campaignId]);
}

export function pitchesRouter(db: Db): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const rows = all<Omit<PitchListItem, 'campaignActive' | 'hasPitch'> & { campaignActive: number; hasPitch: number }>(
      db,
      `SELECT c.id AS campaignId, c.code AS campaignCode, c.name AS campaignName, c.color AS campaignColor,
              c.active AS campaignActive, (p.id IS NOT NULL) AS hasPitch, p.title, p.updated_at AS updatedAt
         FROM campaigns c
         LEFT JOIN campaign_pitches p ON p.campaign_id = c.id
        ORDER BY c.active DESC, c.name ASC, c.id ASC`,
    );
    const body: PitchListItem[] = rows.map((r) => ({ ...r, campaignActive: Boolean(r.campaignActive), hasPitch: Boolean(r.hasPitch) }));
    res.json(body);
  });

  router.get('/:campaignCode', (req, res) => {
    const campaign = campaignByCode(db, String(req.params.campaignCode));
    if (!campaign) throw notFound('Campaign');
    const pitch = pitchFor(db, campaign.id);
    if (!pitch) throw notFound('Pitch');
    res.json(pitch);
  });

  router.put('/:campaignCode', requireRole('admin', 'leader'), (req, res) => {
    const campaign = campaignByCode(db, String(req.params.campaignCode));
    if (!campaign) throw notFound('Campaign');
    const input = pitchBody.parse(req.body);
    const existing = pitchFor(db, campaign.id);
    const facts = input.facts === undefined ? (existing?.facts ?? null) : input.facts || null;
    // The fact check is the office's: a leader edits the title and script, and may send the notes back unchanged.
    if (req.user!.role !== 'admin' && facts !== (existing?.facts ?? null)) throw forbidden(PITCH_FACTS_OFFICE_ONLY);
    db.prepare(
      `INSERT INTO campaign_pitches (campaign_id, title, body, facts, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(campaign_id) DO UPDATE SET title = excluded.title, body = excluded.body, facts = excluded.facts,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(campaign.id, input.title, input.body, facts, req.user!.id, nowISO());
    res.status(existing ? 200 : 201).json(pitchFor(db, campaign.id));
  });

  return router;
}
