import { defineConfig } from '@trigger.dev/sdk/v3';

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF || 'proj_asbtzznxbfbvsbpdauxx',
  runtime: 'node',
  logLevel: 'info',
  maxDuration: 300,
  dirs: ['./src/trigger'],
  build: {
    external: ['sharp'],
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
