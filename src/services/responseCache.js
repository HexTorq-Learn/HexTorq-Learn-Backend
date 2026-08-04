const cache = new Map();
const pending = new Map();

function now() {
  return Date.now();
}

export function clearCachePrefix(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export async function cachedResponse(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return hit.value;
  if (pending.has(key)) return pending.get(key);

  const promise = loader()
    .then((value) => {
      cache.set(key, { value, expiresAt: now() + ttlMs });
      return value;
    })
    .finally(() => {
      pending.delete(key);
    });

  pending.set(key, promise);
  return promise;
}
