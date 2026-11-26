import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { sessionController } from '../controllers/sessionController.js';
import { policyController } from '../controllers/policyController.js';
import { uploadController } from '../controllers/uploadController.js';
import { messageController } from '../controllers/messageController.js';
import { traceController } from '../controllers/traceController.js';
import { streamController } from '../controllers/streamController.js';
import { fileController } from '../controllers/fileController.js';

export const apiRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: config.maxImagesPerJob,
  },
});

apiRouter.post('/session', sessionController.createOrResume);

apiRouter.get('/policy', policyController.get);
apiRouter.put('/policy', policyController.update);

apiRouter.get('/messages', messageController.list);
apiRouter.post('/messages', messageController.create);

apiRouter.post('/upload', upload.array('photos', config.maxImagesPerJob), uploadController.upload);

apiRouter.get('/trace', traceController.get);
apiRouter.get('/stream', streamController.stream);
apiRouter.get('/files/:kind/:filename', fileController.serve);
