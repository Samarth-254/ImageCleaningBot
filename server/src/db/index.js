import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: Number(process.env.DB_POOL_MAX || 12),
      idleTimeoutMillis: 15000,
      connectionTimeoutMillis: 25000,
    });
    pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error:', err.message);
    });
  }
  return pool;
}

/**
 * Single parameterized query helper. All queries in the app MUST go through db.query(text, params).
 */
export async function query(text, params = []) {
  const p = getPool();
  return p.query(text, params);
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export const db = {
  query,
  getPool,
  closePool,
};
