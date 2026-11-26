import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '../src');

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (e.isFile() && e.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

const SQL_KEYWORDS = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i;

export async function checkSqlSafety() {
  const files = await walk(srcDir);
  const violations = [];

  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');
    const rel = path.relative(path.resolve(__dirname, '..'), file);

    // 1. Check template literals containing ${...} alongside SQL keywords
    const templateRegex = /`(?:\\[\s\S]|[^`\\])*?\$\{(?:\\[\s\S]|[^`\\])*?`/g;
    let match;
    while ((match = templateRegex.exec(content)) !== null) {
      const snippet = match[0];
      if (SQL_KEYWORDS.test(snippet)) {
        violations.push({
          file: rel,
          reason: 'Template literal with ${...} contains SQL keyword',
          snippet: snippet.slice(0, 140),
        });
      }
    }

    // 2. Check db.query(...) or client.query(...) using + concatenation or template ${
    const queryCallRegex = /(?:db|client|pool)\.query\s*\(([^)]+)\)/g;
    while ((match = queryCallRegex.exec(content)) !== null) {
      const arg = match[1];
      if (arg.includes('${') || /['"`]\s*\+|\+\s*['"`]/.test(arg)) {
        violations.push({
          file: rel,
          reason: 'Query call uses string concatenation or template interpolation',
          snippet: match[0].slice(0, 140),
        });
      }
    }
  }

  return violations;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkSqlSafety()
    .then((violations) => {
      if (violations.length > 0) {
        console.error('[check:sql] FAILED. Found unsafe SQL patterns:');
        for (const v of violations) {
          console.error(` - ${v.file}: ${v.reason}\n   ${v.snippet}`);
        }
        process.exit(1);
      }
      console.log('[check:sql] PASSED: All SQL queries are parameterized.');
    })
    .catch((err) => {
      console.error('[check:sql] Error:', err);
      process.exit(1);
    });
}
