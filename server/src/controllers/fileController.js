import { storage } from '../services/storage.js';

export const fileController = {
  async serve(req, res, next) {
    try {
      const { kind, filename } = req.params;
      if (!['originals', 'previews', 'outputs'].includes(kind)) {
        return res.status(400).json({ error: 'Invalid file kind' });
      }
      if (!/^[a-zA-Z0-9-]+\.[a-zA-Z0-9]+$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
      }
      const absPath = storage.getAbsolutePath(`${kind}/${filename}`);
      res.sendFile(absPath);
    } catch (err) {
      next(err);
    }
  },
};
