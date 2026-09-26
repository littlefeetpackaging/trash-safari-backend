import express from 'express';
import cors from 'cors';
import 'dotenv/config';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import reportRoutes from './routes/reports.js';
import verificationRoutes from './routes/verifications.js';
import pickupRoutes from './routes/pickups.js';
import uploadRoutes from './routes/uploads.js';
import collectorApplicationRoutes from './routes/collector-application.js';
import adminRoutes from './routes/admin.js';
import adRoutes from './routes/ads.js';
import leaderboardRoutes from './routes/leaderboard.js';
import achievementRoutes from './routes/achievements.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/reports', reportRoutes);
app.use('/verifications', verificationRoutes);
app.use('/pickups', pickupRoutes);
app.use('/uploads', uploadRoutes);
app.use('/collector-application', collectorApplicationRoutes);
app.use('/admin', adminRoutes);
app.use('/ads', adRoutes);
app.use('/leaderboard', leaderboardRoutes);
app.use('/achievements', achievementRoutes);

// Last-resort error handler so a thrown/rejected error in a route becomes a
// clean 500 instead of Express's default HTML stack trace.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`trash-safari-backend listening on :${port}`));
