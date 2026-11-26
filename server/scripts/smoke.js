import sharp from 'sharp';
import { Type } from '@google/genai';
import { z } from 'zod';
import { tasks, runs } from '@trigger.dev/sdk/v3';
import { config } from '../src/config.js';
import { verifyGeminiModel, generateStructuredJson } from '../src/services/gemini.js';
import { editImage } from '../src/services/editor.js';

async function createSampleCarImage() {
  const svg = `<svg width="400" height="250" xmlns="http://www.w3.org/2000/svg">
    <rect width="400" height="250" fill="#e2e8f0"/>
    <rect x="60" y="110" width="280" height="75" rx="18" fill="#1d4ed8"/>
    <rect x="110" y="70" width="160" height="50" rx="12" fill="#2563eb"/>
    <circle cx="120" cy="185" r="24" fill="#111827"/>
    <circle cx="280" cy="185" r="24" fill="#111827"/>
    <path d="M180 130 L230 155" stroke="#9ca3af" stroke-width="5"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

async function runSmoke() {
  console.log('=== Milestone 0 Smoke Test ===');
  const results = {
    gemini: { status: 'skipped' },
    edit: { status: 'skipped' },
    trigger: { status: 'skipped' },
  };

  const sampleBuffer = await createSampleCarImage();

  // 1. Gemini Vision Smoke Test (ANALYSIS_MODEL + CHECK_MODEL)
  if (!config.geminiApiKey) {
    results.gemini = { status: 'missing_key', message: 'GEMINI_API_KEY is not set' };
    console.log('[1/3] Gemini: SKIPPED (GEMINI_API_KEY not set)');
  } else {
    try {
      const modelCheck = await verifyGeminiModel();
      const zodSchema = z.object({
        description: z.string(),
        is_in_scope: z.boolean(),
      });
      const resp = await generateStructuredJson({
        model: config.analysisModel,
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Describe this image briefly and state if it is in scope.' },
              {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: sampleBuffer.toString('base64'),
                },
              },
            ],
          },
        ],
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            description: { type: Type.STRING },
            is_in_scope: { type: Type.BOOLEAN },
          },
          required: ['description', 'is_in_scope'],
        },
        zodSchema,
      });

      const checkResp = await generateStructuredJson({
        model: config.checkModel,
        fallbackModel: config.checkModelFallback,
        thinkingLevel: config.checkThinkingLevel,
        contents: 'Return {"ok":true,"note":"checker ready"}',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            ok: { type: Type.BOOLEAN },
            note: { type: Type.STRING },
          },
          required: ['ok', 'note'],
        },
        zodSchema: z.object({ ok: z.boolean(), note: z.string() }),
        timeoutMs: config.checkTimeoutMs,
      });

      results.gemini = {
        status: 'passed',
        analysisModelVerified: modelCheck.analysisModel?.ok,
        checkModelVerified: modelCheck.checkModel?.ok,
        analysisLatencyMs: resp.latencyMs,
        checkModelUsed: checkResp.modelUsed,
        checkThinkingLevel: config.checkThinkingLevel,
        checkFallbackUsed: checkResp.fallbackUsed,
        checkFallbackReason: checkResp.fallbackReason,
        checkLatencyMs: checkResp.latencyMs,
        data: resp.data,
      };
      console.log('[1/3] Gemini (Analysis + Check): PASSED', results.gemini);
    } catch (err) {
      results.gemini = { status: 'failed', error: err.message };
      console.error('[1/3] Gemini: FAILED', err.message);
    }
  }

  // 2. Image Edit Smoke Test
  try {
    const edited = await editImage({
      imageBuffer: sampleBuffer,
      instruction: 'Remove the scratch on the side door.',
    });
    const meta = await sharp(edited.imageBuffer).metadata();
    results.edit = {
      status: 'passed',
      provider: config.editProvider,
      latencyMs: edited.latencyMs,
      outputDimensions: `${meta.width}x${meta.height}`,
      bytes: edited.imageBuffer.length,
    };
    console.log('[2/3] Image Edit: PASSED', results.edit);
  } catch (err) {
    results.edit = { status: 'failed', error: err.message };
    console.error('[2/3] Image Edit: FAILED', err.message);
  }

  // 3. Trigger.dev Smoke Test
  if (!config.triggerSecretKey) {
    results.trigger = { status: 'missing_key', message: 'TRIGGER_SECRET_KEY is not set' };
    console.log('[3/3] Trigger.dev: SKIPPED (TRIGGER_SECRET_KEY not set)');
  } else {
    try {
      const handle = await tasks.trigger('smoke-test', {
        message: 'CarDesk Milestone 0 smoke check',
      });
      console.log('[3/3] Trigger.dev triggered run:', handle.id, '— polling for completion (make sure trigger:dev is running)...');
      const run = await runs.poll(handle.id, { pollIntervalMs: 1000 });
      results.trigger = {
        status: run.status === 'COMPLETED' ? 'passed' : 'failed',
        runId: handle.id,
        runStatus: run.status,
        output: run.output,
      };
      console.log('[3/3] Trigger.dev:', results.trigger);
    } catch (err) {
      results.trigger = { status: 'failed', error: err.message };
      console.error('[3/3] Trigger.dev: FAILED', err.message);
    }
  }

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(results, null, 2));
}

runSmoke().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
