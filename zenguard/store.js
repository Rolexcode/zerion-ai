import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ─── WATCHED TOKENS ───────────────────────────────────────────────────────────

export async function saveWatchedTokens(userId, tokens) {
  await redis.set(`zenguard:tokens:${userId}`, tokens);
}

export async function loadWatchedTokens(userId) {
  const data = await redis.get(`zenguard:tokens:${userId}`);
  if (!data) return [];
  return Array.isArray(data) ? data : JSON.parse(data);
}

export async function addWatchedToken(userId, token) {
  const tokens = await loadWatchedTokens(userId);
  const exists = tokens.find(t => t.mint === token.mint);
  if (exists) return tokens;
  tokens.push(token);
  await saveWatchedTokens(userId, tokens);
  return tokens;
}

export async function removeWatchedToken(userId, mint) {
  const tokens = await loadWatchedTokens(userId);
  const updated = tokens.filter(t => t.mint !== mint);
  await saveWatchedTokens(userId, updated);
  return updated;
}

export async function clearWatchedTokens(userId) {
  await redis.del(`zenguard:tokens:${userId}`);
}

// ─── WALLET ADDRESS ───────────────────────────────────────────────────────────

export async function saveWatcher(userId, address) {
  await redis.set(`zenguard:watcher:${userId}`, address);
}

export async function loadWatcher(userId) {
  const data = await redis.get(`zenguard:watcher:${userId}`);
  if (!data) return null;
  return typeof data === 'string' ? data : String(data);
}

export async function deleteWatcher(userId) {
  await redis.del(`zenguard:watcher:${userId}`);
}

// ─── ENCRYPTED PRIVATE KEY ────────────────────────────────────────────────────

export async function saveEncryptedKey(userId, encryptedKey) {
  await redis.set(`zenguard:key:${userId}`, encryptedKey);
}

export async function loadEncryptedKey(userId) {
  const data = await redis.get(`zenguard:key:${userId}`);
  if (!data) return null;
  return typeof data === 'string' ? data : String(data);
}

export async function deleteEncryptedKey(userId) {
  await redis.del(`zenguard:key:${userId}`);
}

// ─── LEGACY POLICY (kept for compatibility) ───────────────────────────────────

export async function savePolicy(userId, data) {
  await redis.set(`zenguard:policy:${userId}`, data);
}

export async function loadPolicy(userId) {
  const data = await redis.get(`zenguard:policy:${userId}`);
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) : data;
}

export async function deletePolicy(userId) {
  await redis.del(`zenguard:policy:${userId}`);
}