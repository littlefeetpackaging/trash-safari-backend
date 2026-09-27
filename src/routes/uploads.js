import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireAuth } from '../lib/auth.js';

const router = Router();

const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

// Compressed photos (resized client-side to ~1000-1280px, JPEG ~70-75%)
// should land well under 500KB. This is a hard backstop, not the normal
// case — it stops a bug, a modified client, or an uncompressed upload from
// quietly eating storage and R2's Class A operation quota. At this cap,
// the free 10GB R2 tier holds roughly 50,000 reports.
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB

// Returns a short-lived signed PUT URL. The phone/browser uploads the photo
// directly to object storage with it, then submits the resulting public URL
// as photo_url on a Report/Verification — the photo bytes never pass
// through this server. Doc §9: the DB only ever stores the URL.
//
// The client must report the exact byte size of the file it's about to
// upload (size_bytes). That size is baked into the signed URL itself
// (ContentLength) — R2 enforces the match, so a client can't request a
// small-file signature and then upload something bigger; it would just be
// rejected by R2, not merely policed after the fact.
router.post('/photo-upload-url', requireAuth, async (req, res) => {
  const ext = (req.query.ext || 'jpg').replace(/[^a-z0-9]/gi, '');
  const sizeBytes = Number(req.query.size_bytes ?? req.body?.size_bytes);

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return res.status(400).json({ error: 'size_bytes_required', note: 'pass the exact byte size of the file you are about to upload' });
  }
  if (sizeBytes > MAX_PHOTO_BYTES) {
    return res.status(413).json({ error: 'photo_too_large', max_bytes: MAX_PHOTO_BYTES });
  }

  const key = `reports/${req.user.sub}/${Date.now()}-${randomUUID()}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    ContentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    ContentLength: sizeBytes,
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  const publicUrl = `${process.env.S3_PUBLIC_BASE_URL}/${key}`;

  res.json({ upload_url: uploadUrl, photo_url: publicUrl, expires_in: 300, max_bytes: MAX_PHOTO_BYTES });
});

export default router;
