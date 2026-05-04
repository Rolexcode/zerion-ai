import cron from 'node-cron';
import { getPositions } from './utils.js';
import { loadWatchedTokens, loadEncryptedKey, loadWalletAddress } from './store.js';
import { swapToUSDCSolana, swapToUSDCEVM } from './swapper.js';

const activeMonitors = new Map();
const alertCooldowns = new Map();

// 1 hour cooldown per token per user — prevents spam and rate limit hammering
const COOLDOWN_MS = 60 * 60 * 1000;

function isOnCooldown(userId, mint) {
  const key = `${userId}:${mint}`;
  const last = alertCooldowns.get(key);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(userId, mint) {
  alertCooldowns.set(`${userId}:${mint}`, Date.now());
}

export async function scheduleMonitoring(userId, address, ctx) {
  const monitorKey = `${userId}:${address}`;
  if (activeMonitors.has(monitorKey)) return;

  const task = cron.schedule('*/5 * * * *', async () => {
    try {
      const [positions, watchedTokens] = await Promise.all([
        getPositions(address),
        loadWatchedTokens(userId),
      ]);

      if (!watchedTokens.length) return;

      // Determine if this is the user's OWN wallet
      const [ownSolana, ownEVM] = await Promise.all([
        loadWalletAddress(userId, 'solana'),
        loadWalletAddress(userId, 'evm'),
      ]);
      const isOwnWallet = address === ownSolana || address === ownEVM;

      for (const watched of watchedTokens) {
        if (watched.address !== address) continue;

        const position = positions.find(
          p => p?.attributes?.fungible_info?.symbol === watched.token
        );

        if (!position) continue;

        const change = position?.attributes?.changes?.percent_1d ?? 0;
        const value = position?.attributes?.value ?? 0;
        const price = position?.attributes?.price ?? 0;
        const quantity = position?.attributes?.quantity?.float ?? 0;
        const chain = position?.relationships?.chain?.data?.id ?? 'solana';

        const dropTriggered = change <= -(watched.threshold);
        const pumpTriggered = watched.takeProfit && change >= watched.takeProfit;

        if (!dropTriggered && !pumpTriggered) continue;
        if (isOnCooldown(userId, watched.mint)) continue;

        setCooldown(userId, watched.mint);

        const direction = change > 0 ? '📈' : '📉';
        const reason = dropTriggered
          ? `dropped ${Math.abs(change).toFixed(1)}%`
          : `pumped ${change.toFixed(1)}%`;

        // ─── SURVEILLANCE MODE — alert only ──────────────────────────────────
        if (!isOwnWallet || !watched.autoSell) {
          await ctx.reply(
            `🚨 *ZenGuard Alert*\n\n` +
            `Token: *${watched.token}* ${direction}\n` +
            `Change: *${change.toFixed(1)}%* in 24h\n` +
            `Price: $${Number(price).toFixed(6)}\n` +
            `Value: $${Number(value).toFixed(2)}\n\n` +
            `Wallet: \`${address.slice(0, 6)}...${address.slice(-4)}\``,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '📊 View Wallet', callback_data: 'analyze_watched' },
                  { text: '📋 Dashboard', callback_data: 'show_status' },
                ]],
              },
            }
          );
          continue;
        }

        // ─── PROTECTION MODE — auto-swap user's own wallet ────────────────────
        const chainKey = chain === 'solana' ? 'solana' : 'evm';
        const encryptedKey = await loadEncryptedKey(userId, chainKey);

        if (!encryptedKey) {
          await ctx.reply(
            `🚨 *ZenGuard Alert*\n\n` +
            `*${watched.token}* ${reason} — no wallet key found to execute swap.\n\n` +
            `Check your wallet connection in My Wallets.`,
            { parse_mode: 'Markdown' }
          );
          continue;
        }

        // Calculate swap amount based on user's chosen percentage
        const swapPct = watched.swapPercent ?? 100;
        const swapAmount = quantity * (swapPct / 100);

        await ctx.reply(
          `🚨 *ZenGuard — Auto-Swap Triggered*\n\n` +
          `Token: *${watched.token}* ${direction}\n` +
          `Change: *${change.toFixed(1)}%* in 24h\n` +
          `Swapping *${swapPct}%* of position → USDC...`,
          { parse_mode: 'Markdown' }
        );

        try {
          let txHash;
          if (chain === 'solana') {
            txHash = await swapToUSDCSolana(encryptedKey, watched.mint, swapAmount);
          } else {
            txHash = await swapToUSDCEVM(encryptedKey, chain, watched.mint, swapAmount);
          }

          await ctx.reply(
            `✅ *Swap Executed*\n\n` +
            `${swapPct}% of ${watched.token} → USDC\n` +
            `Tx: \`${txHash}\``,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          console.error(`[monitor] Swap failed:`, err.message);

          // Extend cooldown on swap failure to avoid hammering the API
          alertCooldowns.set(`${userId}:${watched.mint}`, Date.now());

          await ctx.reply(
            `⚠️ *Auto-swap failed*\n\n` +
            `*${watched.token}* ${reason} but swap could not execute.\n` +
            `Reason: ${err.message}\n\n` +
            `Check your position manually.`,
            { parse_mode: 'Markdown' }
          );
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
