import { db } from '../db/index.js';

export const traceModel = {
  async getSnapshot(dealerId) {
    const jobsRes = await db.query(
      'SELECT * FROM jobs WHERE dealer_id = $1 ORDER BY created_at DESC LIMIT 5',
      [dealerId]
    );
    const latestJobId = jobsRes.rows[0]?.id || null;
    const imagesRes = latestJobId
      ? await db.query(
          'SELECT * FROM images WHERE dealer_id = $1 AND job_id = $2 ORDER BY seq_num ASC',
          [dealerId, latestJobId]
        )
      : { rows: [] };
    const usageRes = latestJobId
      ? await db.query(
          'SELECT * FROM ai_usage WHERE dealer_id = $1 AND job_id = $2 ORDER BY id ASC',
          [dealerId, latestJobId]
        )
      : { rows: [] };
    const eventsRes = latestJobId
      ? await db.query(
          'SELECT * FROM trace_events WHERE dealer_id = $1 AND job_id = $2 ORDER BY id ASC',
          [dealerId, latestJobId]
        )
      : { rows: [] };

    return {
      jobs: jobsRes.rows,
      images: imagesRes.rows,
      usage: usageRes.rows,
      events: eventsRes.rows,
    };
  },
};
