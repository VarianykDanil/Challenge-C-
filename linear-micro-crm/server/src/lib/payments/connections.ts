/**
 * Release 1.4 — OWNED BY F payments-foundation: payment connections (table payment_connections).
 *
 *  - Settings (non-secret) are stored as JSON; secrets as ONE encrypted JSON blob (lib/crypto.ts). No API answer, audit
 *    row, log line or error message ever carries a secret: a connection answers only the NAMES of the secrets stored.
 *  - An API connection starts in test mode and 'not_connected'; a successful test makes it 'connected'. A bank file
 *    connection makes real files from the start (mode 'live', 'connected'): nothing moves until Matt uploads a file
 *    to his bank and approves it there.
 *  - Switching an API connection to live needs a connected test first and the words PAYMENT_LIVE_CONFIRMATION typed.
 *    Changing its details puts it back to 'not_connected' (test it again).
 *  - Review fixes: the mode cannot change while a payment through the connection is on its way (its items would go to
 *    the other service: a test payment paid with real money, or a live one "paid" in the sandbox); and a change of mode
 *    or details forgets the last test and its balance (they belonged to the old ones).
 *  - Disconnecting wipes the secrets and keeps the history (batches keep pointing at it). Not while a payment through
 *    it is still on its way; its drafts are cancelled.
 */
import { isLiveConfirmation, PAYMENT_LIVE_CONFIRMATION, type PaymentConnection, type PaymentConnectionInput, type PaymentConnectionPatch, type PaymentConnectionTestResult, type PaymentMode, type UserWithTeam } from '@lm/shared';
import { all, get, run, type Db } from '../../db/connection.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { nowISO, todayISO } from '../dates.ts';
import { HttpError, badRequest, conflict, notFound } from '../errors.ts';
import { redactSecrets } from './http.ts';
import { ProviderConfigError, ProviderError, type PaymentProviderAdapter, type ProviderConfig, type ProviderConnection, type ProviderContext } from './provider.ts';
import { paymentProvider } from './registry.ts';
import { notReadyError } from './stubs.ts';

export interface ConnectionRow {
  id: number;
  provider: string;
  name: string;
  mode: PaymentMode;
  settingsJson: string;
  secretsEnc: string | null;
  status: PaymentConnection['status'];
  lastCheckedAt: string | null;
  lastError: string | null;
  balancePence: number | null;
  createdAt: string;
  createdBy: number | null;
  createdByName: string | null;
  liveConfirmedAt: string | null;
  liveConfirmedBy: number | null;
  disconnectedAt: string | null;
}

const CONNECTION_SELECT = `
  SELECT c.id, c.provider, c.name, c.mode, c.settings_json AS settingsJson, c.secrets_enc AS secretsEnc, c.status,
         c.last_checked_at AS lastCheckedAt, c.last_error AS lastError, c.balance_pence AS balancePence, c.created_at AS createdAt,
         c.created_by AS createdBy, TRIM(u.first_name || ' ' || u.last_name) AS createdByName, c.live_confirmed_at AS liveConfirmedAt,
         c.live_confirmed_by AS liveConfirmedBy, c.disconnected_at AS disconnectedAt
  FROM payment_connections c LEFT JOIN users u ON u.id = c.created_by`;

export const CONNECTION_NAME_MAX = 80;

function parseObject(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** The stored secrets, decrypted ({} when none or unreadable). Server-side only. */
export function connectionSecrets(row: Pick<ConnectionRow, 'secretsEnc'>): Record<string, string> {
  if (!row.secretsEnc) return {};
  try {
    return parseObject(decrypt(row.secretsEnc));
  } catch {
    return {};
  }
}

export function connectionRow(db: Db, id: number): ConnectionRow | undefined {
  return get<ConnectionRow>(db, `${CONNECTION_SELECT} WHERE c.id = ?`, [id]);
}

/** What the API answers: never a secret, only the names of the ones stored. */
export function toConnection(r: ConnectionRow): PaymentConnection {
  return {
    id: r.id,
    provider: r.provider,
    name: r.name,
    mode: r.mode,
    settings: parseObject(r.settingsJson),
    secretsSet: Object.keys(connectionSecrets(r)).sort(),
    status: r.status,
    lastCheckedAt: r.lastCheckedAt,
    lastError: r.lastError,
    balancePence: r.balancePence,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    createdByName: r.createdByName || null,
    liveConfirmedAt: r.liveConfirmedAt,
    liveConfirmedBy: r.liveConfirmedBy,
    disconnectedAt: r.disconnectedAt,
  };
}

export function getConnection(db: Db, id: number): PaymentConnection {
  const r = connectionRow(db, id);
  if (!r) throw notFound('Payment connection');
  return toConnection(r);
}

/** Every connection, the active ones first (newest first), then the disconnected ones. */
export function listConnections(db: Db): PaymentConnection[] {
  return all<ConnectionRow>(db, `${CONNECTION_SELECT} ORDER BY (c.disconnected_at IS NOT NULL), c.id DESC`).map(toConnection);
}

/** The adapter for a stored connection (409 when the provider is no longer known). */
export function adapterFor(provider: string): PaymentProviderAdapter {
  const a = paymentProvider(provider);
  if (!a) throw conflict('This way to pay is not available in this version of Linear Hub');
  return a;
}

/** The connection as its adapter sees it (secrets decrypted for this call only). */
export function providerConnection(r: ConnectionRow): ProviderConnection {
  return { id: r.id, provider: r.provider, name: r.name, mode: r.mode, settings: parseObject(r.settingsJson), secrets: connectionSecrets(r) };
}

/**
 * The context an adapter call gets. With a stored connection (`db` and `connectionId`), package A's adapters can keep
 * secrets the provider hands back (Revolut's refresh token) through `saveSecrets`: merged into the ONE encrypted blob.
 */
export function providerContext(db?: Db, connectionId?: number): ProviderContext {
  const ctx: ProviderContext = { today: todayISO(), now: () => new Date() };
  if (db && connectionId) ctx.saveSecrets = (patch) => saveConnectionSecrets(db, connectionId, patch);
  return ctx;
}

/** Merges `patch` into a connection's encrypted secrets (null or '' removes one). Never while disconnected. */
export function saveConnectionSecrets(db: Db, id: number, patch: Record<string, string | null>): void {
  const r = connectionRow(db, id);
  if (!r || r.disconnectedAt) return;
  const next = { ...connectionSecrets(r) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') delete next[k];
    else if (typeof v === 'string') next[k] = v;
  }
  run(db, `UPDATE payment_connections SET secrets_enc = ? WHERE id = ? AND disconnected_at IS NULL`, [encryptSecrets(next), id]);
}

function cleanName(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') throw badRequest('Give the connection a name');
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return fallback;
  if (name.length > CONNECTION_NAME_MAX) throw badRequest(`Keep the name under ${CONNECTION_NAME_MAX} characters`);
  return name;
}

function stringMap(raw: unknown, what: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest(`The ${what} must be a list of names and values`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') throw badRequest(`The ${what} must be text`);
    out[k] = v;
  }
  return out;
}

function validated(adapter: PaymentProviderAdapter, input: ProviderConfig, existing?: ProviderConfig): ProviderConfig {
  try {
    return adapter.validateConfig(input, existing);
  } catch (err) {
    if (err instanceof ProviderConfigError) throw badRequest(err.message, err.fields);
    throw err;
  }
}

const encryptSecrets = (secrets: Record<string, string>) => (Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : null);

export function createConnection(db: Db, me: UserWithTeam, input: PaymentConnectionInput): PaymentConnection {
  const provider = typeof input?.provider === 'string' ? input.provider : '';
  const adapter = paymentProvider(provider);
  if (!adapter) throw badRequest('Choose one of the ways to pay', [{ path: 'provider', message: 'Choose one of the ways to pay' }]);
  const name = cleanName(input.name, adapter.info.name);
  const config = validated(adapter, { settings: stringMap(input.settings, 'settings'), secrets: stringMap(input.secrets, 'secrets') });
  const file = adapter.info.kind === 'file';
  // a bank file has no test mode (nothing moves until Matt uploads it) — except a test-only one, which never pays anyone
  const live = file && !adapter.info.testOnly;
  const id = run(
    db,
    `INSERT INTO payment_connections (provider, name, mode, settings_json, secrets_enc, status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [provider, name, live ? 'live' : 'test', JSON.stringify(config.settings), encryptSecrets(config.secrets), file ? 'connected' : 'not_connected', nowISO(), me.id],
  ).lastInsertRowid;
  return getConnection(db, id);
}

function activeRow(db: Db, id: number): ConnectionRow {
  const r = connectionRow(db, id);
  if (!r) throw notFound('Payment connection');
  if (r.disconnectedAt) throw conflict('This connection was disconnected. Connect again to use it.');
  return r;
}

export function updateConnection(db: Db, me: UserWithTeam, id: number, patch: PaymentConnectionPatch): PaymentConnection {
  const r = activeRow(db, id);
  const adapter = adapterFor(r.provider);
  const p = (patch ?? {}) as PaymentConnectionPatch;
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (p.name !== undefined) {
    sets.push('name = ?');
    params.push(cleanName(p.name, r.name));
  }
  if (p.settings !== undefined || p.secrets !== undefined) {
    const stored = { settings: parseObject(r.settingsJson), secrets: connectionSecrets(r) };
    const next = validated(adapter, { settings: { ...stored.settings, ...stringMap(p.settings, 'settings') }, secrets: stringMap(p.secrets, 'secrets') }, stored);
    const changed = JSON.stringify(next.settings) !== JSON.stringify(stored.settings) || JSON.stringify(next.secrets) !== JSON.stringify(stored.secrets);
    if (changed) {
      sets.push('settings_json = ?', 'secrets_enc = ?');
      params.push(JSON.stringify(next.settings), encryptSecrets(next.secrets));
      // new details need a new test before an API connection pays anyone; the old test's balance was theirs
      if (adapter.info.kind === 'api') sets.push(`status = 'not_connected'`, 'last_error = NULL', 'balance_pence = NULL', 'last_checked_at = NULL');
    }
  }
  if (p.mode !== undefined && p.mode !== r.mode) {
    if (p.mode !== 'live' && p.mode !== 'test') throw badRequest('Mode is test or live');
    if (adapter.info.testOnly) throw badRequest('The test providers never pay anyone: they have no live mode.');
    if (adapter.info.kind === 'file') throw badRequest('A bank file has no test mode: nothing is paid until you upload the file to your bank and approve it there.');
    // a payment on its way finishes in the mode it was made in (drafts are refused at approval instead)
    const waiting = get<{ id: number }>(
      db,
      `SELECT b.id FROM payment_batches b JOIN payment_items i ON i.batch_id = b.id
       WHERE b.connection_id = ? AND b.status <> 'draft' AND i.status IN ('queued', 'submitted', 'processing') ORDER BY b.id LIMIT 1`,
      [id],
    );
    if (waiting) {
      throw conflict(`Payment #${waiting.id} through this connection is still on its way in ${r.mode === 'live' ? 'live mode' : 'test mode'}. Wait until it has finished (or cancel it), then switch to ${p.mode === 'live' ? 'live' : 'test mode'}.`);
    }
    if (p.mode === 'live') {
      if (!isLiveConfirmation(p.confirm)) {
        throw badRequest(`To pay real money, type ${PAYMENT_LIVE_CONFIRMATION} exactly`, [{ path: 'confirm', message: `Type ${PAYMENT_LIVE_CONFIRMATION} exactly` }]);
      }
      const statusAfter = sets.some((s) => s.startsWith('status')) ? 'not_connected' : r.status;
      if (statusAfter !== 'connected') throw conflict('Test the connection first: switch to live once a test in test mode has worked.');
      sets.push(`mode = 'live'`, 'live_confirmed_at = ?', 'live_confirmed_by = ?');
      params.push(nowISO(), me.id);
      // the provider's live service needs its own test (and has its own balance)
      sets.push(`status = 'not_connected'`, 'balance_pence = NULL', 'last_checked_at = NULL');
    } else {
      sets.push(`mode = 'test'`, `status = 'not_connected'`, 'balance_pence = NULL', 'last_checked_at = NULL');
    }
  }
  if (sets.length) run(db, `UPDATE payment_connections SET ${[...new Set(sets)].join(', ')} WHERE id = ?`, [...params, id]);
  return getConnection(db, id);
}

/** Disconnects (secrets wiped, drafts cancelled); 409 while a payment through it is on its way. */
export function disconnectConnection(db: Db, me: UserWithTeam, id: number): PaymentConnection {
  const r = activeRow(db, id);
  const waiting = get<{ id: number }>(db, `SELECT id FROM payment_batches WHERE connection_id = ? AND status IN ('submitted', 'processing') ORDER BY id LIMIT 1`, [id]);
  if (waiting) throw conflict(`Payment #${waiting.id} through this connection is still on its way. Wait until it has finished (or cancel it), then disconnect.`);
  const at = nowISO();
  run(db, `UPDATE payment_items SET status = 'cancelled', updated_at = ? WHERE status = 'queued' AND batch_id IN (SELECT id FROM payment_batches WHERE connection_id = ? AND status = 'draft')`, [at, id]);
  run(db, `UPDATE payment_batches SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, updated_at = ? WHERE connection_id = ? AND status = 'draft'`, [at, me.id, at, id]);
  run(db, `UPDATE payment_connections SET disconnected_at = ?, secrets_enc = NULL, status = 'not_connected' WHERE id = ?`, [at, r.id]);
  return getConnection(db, id);
}

/** Tests the connection with its provider (501 until the adapter is built). Stores the outcome. */
export async function testConnection(db: Db, id: number, ctx: ProviderContext = providerContext(db, id)): Promise<PaymentConnectionTestResult> {
  const r = activeRow(db, id);
  const adapter = adapterFor(r.provider);
  if (!adapter.ready) throw notReadyError(adapter.info.name);
  const conn = providerConnection(r);
  const secrets = Object.values(conn.secrets);
  let ok = false;
  let message: string;
  let balancePence: number | null = null;
  try {
    const out = await adapter.testConnection(conn, ctx);
    ok = out.ok;
    message = redactSecrets(out.message, secrets);
    balancePence = Number.isSafeInteger(out.balancePence) ? (out.balancePence as number) : null;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    message = redactSecrets(err instanceof ProviderError ? err.message : `The test did not work: ${String((err as Error)?.message ?? err)}`, secrets).slice(0, 500);
  }
  const at = nowISO();
  run(db, `UPDATE payment_connections SET status = ?, last_checked_at = ?, last_error = ?, balance_pence = ? WHERE id = ? AND disconnected_at IS NULL`, [
    ok ? 'connected' : 'error', at, ok ? null : message, balancePence, id,
  ]);
  return { ok, message, balancePence, checkedAt: at, connection: getConnection(db, id) };
}
