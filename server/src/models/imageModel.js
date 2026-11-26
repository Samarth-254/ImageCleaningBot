import { db } from '../db/index.js';

export const imageModel = {
  async listByJob(jobId, dealerId) {
    const res = await db.query(
      'SELECT id, hash, seq_num FROM images WHERE job_id = $1 AND dealer_id = $2 ORDER BY seq_num ASC',
      [jobId, dealerId]
    );
    return res.rows;
  },

  async create({ id, jobId, dealerId, seqNum, originalPath, previewPath, hash, mimeType, width, height }) {
    await db.query(
      `INSERT INTO images (id, job_id, dealer_id, seq_num, original_path, preview_path, hash, mime_type, width, height, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued')`,
      [id, jobId, dealerId, seqNum, originalPath, previewPath, hash, mimeType, width, height]
    );
  },

  async findLatestBySeqNum(dealerId, seqNum) {
    const res = await db.query(
      `SELECT i.id, i.job_id, i.seq_num, i.retry_count
       FROM images i
       JOIN jobs j ON j.id = i.job_id
       WHERE i.dealer_id = $1 AND i.seq_num = $2
       ORDER BY j.created_at DESC LIMIT 1`,
      [dealerId, seqNum]
    );
    return res.rows[0] || null;
  },
};
