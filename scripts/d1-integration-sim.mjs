/**
 * SQLite integration simulation (node:sqlite) for Reliability Gate.
 * Applies migrations 0001–0003 then exercises lifecycle SQL on ONE database
 * (jobs + quota_reservations) — same architecture as production D1 binding.
 *
 * Usage: node scripts/d1-integration-sim.mjs
 * Note: Prefer `wrangler d1 migrations apply --local` when wrangler is available.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(':memory:');

function apply(path) {
  db.exec('PRAGMA foreign_keys = OFF');
  const sql = readFileSync(path, 'utf8');
  for (const stmt of sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0)) {
    try {
      db.exec(stmt);
    } catch (e) {
      const m = String(e.message || e);
      if (m.includes('duplicate column') || m.includes('already exists')) continue;
      console.error('SQL FAIL', path, m, stmt.slice(0, 100));
      process.exit(1);
    }
  }
}

apply(join(root, 'migrations/0001_init.sql'));
apply(join(root, 'migrations/0002_quota_atomicity.sql'));
apply(join(root, 'migrations/0003_reliability_persistence.sql'));
db.exec('PRAGMA foreign_keys = ON');
console.log('MIGRATIONS_OK');

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
for (const t of ['jobs', 'quota_reservations', 'provider_quotas', 'dead_letter_jobs', 'watchdog_actions', 'settings']) {
  if (!tables.includes(t)) throw new Error('missing ' + t);
}
console.log('SCHEMA_OK');

db.prepare(
  `INSERT OR REPLACE INTO provider_quotas (id, provider_id, model_id, window, limit_units, used_units, reserved_units)
   VALUES ('q1', 'cf_workers_ai', NULL, 'daily', 10000, 0, 0)`
).run();
db.prepare(`UPDATE settings SET value = 'RUNNING' WHERE key = 'factory_status'`).run();

let p = 0, f = 0;
const ok = (n, c) => { if (c) { p++; console.log('PASS', n); } else { f++; console.log('FAIL', n); } };

// A: reserve → fail → release once
db.prepare(`INSERT INTO jobs (id,type,status,attempt_count,payload_json,state_entered_at,created_at,updated_at) VALUES ('job-a','IMAGE_GENERATION','generating',1,'{}',datetime('now','-20 minutes'),datetime('now'),datetime('now'))`).run();
db.prepare(`INSERT INTO quota_reservations (id,provider_id,units,job_id,status,expires_at,created_at) VALUES ('res-a','cf_workers_ai',50,'job-a','reserved',datetime('now','+1 hour'),datetime('now'))`).run();
db.prepare(`UPDATE provider_quotas SET reserved_units=50 WHERE id='q1'`).run();
ok('A_fail', db.prepare(`UPDATE jobs SET status='failed', error_code='WATCHDOG_GENERATING_TIMEOUT' WHERE id='job-a' AND status='generating'`).run().changes === 1);
const res = db.prepare(`SELECT id,units FROM quota_reservations WHERE job_id='job-a' AND status='reserved'`).get();
ok('A_rel', db.prepare(`UPDATE quota_reservations SET status='released' WHERE id=? AND status='reserved'`).run(res.id).changes === 1);
db.prepare(`UPDATE provider_quotas SET reserved_units=MAX(0,reserved_units-?) WHERE id='q1'`).run(res.units);
ok('A_quota0', db.prepare(`SELECT reserved_units FROM provider_quotas WHERE id='q1'`).get().reserved_units === 0);
ok('A_once', db.prepare(`UPDATE quota_reservations SET status='released' WHERE id=? AND status='reserved'`).run(res.id).changes === 0);

// B: concurrent conditional
db.prepare(`INSERT INTO jobs (id,type,status,attempt_count,payload_json,state_entered_at,created_at,updated_at) VALUES ('job-b','IMAGE_GENERATION','generating',1,'{}',datetime('now','-20 minutes'),datetime('now'),datetime('now'))`).run();
ok('B', db.prepare(`UPDATE jobs SET status='failed' WHERE id='job-b' AND status='generating'`).run().changes === 1 && db.prepare(`UPDATE jobs SET status='failed' WHERE id='job-b' AND status='generating'`).run().changes === 0);

// C: committed no release
db.prepare(`INSERT INTO quota_reservations (id,provider_id,units,job_id,status,expires_at,created_at) VALUES ('res-c','cf_workers_ai',10,'job-c','committed',datetime('now','+1 hour'),datetime('now'))`).run();
ok('C', db.prepare(`UPDATE quota_reservations SET status='released' WHERE job_id='job-c' AND status='reserved'`).run().changes === 0);

// D: DLQ once
db.prepare(`INSERT INTO jobs (id,type,status,attempt_count,payload_json,created_at,updated_at) VALUES ('job-d','IMAGE_GENERATION','running',3,'{}',datetime('now'),datetime('now'))`).run();
db.prepare(`UPDATE jobs SET status='dead_letter' WHERE id='job-d' AND status='running' AND attempt_count=3`).run();
db.prepare(`INSERT OR IGNORE INTO dead_letter_jobs (id,job_id,reason,attempt_count,status,created_at,failed_at) VALUES ('dlq_job-d','job-d','max_attempts_3',3,'open',datetime('now'),datetime('now'))`).run();
db.prepare(`INSERT OR IGNORE INTO dead_letter_jobs (id,job_id,reason,attempt_count,status,created_at,failed_at) VALUES ('dlq_job-d','job-d','max_attempts_3',3,'open',datetime('now'),datetime('now'))`).run();
ok('D', db.prepare(`SELECT COUNT(*) as c FROM dead_letter_jobs WHERE job_id='job-d'`).get().c === 1);

// E: STOP
db.prepare(`UPDATE settings SET value='STOPPED' WHERE key='factory_status'`).run();
db.prepare(`INSERT INTO jobs (id,type,status,attempt_count,payload_json,state_entered_at,created_at,updated_at) VALUES ('job-e','IMAGE_GENERATION','queued',0,'{}',datetime('now','-2 hours'),datetime('now'),datetime('now'))`).run();
db.prepare(`UPDATE jobs SET status='failed', error_code='FACTORY_STOPPED' WHERE id='job-e' AND status='queued'`).run();
ok('E', db.prepare(`SELECT error_code FROM jobs WHERE id='job-e'`).get().error_code === 'FACTORY_STOPPED');
ok('same_db', tables.includes('jobs') && tables.includes('quota_reservations'));

console.log('RESULT', p, 'passed', f, 'failed');
process.exit(f ? 1 : 0);
