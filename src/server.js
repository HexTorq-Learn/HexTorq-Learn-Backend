import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createServer } from 'http';
import { ZodError } from 'zod';
import { authRouter } from './routes/auth.js';
import { videosRouter } from './routes/videos.js';
import { trackingRouter } from './routes/tracking.js';
import { analyticsRouter } from './routes/analytics.js';
import { adminRouter } from './routes/admin.js';
import { playlistsRouter } from './routes/playlists.js';
import { initRealtime } from './realtime.js';
import { corsOrigin, getAllowedOrigins } from './cors.js';
import { ensureUserContactColumns } from './services/databaseEnsure.js';

const PROJECT_NAME = 'HexTorq Learn Backend';
const app = express();
const port = Number(process.env.PORT || 4000);
const corsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};

function forceCorsHeaders(req, res, next) {
  const origin = req.get('origin');
  if (origin && getAllowedOrigins().includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'Content-Type,Authorization');
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  return next();
}

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.log(JSON.stringify({
      project: PROJECT_NAME,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs),
      origin: req.get('origin') || null,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    }));
  });
  next();
}

function healthPayload() {
  return {
    status: 'ok',
    project: PROJECT_NAME,
    service: 'hextorq-learn-backend',
    timestamp: new Date().toISOString(),
  };
}

app.use(forceCorsHeaders);
app.use(helmet());
app.use(requestLogger);
app.options(/.*/, cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json(healthPayload());
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
  res.json(healthPayload());
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

ensureUserContactColumns()
  .then(() => {
    server.listen(port, () => {
      console.log(`HexTorq Learn backend listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to prepare database columns before startup', error);
    process.exit(1);
  });
