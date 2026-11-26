import { db } from '../db/index.js';

export const dealerModel = {
  async ensure(dealerId) {
    await db.query('INSERT INTO dealers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [dealerId]);
  },
};
