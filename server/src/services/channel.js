import { db } from '../db/index.js';

/**
 * Small Channel interface so WhatsApp (or another messaging transport)
 * can be plugged in later without changing core job/pipeline logic.
 */
export class WebChannel {
  async sendMessage({ dealerId, jobId = null, imageId = null, role = 'assistant', msgType = 'text', text = '', payload = {}, deliveryStatus = 'delivered' }) {
    const res = await db.query(
      `INSERT INTO messages (dealer_id, job_id, image_id, role, msg_type, text, payload_json, delivery_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, dealer_id, job_id, image_id, role, msg_type, text, payload_json, delivery_status, created_at`,
      [dealerId, jobId, imageId, role, msgType, text, JSON.stringify(payload), deliveryStatus]
    );
    return res.rows[0];
  }

  async markJobMessagesRead({ dealerId, jobId }) {
    await db.query(
      `UPDATE messages SET delivery_status = 'read'
       WHERE dealer_id = $1 AND job_id = $2 AND role = 'dealer' AND delivery_status != 'read'`,
      [dealerId, jobId]
    );
  }
}

export const channel = new WebChannel();
