import { config } from './config.js';
import { createApp } from './app.js';
import { db } from './db/index.js';
import { verifyGeminiModel } from './services/gemini.js';
import { storage } from './services/storage.js';

const app = createApp();

storage.init().catch((e) => console.error('[Storage] Init error:', e));

const server = app.listen(config.port, () => {
  console.log(`[CarDesk Server] Listening on http://localhost:${config.port}`);
  verifyGeminiModel().catch(() => {});
});

async function shutdown(signal) {
  console.log(`[CarDesk Server] Received ${signal}, shutting down...`);
  server.close(async () => {
    await db.closePool().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
