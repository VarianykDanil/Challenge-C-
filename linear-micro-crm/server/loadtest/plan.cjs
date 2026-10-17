// Read-only EXPLAIN QUERY PLAN analysis of the heaviest Linear Hub queries.
//   node plan.cjs --db /path/to/copy.sqlite
// Reconstructs the real SQL (from server/src/lib/metrics.ts, db/queries.ts, routes/*) with representative
// params and prints the plan, flagging any full-table SCAN that is not index-backed.

const { DatabaseSync } = require('node:sqlite');

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[++i];
const DB = args.db;
if (!DB) { console.error('--db required'); process.exit(1); }
const db = new DatabaseSync(DB, { readOnly: true });

const today = db.prepare(`SELECT MAX(date) AS d FROM gauge_entries`).get().d;
const from12 = db.prepare(`SELECT date(?, '-84 days') AS d`).get(today).d;
const sampleUser = db.prepare(`SELECT user_id FROM gauge_entries LIMIT 1`).get().user_id;
const sampleCampaign = db.prepare(`SELECT id FROM campaigns LIMIT 1`).get().id;

const GAUGE_FROM = `
  FROM gauge_entries g
  JOIN users u ON u.id = g.user_id
  LEFT JOIN teams t ON t.id = u.team_id
  JOIN events e ON e.id = g.event_id
  JOIN campaigns c ON c.id = e.campaign_id`;
const SUMS = `COALESCE(SUM(g.stops),0) AS stops, COALESCE(SUM(g.sales),0) AS sales`;
const MONDAY_SQL = `date(g.date, '-' || ((CAST(strftime('%w', g.date) AS INTEGER) + 6) % 7) || ' days')`;

const QUERIES = [
  ['gauges/summary groupBy=day (12wk)',
    `SELECT g.date AS key, ${SUMS}, COUNT(DISTINCT g.user_id || '/' || g.date) AS days ${GAUGE_FROM} WHERE g.date BETWEEN ? AND ? GROUP BY g.date ORDER BY key ASC`, [from12, today]],
  ['gauges/summary groupBy=week (12wk)',
    `SELECT ${MONDAY_SQL} AS key, ${SUMS}, COUNT(DISTINCT g.user_id || '/' || g.date) AS days ${GAUGE_FROM} WHERE g.date BETWEEN ? AND ? GROUP BY ${MONDAY_SQL} ORDER BY key ASC`, [from12, today]],
  ['gauges/summary groupBy=campaign (12wk)',
    `SELECT c.id AS key, ${SUMS}, COUNT(DISTINCT g.user_id || '/' || g.date) AS days ${GAUGE_FROM} WHERE g.date BETWEEN ? AND ? GROUP BY c.id ORDER BY sales DESC`, [from12, today]],
  ['leaderboard fetchRows (GROUP BY user)',
    `SELECT u.id, SUM(g.sales) AS sales, SUM(g.stops) AS stops, COUNT(DISTINCT g.date) AS days ${GAUGE_FROM} WHERE g.date BETWEEN ? AND ? GROUP BY u.id`, [from12, today]],
  ['dashboard personal totalsFor (user+range)',
    `SELECT ${SUMS}, COUNT(DISTINCT g.user_id || '/' || g.date) AS days ${GAUGE_FROM} WHERE g.user_id = ? AND g.date BETWEEN ? AND ?`, [sampleUser, from12, today]],
  ['dashboard company revenue (range)',
    `SELECT COALESCE(SUM(g.sales * c.payout_per_sale),0) AS r ${GAUGE_FROM} WHERE g.date BETWEEN ? AND ?`, [from12, today]],
  ['dashboard company byCampaign (correlated subquery)',
    `SELECT c.id, COALESCE((SELECT SUM(g.sales) FROM gauge_entries g JOIN events e ON e.id = g.event_id WHERE e.campaign_id = c.id AND g.date BETWEEN ? AND ?),0) AS sales FROM campaigns c WHERE c.active = 1 ORDER BY sales DESC`, [from12, today]],
  ['events list (EVENT_SELECT subquery + date range)',
    `SELECT e.id, COALESCE(g.sales,0) AS sales FROM events e JOIN campaigns c ON c.id = e.campaign_id JOIN teams t ON t.id = e.team_id LEFT JOIN (SELECT event_id, SUM(sales) AS sales, COUNT(DISTINCT user_id) AS repCount FROM gauge_entries GROUP BY event_id) g ON g.event_id = e.id WHERE e.date BETWEEN ? AND ? ORDER BY e.date ASC, e.start_time ASC`, [from12, today]],
  ['finance byCampaign (join pay_plans, 12wk)',
    `SELECT c.id, COALESCE(SUM(g.sales),0) AS sales, COALESCE(SUM(g.sales * pp.commission_per_sale),0) AS commission ${GAUGE_FROM} JOIN pay_plans pp ON pp.id = u.pay_plan_id WHERE g.date BETWEEN ? AND ? GROUP BY c.id ORDER BY sales DESC`, [from12, today]],
  ['finance per-week revenue (scalar)',
    `SELECT COALESCE(SUM(g.sales * c.payout_per_sale),0) AS revenue ${GAUGE_FROM} WHERE g.date BETWEEN ? AND ?`, [from12, today]],
  ['payroll list (week_start range)',
    `SELECT p.id FROM payroll_runs p JOIN users u ON u.id = p.user_id LEFT JOIN teams t ON t.id = u.team_id WHERE p.week_start BETWEEN ? AND ? ORDER BY p.week_start DESC, u.last_name ASC`, [from12, today]],
  ['weekPayFor own gauges (user+range)',
    `SELECT COUNT(DISTINCT date) AS days, COALESCE(SUM(sales),0) AS sales FROM gauge_entries WHERE user_id = ? AND date BETWEEN ? AND ?`, [sampleUser, from12, today]],
  ['leader override team-sales subquery',
    `SELECT COALESCE(SUM(o.sales),0) AS s FROM gauge_entries o WHERE o.user_id <> ? AND o.event_id IN (SELECT event_id FROM gauge_entries WHERE user_id = ? AND date BETWEEN ? AND ?)`, [sampleUser, sampleUser, from12, today]],
  ['users directory (order by name)',
    `SELECT u.id FROM users u LEFT JOIN teams t ON t.id = u.team_id JOIN pay_plans pp ON pp.id = u.pay_plan_id WHERE u.status = 'active' ORDER BY u.last_name, u.first_name`, []],
  ['recruitment candidates (stage + order)',
    `SELECT c.id FROM candidates c LEFT JOIN users o ON o.id = c.owner_id LEFT JOIN users r ON r.id = c.referred_by_id WHERE c.stage NOT IN ('hired','rejected','withdrawn') ORDER BY c.stage_updated_at DESC`, []],
  ['recruitment summary stage_changes (date range)',
    `SELECT s.to_stage, COUNT(DISTINCT s.candidate_id) FROM stage_changes s JOIN candidates c ON c.id = s.candidate_id WHERE c.applied_at BETWEEN ? AND ? GROUP BY s.to_stage`, [from12 + 'T00:00:00.000Z', today + 'T23:59:59.999Z']],
];

function timeOne(sql, params) {
  const t0 = performance.now();
  try { db.prepare(sql).all(...params); } catch (e) { return `ERR ${e.message}`; }
  return (performance.now() - t0).toFixed(2) + ' ms';
}

for (const [name, sql, params] of QUERIES) {
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params);
  const lines = plan.map((r) => r.detail);
  const fullScans = lines.filter((d) => /^SCAN /.test(d) && !/USING (INDEX|COVERING INDEX|INTEGER PRIMARY KEY)/.test(d));
  const t = timeOne(sql, params);
  console.log(`\n### ${name}   [${t}]`);
  for (const d of lines) console.log('   ' + d);
  if (fullScans.length) console.log('   ⚠ FULL SCAN(S): ' + fullScans.join(' | '));
}
db.close();
