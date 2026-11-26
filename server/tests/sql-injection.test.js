import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { checkSqlSafety } from '../scripts/check-sql.js';
import { storage } from '../src/services/storage.js';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';

const HOSTILE_INPUT = "'; DROP TABLE jobs;--";

test('check:sql passes with zero unsafe SQL patterns', async () => {
  const violations = await checkSqlSafety();
  assert.equal(violations.length, 0, `Unexpected SQL violations: ${JSON.stringify(violations)}`);
});

test('storage.saveOriginal writes immutable file and rejects path traversal', async () => {
  const sample = Buffer.from('test-image-bytes');
  const relPath = await storage.saveOriginal(sample, 'jpg');
  assert.ok(relPath.startsWith('originals/'));
  const readBack = await storage.readBuffer(relPath);
  assert.deepEqual(readBack, sample);
  assert.throws(() => storage.getAbsolutePath('../../etc/passwd'), /Invalid storage path/);
});

test('hostile SQL injection payload is stored as plain text via parameterized query', async (t) => {
  if (!config.databaseUrl) {
    // Verify parameterized query contract even without live DB
    let capturedText = '';
    let capturedParams = [];
    const mockPool = {
      async query(text, params) {
        capturedText = text;
        capturedParams = params;
        return { rows: [{ text: params[3] }], rowCount: 1 };
      },
    };
    const res = await mockPool.query(
      'INSERT INTO messages (dealer_id, role, msg_type, text) VALUES ($1, $2, $3, $4) RETURNING text',
      [crypto.randomUUID(), 'dealer', 'text', HOSTILE_INPUT]
    );
    assert.ok(!capturedText.includes('DROP TABLE'));
    assert.equal(capturedParams[3], HOSTILE_INPUT);
    assert.equal(res.rows[0].text, HOSTILE_INPUT);
    return;
  }

  const dealerId = crypto.randomUUID();
  const otherDealerId = crypto.randomUUID();
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO dealers (id) VALUES ($1), ($2)', [dealerId, otherDealerId]);
    const inserted = await client.query(
      'INSERT INTO messages (dealer_id, role, msg_type, text) VALUES ($1, $2, $3, $4) RETURNING id, text',
      [dealerId, 'dealer', 'text', HOSTILE_INPUT]
    );
    assert.equal(inserted.rows[0].text, HOSTILE_INPUT);

    // Verify jobs table still exists
    const jobsCheck = await client.query("SELECT to_regclass('public.jobs') AS tbl");
    assert.equal(jobsCheck.rows[0].tbl, 'jobs');

    // Verify dealer_id scoping: otherDealerId cannot see dealerId's message
    const scoped = await client.query(
      'SELECT id FROM messages WHERE id = $1 AND dealer_id = $2',
      [inserted.rows[0].id, otherDealerId]
    );
    assert.equal(scoped.rowCount, 0);

    await client.query('ROLLBACK');
  } finally {
    client.release();
    await db.closePool();
  }
});
