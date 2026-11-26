import { z } from 'zod';
import { db } from '../db/index.js';
import { DEFAULT_POLICY } from '../db/seed.js';

export const PolicySchema = z
  .object({
    scope_description: z.string().min(1).optional(),
    background_style: z.string().min(1),
    identifier_handling: z.string().min(1).optional(),
    never_edit: z.array(z.string()).min(1),
    discouraged_edit_verbs: z.array(z.string()).optional(),
    max_minor_differences: z.number().int().min(0).optional(),
    show_reconstruction_note: z.boolean().optional(),
    reply_tone: z.string().min(1),
    default_language: z.string().min(1),
    repair_rules: z.record(z.any()).optional(),
  })
  .passthrough();

export async function getActivePolicy() {
  const res = await db.query(
    'SELECT id, version, policy_json, created_at FROM policies WHERE is_active = TRUE ORDER BY version DESC LIMIT 1'
  );
  if (res.rowCount === 0) {
    return { id: 0, version: 1, policy_json: DEFAULT_POLICY, created_at: new Date().toISOString() };
  }
  return res.rows[0];
}

export async function updatePolicy(newPolicyJson) {
  const validated = PolicySchema.parse(newPolicyJson);
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const latest = await client.query('SELECT COALESCE(MAX(version), 0) AS max_ver FROM policies');
    const nextVersion = Number(latest.rows[0].max_ver) + 1;
    await client.query('UPDATE policies SET is_active = FALSE WHERE is_active = TRUE');
    const inserted = await client.query(
      'INSERT INTO policies (version, is_active, policy_json) VALUES ($1, TRUE, $2) RETURNING id, version, policy_json, created_at',
      [nextVersion, JSON.stringify(validated)]
    );
    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
