import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { verifyGeminiModel } from './services/gemini.js';
import { storage } from './services/storage.js';
import { apiRouter } from './routes/api.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  const imgSrc = ["'self'", 'data:', 'blob:', ...config.allowedOrigins];
  const connectSrc = ["'self'", ...config.allowedOrigins];

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc,
          connectSrc,
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
        },
      },
    })
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Allow same-origin / curl / server-to-server requests with no Origin header
        if (!origin) return callback(null, true);
        if (config.allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    })
  );

  const ipLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP, please slow down.' },
  });

  const dealerLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 90,
    keyGenerator: (req) => String(req.headers['x-dealer-id'] || req.ip),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests for this dealer session, please slow down.' },
  });

  app.use(ipLimiter);
  app.use('/api', dealerLimiter);
  app.use(express.json({ limit: '256kb' }));

  app.use((req, res, next) => {
    if (req.path === '/api/stream') return next();
    const start = Date.now();
    res.on('finish', () => {
      console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'cardesk-server',
      editProvider: config.editProvider,
      geminiModel: config.geminiModel,
    });
  });

  app.use('/api', apiRouter);

  app.use((err, _req, res, _next) => {
    if (err?.message === 'Not allowed by CORS') {
      return res.status(403).json({ error: 'CORS origin not allowed' });
    }
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large (max 15 MB per photo).' });
    }
    if (err?.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: `Too many files at once (max ${config.maxImagesPerJob}).` });
    }
    console.error('[Express Error]', err);
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const app = createApp();
  storage.init().catch((e) => console.error('[Storage] Init error:', e));
  app.listen(config.port, () => {
    console.log(`[CarDesk Server] Listening on http://localhost:${config.port}`);
    verifyGeminiModel().catch(() => {});
  });
}
