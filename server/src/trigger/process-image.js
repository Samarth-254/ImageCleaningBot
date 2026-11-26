import { task, queue } from '@trigger.dev/sdk/v3';
import sharp from 'sharp';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { storage } from '../services/storage.js';
import { editImage } from '../services/editor.js';
import { getActivePolicy } from '../services/policy.js';
import { channel } from '../services/channel.js';
import { buildEditInstruction, decideRetry, runAnalyzeStep, runCheckStep } from '../services/pipeline.js';

const imageQueue = queue({
  name: 'process-image-queue',
  concurrencyLimit: config.triggerImageConcurrency,
});

function fileUrlFromRelPath(relPath) {
  if (!relPath) return null;
  const parts = relPath.split('/');
  return `/api/files/${parts[0]}/${path.basename(relPath)}`;
}

async function addTrace(dealerId, jobId, imageId, stage, payload = {}, latencyMs = null) {
  await db.query(
    `INSERT INTO trace_events (dealer_id, job_id, image_id, stage, payload_json, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [dealerId, jobId, imageId, stage, JSON.stringify(payload), latencyMs]
  );
}

async function withTimeout(promiseFactory, ms, label) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promiseFactory(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runProcessImage(payload, ctx = {}) {
    const { jobId, dealerId, imageId, seqNum, forceRetry = false } = payload;
    const startedAt = Date.now();

    const imgRes = await db.query(
      'SELECT * FROM images WHERE id = $1 AND job_id = $2 AND dealer_id = $3',
      [imageId, jobId, dealerId]
    );
    if (imgRes.rowCount === 0) {
      return { error: 'image_not_found' };
    }

    let img = imgRes.rows[0];
    let stepState = img.step_state || {};

    if (forceRetry) {
      stepState = { analyzed: Boolean(img.analysis_json) };
      await db.query(
        `UPDATE images
         SET step_state = $1, retry_count = retry_count + 1, status = 'queued', final_decision = NULL, note = NULL, updated_at = NOW()
         WHERE id = $2 AND dealer_id = $3`,
        [JSON.stringify(stepState), imageId, dealerId]
      );
    }

    await db.query(
      'UPDATE images SET trigger_run_id = $1, updated_at = NOW() WHERE id = $2 AND dealer_id = $3',
      [ctx?.run?.id || null, imageId, dealerId]
    );

    const policyRow = await getActivePolicy();
    const policy = policyRow.policy_json;

    const runPipeline = async (signal) => {
      console.log(`[Image] start job=${jobId} seq=${seqNum} image=${imageId}`);
      const originalBuffer = await storage.readBuffer(img.original_path);
      if (signal?.aborted) return;
      // STEP 1: ANALYZE (skip if already done)
      let analysis = img.analysis_json;
      if (!stepState.analyzed || !analysis) {
        await db.query(
          "UPDATE images SET status = 'analyzing', updated_at = NOW() WHERE id = $1 AND dealer_id = $2",
          [imageId, dealerId]
        );

        // Check content-hash cache for identical image in same dealer
        const cached = await db.query(
          `SELECT analysis_json FROM images
           WHERE dealer_id = $1 AND hash = $2 AND id != $3 AND analysis_json IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
          [dealerId, img.hash, imageId]
        );

        if (cached.rowCount > 0 && !forceRetry) {
          analysis = cached.rows[0].analysis_json;
          await addTrace(dealerId, jobId, imageId, 'analyze_cached', { action: analysis.action }, 0);
        } else {
          const downscaled = await sharp(originalBuffer)
            .rotate()
            .resize({
              width: config.analysisImageMaxEdge,
              height: config.analysisImageMaxEdge,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .jpeg({ quality: 82 })
            .toBuffer();

          const analyzed = await runAnalyzeStep({
            imageBuffer: downscaled,
            mimeType: 'image/jpeg',
            policy,
            dealerId,
            jobId,
            imageId,
          });
          analysis = analyzed.analysis;
          await addTrace(
            dealerId,
            jobId,
            imageId,
            'analyze_done',
            {
              action: analysis.action,
              problemsCount: analysis.problems?.length || 0,
              injectionSuspected: analysis.injection_suspected,
              modelUsed: analyzed.modelUsed,
            },
            analyzed.latencyMs
          );
        }

        if (analysis.injection_suspected) {
          await addTrace(dealerId, jobId, imageId, 'prompt_injection_ignored', {
            description: analysis.description,
          });
        }

        stepState = { ...stepState, analyzed: true };
        await db.query(
          `UPDATE images
           SET analysis_json = $1, step_state = $2, updated_at = NOW()
           WHERE id = $3 AND dealer_id = $4`,
          [JSON.stringify(analysis), JSON.stringify(stepState), imageId, dealerId]
        );
      }

      // Handle non-edit actions
      if (analysis.action !== 'edit') {
        const decision = analysis.action; // passthrough | reject | ask_dealer
        const note =
          decision === 'ask_dealer'
            ? analysis.clarifying_question || analysis.action_reason
            : analysis.action_reason;

        stepState = { ...stepState, edited: true, checked: true };
        await db.query(
          `UPDATE images
           SET status = 'completed', final_decision = $1, note = $2, step_state = $3,
               total_latency_ms = $4, updated_at = NOW()
           WHERE id = $5 AND dealer_id = $6`,
          [decision, note, JSON.stringify(stepState), Date.now() - startedAt, imageId, dealerId]
        );

        if (!stepState.reported) {
          const origUrl = fileUrlFromRelPath(img.original_path);
          await channel.sendMessage({
            dealerId,
            jobId,
            imageId,
            role: 'assistant',
            msgType: decision === 'reject' || decision === 'ask_dealer' ? 'text' : 'result',
            text: `Photo ${seqNum}: ${note}`,
            payload:
              decision === 'passthrough'
                ? { afterUrl: origUrl, repairedChips: ['Original kept'] }
                : {},
          });
          stepState = { ...stepState, reported: true };
          await db.query(
            'UPDATE images SET step_state = $1, updated_at = NOW() WHERE id = $2 AND dealer_id = $3',
            [JSON.stringify(stepState), imageId, dealerId]
          );
        }
        return { imageId, decision };
      }

      // STEP 2 & 3: EDIT + CHECK with smarter retry and PHOTO_TIME_BUDGET_MS
      let editRelPath = img.edit_output_path;
      let checkResult = img.check_json;
      let retryCount = img.retry_count || 0;
      let nextBuiltOverride = null;
      let currentInstruction = img.edit_instruction || '';

      if (!stepState.checked) {
        for (let attempt = 0; attempt <= config.maxEditRetries; attempt += 1) {
          let editedBuffer;
          let lastEditMs = 15000;

          if (!stepState.edited || attempt > 0) {
            const built = nextBuiltOverride || buildEditInstruction({ analysis, policy });
            currentInstruction = built.instruction;
            await db.query(
              "UPDATE images SET status = 'editing', edit_instruction = $1, updated_at = NOW() WHERE id = $2 AND dealer_id = $3",
              [currentInstruction, imageId, dealerId]
            );
            await addTrace(dealerId, jobId, imageId, 'edit_prompt_built', {
              attempt: attempt + 1,
              modeUsed: built.modeUsed,
              fallbackReason: built.fallbackReason,
              substitutions: built.substitutions,
              draftEditPrompt: built.draftEditPrompt,
              finalInstruction: currentInstruction,
              mustPreserve: built.mustPreserve,
            });

            const editRes = await editImage({ imageBuffer: originalBuffer, instruction: currentInstruction });
            if (signal?.aborted) return;
            lastEditMs = editRes.latencyMs;

            // Normalize output back to exact oriented original pixel dimensions & strip metadata
            const { info: origInfo } = await sharp(originalBuffer)
              .rotate()
              .toBuffer({ resolveWithObject: true });
            const normalizedBuffer = await sharp(editRes.imageBuffer)
              .resize({
                width: origInfo.width,
                height: origInfo.height,
                fit: 'fill',
              })
              .jpeg({ quality: 92 })
              .toBuffer();

            editRelPath = await storage.saveOutput(normalizedBuffer, 'jpg');
            editedBuffer = normalizedBuffer;

            await db.query(
              `INSERT INTO ai_usage (dealer_id, job_id, image_id, provider, model, operation, tokens, latency_ms, success)
               VALUES ($1, $2, $3, $4, $5, 'edit', 0, $6, TRUE)`,
              [dealerId, jobId, imageId, editRes.meta?.provider || config.editProvider, editRes.meta?.model || config.editModelName, editRes.latencyMs]
            );

            await addTrace(
              dealerId,
              jobId,
              imageId,
              'edit_done',
              { attempt: attempt + 1, provider: editRes.meta?.provider },
              editRes.latencyMs
            );

            stepState = { ...stepState, edited: true };
            await db.query(
              `UPDATE images
               SET edit_output_path = $1, step_state = $2, updated_at = NOW()
               WHERE id = $3 AND dealer_id = $4`,
              [editRelPath, JSON.stringify(stepState), imageId, dealerId]
            );
          } else {
            editedBuffer = await storage.readBuffer(editRelPath);
          }

          await db.query(
            "UPDATE images SET status = 'checking', updated_at = NOW() WHERE id = $1 AND dealer_id = $2",
            [imageId, dealerId]
          );

          const checkEdge = config.checkImageMaxEdge;
          const origDownscaled = await sharp(originalBuffer)
            .rotate()
            .resize({ width: checkEdge, height: checkEdge, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 84 })
            .toBuffer();
          const { info: origCheckInfo } = await sharp(origDownscaled).toBuffer({ resolveWithObject: true });
          const editDownscaled = await sharp(editedBuffer)
            .resize({ width: origCheckInfo.width, height: origCheckInfo.height, fit: 'fill' })
            .jpeg({ quality: 84 })
            .toBuffer();

          const checked = await runCheckStep({
            originalBuffer: origDownscaled,
            editedBuffer: editDownscaled,
            analysis,
            policy,
            dealerId,
            jobId,
            imageId,
            isFinalAttempt: attempt >= config.maxEditRetries,
          });
          if (signal?.aborted) return;
          checkResult = checked.check;

          await addTrace(
            dealerId,
            jobId,
            imageId,
            'check_done',
            {
              attempt: attempt + 1,
              verdict: checkResult.verdict,
              verdictRule: checkResult.verdict_rule,
              modelUsed: checked.modelUsed,
              thinkingLevel: checkResult.thinking_level,
              fallbackUsed: checked.fallbackUsed,
              fallbackReason: checked.fallbackReason,
            },
            checked.latencyMs
          );

          if (checkResult.verdict === 'pass') {
            break;
          }

          const elapsedMs = Date.now() - startedAt;
          const estimatedRetryMs = lastEditMs + checked.latencyMs;
          const decision = decideRetry({
            check: checkResult,
            analysis,
            policy,
            retryCount,
            maxRetries: config.maxEditRetries,
            previousInstruction: currentInstruction,
            elapsedMs,
            estimatedRetryMs,
            budgetMs: config.photoTimeBudgetMs,
          });

          await addTrace(dealerId, jobId, imageId, 'retry_decision', {
            attempt: attempt + 1,
            shouldRetry: decision.shouldRetry,
            reason: decision.reason,
            elapsedMs,
            estimatedRetryMs,
            budgetMs: config.photoTimeBudgetMs,
          });

          if (decision.shouldRetry && decision.nextBuilt) {
            retryCount += 1;
            nextBuiltOverride = decision.nextBuilt;
            await db.query(
              'UPDATE images SET retry_count = $1, updated_at = NOW() WHERE id = $2 AND dealer_id = $3',
              [retryCount, imageId, dealerId]
            );
            continue;
          }

          // No retry (budget exceeded, not retryable, or identical instruction) -> fallback
          checkResult = {
            ...checkResult,
            verdict: 'fallback',
            retry_skipped_reason: decision.reason,
          };
          break;
        }

        stepState = { ...stepState, checked: true };
        await db.query(
          `UPDATE images SET check_json = $1, step_state = $2, updated_at = NOW() WHERE id = $3 AND dealer_id = $4`,
          [JSON.stringify(checkResult), JSON.stringify(stepState), imageId, dealerId]
        );
      }

      const passed = checkResult?.verdict === 'pass';
      const finalDecision = passed ? 'fixed' : 'fallback_original';
      const reconstructedCount = (checkResult?.reconstructed_regions || []).length;
      const showReconNote = Boolean(policy?.show_reconstruction_note) && reconstructedCount > 0;
      const skipReason = checkResult?.retry_skipped_reason ? ` [${checkResult.retry_skipped_reason}]` : '';
      const partialUnfixed = checkResult?.partial_unfixed || [];
      const partialFixed = checkResult?.partial_fixed || [];
      const partialSummary =
        passed && partialUnfixed.length > 0
          ? `${partialFixed.join(', ') || 'main issue'} fixed; ${partialUnfixed.join(', ')} still visible.`
          : '';
      const note = passed
        ? partialSummary ||
          `Repaired ${analysis.problems?.length || 0} issue(s) cleanly.${showReconNote ? ` (${reconstructedCount} obscured area(s) reconstructed naturally.)` : ''}`
        : `Kept the original for photo ${seqNum} (${checkResult?.failure_reasons?.join('; ') || checkResult?.looks_natural?.reason || 'did not pass quality check'}${skipReason}).`;

      if (signal?.aborted) return;
      const totalLatencyMs = Date.now() - startedAt;
      console.log(`[Image] done job=${jobId} seq=${seqNum} decision=${finalDecision} latencyMs=${totalLatencyMs}`);
      await db.query(
        `UPDATE images
         SET status = 'completed', final_decision = $1, note = $2, total_latency_ms = $3, updated_at = NOW()
         WHERE id = $4 AND dealer_id = $5`,
        [finalDecision, note, totalLatencyMs, imageId, dealerId]
      );

      await db.query(
        `INSERT INTO audit_log (dealer_id, job_id, image_id, problems_repaired, model, decision)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          dealerId,
          jobId,
          imageId,
          JSON.stringify(passed ? analysis.problems || [] : []),
          config.editModelName,
          finalDecision,
        ]
      );

      if (!stepState.reported) {
        const beforeUrl = fileUrlFromRelPath(img.original_path);
        const afterUrl = passed ? fileUrlFromRelPath(editRelPath) : beforeUrl;
        const repairedChips = passed
          ? (analysis.problems || []).slice(0, 4).map((p) => `${p.type} (${p.where})`)
          : ['Original returned'];

        await channel.sendMessage({
          dealerId,
          jobId,
          imageId,
          role: 'assistant',
          msgType: 'result',
          text: passed
            ? partialSummary
              ? `Photo ${seqNum} partially fixed (${partialSummary})`
              : `Photo ${seqNum} fixed!`
            : note,
          payload: {
            beforeUrl,
            afterUrl,
            repairedChips,
            quickReplies: [{ label: `Retry photo ${seqNum}`, action: 'text', text: `retry photo ${seqNum}` }],
          },
        });

        stepState = { ...stepState, reported: true };
        await db.query(
          'UPDATE images SET step_state = $1, updated_at = NOW() WHERE id = $2 AND dealer_id = $3',
          [JSON.stringify(stepState), imageId, dealerId]
        );
      }

      return { imageId, finalDecision };
    };

    try {
      return await withTimeout((signal) => runPipeline(signal), config.perImageTimeoutMs, `process-image-${seqNum}`);
    } catch (err) {
      // Fail safe: return ORIGINAL photo with an honest note
      const fallbackNote = `Kept the original for photo ${seqNum} (${err.message}).`;
      await addTrace(dealerId, jobId, imageId, 'fallback_error', { error: err.message });

      await db.query(
        `UPDATE images
         SET status = 'completed', final_decision = 'fallback_original', note = $1,
             total_latency_ms = $2, updated_at = NOW()
         WHERE id = $3 AND dealer_id = $4`,
        [fallbackNote, Date.now() - startedAt, imageId, dealerId]
      );

      if (!stepState.reported) {
        const origUrl = fileUrlFromRelPath(img.original_path);
        await channel.sendMessage({
          dealerId,
          jobId,
          imageId,
          role: 'assistant',
          msgType: 'result',
          text: fallbackNote,
          payload: {
            beforeUrl: origUrl,
            afterUrl: origUrl,
            repairedChips: ['Original fallback'],
            quickReplies: [{ label: `Retry photo ${seqNum}`, action: 'text', text: `retry photo ${seqNum}` }],
          },
        });
        stepState = { ...stepState, reported: true };
        await db.query(
          'UPDATE images SET step_state = $1, updated_at = NOW() WHERE id = $2 AND dealer_id = $3',
          [JSON.stringify(stepState), imageId, dealerId]
        );
      }

      return { imageId, finalDecision: 'fallback_original', error: err.message };
    }
}

export const processImageTask = task({
  id: 'process-image',
  queue: imageQueue,
  maxDuration: 240,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 8000,
    factor: 2,
    randomize: true,
  },
  run: async (payload, { ctx }) => runProcessImage(payload, ctx),
});
