import { task } from '@trigger.dev/sdk/v3';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { channel } from '../services/channel.js';
import { processImageTask, runProcessImage } from './process-image.js';

export async function runProcessVehicleJob(payload, ctx = {}) {
    const { jobId, dealerId } = payload;
    const jobStartedAt = Date.now();

    const jobRes = await db.query(
      'SELECT id, summary_json FROM jobs WHERE id = $1 AND dealer_id = $2',
      [jobId, dealerId]
    );
    if (jobRes.rowCount === 0) {
      return { error: 'job_not_found' };
    }

    const imagesRes = await db.query(
      'SELECT id, seq_num, retry_count FROM images WHERE job_id = $1 AND dealer_id = $2 ORDER BY seq_num ASC',
      [jobId, dealerId]
    );

    const images = imagesRes.rows;
    console.log(`[Job] start job=${jobId} dealer=${dealerId} images=${images.length}`);
    if (images.length === 0) {
      await db.query(
        "UPDATE jobs SET status = 'done', updated_at = NOW() WHERE id = $1 AND dealer_id = $2",
        [jobId, dealerId]
      );
      return { count: 0 };
    }

    await db.query(
      `INSERT INTO trace_events (dealer_id, job_id, stage, payload_json)
       VALUES ($1, $2, 'job_started', $3)`,
      [dealerId, jobId, JSON.stringify({ imageCount: images.length, runId: ctx?.run?.id })]
    );

    const batchItems = images.map((img) => ({
      payload: {
        jobId,
        dealerId,
        imageId: img.id,
        seqNum: img.seq_num,
        totalImages: images.length,
      },
      options: {
        idempotencyKey: `process-img-${img.id}-r${img.retry_count || 0}`,
      },
    }));

    let batchCount = 0;
    if (batchItems.length === 1) {
      // Avoid an extra Trigger.dev queue/worker hop for a single image
      await runProcessImage(batchItems[0].payload, { run: { id: ctx?.run?.id || 'parent-worker' } });
      batchCount = 1;
    } else if (config.triggerSecretKey && ctx?.run?.id) {
      const batchResult = await processImageTask.batchTriggerAndWait(batchItems);
      batchCount = batchResult.runs?.length || 0;
    } else {
      // Local in-process execution when Trigger.dev is skipped (cap at 2 to avoid CPU/Sharp contention)
      const limit = Math.max(1, Math.min(Number(process.env.LOCAL_IMAGE_CONCURRENCY || 2), config.triggerImageConcurrency));
      for (let i = 0; i < batchItems.length; i += limit) {
        const chunk = batchItems.slice(i, i + limit);
        await Promise.all(chunk.map((item) => runProcessImage(item.payload, { run: { id: 'local-inprocess' } })));
      }
      batchCount = batchItems.length;
    }

    const finalImgsRes = await db.query(
      'SELECT id, seq_num, final_decision, note FROM images WHERE job_id = $1 AND dealer_id = $2 ORDER BY seq_num ASC',
      [jobId, dealerId]
    );
    const finalImgs = finalImgsRes.rows;

    const counts = { fixed: 0, passthrough: 0, reject: 0, fallback_original: 0, ask_dealer: 0 };
    for (const im of finalImgs) {
      if (im.final_decision && counts[im.final_decision] !== undefined) {
        counts[im.final_decision] += 1;
      } else {
        counts.fallback_original += 1;
      }
    }

    const totalLatencyMs = Date.now() - jobStartedAt;
    console.log(`[Job] done job=${jobId} totalLatencyMs=${totalLatencyMs} summary=${JSON.stringify(counts)}`);
    const summary = { counts, totalLatencyMs, imageCount: finalImgs.length };

    const updated = await db.query(
      `UPDATE jobs
       SET status = 'done', summary_json = $1, updated_at = NOW()
       WHERE id = $2 AND dealer_id = $3 AND summary_json IS NULL
       RETURNING id`,
      [JSON.stringify(summary), jobId, dealerId]
    );

    await channel.markJobMessagesRead({ dealerId, jobId });

    if (updated.rowCount > 0) {
      const parts = [];
      if (counts.fixed > 0) parts.push(`${counts.fixed} repaired`);
      if (counts.passthrough > 0) parts.push(`${counts.passthrough} kept as original`);
      if (counts.fallback_original > 0) parts.push(`${counts.fallback_original} original fallback`);
      if (counts.reject > 0) parts.push(`${counts.reject} skipped`);

      await channel.sendMessage({
        dealerId,
        jobId,
        role: 'assistant',
        msgType: 'text',
        text: `All done (${(totalLatencyMs / 1000).toFixed(1)}s): ${parts.join(', ')}.`,
        payload: {
          quickReplies: [
            ...(counts.fixed > 0 ? [{ label: 'Download all', action: 'download_all' }] : []),
            { label: 'New car', action: 'text', text: 'new car' },
          ],
        },
      });
    }

    return { summary, batchOk: batchCount };
}

export const processVehicleJobTask = task({
  id: 'process-vehicle-job',
  maxDuration: 300,
  run: async (payload, { ctx }) => runProcessVehicleJob(payload, ctx),
});
