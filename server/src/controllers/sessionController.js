import crypto from 'node:crypto';
import { z } from 'zod';
import { dealerModel } from '../models/dealerModel.js';

const UuidSchema = z.string().uuid();

export const sessionController = {
  async createOrResume(req, res, next) {
    try {
      const parsed = UuidSchema.safeParse(req.body?.dealerId);
      const dealerId = parsed.success ? parsed.data : crypto.randomUUID();
      await dealerModel.ensure(dealerId);
      res.json({ dealerId });
    } catch (err) {
      next(err);
    }
  },
};
