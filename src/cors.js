const DEFAULT_ORIGINS = [
  'https://learn.hextorq.tech',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export function getAllowedOrigins() {
  return [...DEFAULT_ORIGINS, ...(process.env.FRONTEND_ORIGIN || '').split(',')]
    .map((origin) => origin.trim())
    .filter(Boolean)
    .filter((origin, index, origins) => origins.indexOf(origin) === index);
}

export function corsOrigin(origin, callback) {
  if (!origin || getAllowedOrigins().includes(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`Origin not allowed by CORS: ${origin}`));
}
