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

// ─── ENCRYPTED PRIVATE KEYS — PER CHAIN ──────────────────────────────────────

export async function saveEncryptedKey(userId, encryptedKey, chain = 'solana') {
  await redis.set(`zenguard:key:${chain}:${userId}`, encryptedKey);
}

export async function loadEncryptedKey(userId, chain = 'solana') {
  const data = await redis.get(`zenguard:key:${chain}:${userId}`);
  if (!data) return null;
  return typeof data === 'string' ? data : String(data);
}

export async function deleteEncryptedKey(userId, chain = 'solana') {
  await redis.del(`zenguard:key:${chain}:${userId}`);
}

export async function loadAllKeys(userId) {
  const [solana, evm] = await Promise.all([
    loadEncryptedKey(userId, 'solana'),
    loadEncryptedKey(userId, 'evm'),
  ]);
  return { solana, evm };
}

export async function saveWalletAddress(userId, address, chain = 'solana') {
  await redis.set(`zenguard:address:${chain}:${userId}`, address);
}

export async function loadWalletAddress(userId, chain = 'solana') {
  const data = await redis.get(`zenguard:address:${chain}:${userId}`);
  if (!data) return null;
  return typeof data === 'string' ? data : String(data);
}

export async function loadAllAddresses(userId) {
  const [solana, evm] = await Promise.all([
    loadWalletAddress(userId, 'solana'),
    loadWalletAddress(userId, 'evm'),
  ]);
  return { solana, evm };
}

// ─── ACTIVE TRADING POSITIONS ─────────────────────────────────────────────────

export async function savePosition(userId, position) {
  const positions = await loadPositions(userId);
  const existing = positions.findIndex(p => p.mint === position.mint);
  if (existing >= 0) {
    positions[existing] = position;
  } else {
    positions.push(position);
  }
  await redis.set(`zenguard:positions:${userId}`, positions);
}

export async function loadPositions(userId) {
  const data = await redis.get(`zenguard:positions:${userId}`);
  if (!data) return [];
  return Array.isArray(data) ? data : JSON.parse(data);
}

export async function removePosition(userId, mint) {
  const positions = await loadPositions(userId);
  const updated = positions.filter(p => p.mint !== mint);
  await redis.set(`zenguard:positions:${userId}`, updated);
}

export async function clearPositions(userId) {
  await redis.del(`zenguard:positions:${userId}`);
}

// ─── LEGACY POLICY ────────────────────────────────────────────────────────────

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