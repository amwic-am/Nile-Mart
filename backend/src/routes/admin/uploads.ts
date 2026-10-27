import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../../config.js';
import { requirePerm } from '../../lib/auth.js';
import { unprocessable } from '../../lib/errors.js';
import { asyncRoute } from '../../lib/request.js';
import { uploadLimiter } from '../../middleware/security.js';
import { recordAudit } from './shared.js';

const router = Router();

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

fs.mkdirSync(config.uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, done) => done(null, config.uploadsDir),
  filename: (_req, file, done) => {
    const extension = EXTENSIONS[file.mimetype] ?? 'bin';
    done(null, `${randomUUID()}.${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => {
    if (!EXTENSIONS[file.mimetype]) {
      done(unprocessable('Upload a PNG, JPEG, WebP, AVIF or GIF image.'));
      return;
    }
    done(null, true);
  },
});

async function hasValidSignature(filePath: string, mime: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(12);
    await handle.read(buffer, 0, 12, 0);
    if (mime === 'image/png') {
      return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (mime === 'image/jpeg') {
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    if (mime === 'image/gif') {
      return buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
        buffer.subarray(0, 6).toString('ascii') === 'GIF89a';
    }
    if (mime === 'image/webp') {
      return buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    }
    if (mime === 'image/avif') {
      const brand = buffer.subarray(8, 12).toString('ascii');
      return buffer.subarray(4, 8).toString('ascii') === 'ftyp' && (brand === 'avif' || brand === 'avis');
    }
    return false;
  } finally {
    await handle.close();
  }
}

router.post(
  '/uploads',
  uploadLimiter,
  requirePerm('uploads.write'),
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const file = req.file;
    if (!file) throw unprocessable('Choose an image to upload.');

    const valid = await hasValidSignature(file.path, file.mimetype);
    if (!valid) {
      await fs.promises.unlink(file.path).catch(() => undefined);
      throw unprocessable('That file is not a valid image.');
    }

    const url = `/uploads/${path.basename(file.path)}`;
    await recordAudit(req, {
      action: 'upload.created',
      entityType: 'upload',
      entityId: path.basename(file.path),
      after: { url, size: file.size, mime: file.mimetype },
    });

    res.status(201).json({
      upload: {
        url,
        filename: path.basename(file.path),
        size: file.size,
        mime: file.mimetype,
      },
    });
  }),
);

export default router;
