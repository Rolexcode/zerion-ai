import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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

export async function saveEncryptedKey(userId, encryptedKey) {
  await redis.set(`zenguard:key:${userId}`, encryptedKey);
}

export async function loadEncryptedKey(userId) {
  return await redis.get(`zenguard:key:${userId}`);
}

export async function deleteEncryptedKey(userId) {
  await redis.del(`zenguard:key:${userId}`);
}