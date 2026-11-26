import { defineConfig } from '@trigger.dev/sdk/v3';

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF || 'proj_dmnjwndevjpjdjnhtnmc',
  runtime: 'node',
  logLevel: 'info',
  maxDuration: 300,
  dirs: ['./src/trigger'],
  build: {
    external: ['sharp', '@google/genai', 'pg', 'zod', 'dotenv'],
  },
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
});
