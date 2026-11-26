import { db } from '../db/index.js';

export const messageModel = {
  async listByDealer(dealerId, limit = 200) {
    const res = await db.query(
      'SELECT * FROM messages WHERE dealer_id = $1 ORDER BY id ASC LIMIT $2',
      [dealerId, limit]
    );
    return res.rows;
  },

  async listAfterId(dealerId, lastMsgId, limit = 50) {
    const res = await db.query(
      'SELECT * FROM messages WHERE dealer_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3',
      [dealerId, lastMsgId, limit]
    );
    return res.rows;
  },
};
