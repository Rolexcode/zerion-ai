import cron from 'node-cron';
import { getPortfolio, getPositions } from './utils.js';
import { evaluatePolicy } from './policies.js';

const activeMonitors = new Map();

export async function scheduleMonitoring(address, ctx) {
  if (activeMonitors.has(address)) return;

  const task = cron.schedule('* * * * *', async () => {
    try {
      const [portfolio, positions] = await Promise.all([
        getPortfolio(address),
        getPositions(address),
      ]);

      const threat = await evaluatePolicy(ctx.from.id, portfolio, positions);

      if (threat.triggered) {
        await ctx.reply(
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
  }
}