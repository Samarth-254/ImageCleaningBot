import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const triggerIdx = __dirname.indexOf(`${path.sep}.trigger${path.sep}`);
const serverRoot = triggerIdx >= 0 ? __dirname.slice(0, triggerIdx) : path.resolve(__dirname, '..');
const serverEnvPath = path.join(serverRoot, '.env');

dotenv.config({ path: serverEnvPath });

const analysisModel = process.env.ANALYSIS_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const rawThinking = (process.env.CHECK_THINKING_LEVEL || 'low').toLowerCase();
const checkThinkingLevel = ['low', 'medium', 'high'].includes(rawThinking) ? rawThinking : 'low';

export const config = {
  port: Number(process.env.PORT || 3001),
  nodeEnv: process.env.NODE_ENV || 'development',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  databaseUrl: process.env.DATABASE_URL || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: analysisModel,
  analysisModel,
  checkModel: process.env.CHECK_MODEL || 'gemini-3.8-flash',
  checkThinkingLevel,
  checkModelFallback: process.env.CHECK_MODEL_FALLBACK || analysisModel,
  geminiMaxConcurrent: Number(process.env.GEMINI_MAX_CONCURRENT || 3),
  analysisTimeoutMs: Number(process.env.ANALYSIS_TIMEOUT_MS || 30000),
  checkTimeoutMs: Number(process.env.CHECK_TIMEOUT_MS || 45000),
  chatIntentTimeoutMs: Number(process.env.CHAT_INTENT_TIMEOUT_MS || 15000),
  analysisImageMaxEdge: Number(process.env.ANALYSIS_IMAGE_MAX_EDGE || 1024),
  checkImageMaxEdge: Number(process.env.CHECK_IMAGE_MAX_EDGE || 768),
  editProvider: process.env.EDIT_PROVIDER || 'mock',
  editFallbackProvider: process.env.EDIT_FALLBACK_PROVIDER || '',
  editApiUrl: process.env.EDIT_API_URL || '',
  editApiKey: process.env.EDIT_API_KEY || '',
  editModelName: process.env.EDIT_MODEL_NAME || 'qwen-image-edit',
  kieApiKey: process.env.KIE_API_KEY || '',
  kieApiKeys: [
    ...(process.env.KIE_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean),
    ...(process.env.KIE_API_KEY ? [process.env.KIE_API_KEY.trim()] : []),
    ...(process.env.KIE_API_KEY_2 ? [process.env.KIE_API_KEY_2.trim()] : []),
  ].filter((v, i, arr) => v && arr.indexOf(v) === i),
  kieModelName: process.env.KIE_MODEL_NAME || 'google/nano-banana-edit',
  editResolution: process.env.EDIT_RESOLUTION || '640px',
  editPromptMode: process.env.EDIT_PROMPT_MODE === 'template' ? 'template' : 'ai',
  editTimeoutMs: Number(process.env.EDIT_TIMEOUT_MS || 45000),
  triggerSecretKey: process.env.TRIGGER_SECRET_KEY || '',
  triggerProjectRef: process.env.TRIGGER_PROJECT_REF || 'proj_asbtzznxbfbvsbpdauxx',
  triggerImageConcurrency: Number(process.env.TRIGGER_IMAGE_CONCURRENCY || 3),
  photoGroupWindowMs: Number(process.env.PHOTO_GROUP_WINDOW_MS || 45000),
  maxImagesPerJob: Number(process.env.MAX_IMAGES_PER_JOB || 12),
  maxEditRetries: Number(process.env.MAX_EDIT_RETRIES || 1),
  perImageTimeoutMs: Number(process.env.PER_IMAGE_TIMEOUT_MS || 210000),
  photoTimeBudgetMs: Number(process.env.PHOTO_TIME_BUDGET_MS || 180000),
  costPer1kTokensUsd: Number(process.env.COST_PER_1K_TOKENS_USD || 0),
  storageDir: process.env.STORAGE_DIR || path.join(serverRoot, 'storage'),
  promptsDir: path.join(serverRoot, 'prompts'),
};
