import { z } from 'zod';
import { config } from '../config.js';
import { dealerModel } from '../models/dealerModel.js';
import { jobModel } from '../models/jobModel.js';
import { imageModel } from '../models/imageModel.js';
import { messageModel } from '../models/messageModel.js';
import { getActivePolicy } from '../services/policy.js';
import { channel } from '../services/channel.js';
import { classifyChatIntent } from '../services/pipeline.js';
import { startJobTask } from '../trigger/start-job.js';
import { processVehicleJobTask, runProcessVehicleJob } from '../trigger/process-vehicle-job.js';
import { processImageTask, runProcessImage } from '../trigger/process-image.js';

const UuidSchema = z.string().uuid();
const MessageBodySchema = z.object({
  dealerId: z.string().uuid(),
  text: z.string().min(1).max(2000),
  clientMsgId: z.string().optional(),
});

async function startJobInProcess({ jobId, dealerId }) {
  const started = await jobModel.startProcessingIfCollecting(jobId, dealerId);
  if (!started) return;
  runProcessVehicleJob({ jobId, dealerId }, { run: { id: 'local-inprocess' } }).catch((err) => {
    console.error('[LocalJob] Failed:', err);
  });
}

export const messageController = {
  async list(req, res, next) {
    try {
      const parsed = UuidSchema.safeParse(req.query.dealerId);
      if (!parsed.success) return res.status(400).json({ error: 'Valid dealerId required' });
      const messages = await messageModel.listByDealer(parsed.data, 200);
      res.json({ messages });
    } catch (err) {
      next(err);
    }
  },

  async create(req, res, next) {
    try {
      const parsed = MessageBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid message body' });
      }
      const { dealerId, text, clientMsgId } = parsed.data;
      await dealerModel.ensure(dealerId);

      await channel.sendMessage({
        dealerId,
        role: 'dealer',
        msgType: 'text',
        text,
        deliveryStatus: 'delivered',
        payload: { clientMsgId },
      });

      const policyRow = await getActivePolicy();
      const trimmedLower = text.trim().toLowerCase();
      let classified = null;

      // Fast deterministic match for standard control commands (avoids extra LLM latency)
      if (/^(done|process|process now|start|go)$/i.test(trimmedLower)) {
        classified = { intent: 'done_start', reply: '' };
      } else if (/^retry\s*(?:photo)?\s*(\d+)$/i.test(trimmedLower)) {
        const m = trimmedLower.match(/^retry\s*(?:photo)?\s*(\d+)$/i);
        classified = {
          intent: 'retry_photo',
          photo_number: Number(m[1]),
          reply: `Retrying photo ${m[1]} now — updated result will be sent shortly.`,
        };
      } else if (/^new\s*car$/i.test(trimmedLower)) {
        classified = {
          intent: 'new_car',
          reply: 'Ready for a new car! Upload your next set of photos whenever you are ready.',
        };
      } else {
        try {
          classified = await classifyChatIntent({
            text,
            policy: policyRow.policy_json,
            dealerId,
          });
        } catch {
          classified = {
            intent: 'question',
            reply: 'Upload your car photos anytime, or type "done" to process your current batch.',
          };
        }
      }

      if (classified.intent === 'done_start') {
        const openJob = await jobModel.findCollecting(dealerId);
        if (openJob) {
          const jobId = openJob.id;
          const started = await jobModel.startProcessingIfCollecting(jobId, dealerId);
          if (started) {
            await channel.sendMessage({
              dealerId,
              jobId,
              role: 'assistant',
              msgType: 'text',
              text: 'Processing your image(s) — your edited photo(s) will be sent very soon.',
            });
            if (config.triggerSecretKey) {
              const handle = await processVehicleJobTask.trigger(
                { jobId, dealerId },
                { idempotencyKey: `process-vehicle-${jobId}` }
              );
              await jobModel.setTriggerRunId?.(jobId, dealerId, handle.id).catch(() => {});
            } else {
              runProcessVehicleJob({ jobId, dealerId }, { run: { id: 'local-inprocess' } }).catch((err) => {
                console.error('[LocalJob] Failed:', err);
              });
            }
          }
        } else {
          await channel.sendMessage({
            dealerId,
            role: 'assistant',
            msgType: 'text',
            text: 'No pending photos right now — upload car photos whenever you are ready!',
          });
        }
        return res.json({ ok: true, intent: classified.intent });
      } else if (classified.intent === 'retry_photo' && classified.photo_number) {
        const row = await imageModel.findLatestBySeqNum(dealerId, classified.photo_number);
        if (row) {
          if (config.triggerSecretKey) {
            await processImageTask.trigger(
              {
                jobId: row.job_id,
                dealerId,
                imageId: row.id,
                seqNum: row.seq_num,
                forceRetry: true,
              },
              { idempotencyKey: `retry-img-${row.id}-${Date.now()}` }
            );
          } else {
            runProcessImage(
              {
                jobId: row.job_id,
                dealerId,
                imageId: row.id,
                seqNum: row.seq_num,
                forceRetry: true,
              },
              { run: { id: 'local-inprocess' } }
            ).catch((err) => console.error('[LocalRetry] Failed:', err));
          }
        }
      } else if (classified.intent === 'new_car') {
        await jobModel.closeCollecting(dealerId);
      }

      await channel.sendMessage({
        dealerId,
        role: 'assistant',
        msgType: 'text',
        text: classified.reply,
      });

      res.json({ ok: true, intent: classified.intent });
    } catch (err) {
      next(err);
    }
  },
};
