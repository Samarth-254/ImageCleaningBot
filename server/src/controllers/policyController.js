import { z } from 'zod';
import { getActivePolicy, updatePolicy } from '../services/policy.js';

export const policyController = {
  async get(_req, res, next) {
    try {
      const policy = await getActivePolicy();
      res.json(policy);
    } catch (err) {
      next(err);
    }
  },

  async update(req, res, next) {
    try {
      const updated = await updatePolicy(req.body?.policy_json ?? req.body);
      res.json(updated);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid policy JSON', details: err.errors });
      }
      next(err);
    }
  },
};
