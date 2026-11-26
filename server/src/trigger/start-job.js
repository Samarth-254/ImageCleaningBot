import { task } from '@trigger.dev/sdk/v3';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { processVehicleJobTask } from './process-vehicle-job.js';

export const startJobTask = task({
  id: 'start-job',
  maxDuration: 60,
  run: async (payload) => {
    const { jobId, dealerId, forceNow = false } = payload;

    const jobRes = await db.query(
      'SELECT id, status, last_photo_at FROM jobs WHERE id = $1 AND dealer_id = $2',
      [jobId, dealerId]
    );
    if (jobRes.rowCount === 0) {
      return { skipped: true, reason: 'job_not_found' };
    }
    const job = jobRes.rows[0];
    if (job.status !== 'collecting') {
      return { skipped: true, reason: `already_${job.status}` };
    }

    if (!forceNow && job.last_photo_at) {
      const elapsedMs = Date.now() - new Date(job.last_photo_at).getTime();
      const remainingMs = config.photoGroupWindowMs - elapsedMs;
      if (remainingMs > 1000) {
        const delaySeconds = Math.ceil(remainingMs / 1000);
        await startJobTask.trigger(
          { jobId, dealerId, forceNow: false },
          {
            delay: `${delaySeconds}s`,
            idempotencyKey: `start-job-${jobId}-${new Date(job.last_photo_at).getTime()}`,
          }
        );
        return { rescheduled: true, delaySeconds };
      }
    }

    // Exactly-once transition from collecting -> processing
    const started = await db.query(
      `UPDATE jobs
       SET status = 'processing', updated_at = NOW()
       WHERE id = $1 AND dealer_id = $2 AND status = 'collecting'
       RETURNING id`,
      [jobId, dealerId]
    );

    if (started.rowCount === 0) {
      return { skipped: true, reason: 'already_started_by_concurrent_trigger' };
    }

    const handle = await processVehicleJobTask.trigger(
      { jobId, dealerId },
      { idempotencyKey: `process-vehicle-${jobId}` }
    );

    await db.query(
      'UPDATE jobs SET trigger_run_id = $1, updated_at = NOW() WHERE id = $2 AND dealer_id = $3',
      [handle.id, jobId, dealerId]
    );

    return { started: true, parentRunId: handle.id };
  },
});
