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

// Returns a short-lived signed PUT URL. The phone/browser uploads the photo
// directly to object storage with it, then submits the resulting public URL
// as photo_url on a Report/Verification — the photo bytes never pass
// through this server. Doc §9: the DB only ever stores the URL.
router.post('/photo-upload-url', requireAuth, async (req, res) => {
  const ext = (req.query.ext || 'jpg').replace(/[^a-z0-9]/gi, '');
  const key = `reports/${req.user.sub}/${Date.now()}-${randomUUID()}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    ContentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  const publicUrl = `${process.env.S3_PUBLIC_BASE_URL}/${key}`;

  res.json({ upload_url: uploadUrl, photo_url: publicUrl, expires_in: 300 });
});

export default router;
