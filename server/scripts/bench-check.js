import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { DEFAULT_POLICY } from '../src/db/seed.js';
import { generateStructuredJson } from '../src/services/gemini.js';
import { CheckZodSchema } from '../src/services/pipeline.js';

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

async function benchModel({ model, thinkingLevel, edge, origBuf, editBuf, promptText }) {
  const origDown = await sharp(origBuf)
    .rotate()
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 84 })
    .toBuffer();
  const { info } = await sharp(origDown).toBuffer({ resolveWithObject: true });
  const editDown = await sharp(editBuf)
    .resize({ width: info.width, height: info.height, fit: 'fill' })
    .jpeg({ quality: 84 })
    .toBuffer();

  const latencies = [];
  const tokens = [];
  let lastVerdict = '';

  for (let i = 0; i < 3; i += 1) {
    const res = await generateStructuredJson({
      model,
      thinkingLevel,
      systemInstruction: promptText,
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Compare Image 1 (ORIGINAL) and Image 2 (EDITED) and return compact JSON.' },
            { inlineData: { mimeType: 'image/jpeg', data: origDown.toString('base64') } },
            { inlineData: { mimeType: 'image/jpeg', data: editDown.toString('base64') } },
          ],
        },
      ],
      zodSchema: CheckZodSchema,
      timeoutMs: config.checkTimeoutMs,
    });
    latencies.push(res.latencyMs);
    tokens.push(res.tokens);
    lastVerdict = res.data.verdict;
  }

  return {
    model,
    thinkingLevel: thinkingLevel || 'none',
    edge,
    medianLatencyMs: median(latencies),
    medianTokens: median(tokens),
    lastVerdict,
  };
}

async function main() {
  const [origPath, editPath] = process.argv.slice(2);
  if (!origPath || !editPath) {
    console.error('Usage: npm run bench:check -- <original> <edited>');
    process.exit(1);
  }

  const origBuf = await fs.readFile(path.resolve(origPath));
  const editBuf = await fs.readFile(path.resolve(editPath));
  const rawTpl = await fs.readFile(path.join(config.promptsDir, 'check.txt'), 'utf8');
  const promptText = rawTpl
    .replaceAll('{{POLICY_JSON}}', JSON.stringify(DEFAULT_POLICY))
    .replaceAll('{{PROBLEMS_JSON}}', JSON.stringify([{ type: 'crack', where: 'transparent front panel', severity: 'severe', fix_instruction: 'Remove only the crack lines.' }]))
    .replaceAll('{{MUST_PRESERVE_JSON}}', JSON.stringify([{ item: 'interior behind glass', visibility: 'obscured_by_damage' }]));

  const edges = [768, 1024, 1280];
  const models = [
    { model: config.checkModel, thinkingLevel: config.checkThinkingLevel },
    { model: config.checkModelFallback, thinkingLevel: null },
  ];

  const results = [];
  for (const m of models) {
    for (const edge of edges) {
      console.log(`Benchmarking ${m.model} (thinking=${m.thinkingLevel || 'none'}) @ ${edge}px...`);
      try {
        const r = await benchModel({ ...m, edge, origBuf, editBuf, promptText });
        results.push(r);
        console.log(' ->', r);
      } catch (err) {
        const row = {
          model: m.model,
          thinkingLevel: m.thinkingLevel || 'none',
          edge,
          medianLatencyMs: 'ERROR',
          medianTokens: 0,
          lastVerdict: err.message.slice(0, 60),
        };
        results.push(row);
        console.log(' -> ERROR:', err.message.slice(0, 120));
      }
    }
  }

  console.log('\n=== Checker Benchmark Summary ===');
  console.table(results);
}

main()
  .then(() => db.closePool().catch(() => {}))
  .catch(async (err) => {
    console.error('bench:check failed:', err);
    await db.closePool().catch(() => {});
    process.exit(1);
  });
