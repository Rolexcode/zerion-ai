import cron from 'node-cron';
import { getPortfolio, getPositions } from './utils.js';
import { evaluatePolicy } from './policies.js';

const activeMonitors = new Map();
const alertCooldowns = new Map();
const restoringAddresses = new Set();

const COOLDOWN_MS = 60 * 60 * 1000;

function isOnCooldown(address, token) {
  const key = `${address}:${token}`;
  const last = alertCooldowns.get(key);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(address, token) {
  alertCooldowns.set(`${address}:${token}`, Date.now());
}

export async function scheduleMonitoring(address, ctx) {
  if (activeMonitors.has(address)) return;
  if (restoringAddresses.has(address)) return;
  restoringAddresses.add(address);

  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const telegram = ctx.telegram;

  const task = cron.schedule('*/15 * * * *', async () => {
    try {
      const [portfolio, positions] = await Promise.all([
        getPortfolio(address),
        getPositions(address),
      ]);

      const threat = await evaluatePolicy(userId, portfolio, positions);

      if (threat.triggered && !isOnCooldown(address, threat.token)) {
        setCooldown(address, threat.token);

        await telegram.sendMessage(
          chatId,
          `🚨 *ZenGuard Alert*\n\n` +
          `Wallet: \`${address.slice(0, 6)}...${address.slice(-4)}\`\n` +
          `Threat: ${threat.reason}\n` +
          `Action: Swap triggered → USDC`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      console.error(`[monitor] Error checking ${address}:`, err.message);
    }
  });

  activeMonitors.set(address, task);
}

export function stopMonitoring(address) {
  const task = activeMonitors.get(address);
  if (task) {
    task.stop();
    activeMonitors.delete(address);
    restoringAddresses.delete(address);
  }
}