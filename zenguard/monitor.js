import cron from 'node-cron';
import { getPositions } from './utils.js';
import { loadWatchedTokens, loadEncryptedKey } from './store.js';
import { swapToUSDCSolana, swapToUSDCEVM } from './swapper.js';

const activeMonitors = new Map();
const alertCooldowns = new Map();

const COOLDOWN_MS = 60 * 60 * 1000;

function isOnCooldown(userId, mint) {
  const key = `${userId}:${mint}`;
  const last = alertCooldowns.get(key);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(userId, mint) {
  const key = `${userId}:${mint}`;
  alertCooldowns.set(key, Date.now());
}

export async function scheduleMonitoring(userId, address, ctx) {
  const monitorKey = `${userId}:${address}`;
  if (activeMonitors.has(monitorKey)) return;

  const task = cron.schedule('*/5 * * * *', async () => {
    try {
      const [positions, watchedTokens, encryptedKey] = await Promise.all([
        getPositions(address),
        loadWatchedTokens(userId),
        loadEncryptedKey(userId),
      ]);

      if (!watchedTokens.length) return;

      for (const watched of watchedTokens) {
        const position = positions.find(
          (p) => p?.attributes?.fungible_info?.symbol === watched.token
        );

        if (!position) continue;

        const change = position?.attributes?.changes?.percent_1d ?? 0;
        const value = position?.attributes?.value ?? 0;
        const price = position?.attributes?.price ?? 0;
        const quantity = position?.attributes?.quantity?.float ?? 0;

        if (Math.abs(change) >= watched.threshold) {
          if (isOnCooldown(userId, watched.mint)) continue;
          setCooldown(userId, watched.mint);

          const direction = change > 0 ? '📈' : '📉';

          if (encryptedKey) {
            // Protection mode — execute real swap
            try {
              await ctx.reply(
                `🚨 *ZenGuard — Auto-Swap Triggered*\n\n` +
                `Token: *${watched.token}* ${direction}\n` +
                `Change: *${change.toFixed(1)}%* in 24h\n` +
                `Executing protective swap to USDC...`,
                { parse_mode: 'Markdown' }
              );

              const chain = watched.chain ?? 'solana';
              let txHash;

              if (chain === 'solana') {
                txHash = await swapToUSDCSolana(
                  encryptedKey,
                  watched.mint,
                  quantity
                );
              } else {
                txHash = await swapToUSDCEVM(
                  encryptedKey,
                  chain,
                  watched.mint,
                  quantity
                );
              }

              await ctx.reply(
                `✅ *Swap Executed*\n\n` +
                `${watched.token} → USDC\n` +
                `Tx: \`${txHash}\`\n\n` +
                `Your funds are protected.`,
                { parse_mode: 'Markdown' }
              );

            } catch (err) {
              console.error('[monitor] Swap failed:', err.message);
              await ctx.reply(
                `⚠️ *Auto-swap failed*\n\n` +
                `${watched.token} moved ${change.toFixed(1)}% but swap could not execute.\n` +
                `Reason: ${err.message}\n\n` +
                `Check your position manually.`,
                { parse_mode: 'Markdown' }
              );
            }

          } else {
            // Surveillance mode — alert only
            await ctx.reply(
              `🚨 *ZenGuard Alert*\n\n` +
              `Token: *${watched.token}* ${direction}\n` +
              `Change: *${change.toFixed(1)}%* in 24h\n` +
              `Current Price: $${Number(price).toFixed(6)}\n` +
              `Position Value: $${Number(value).toFixed(2)}\n\n` +
              `Wallet: \`${address.slice(0, 6)}...${address.slice(-4)}\``,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '📊 View Wallet', callback_data: 'analyze_watched' },
                    { text: '⚙️ Edit Rules', callback_data: 'show_status' },
                  ]],
                },
              }
            );
          }
        }
      }
    } catch (err) {
      console.error(`[monitor] Error checking ${address}:`, err.message);
    }
  });

  activeMonitors.set(monitorKey, task);
}

export function stopMonitoring(userId, address) {
  const monitorKey = `${userId}:${address}`;
  const task = activeMonitors.get(monitorKey);
  if (task) {
    task.stop();
    activeMonitors.delete(monitorKey);
  }
}