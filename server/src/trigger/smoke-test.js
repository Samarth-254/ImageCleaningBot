import { task } from '@trigger.dev/sdk/v3';

export const smokeTestTask = task({
  id: 'smoke-test',
  maxDuration: 30,
  run: async (payload) => {
    return {
      ok: true,
      echo: payload?.message || 'hello from trigger.dev',
      timestamp: new Date().toISOString(),
    };
  },
});
