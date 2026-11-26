import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const SUBDIRS = ['originals', 'previews', 'outputs'];

async function ensureDirs() {
  await fs.mkdir(config.storageDir, { recursive: true });
  await Promise.all(
    SUBDIRS.map((d) => fs.mkdir(path.join(config.storageDir, d), { recursive: true }))
  );
}

function resolveSafePath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string' || relativePath.includes('..') || path.isAbsolute(relativePath)) {
    throw new Error('Invalid storage path');
  }
  const full = path.resolve(config.storageDir, relativePath);
  if (!full.startsWith(path.resolve(config.storageDir) + path.sep)) {
    throw new Error('Invalid storage path');
  }
  return full;
}

export const storage = {
  async init() {
    await ensureDirs();
  },

  /**
   * Store an original image immutably with a random UUID filename.
   * Never overwrites an existing file.
   */
  async saveOriginal(buffer, ext = 'jpg') {
    await ensureDirs();
    const safeExt = String(ext).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
    const fileName = `${crypto.randomUUID()}.${safeExt}`;
    const relPath = path.posix.join('originals', fileName);
    const absPath = resolveSafePath(relPath);
    await fs.writeFile(absPath, buffer, { flag: 'wx' });
    return relPath;
  },

  async savePreview(buffer, ext = 'jpg') {
    await ensureDirs();
    const safeExt = String(ext).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
    const fileName = `${crypto.randomUUID()}.${safeExt}`;
    const relPath = path.posix.join('previews', fileName);
    const absPath = resolveSafePath(relPath);
    await fs.writeFile(absPath, buffer);
    return relPath;
  },

  async saveOutput(buffer, ext = 'jpg') {
    await ensureDirs();
    const safeExt = String(ext).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
    const fileName = `${crypto.randomUUID()}.${safeExt}`;
    const relPath = path.posix.join('outputs', fileName);
    const absPath = resolveSafePath(relPath);
    await fs.writeFile(absPath, buffer);
    return relPath;
  },

  async readBuffer(relPath) {
    const absPath = resolveSafePath(relPath);
    return fs.readFile(absPath);
  },

  getAbsolutePath(relPath) {
    return resolveSafePath(relPath);
  },
};
