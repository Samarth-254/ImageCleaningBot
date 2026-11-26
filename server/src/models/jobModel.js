import { db } from '../db/index.js';

export const jobModel = {
  async findCollecting(dealerId) {
    const res = await db.query(
      "SELECT * FROM jobs WHERE dealer_id = $1 AND status = 'collecting' ORDER BY created_at DESC LIMIT 1",
      [dealerId]
    );
    return res.rows[0] || null;
  },

  async createCollecting(jobId, dealerId) {
    await db.query(
      "INSERT INTO jobs (id, dealer_id, status, last_photo_at) VALUES ($1, $2, 'collecting', NOW())",
      [jobId, dealerId]
    );
  },

  async touchLastPhoto(jobId, dealerId) {
    await db.query(
      'UPDATE jobs SET last_photo_at = NOW(), updated_at = NOW() WHERE id = $1 AND dealer_id = $2',
      [jobId, dealerId]
    );
  },

  async startProcessingIfCollecting(jobId, dealerId) {
    const res = await db.query(
      `UPDATE jobs
       SET status = 'processing', updated_at = NOW()
       WHERE id = $1 AND dealer_id = $2 AND status = 'collecting'
       RETURNING id`,
      [jobId, dealerId]
    );
    return res.rowCount > 0;
  },

  async getStatusAndLastPhoto(jobId, dealerId) {
    const res = await db.query(
      'SELECT status, last_photo_at FROM jobs WHERE id = $1 AND dealer_id = $2',
      [jobId, dealerId]
    );
    return res.rows[0] || null;
  },

  async closeCollecting(dealerId) {
    await db.query(
      "UPDATE jobs SET status = 'done', updated_at = NOW() WHERE dealer_id = $1 AND status = 'collecting'",
      [dealerId]
    );
  },

  async setTriggerRunId(jobId, dealerId, triggerRunId) {
    await db.query(
      'UPDATE jobs SET trigger_run_id = $1, updated_at = NOW() WHERE id = $2 AND dealer_id = $3',
      [triggerRunId, jobId, dealerId]
    );
  },
};
