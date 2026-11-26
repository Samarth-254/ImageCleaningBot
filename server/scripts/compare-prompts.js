import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { DEFAULT_POLICY } from '../src/db/seed.js';
import { getActivePolicy } from '../src/services/policy.js';
import { editImage } from '../src/services/editor.js';
import { buildEditInstruction, decideRetry, runAnalyzeStep, runCheckStep } from '../src/services/pipeline.js';

function parseArgs(argv) {
  let folder = '';
  let limit = 5;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) {
      limit = Math.max(1, Number(argv[i + 1]) || 5);
      i += 1;
    } else if (!a.startsWith('-')) {
      folder = a;
    }
  }
  return { folder, limit };
}

async function runMode({ mode, originalBuffer, analysis, policy, outPath }) {
  const startedAt = Date.now();
  let nextBuiltOverride = null;
  let retried = false;
  let fellBack = false;
  let finalCheck = null;
  let finalInstruction = '';
  let totalEditLatencyMs = 0;
  let lastCheckLatencyMs = 0;

  for (let attempt = 0; attempt <= config.maxEditRetries; attempt += 1) {
    const built = nextBuiltOverride || buildEditInstruction({ analysis, policy, mode });
    finalInstruction = built.instruction;

    const editRes = await editImage({ imageBuffer: originalBuffer, instruction: finalInstruction });
    totalEditLatencyMs += editRes.latencyMs;

    const { info: origInfo } = await sharp(originalBuffer).rotate().toBuffer({ resolveWithObject: true });
    const normalizedBuffer = await sharp(editRes.imageBuffer)
      .resize({ width: origInfo.width, height: origInfo.height, fit: 'fill' })
      .jpeg({ quality: 92 })
      .toBuffer();

    await fs.writeFile(outPath, normalizedBuffer);

    const checkEdge = config.checkImageMaxEdge;
    const origDown = await sharp(originalBuffer)
      .rotate()
      .resize({ width: checkEdge, height: checkEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 84 })
      .toBuffer();
    const { info: checkInfo } = await sharp(origDown).toBuffer({ resolveWithObject: true });
    const editDown = await sharp(normalizedBuffer)
      .resize({ width: checkInfo.width, height: checkInfo.height, fit: 'fill' })
      .jpeg({ quality: 84 })
      .toBuffer();

    const checked = await runCheckStep({
      originalBuffer: origDown,
      editedBuffer: editDown,
      analysis,
      policy,
      isFinalAttempt: attempt >= config.maxEditRetries,
    });
    finalCheck = checked.check;
    lastCheckLatencyMs = checked.latencyMs;

    if (finalCheck.verdict === 'pass') break;
    const decision = decideRetry({
      check: finalCheck,
      analysis,
      policy,
      retryCount: attempt,
      maxRetries: config.maxEditRetries,
      previousInstruction: finalInstruction,
      elapsedMs: Date.now() - startedAt,
      estimatedRetryMs: editRes.latencyMs + checked.latencyMs,
      budgetMs: config.photoTimeBudgetMs,
    });
    if (decision.shouldRetry && decision.nextBuilt) {
      retried = true;
      nextBuiltOverride = decision.nextBuilt;
      continue;
    }
    fellBack = true;
    break;
  }

  if (finalCheck?.verdict !== 'pass') fellBack = true;

  const preserved = finalCheck?.preserved_items || [];
  const preservedPassed = preserved.filter((p) => p.unchanged).length;

  return {
    mode,
    finalInstruction,
    editLatencyMs: totalEditLatencyMs,
    checkLatencyMs: lastCheckLatencyMs,
    totalLatencyMs: Date.now() - startedAt,
    verdict: finalCheck?.verdict || 'fallback',
    verdictRule: finalCheck?.verdict_rule || '',
    preservedItems: preserved,
    reconstructedRegions: finalCheck?.reconstructed_regions || [],
    unlistedDifferences: finalCheck?.unlisted_differences || [],
    preservedPassed,
    preservedTotal: preserved.length,
    retried,
    fellBack,
    outPath,
  };
}

async function main() {
  const { folder, limit } = parseArgs(process.argv.slice(2));
  if (!folder) {
    console.error('Usage: npm run compare:prompts -- <folder> --limit 5');
    process.exit(1);
  }

  console.warn(
    `WARNING: Every image run through compare:prompts consumes edit-API credits (EDIT_PROVIDER=${config.editProvider}, limit=${limit}).`
  );

  const absFolder = path.resolve(folder);
  const entries = await fs.readdir(absFolder, { withFileTypes: true });
  const imageFiles = entries
    .filter((e) => e.isFile() && /\.(jpe?g|png|webp)$/i.test(e.name))
    .slice(0, limit)
    .map((e) => path.join(absFolder, e.name));

  if (imageFiles.length === 0) {
    console.error(`No JPEG/PNG/WebP images found in ${absFolder}`);
    process.exit(1);
  }

  let policy = DEFAULT_POLICY;
  try {
    const row = await getActivePolicy();
    policy = row.policy_json;
  } catch {
    console.warn('Using DEFAULT_POLICY (DB unavailable).');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(config.storageDir, 'compare', stamp);
  await fs.mkdir(outDir, { recursive: true });

  const rows = [];
  for (const filePath of imageFiles) {
    const name = path.basename(filePath);
    console.log(`Processing ${name}...`);
    const originalBuffer = await fs.readFile(filePath);
    const downscaled = await sharp(originalBuffer)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();

    const { analysis } = await runAnalyzeStep({ imageBuffer: downscaled, mimeType: 'image/jpeg', policy });
    if (analysis.action !== 'edit') {
      console.log(`Skipping ${name}: analysis action=${analysis.action}`);
      continue;
    }

    const templateRes = await runMode({
      mode: 'template',
      originalBuffer,
      analysis,
      policy,
      outPath: path.join(outDir, `${name}.template.jpg`),
    });
    const aiRes = await runMode({
      mode: 'ai',
      originalBuffer,
      analysis,
      policy,
      outPath: path.join(outDir, `${name}.ai.jpg`),
    });

    rows.push({ name, template: templateRes, ai: aiRes });
  }

  const summarize = (modeKey) => {
    const list = rows.map((r) => r[modeKey]);
    const n = list.length || 1;
    const passes = list.filter((x) => x.verdict === 'pass').length;
    const retries = list.filter((x) => x.retried).length;
    const fallbacks = list.filter((x) => x.fellBack).length;
    const avgLatency = Math.round(list.reduce((s, x) => s + x.editLatencyMs, 0) / n);
    const pPass = list.reduce((s, x) => s + x.preservedPassed, 0);
    const pTotal = list.reduce((s, x) => s + x.preservedTotal, 0);
    return {
      count: list.length,
      passRate: `${((passes / n) * 100).toFixed(0)}% (${passes}/${list.length})`,
      preservedRate: pTotal ? `${((pPass / pTotal) * 100).toFixed(0)}% (${pPass}/${pTotal})` : 'N/A',
      retries,
      fallbacks,
      avgLatencyMs: avgLatency,
    };
  };

  const tSum = summarize('template');
  const aSum = summarize('ai');

  const md = [
    `# Prompt Mode Comparison Report (${stamp})`,
    '',
    `Images compared: ${rows.length} | Provider: ${config.editProvider}`,
    '',
    '## Side-by-Side Results',
    '',
    '| Image | Mode | Verdict | Preserved Items | Retried | Fell Back | Edit Latency | Final Instruction |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.flatMap((r) =>
      [r.template, r.ai].map(
        (m) =>
          `| ${r.name} | ${m.mode} | ${m.verdict} | ${m.preservedPassed}/${m.preservedTotal} | ${m.retried} | ${m.fellBack} | ${m.editLatencyMs}ms | ${m.finalInstruction.replace(/\|/g, '/').slice(0, 120)}... |`
      )
    ),
    '',
    '## Summary',
    '',
    '| Metric | Template Mode | AI Mode |',
    '|---|---|---|',
    `| Pass Rate | ${tSum.passRate} | ${aSum.passRate} |`,
    `| Preserved-Items Pass Rate | ${tSum.preservedRate} | ${aSum.preservedRate} |`,
    `| Retries | ${tSum.retries} | ${aSum.retries} |`,
    `| Fallbacks | ${tSum.fallbacks} | ${aSum.fallbacks} |`,
    `| Avg Edit Latency | ${tSum.avgLatencyMs}ms | ${aSum.avgLatencyMs}ms |`,
    '',
    '## Detailed Checker Observations',
    '',
    ...rows.flatMap((r) => [
      `### ${r.name}`,
      ...[r.template, r.ai].flatMap((m) => [
        `#### Mode: \`${m.mode}\` — Verdict: \`${m.verdict}\` (Rule: \`${m.verdictRule}\`, Check: ${m.checkLatencyMs}ms, Total: ${m.totalLatencyMs}ms)`,
        `- **Final Instruction**: ${m.finalInstruction}`,
        '- **Preserved Items**:',
        ...m.preservedItems.map(
          (pi) =>
            `  - \`${pi.item}\` [${pi.visibility || 'clear'}]: **unchanged=${pi.unchanged}** | Orig: "${pi.original_observation}" | Out: "${pi.output_observation}" (${pi.note})`
        ),
        '- **Reconstructed Regions**:',
        ...(m.reconstructedRegions.length > 0
          ? m.reconstructedRegions.map(
              (rr) =>
                `  - \`${rr.item}\`: consistent=${rr.consistent_with_visible_fragments}, plausible=${rr.plausible} — ${rr.description} (${rr.note})`
            )
          : ['  - None']),
        '- **Unlisted Differences**:',
        ...(m.unlistedDifferences.length > 0
          ? m.unlistedDifferences.map(
            (ud) => `  - [${ud.severity}] ${ud.description} (${ud.location})`
          )
          : ['  - None']),
        '',
      ]),
    ]),
  ].join('\n');

  const reportPath = path.join(outDir, 'compare-report.md');
  await fs.writeFile(reportPath, md, 'utf8');
  console.log(`\nReport written to: ${reportPath}`);
}

main()
  .then(() => db.closePool().catch(() => { }))
  .catch(async (err) => {
    console.error('compare:prompts failed:', err);
    await db.closePool().catch(() => { });
    process.exit(1);
  });
