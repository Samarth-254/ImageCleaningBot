import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { generateStructuredJson } from './gemini.js';

export const MAX_EDIT_PROMPT_CHARS = 1200;
export const MAX_PRESERVE_ITEMS = 15;
export const MAX_PRESERVE_ITEM_CHARS = 80;

export const FIXED_RULES =
  'Fix ONLY the problems described above. Do not change anything else in the image. The result must look like a natural, unedited photograph.';

const promptCache = new Map();

async function loadPromptTemplate(filename, replacements = {}) {
  let tpl = promptCache.get(filename);
  if (!tpl) {
    tpl = await fs.readFile(path.join(config.promptsDir, filename), 'utf8');
    promptCache.set(filename, tpl);
  }
  let out = tpl;
  for (const [key, val] of Object.entries(replacements)) {
    out = out.replaceAll(`{{${key}}}`, val);
  }
  return out;
}

export const MustPreserveItemSchema = z.object({
  item: z.string().max(MAX_PRESERVE_ITEM_CHARS),
  visibility: z.enum(['clear', 'obscured_by_damage']),
});

export const AnalysisZodSchema = z.object({
  description: z.string().max(1000),
  tags: z.array(z.string().max(40)),
  is_in_scope: z.boolean(),
  matches_never_edit_policy: z.boolean(),
  contains_people_or_faces: z.boolean(),
  usability: z.object({
    score: z.number().min(0).max(1),
    reasons: z.array(z.string().max(200)),
  }),
  quality_issues: z.array(z.string().max(120)),
  problems: z.array(
    z.object({
      type: z.string().max(80),
      where: z.string().max(120),
      severity: z.string().max(40),
      fix_instruction: z.string().max(240),
    })
  ),
  must_preserve: z.array(MustPreserveItemSchema),
  edit_prompt: z.string(),
  injection_suspected: z.boolean(),
  background_issues: z.string().max(300),
  looks_non_original: z.object({
    is_non_original: z.boolean(),
    reasoning: z.string().max(300),
  }),
  action: z.enum(['edit', 'passthrough', 'reject', 'ask_dealer']),
  action_reason: z.string().max(400),
  confidence: z.number().min(0).max(1),
  clarifying_question: z.string().max(300).optional().default(''),
});

const ANALYSIS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    description: { type: Type.STRING },
    tags: { type: Type.ARRAY, items: { type: Type.STRING } },
    is_in_scope: { type: Type.BOOLEAN },
    matches_never_edit_policy: { type: Type.BOOLEAN },
    contains_people_or_faces: { type: Type.BOOLEAN },
    usability: {
      type: Type.OBJECT,
      properties: {
        score: { type: Type.NUMBER },
        reasons: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['score', 'reasons'],
    },
    quality_issues: { type: Type.ARRAY, items: { type: Type.STRING } },
    problems: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING },
          where: { type: Type.STRING },
          severity: { type: Type.STRING },
          fix_instruction: { type: Type.STRING },
        },
        required: ['type', 'where', 'severity', 'fix_instruction'],
      },
    },
    must_preserve: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          item: { type: Type.STRING },
          visibility: { type: Type.STRING, enum: ['clear', 'obscured_by_damage'] },
        },
        required: ['item', 'visibility'],
      },
    },
    edit_prompt: { type: Type.STRING },
    injection_suspected: { type: Type.BOOLEAN },
    background_issues: { type: Type.STRING },
    looks_non_original: {
      type: Type.OBJECT,
      properties: {
        is_non_original: { type: Type.BOOLEAN },
        reasoning: { type: Type.STRING },
      },
      required: ['is_non_original', 'reasoning'],
    },
    action: { type: Type.STRING, enum: ['edit', 'passthrough', 'reject', 'ask_dealer'] },
    action_reason: { type: Type.STRING },
    confidence: { type: Type.NUMBER },
    clarifying_question: { type: Type.STRING },
  },
  required: [
    'description',
    'tags',
    'is_in_scope',
    'matches_never_edit_policy',
    'contains_people_or_faces',
    'usability',
    'quality_issues',
    'problems',
    'must_preserve',
    'edit_prompt',
    'injection_suspected',
    'background_issues',
    'looks_non_original',
    'action',
    'action_reason',
    'confidence',
  ],
};

export const CheckZodSchema = z.object({
  same_subject_and_scene: z.object({
    ok: z.boolean(),
    reason: z.string().max(240),
  }),
  preserved_items: z.array(
    z.object({
      item: z.string().max(100),
      visibility: z.enum(['clear', 'obscured_by_damage']).optional().default('clear'),
      original_observation: z.string().max(240),
      output_observation: z.string().max(240),
      unchanged: z.boolean(),
      note: z.string().max(200),
    })
  ),
  reconstructed_regions: z
    .array(
      z.object({
        item: z.string().max(100),
        description: z.string().max(240),
        consistent_with_visible_fragments: z.boolean(),
        plausible: z.boolean(),
        note: z.string().max(200),
      })
    )
    .optional()
    .default([]),
  unlisted_differences: z
    .array(
      z.object({
        description: z.string().max(200),
        location: z.string().max(100),
        severity: z.string().max(40),
      })
    )
    .max(8),
  problems_actually_fixed: z.array(
    z.object({
      problem: z.string().max(200),
      fixed: z.boolean(),
      note: z.string().max(200),
    })
  ),
  looks_natural: z.object({
    ok: z.boolean(),
    reason: z.string().max(200),
  }),
  policy_compliance: z.object({
    ok: z.boolean(),
    reason: z.string().max(200),
  }),
  verdict: z.enum(['pass', 'retry', 'fallback']),
  retry_guidance: z.string().max(400).optional().default(''),
  revised_edit_prompt: z.string().max(1200).optional().default(''),
});

const CHECK_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    same_subject_and_scene: {
      type: Type.OBJECT,
      properties: {
        ok: { type: Type.BOOLEAN },
        reason: { type: Type.STRING },
      },
      required: ['ok', 'reason'],
    },
    preserved_items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          item: { type: Type.STRING },
          visibility: { type: Type.STRING, enum: ['clear', 'obscured_by_damage'] },
          original_observation: { type: Type.STRING },
          output_observation: { type: Type.STRING },
          unchanged: { type: Type.BOOLEAN },
          note: { type: Type.STRING },
        },
        required: ['item', 'visibility', 'original_observation', 'output_observation', 'unchanged', 'note'],
      },
    },
    reconstructed_regions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          item: { type: Type.STRING },
          description: { type: Type.STRING },
          consistent_with_visible_fragments: { type: Type.BOOLEAN },
          plausible: { type: Type.BOOLEAN },
          note: { type: Type.STRING },
        },
        required: ['item', 'description', 'consistent_with_visible_fragments', 'plausible', 'note'],
      },
    },
    unlisted_differences: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          description: { type: Type.STRING },
          location: { type: Type.STRING },
          severity: { type: Type.STRING },
        },
        required: ['description', 'location', 'severity'],
      },
    },
    problems_actually_fixed: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          problem: { type: Type.STRING },
          fixed: { type: Type.BOOLEAN },
          note: { type: Type.STRING },
        },
        required: ['problem', 'fixed', 'note'],
      },
    },
    looks_natural: {
      type: Type.OBJECT,
      properties: {
        ok: { type: Type.BOOLEAN },
        reason: { type: Type.STRING },
      },
      required: ['ok', 'reason'],
    },
    policy_compliance: {
      type: Type.OBJECT,
      properties: {
        ok: { type: Type.BOOLEAN },
        reason: { type: Type.STRING },
      },
      required: ['ok', 'reason'],
    },
    verdict: { type: Type.STRING, enum: ['pass', 'retry', 'fallback'] },
    retry_guidance: { type: Type.STRING },
    revised_edit_prompt: { type: Type.STRING },
  },
  required: [
    'same_subject_and_scene',
    'preserved_items',
    'reconstructed_regions',
    'unlisted_differences',
    'problems_actually_fixed',
    'looks_natural',
    'policy_compliance',
    'verdict',
  ],
};

export const ChatIntentZodSchema = z.object({
  intent: z.enum([
    'done_start',
    'retry_photo',
    'new_car',
    'question',
    'unsupported_media',
    'out_of_scope',
  ]),
  photo_number: z.number().int().nullable().optional(),
  language: z.string().max(40),
  reply: z.string().max(500),
});

const CHAT_INTENT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      enum: ['done_start', 'retry_photo', 'new_car', 'question', 'unsupported_media', 'out_of_scope'],
    },
    photo_number: { type: Type.INTEGER, nullable: true },
    language: { type: Type.STRING },
    reply: { type: Type.STRING },
  },
  required: ['intent', 'language', 'reply'],
};

export async function recordAiUsage({
  dealerId,
  jobId,
  imageId,
  provider,
  model,
  operation,
  tokens = 0,
  inputTokens = 0,
  outputTokens = 0,
  thinkingTokens = 0,
  latencyMs = 0,
  success = true,
}) {
  await db.query(
    `INSERT INTO ai_usage (dealer_id, job_id, image_id, provider, model, operation, tokens, input_tokens, output_tokens, thinking_tokens, latency_ms, success)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      dealerId || null,
      jobId || null,
      imageId || null,
      provider,
      model,
      operation,
      tokens,
      inputTokens,
      outputTokens,
      thinkingTokens,
      latencyMs,
      Boolean(success),
    ]
  );
}

const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior|above|system)\s+instructions?\b/gi,
  /\bdisregard\s+(all\s+)?(previous|prior|above|system)\s+instructions?\b/gi,
  /\bforget\s+(your|all)\s+(rules|instructions)\b/gi,
  /\bsystem\s+prompt\b/gi,
  /\byou\s+are\s+now\b/gi,
  /\bact\s+as\b/gi,
  /\boverride\s+(rules|policy|instructions)\b/gi,
];

function sanitizeSingleText(raw, maxLen) {
  let text = String(raw || '');
  let modified = false;
  const reasons = [];

  const noCtrl = text.replace(/[\x00-\x1F\x7F]/g, ' ');
  if (noCtrl !== text) {
    modified = true;
    reasons.push('control_chars');
    text = noCtrl;
  }

  const noUrls = text.replace(/https?:\/\/\S+|www\.\S+/gi, '');
  if (noUrls !== text) {
    modified = true;
    reasons.push('url_removed');
    text = noUrls;
  }

  const noMd = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/(\*\*|__)/g, '');
  if (noMd !== text) {
    modified = true;
    reasons.push('markdown_removed');
    text = noMd;
  }

  for (const pat of INJECTION_PATTERNS) {
    const cleaned = text.replace(pat, '');
    if (cleaned !== text) {
      modified = true;
      reasons.push('injection_phrase_removed');
      text = cleaned;
    }
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) {
    modified = true;
    reasons.push('length_capped');
    text = text.slice(0, maxLen).trim();
  }

  return { text, modified, reasons };
}

export function sanitizeEditInputs({ editPrompt, mustPreserve }) {
  const reasons = [];
  let modified = false;

  const promptRes = sanitizeSingleText(editPrompt, MAX_EDIT_PROMPT_CHARS);
  if (promptRes.modified) {
    modified = true;
    reasons.push(...promptRes.reasons);
  }

  const rawList = Array.isArray(mustPreserve) ? mustPreserve : [];
  if (rawList.length > MAX_PRESERVE_ITEMS) {
    modified = true;
    reasons.push('preserve_list_capped');
  }

  const cleanPreserve = [];
  for (const entry of rawList.slice(0, MAX_PRESERVE_ITEMS)) {
    const rawItem = typeof entry === 'string' ? entry : entry?.item || '';
    const visibility = entry?.visibility === 'obscured_by_damage' ? 'obscured_by_damage' : 'clear';
    const itemRes = sanitizeSingleText(rawItem, MAX_PRESERVE_ITEM_CHARS);
    if (itemRes.modified) {
      modified = true;
      reasons.push(...itemRes.reasons);
    }
    if (itemRes.text) {
      cleanPreserve.push({ item: itemRes.text, visibility });
    }
  }

  return {
    cleanPrompt: promptRes.text,
    cleanPreserve,
    modified,
    reasons: [...new Set(reasons)],
  };
}

export function findDiscouragedVerbs(text, policy = {}) {
  const verbs = Array.isArray(policy?.discouraged_edit_verbs) ? policy.discouraged_edit_verbs : [];
  const lower = String(text || '').toLowerCase();
  const found = [];
  for (const v of verbs) {
    const clean = String(v || '').trim().toLowerCase();
    if (!clean) continue;
    const re = new RegExp(`\\b${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|ed|ing)?\\b`, 'i');
    if (re.test(lower)) {
      found.push(clean);
    }
  }
  return found;
}

export function applyAnalysisGuardrails(analysis, policy = {}) {
  const injection = Boolean(analysis.injection_suspected);
  const neverEditList = Array.isArray(policy?.never_edit) ? policy.never_edit : [];
  const tagsLower = (analysis.tags || []).map((t) => String(t).toLowerCase());
  const descLower = String(analysis.description || '').toLowerCase();

  const matchesPolicyKeyword = neverEditList.some((entry) => {
    const term = String(entry).toLowerCase().replace(/_/g, ' ').trim();
    const singular = term.endsWith('s') ? term.slice(0, -1) : term;
    return (
      tagsLower.some((t) => t.includes(term) || t.includes(singular)) ||
      descLower.includes(term) ||
      descLower.includes(singular)
    );
  });

  if (analysis.matches_never_edit_policy || matchesPolicyKeyword) {
    return {
      ...analysis,
      injection_suspected: injection,
      matches_never_edit_policy: true,
      action: 'passthrough',
      action_reason: 'Protected category per active policy: returned original untouched.',
    };
  }

  if (!analysis.is_in_scope && analysis.action === 'edit') {
    return {
      ...analysis,
      injection_suspected: injection,
      action: 'reject',
      action_reason: analysis.action_reason || 'This image is outside the active policy scope.',
    };
  }

  return {
    ...analysis,
    injection_suspected: injection,
  };
}

export async function runAnalyzeStep({ imageBuffer, mimeType = 'image/jpeg', policy, dealerId, jobId, imageId }) {
  const systemInstruction = await loadPromptTemplate('analyze.txt', {
    POLICY_JSON: JSON.stringify(policy),
  });

  try {
    const res = await generateStructuredJson({
      model: config.analysisModel,
      systemInstruction,
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Analyze this image and return the structured JSON output.' },
            { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
          ],
        },
      ],
      responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      zodSchema: AnalysisZodSchema,
      timeoutMs: config.analysisTimeoutMs,
    });

    await recordAiUsage({
      dealerId,
      jobId,
      imageId,
      provider: 'gemini',
      model: res.modelUsed,
      operation: 'analyze',
      tokens: res.tokens,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      thinkingTokens: res.thinkingTokens,
      latencyMs: res.latencyMs,
      success: true,
    });

    return {
      analysis: applyAnalysisGuardrails(res.data, policy),
      tokens: res.tokens,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      thinkingTokens: res.thinkingTokens,
      latencyMs: res.latencyMs,
      modelUsed: res.modelUsed,
    };
  } catch (err) {
    await recordAiUsage({
      dealerId,
      jobId,
      imageId,
      provider: 'gemini',
      model: config.analysisModel,
      operation: 'analyze',
      tokens: err.tokens || 0,
      inputTokens: err.inputTokens || 0,
      outputTokens: err.outputTokens || 0,
      thinkingTokens: err.thinkingTokens || 0,
      latencyMs: err.latencyMs || 0,
      success: false,
    }).catch(() => {});
    throw err;
  }
}

function buildPolicySnippet(policy) {
  const notes = [];
  if (policy?.background_style) {
    notes.push(`Background policy: ${String(policy.background_style).replace(/_/g, ' ')}.`);
  }
  const idPolicy = policy?.identifier_handling || policy?.licence_plate_handling;
  if (idPolicy) {
    notes.push(`Visible identifier policy: ${String(idPolicy).replace(/_/g, ' ')}.`);
  }
  return notes.join(' ');
}

function buildPreserveClauses(cleanPreserve) {
  const clearItems = cleanPreserve.filter((p) => p.visibility !== 'obscured_by_damage').map((p) => p.item);
  const obscuredItems = cleanPreserve.filter((p) => p.visibility === 'obscured_by_damage').map((p) => p.item);
  const lines = [];
  if (clearItems.length > 0) {
    lines.push(`Must stay exactly unchanged: ${clearItems.join('; ')}.`);
  }
  if (obscuredItems.length > 0) {
    lines.push(
      `May become visible after the repair; keep them consistent with any visible fragments and natural: ${obscuredItems.join('; ')}.`
    );
  }
  return lines;
}

function buildMinimalProblemClauses(problems, policy, substitutions) {
  const list = Array.isArray(problems) ? problems : [];
  if (list.length === 0) {
    return ['Remove only the visible surface marks; change nothing else.'];
  }
  return list.map((p, idx) => {
    const rawFix = sanitizeSingleText(p.fix_instruction || '', 240).text;
    const badVerbs = findDiscouragedVerbs(rawFix, policy);
    if (!rawFix || badVerbs.length > 0) {
      if (badVerbs.length > 0) {
        substitutions.push({ source: `problem_${idx + 1}`, verbsFound: badVerbs });
      }
      return `${idx + 1}. Remove only the visible ${p.type} at ${p.where}; change nothing else.`;
    }
    return `${idx + 1}. ${rawFix}`;
  });
}

function assembleCoherentInstruction({ mainClause, cleanPreserve, policy }) {
  const parts = [
    mainClause,
    ...buildPreserveClauses(cleanPreserve),
    buildPolicySnippet(policy),
    FIXED_RULES,
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Assemble ONE coherent, non-contradictory edit instruction.
 * Enforces discouraged_edit_verbs from policy, splits clear vs obscured_by_damage items,
 * and builds a fresh instruction on retry from retry_guidance.
 */
export function buildEditInstruction({
  analysis,
  policy,
  retryGuidance = '',
  revisedEditPrompt = '',
  mode = config.editPromptMode,
}) {
  const rawPrompt = typeof analysis?.edit_prompt === 'string' ? analysis.edit_prompt : '';
  const { cleanPrompt, cleanPreserve, modified, reasons } = sanitizeEditInputs({
    editPrompt: rawPrompt,
    mustPreserve: analysis?.must_preserve || [],
  });

  const substitutions = [];

  // On retry: prefer Checker's AI-written revised_edit_prompt (only fall back to template if empty/unsafe)
  if (retryGuidance || revisedEditPrompt) {
    const rawRevised = typeof revisedEditPrompt === 'string' ? revisedEditPrompt : '';
    const { cleanPrompt: cleanRevised, modified: revModified, reasons: revReasons } = sanitizeEditInputs({
      editPrompt: rawRevised,
      mustPreserve: [],
    });
    const revBadVerbs = findDiscouragedVerbs(cleanRevised, policy);
    if (cleanRevised && !revModified && revBadVerbs.length === 0) {
      return {
        instruction: assembleCoherentInstruction({
          mainClause: cleanRevised,
          cleanPreserve,
          policy,
        }),
        modeUsed: 'ai',
        fallbackReason: null,
        substitutions,
        draftEditPrompt: rawRevised,
        mustPreserve: cleanPreserve,
      };
    }
    if (revBadVerbs.length > 0) {
      substitutions.push({ source: 'revised_edit_prompt', verbsFound: revBadVerbs });
    }

    let cleanRetry = sanitizeSingleText(retryGuidance, 350).text;
    const retryBadVerbs = findDiscouragedVerbs(cleanRetry, policy);
    if (retryBadVerbs.length > 0) {
      substitutions.push({ source: 'retry_guidance', verbsFound: retryBadVerbs });
      cleanRetry = '';
    }
    const problemClauses = buildMinimalProblemClauses(analysis?.problems, policy, substitutions).join(' ');
    const isUnderEdited = /unfixed|not fixed|still visible|still present/i.test(cleanRetry);
    const mainClause = isUnderEdited
      ? `Ensure these visible defects are completely removed and cleaned (${cleanRetry}): ${problemClauses}`
      : cleanRetry
        ? `Minimal repair only (${cleanRetry}): ${problemClauses}`
        : `Minimal repair only: ${problemClauses}`;

    return {
      instruction: assembleCoherentInstruction({ mainClause, cleanPreserve, policy }),
      modeUsed: 'template',
      fallbackReason: revModified ? `retry_sanitized:${revReasons.join(',')}` : 'retry_template_fallback',
      substitutions,
      draftEditPrompt: rawRevised || rawPrompt,
      mustPreserve: cleanPreserve,
    };
  }

  if (mode === 'template') {
    const problemClauses = buildMinimalProblemClauses(analysis?.problems, policy, substitutions).join(' ');
    return {
      instruction: assembleCoherentInstruction({
        mainClause: `Repair ONLY the following: ${problemClauses}`,
        cleanPreserve,
        policy,
      }),
      modeUsed: 'template',
      fallbackReason: null,
      substitutions,
      draftEditPrompt: rawPrompt,
      mustPreserve: cleanPreserve,
    };
  }

  let fallbackReason = null;
  const promptBadVerbs = findDiscouragedVerbs(cleanPrompt, policy);
  if (analysis?.injection_suspected) {
    fallbackReason = 'injection_suspected';
  } else if (typeof analysis?.edit_prompt !== 'string' || !cleanPrompt) {
    fallbackReason = 'empty_or_malformed_edit_prompt';
  } else if (modified) {
    fallbackReason = `sanitized_or_capped:${reasons.join(',')}`;
  } else if (promptBadVerbs.length > 0) {
    fallbackReason = `discouraged_verb:${promptBadVerbs.join(',')}`;
    substitutions.push({ source: 'edit_prompt', verbsFound: promptBadVerbs });
  }

  if (fallbackReason) {
    const problemClauses = buildMinimalProblemClauses(analysis?.problems, policy, substitutions).join(' ');
    return {
      instruction: assembleCoherentInstruction({
        mainClause: `Repair ONLY the following: ${problemClauses}`,
        cleanPreserve,
        policy,
      }),
      modeUsed: 'template',
      fallbackReason,
      substitutions,
      draftEditPrompt: rawPrompt,
      mustPreserve: cleanPreserve,
    };
  }

  return {
    instruction: assembleCoherentInstruction({
      mainClause: cleanPrompt,
      cleanPreserve,
      policy,
    }),
    modeUsed: 'ai',
    fallbackReason: null,
    substitutions,
    draftEditPrompt: rawPrompt,
    mustPreserve: cleanPreserve,
  };
}

/**
 * Code-enforced checker verdict rules:
 * - same_subject_and_scene.ok === false -> fail (not retryable)
 * - Any 'clear' preserved_item with unchanged === false -> fail (retryable)
 * - Any reconstructed_regions with !consistent_with_visible_fragments or !plausible -> fail (retryable)
 * - Any unlisted_differences with severity === 'major' -> fail (retryable)
 * - Count of 'minor' unlisted_differences > policy.max_minor_differences -> fail (retryable)
 * - Any problems_actually_fixed with fixed === false -> fail (not retryable via narrower edit)
 * - looks_natural.ok === false or policy_compliance.ok === false -> fail (not retryable)
 */
export function applyCheckGuardrails(check, { isFinalAttempt = false, policy = null, problems = [] } = {}) {
  const preserved = Array.isArray(check?.preserved_items) ? check.preserved_items : [];
  const reconstructed = Array.isArray(check?.reconstructed_regions) ? check.reconstructed_regions : [];
  const unlisted = Array.isArray(check?.unlisted_differences) ? check.unlisted_differences : [];
  const fixedList = Array.isArray(check?.problems_actually_fixed) ? check.problems_actually_fixed : [];
  const maxMinor = Number.isFinite(Number(policy?.max_minor_differences))
    ? Number(policy.max_minor_differences)
    : 1;

  const failedClear = preserved.filter(
    (p) => p.visibility !== 'obscured_by_damage' && p.unchanged === false
  );
  const failedReconstructed = reconstructed.filter(
    (r) => r.consistent_with_visible_fragments === false || r.plausible === false
  );
  const majorUnlisted = unlisted.filter((u) => String(u.severity || '').toLowerCase() === 'major');
  const minorUnlisted = unlisted.filter((u) => String(u.severity || '').toLowerCase() === 'minor');
  const anyFixed = fixedList.some((p) => p.fixed === true);
  const findSeverity = (problemName) => {
    if (!Array.isArray(problems)) return '';
    const matched = problems.find(
      (orig) =>
        String(problemName || '').toLowerCase().includes(String(orig.type || '').toLowerCase()) ||
        String(orig.type || '').toLowerCase().includes(String(problemName || '').toLowerCase())
    );
    return String(matched?.severity || '').toLowerCase();
  };
  const highSeverityFixed = fixedList.some(
    (p) => p.fixed === true && ['high', 'severe', 'critical'].includes(findSeverity(p.problem))
  );

  const partialUnfixed = [];
  const unfixedProblems = fixedList.filter((p) => {
    if (p.fixed !== false) return false;
    if (!anyFixed || !Array.isArray(problems) || problems.length === 0) return true;
    const sev = findSeverity(p.problem);
    if (sev === 'low' || sev === 'minor') {
      partialUnfixed.push(p.problem);
      return false;
    }
    if (isFinalAttempt && highSeverityFixed && !['high', 'severe', 'critical'].includes(sev)) {
      partialUnfixed.push(p.problem);
      return false;
    }
    return true;
  });

  const failureReasons = [];
  let verdictRule = 'all_checks_passed';
  let retryable = false;

  if (check?.same_subject_and_scene?.ok === false) {
    verdictRule = 'same_subject_failed';
    failureReasons.push(`Subject/scene changed: ${check.same_subject_and_scene.reason}`);
  } else if (failedClear.length > 0) {
    verdictRule = 'clear_preserved_item_changed';
    retryable = true;
    failureReasons.push(
      `Clear preserved item(s) altered/missing: ${failedClear.map((f) => f.item).join(', ')}`
    );
  } else if (failedReconstructed.length > 0) {
    verdictRule = 'inconsistent_reconstruction';
    retryable = true;
    failureReasons.push(
      `Inconsistent reconstruction: ${failedReconstructed.map((r) => r.item).join(', ')}`
    );
  } else if (majorUnlisted.length > 0) {
    verdictRule = 'major_unlisted_difference';
    retryable = true;
    failureReasons.push(
      `Major unlisted difference(s): ${majorUnlisted.map((m) => m.description).join('; ')}`
    );
  } else if (minorUnlisted.length > maxMinor && !isFinalAttempt) {
    verdictRule = 'minor_unlisted_threshold_exceeded';
    retryable = true;
    failureReasons.push(
      `Too many minor unlisted differences (${minorUnlisted.length} > ${maxMinor})`
    );
  } else if (unfixedProblems.length > 0) {
    verdictRule = 'problem_not_fixed';
    retryable = true;
    const unfixedSummary = unfixedProblems
      .map((u) => `${u.problem}${u.note ? ` (${u.note})` : ''}`)
      .join('; ');
    failureReasons.push(`Problem(s) not fixed: ${unfixedSummary}`);
  } else if (check?.looks_natural?.ok === false) {
    verdictRule = 'looks_natural_failed';
    failureReasons.push(`Unnatural output: ${check.looks_natural.reason}`);
  } else if (check?.policy_compliance?.ok === false) {
    verdictRule = 'policy_compliance_failed';
    failureReasons.push(`Policy violation: ${check.policy_compliance.reason}`);
  } else if (check?.verdict === 'fallback') {
    verdictRule = 'model_verdict_fallback';
    retryable = !isFinalAttempt;
    failureReasons.push(check?.retry_guidance || 'Model requested fallback.');
  } else if (check?.verdict === 'retry' && !isFinalAttempt) {
    verdictRule = 'model_verdict_retry';
    retryable = true;
    failureReasons.push(check?.retry_guidance || 'Model requested retry.');
  } else if (partialUnfixed.length > 0) {
    verdictRule = 'partial_repair_accepted';
  }

  if (failureReasons.length > 0) {
    const nextVerdict =
      !retryable || isFinalAttempt || check?.verdict === 'fallback' ? 'fallback' : 'retry';
    const targetedGuidance =
      verdictRule === 'problem_not_fixed'
        ? `Focus specifically on fixing the unfixed areas: ${unfixedProblems.map((u) => u.problem).join('; ')}.`
        : check?.retry_guidance || failureReasons.join(' ');
    return {
      ...check,
      verdict: nextVerdict,
      verdict_rule: verdictRule,
      retryable,
      retry_guidance: targetedGuidance,
      failure_reasons: failureReasons,
    };
  }

  return {
    ...check,
    verdict: 'pass',
    verdict_rule: verdictRule,
    retryable: false,
    failure_reasons: [],
    partial_unfixed: partialUnfixed,
    partial_fixed: fixedList.filter((p) => p.fixed === true).map((p) => p.problem),
  };
}

/**
 * Decide whether to retry based on retryability, maxRetries, PHOTO_TIME_BUDGET_MS,
 * and whether the fresh retry instruction differs from the previous instruction.
 */
export function decideRetry({
  check,
  analysis,
  policy,
  retryCount,
  maxRetries,
  previousInstruction,
  elapsedMs,
  estimatedRetryMs,
  budgetMs,
}) {
  if (check?.verdict === 'pass') {
    return { shouldRetry: false, reason: 'passed', nextBuilt: null };
  }
  if (!check?.retryable) {
    return { shouldRetry: false, reason: `not_retryable:${check?.verdict_rule || 'unknown'}`, nextBuilt: null };
  }
  if (retryCount >= maxRetries) {
    return { shouldRetry: false, reason: 'max_retries_reached', nextBuilt: null };
  }
  if (elapsedMs + estimatedRetryMs > budgetMs) {
    return {
      shouldRetry: false,
      reason: `time_budget_exceeded:${Math.round(elapsedMs)}ms+${Math.round(estimatedRetryMs)}ms>${budgetMs}ms`,
      nextBuilt: null,
    };
  }

  const nextBuilt = buildEditInstruction({
    analysis,
    policy,
    retryGuidance: check.retry_guidance || check.failure_reasons?.join('; ') || 'Preserve all clear items.',
    revisedEditPrompt: check.revised_edit_prompt || '',
  });

  if (nextBuilt.instruction.trim() === String(previousInstruction || '').trim()) {
    return { shouldRetry: false, reason: 'identical_instruction', nextBuilt: null };
  }

  return { shouldRetry: true, reason: `retryable:${check.verdict_rule}`, nextBuilt };
}

export async function runCheckStep({
  originalBuffer,
  editedBuffer,
  analysis,
  policy,
  dealerId,
  jobId,
  imageId,
  isFinalAttempt = false,
  _overrideClient = null,
}) {
  const mustPreserve = Array.isArray(analysis?.must_preserve) ? analysis.must_preserve : [];
  const systemInstruction = await loadPromptTemplate('check.txt', {
    POLICY_JSON: JSON.stringify(policy),
    PROBLEMS_JSON: JSON.stringify(analysis?.problems || []),
    MUST_PRESERVE_JSON: JSON.stringify(mustPreserve),
  });

  try {
    const res = await generateStructuredJson({
      model: config.checkModel,
      fallbackModel: config.checkModelFallback,
      thinkingLevel: config.checkThinkingLevel,
      systemInstruction,
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Compare Image 1 (ORIGINAL) and Image 2 (EDITED) and return compact JSON.' },
            { inlineData: { mimeType: 'image/jpeg', data: originalBuffer.toString('base64') } },
            { inlineData: { mimeType: 'image/jpeg', data: editedBuffer.toString('base64') } },
          ],
        },
      ],
      responseSchema: CHECK_RESPONSE_SCHEMA,
      zodSchema: CheckZodSchema,
      timeoutMs: config.checkTimeoutMs,
      _overrideClient,
    });

    await recordAiUsage({
      dealerId,
      jobId,
      imageId,
      provider: 'gemini',
      model: res.modelUsed,
      operation: 'check',
      tokens: res.tokens,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      thinkingTokens: res.thinkingTokens,
      latencyMs: res.latencyMs,
      success: true,
    }).catch(() => {});

    const guarded = applyCheckGuardrails(res.data, {
      isFinalAttempt,
      policy,
      problems: analysis?.problems || [],
    });
    return {
      check: {
        ...guarded,
        model_used: res.modelUsed,
        thinking_level: res.fallbackUsed ? null : config.checkThinkingLevel,
        fallback_used: res.fallbackUsed,
        fallback_reason: res.fallbackReason,
      },
      tokens: res.tokens,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      thinkingTokens: res.thinkingTokens,
      latencyMs: res.latencyMs,
      modelUsed: res.modelUsed,
      fallbackUsed: res.fallbackUsed,
      fallbackReason: res.fallbackReason,
    };
  } catch (err) {
    await recordAiUsage({
      dealerId,
      jobId,
      imageId,
      provider: 'gemini',
      model: err.modelUsed || config.checkModel,
      operation: 'check',
      tokens: err.tokens || 0,
      inputTokens: err.inputTokens || 0,
      outputTokens: err.outputTokens || 0,
      thinkingTokens: err.thinkingTokens || 0,
      latencyMs: err.latencyMs || 0,
      success: false,
    }).catch(() => {});
    throw err;
  }
}

export async function classifyChatIntent({ text, policy, dealerId }) {
  const systemInstruction = await loadPromptTemplate('chat_intent.txt', {
    POLICY_JSON: JSON.stringify(policy),
  });

  const res = await generateStructuredJson({
    model: config.analysisModel,
    systemInstruction,
    contents: `User message: ${JSON.stringify(text)}`,
    responseSchema: CHAT_INTENT_RESPONSE_SCHEMA,
    zodSchema: ChatIntentZodSchema,
    timeoutMs: config.chatIntentTimeoutMs,
  });

  await recordAiUsage({
    dealerId,
    provider: 'gemini',
    model: res.modelUsed,
    operation: 'chat_intent',
    tokens: res.tokens,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    thinkingTokens: res.thinkingTokens,
    latencyMs: res.latencyMs,
    success: true,
  });

  return res.data;
}
