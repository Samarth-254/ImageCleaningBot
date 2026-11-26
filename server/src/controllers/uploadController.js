import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import { config } from '../config.js';
import { dealerModel } from '../models/dealerModel.js';
import { jobModel } from '../models/jobModel.js';
import { imageModel } from '../models/imageModel.js';
import { storage } from '../services/storage.js';
import { channel } from '../services/channel.js';
import { startJobTask } from '../trigger/start-job.js';
import { runProcessVehicleJob } from '../trigger/process-vehicle-job.js';

const UuidSchema = z.string().uuid();
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

function fileUrlFromRelPath(relPath) {
  if (!relPath) return null;
  const parts = relPath.split('/');
  return `/api/files/${parts[0]}/${path.basename(relPath)}`;
}

async function startJobInProcess({ jobId, dealerId }) {
  const started = await jobModel.startProcessingIfCollecting(jobId, dealerId);
  if (!started) return;
  runProcessVehicleJob({ jobId, dealerId }, { run: { id: 'local-inprocess' } }).catch((err) => {
    console.error('[LocalJob] Failed:', err);
  });
}

export const uploadController = {
  async upload(req, res, next) {
    try {
      const parsed = UuidSchema.safeParse(req.body?.dealerId || req.headers['x-dealer-id']);
      if (!parsed.success) return res.status(400).json({ error: 'Valid dealerId required' });
      const dealerId = parsed.data;
      const clientMsgId = typeof req.body?.clientMsgId === 'string' ? req.body.clientMsgId : null;
      await dealerModel.ensure(dealerId);

      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'No photos uploaded.' });
      }

      const openJob = await jobModel.findCollecting(dealerId);
      let jobId;
      if (openJob) {
        jobId = openJob.id;
      } else {
        jobId = crypto.randomUUID();
        await jobModel.createCollecting(jobId, dealerId);
      }

      const existingImgs = await imageModel.listByJob(jobId, dealerId);
      let currentCount = existingImgs.length;
      const existingHashes = new Set(existingImgs.map((r) => r.hash));

      const accepted = [];
      const duplicates = [];
      const rejected = [];

      for (const file of files) {
        if (currentCount >= config.maxImagesPerJob) {
          rejected.push(`Reached max ${config.maxImagesPerJob} photos per batch.`);
          continue;
        }

        const detected = await fileTypeFromBuffer(file.buffer);
        if (!detected || !ALLOWED_MIMES.has(detected.mime)) {
          rejected.push(`${file.originalname || 'File'} is not a supported image (JPEG, PNG, WebP, HEIC).`);
          continue;
        }

        const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
        if (existingHashes.has(hash)) {
          duplicates.push(file.originalname || 'Photo');
          continue;
        }
        existingHashes.add(hash);

        let origBuffer = file.buffer;
        let origExt = detected.ext === 'heic' || detected.ext === 'heif' ? 'jpg' : detected.ext;
        if (detected.mime === 'image/heic' || detected.mime === 'image/heif') {
          origBuffer = await sharp(file.buffer).rotate().jpeg({ quality: 92 }).toBuffer();
        }

        const meta = await sharp(origBuffer).rotate().metadata();
        const origPath = await storage.saveOriginal(origBuffer, origExt);
        const previewBuffer = await sharp(origBuffer)
          .rotate()
          .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 78 })
          .toBuffer();
        const previewPath = await storage.savePreview(previewBuffer, 'jpg');

        currentCount += 1;
        const imageId = crypto.randomUUID();
        await imageModel.create({
          id: imageId,
          jobId,
          dealerId,
          seqNum: currentCount,
          originalPath: origPath,
          previewPath,
          hash,
          mimeType: detected.mime,
          width: meta.width || null,
          height: meta.height || null,
        });

        accepted.push({
          id: imageId,
          seqNum: currentCount,
          url: fileUrlFromRelPath(previewPath),
        });
      }

      const nowTs = Date.now();
      await jobModel.touchLastPhoto(jobId, dealerId);

      if (accepted.length > 0) {
        await channel.sendMessage({
          dealerId,
          jobId,
          role: 'dealer',
          msgType: 'image',
          text: accepted.length === 1 ? 'Uploaded 1 photo' : `Uploaded ${accepted.length} photos`,
          deliveryStatus: 'delivered',
          payload: {
            clientMsgId,
            images: accepted.map((a) => ({ id: a.id, url: a.url, progress: 100 })),
          },
        });

        const delaySeconds = Math.max(1, Math.ceil(config.photoGroupWindowMs / 1000));
        if (config.triggerSecretKey) {
          await startJobTask.trigger(
            { jobId, dealerId, forceNow: false },
            {
              delay: `${delaySeconds}s`,
              idempotencyKey: `start-job-${jobId}-${nowTs}`,
            }
          );
        } else {
          const timer = setTimeout(() => {
            jobModel
              .getStatusAndLastPhoto(jobId, dealerId)
              .then((row) => {
                if (row && row.status === 'collecting') {
                  const elapsed = Date.now() - new Date(row.last_photo_at).getTime();
                  if (elapsed >= config.photoGroupWindowMs - 500) {
                    return startJobInProcess({ jobId, dealerId });
                  }
                }
              })
              .catch(() => {});
          }, config.photoGroupWindowMs);
          timer.unref?.();
        }

        await channel.sendMessage({
          dealerId,
          jobId,
          role: 'assistant',
          msgType: 'text',
          text: `Got ${accepted.length} photo${accepted.length > 1 ? 's' : ''}! Send more or tap "Process now" to start right away.`,
          payload: {
            quickReplies: [{ label: 'Process now', action: 'text', text: 'done' }],
          },
        });
      }

      if (duplicates.length > 0) {
        await channel.sendMessage({
          dealerId,
          jobId,
          role: 'assistant',
          msgType: 'text',
          text: `Skipped ${duplicates.length} duplicate photo${duplicates.length > 1 ? 's' : ''} already in this batch.`,
        });
      }

      if (rejected.length > 0) {
        await channel.sendMessage({
          dealerId,
          jobId,
          role: 'assistant',
          msgType: 'text',
          text: rejected.join(' '),
        });
      }

      res.json({ jobId, acceptedCount: accepted.length, duplicatesCount: duplicates.length, rejected });
    } catch (err) {
      next(err);
    }
  },
};
