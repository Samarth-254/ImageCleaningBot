import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

let aiClient = null;

export function getGeminiClient() {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment');
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return aiClient;
}

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.current += 1;
  }

  release() {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

const geminiSemaphore = new Semaphore(config.geminiMaxConcurrent);

export function classifyFallbackReason(err) {
  if (!err) return 'unavailable';
  if (err.name === 'AbortError' || err.name === 'TimeoutError' || /timeout|aborted/i.test(String(err.message))) {
    return 'timeout';
  }
  const status = Number(err?.status || err?.statusCode || err?.code);
  const msg = String(err?.message || '');
  if (status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
    return '429';
  }
  if ((status >= 500 && status < 600) || msg.includes('503') || msg.includes('500') || msg.includes('UNAVAILABLE')) {
    return '5xx';
  }
  if (status === 404 || msg.includes('NOT_FOUND')) {
    return 'unavailable';
  }
  if (err instanceof SyntaxError || /JSON|validation|Zod/i.test(msg)) {
    return 'invalid_json';
  }
  return 'unavailable';
}

export function isRetryableOrUnavailable(err) {
  const reason = classifyFallbackReason(err);
  return ['timeout', '429', '5xx', 'unavailable'].includes(reason);
}

function extractTokenCounts(usage = {}) {
  const inputTokens = Number(usage.promptTokenCount || 0);
  const outputTokens = Number(usage.candidatesTokenCount || 0);
  const thinkingTokens = Number(usage.thoughtsTokenCount || 0);
  const totalTokens = Number(usage.totalTokenCount || inputTokens + outputTokens + thinkingTokens);
  return { inputTokens, outputTokens, thinkingTokens, totalTokens };
}

async function withBackoff(fn, { maxAttempts = 4, baseDelayMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const reason = classifyFallbackReason(err);
      if ((reason !== '429' && reason !== '5xx') || attempt === maxAttempts) {
        throw err;
      }
      const exp = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, exp + jitter));
    }
  }
  throw lastErr;
}

/**
 * Startup check: verify ANALYSIS_MODEL and CHECK_MODEL exist via models.list().
 */
export async function verifyGeminiModel() {
  if (!config.geminiApiKey) {
    console.warn('[Gemini] GEMINI_API_KEY not set; skipping model list verification.');
    return { ok: false, reason: 'GEMINI_API_KEY missing' };
  }
  try {
    const ai = getGeminiClient();
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    const names = [];
    for await (const m of pager) {
      if (m?.name) names.push(m.name);
    }

    const checkExists = (target) =>
      names.some((n) => n === target || n === `models/${target}` || n.endsWith(`/${target}`));

    const analysisOk = checkExists(config.analysisModel);
    const checkOk = checkExists(config.checkModel);

    if (!analysisOk) {
      console.error(`[Gemini] WARNING: ANALYSIS_MODEL="${config.analysisModel}" NOT found in models.list().`);
    } else {
      console.log(`[Gemini] Verified ANALYSIS_MODEL="${config.analysisModel}".`);
    }

    if (!checkOk) {
      console.error(`[Gemini] WARNING: CHECK_MODEL="${config.checkModel}" NOT found in models.list().`);
    } else {
      console.log(
        `[Gemini] Verified CHECK_MODEL="${config.checkModel}" (thinkingLevel=${config.checkThinkingLevel}).`
      );
    }

    return {
      ok: analysisOk && checkOk,
      analysisModel: { id: config.analysisModel, ok: analysisOk },
      checkModel: { id: config.checkModel, ok: checkOk },
      availableSample: names.slice(0, 10),
    };
  } catch (err) {
    console.error('[Gemini] Failed to verify models via models.list():', err.message);
    return { ok: false, reason: err.message };
  }
}

/**
 * Call Gemini with structured JSON output, concurrency cap, 429/5xx backoff,
 * optional thinkingLevel, optional fallbackModel (with logged fallbackReason),
 * Zod validation, and ONE automatic JSON repair attempt on malformed output.
 */
export async function generateStructuredJson({
  model = config.analysisModel,
  fallbackModel = null,
  thinkingLevel = null,
  contents,
  responseSchema,
  zodSchema,
  systemInstruction,
  timeoutMs = 30000,
  _overrideClient = null,
}) {
  const ai = _overrideClient || getGeminiClient();
  const startedAt = Date.now();
  let modelUsed = model;
  let fallbackUsed = false;
  let fallbackReason = null;

  const invokeModel = async (targetModel, promptContents, useThinking) => {
    await geminiSemaphore.acquire();
    try {
      return await withBackoff(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const genConfig = {
            ...(systemInstruction ? { systemInstruction } : {}),
            responseMimeType: 'application/json',
            ...(responseSchema ? { responseSchema } : {}),
            ...(useThinking ? { thinkingConfig: { thinkingLevel: useThinking } } : {}),
            abortSignal: controller.signal,
          };
          return await ai.models.generateContent({
            model: targetModel,
            contents: promptContents,
            config: genConfig,
          });
        } finally {
          clearTimeout(timer);
        }
      });
    } finally {
      geminiSemaphore.release();
    }
  };

  const tryParseAndValidate = (text) => {
    const parsed = JSON.parse(text);
    return zodSchema ? zodSchema.parse(parsed) : parsed;
  };

  let tokenTotals = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 };
  const addUsage = (resp) => {
    const c = extractTokenCounts(resp?.usageMetadata || {});
    tokenTotals.inputTokens += c.inputTokens;
    tokenTotals.outputTokens += c.outputTokens;
    tokenTotals.thinkingTokens += c.thinkingTokens;
    tokenTotals.totalTokens += c.totalTokens;
  };

  const runAttempt = async (targetModel, useThinking) => {
    const response = await invokeModel(targetModel, contents, useThinking);
    addUsage(response);
    const rawText = response?.text || '';
    try {
      const data = tryParseAndValidate(rawText);
      return { data, repaired: false };
    } catch (firstErr) {
      const repairPrompt = [
        'Your previous JSON output failed parsing or schema validation.',
        `Error: ${firstErr.message}`,
        'Return ONLY valid JSON matching the required schema. Fix the malformed output below:',
        rawText.slice(0, 4000),
      ].join('\n');
      const repairResp = await invokeModel(targetModel, repairPrompt, useThinking);
      addUsage(repairResp);
      const repairedData = tryParseAndValidate(repairResp?.text || '');
      return { data: repairedData, repaired: true };
    }
  };

  try {
    const out = await runAttempt(model, thinkingLevel);
    return {
      ...out,
      ...tokenTotals,
      tokens: tokenTotals.totalTokens,
      latencyMs: Date.now() - startedAt,
      modelUsed,
      fallbackUsed,
      fallbackReason,
    };
  } catch (primaryErr) {
    if (fallbackModel && fallbackModel !== model) {
      fallbackUsed = true;
      fallbackReason = classifyFallbackReason(primaryErr);
      modelUsed = fallbackModel;
      try {
        const fbOut = await runAttempt(fallbackModel, null);
        return {
          ...fbOut,
          ...tokenTotals,
          tokens: tokenTotals.totalTokens,
          latencyMs: Date.now() - startedAt,
          modelUsed,
          fallbackUsed,
          fallbackReason,
        };
      } catch (fbErr) {
        const err = new Error(`Fallback model (${fallbackModel}) failed after ${fallbackReason}: ${fbErr.message}`);
        Object.assign(err, tokenTotals, {
          tokens: tokenTotals.totalTokens,
          latencyMs: Date.now() - startedAt,
          modelUsed,
          fallbackUsed,
          fallbackReason,
        });
        throw err;
      }
    }
    const err = new Error(primaryErr.message);
    Object.assign(err, tokenTotals, {
      tokens: tokenTotals.totalTokens,
      latencyMs: Date.now() - startedAt,
      modelUsed,
      fallbackUsed,
      fallbackReason,
    });
    throw err;
  }
}
