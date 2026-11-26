import { z } from 'zod';
import { traceModel } from '../models/traceModel.js';

const UuidSchema = z.string().uuid();

export const traceController = {
  async get(req, res, next) {
    try {
      const parsed = UuidSchema.safeParse(req.query.dealerId);
      if (!parsed.success) return res.status(400).json({ error: 'Valid dealerId required' });
      const snapshot = await traceModel.getSnapshot(parsed.data);
      res.json(snapshot);
    } catch (err) {
      next(err);
    }
  },
};
