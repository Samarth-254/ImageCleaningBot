import { z } from 'zod';
import { messageModel } from '../models/messageModel.js';
import { traceModel } from '../models/traceModel.js';

const UuidSchema = z.string().uuid();

export const streamController = {
  async stream(req, res) {
    const parsed = UuidSchema.safeParse(req.query.dealerId);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid dealerId required' });
    }
    const dealerId = parsed.data;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let lastMsgId = Number(req.headers['last-event-id'] || req.query.lastId || 0);
    let lastTraceHash = '';
    let closed = false;

    const poll = async () => {
      if (closed) return;
      try {
        const newMsgs = await messageModel.listAfterId(dealerId, lastMsgId, 50);
        for (const msg of newMsgs) {
          lastMsgId = Number(msg.id);
          res.write(`id: ${msg.id}\n`);
          res.write(`event: message\n`);
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
        }

        const trace = await traceModel.getSnapshot(dealerId);
        const traceHash = JSON.stringify({
          jobs: trace.jobs.map((j) => [j.id, j.status, j.updated_at]),
          images: trace.images.map((i) => [i.id, i.status, i.final_decision, i.updated_at]),
          eventsLen: trace.events.length,
        });
        if (traceHash !== lastTraceHash) {
          lastTraceHash = traceHash;
          res.write(`event: trace\n`);
          res.write(`data: ${JSON.stringify(trace)}\n\n`);
        }
      } catch {
        // Keep SSE alive across transient DB blips
      }
    };

    await poll();
    const interval = setInterval(poll, 500);
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      closed = true;
      clearInterval(interval);
      clearInterval(heartbeat);
    });
  },
};
