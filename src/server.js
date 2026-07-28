import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createServer } from 'http';
import morgan from 'morgan';
import { ZodError } from 'zod';
import { authRouter } from './routes/auth.js';
import { videosRouter } from './routes/videos.js';
import { trackingRouter } from './routes/tracking.js';
import { analyticsRouter } from './routes/analytics.js';
import { adminRouter } from './routes/admin.js';
import { playlistsRouter } from './routes/playlists.js';
import { initRealtime } from './realtime.js';
import { corsOrigin } from './cors.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const corsOptions = {
  origin: corsOrigin,
  credentials: true,
};

app.use(helmet());
app.options(/.*/, cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

function mountApi(prefix = '') {
  app.use(`${prefix}/api/auth`, authRouter);
  app.use(`${prefix}/api/playlists`, playlistsRouter);
  app.use(`${prefix}/api/videos`, videosRouter);
  app.use(`${prefix}/api/tracking`, trackingRouter);
  app.use(`${prefix}/api/analytics`, analyticsRouter);
  app.use(`${prefix}/api/admin`, adminRouter);
}

app.get('/hextorq-learn/health', (_req, res) => {
  res.json({ status: 'ok' });
});

mountApi();
mountApi('/hextorq-learn');

app.use((error, _req, res, _next) => {
  if (error instanceof ZodError) {
    return res.status(400).json({ message: 'Invalid request', issues: error.issues });
  }

  if (
    error.name === 'PrismaClientInitializationError'
    || error.message?.includes("Can't reach database server")
  ) {
    console.error(error);
    return res.status(503).json({ message: 'Database unavailable. Check PostgreSQL connection settings.' });
  }

  console.error(error);
  return res.status(500).json({ message: 'Server error' });
});

const server = createServer(app);
initRealtime(server);

server.listen(port, () => {
  console.log(`HexTorq Learn backend listening on http://localhost:${port}`);
});
