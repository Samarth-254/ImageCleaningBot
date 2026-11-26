import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/index.js';
import { db } from '../src/db/index.js';

const REAL_CAR_IMAGE =
  process.argv[2] ||
  'C:\\Users\\Samarth\\.gemini\\antigravity\\brain\\17a609a4-7a17-43e5-8d46-0d13ddc69a1f\\used_silver_sedan_damaged_1795688961434.jpg';

async function main() {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;

  try {
    const sess = await (
      await fetch(`${base}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).json();
    const dealerId = sess.dealerId;
    console.log('1. Session created:', dealerId);

    const carBuf = await fs.readFile(REAL_CAR_IMAGE);
    const fd = new FormData();
    fd.append('dealerId', dealerId);
    fd.append('photos', new Blob([carBuf], { type: 'image/jpeg' }), path.basename(REAL_CAR_IMAGE));

    const up = await (
      await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'x-dealer-id': dealerId },
        body: fd,
      })
    ).json();
    console.log('2. Upload response:', up);

    const msg = await (
      await fetch(`${base}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dealer-id': dealerId },
        body: JSON.stringify({ dealerId, text: 'done' }),
      })
    ).json();
    console.log('3. Done message intent:', msg);

    let trace;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      trace = await (await fetch(`${base}/trace?dealerId=${dealerId}`)).json();
      if (trace.jobs[0]?.status === 'done') break;
    }

    console.log('4. Job status:', trace.jobs[0]?.status);
    console.log('   Job trigger_run_id:', trace.jobs[0]?.trigger_run_id);
    console.log('   Summary:', trace.jobs[0]?.summary_json);
    for (const img of trace.images) {
      console.log(`   Image #${img.seq_num}:`);
      console.log('     trigger_run_id:', img.trigger_run_id);
      console.log('     decision:', img.final_decision);
      console.log('     action:', img.analysis_json?.action);
      console.log('     description:', img.analysis_json?.description);
      console.log('     problems:', JSON.stringify(img.analysis_json?.problems));
      console.log('     edit_instruction:', img.edit_instruction);
      console.log('     check_verdict:', img.check_json?.verdict, img.check_json?.scores);
      console.log('     original_path:', img.original_path);
      console.log('     edit_output_path:', img.edit_output_path);
      console.log('     total_latency_ms:', img.total_latency_ms);
      console.log('     note:', img.note);
    }
  } finally {
    server.close();
    await db.closePool();
  }
}

main().catch((err) => {
  console.error('E2E flow error:', err);
  process.exit(1);
});
