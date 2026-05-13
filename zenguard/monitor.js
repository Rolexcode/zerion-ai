import cron from 'node-cron';
import {
  loadWatchedTokens,
  loadEncryptedKey,
  loadWalletAddress,
  loadPositions,
  savePosition,
  removePosition,
} from './store.js';
import { swapToUSDCSolana, swapToUSDCEVM, getEVMTokenBalance, getTokenInfo } from './swapper.js';

const activeMonitors = new Map();
const alertCooldowns = new Map();

// 1 hour cooldown per token per user
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

function findPosition(positions, watched, chain) {
  return positions.find((position) => {
    const sameToken = position.mint?.toLowerCase() === watched.mint?.toLowerCase();
    const sameChain = !position.chain || !chain || position.chain === chain;
    return sameToken && sameChain;
  });
}

function calculateSwapAmount(position, swapPct) {
  const positionAmount = Number(position?.amount);
  const pct = Number(swapPct);
  if (!Number.isFinite(positionAmount) || positionAmount <= 0) return null;
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
  return Number(((positionAmount * pct) / 100).toPrecision(12));
}

async function updatePositionAfterSwap(userId, position, swapAmount, swapPct) {
  if (swapPct >= 100 || swapAmount >= Number(position.amount)) {
    await removePosition(userId, position.mint);
    return 0;
  }

  const remaining = Math.max(0, Number(position.amount) - swapAmount);
  await savePosition(userId, {
    ...position,
    amount: remaining.toPrecision(12),
    lastAutoSellAt: new Date().toISOString(),
  });
  return remaining;
}

function normalizeSwapResult(result) {
  if (typeof result === 'string') {
    return { hash: result, outputAmount: null };
  }
  return {
    hash: result?.hash,
    outputAmount: result?.outputAmount ?? null,
  };
}

export async function scheduleMonitoring(userId, address, ctx) {
  const monitorKey = `${userId}:${address}`;
  if (activeMonitors.has(monitorKey)) return;

  const task = cron.schedule('*/5 * * * *', async () => {
    try {
      const watchedTokens = await loadWatchedTokens(userId);
      if (!watchedTokens.length) return;

      // Determine if this is the user's OWN wallet
      const [ownSolana, ownEVM] = await Promise.all([
        loadWalletAddress(userId, 'solana'),
        loadWalletAddress(userId, 'evm'),
      ]);
      const isOwnWallet = address === ownSolana || address === ownEVM;

      for (const watched of watchedTokens) {
        if (watched.address !== address) continue;
        if (isOnCooldown(userId, watched.mint)) continue;

        // Use DexScreener for price — zero Zerion API quota used here
        let tokenInfo;
        try {
          tokenInfo = await getTokenInfo(watched.mint);
        } catch (err) {
          console.error(`[monitor] Price fetch failed for ${watched.token}:`, err.message);
          continue;
        }

        const change = tokenInfo.change24h ?? 0;
        const price = tokenInfo.price ?? 0;
        const chain = watched.chain ?? tokenInfo.chain ?? 'solana';

        const dropTriggered = change <= -(watched.threshold);
        const pumpTriggered = watched.takeProfit && change >= watched.takeProfit;

        if (!dropTriggered && !pumpTriggered) continue;

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
            `Price: $${Number(price).toFixed(6)}\n\n` +
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

        const swapPct = watched.swapPercent ?? 100;
        const positions = await loadPositions(userId);
        const position = findPosition(positions, watched, chain);
        if (position && chain !== 'solana') {
          try {
            position.amount = await getEVMTokenBalance(encryptedKey, chain, watched.mint);
          } catch (err) {
            console.error(`[monitor] Live balance fetch failed for ${watched.token}:`, err.message);
          }
        }
        const swapAmount = calculateSwapAmount(position, swapPct);

        if (!position || !swapAmount) {
          await ctx.reply(
            `⚠️ *Auto-swap skipped*\n\n` +
            `*${watched.token}* ${reason}, but ZenGuard could not find a tracked position amount to sell.\n\n` +
            `Open Positions and confirm this token is tracked before enabling auto-sell.`,
            { parse_mode: 'Markdown' }
          );
          continue;
        }

        await ctx.reply(
          `🚨 *ZenGuard — Auto-Swap Triggered*\n\n` +
          `Token: *${watched.token}* ${direction}\n` +
          `Change: *${change.toFixed(1)}%* in 24h\n` +
          `Swapping *${swapPct}%* (${swapAmount} ${watched.token}) -> ETH...`,
          { parse_mode: 'Markdown' }
        );

        try {
          let swapResult;

          if (chain === 'solana') {
            swapResult = await swapToUSDCSolana(encryptedKey, watched.mint, swapAmount);
          } else {
            swapResult = await swapToUSDCEVM(encryptedKey, chain, watched.mint, swapAmount, 'eth');
          }
          const { hash: txHash } = normalizeSwapResult(swapResult);
          const remaining = await updatePositionAfterSwap(userId, position, swapAmount, swapPct);

          await ctx.reply(
            `✅ *Swap Executed*\n\n` +
            `${swapAmount} ${watched.token} -> ETH\n` +
            `Tx: \`${txHash}\`\n` +
            `${remaining > 0 ? `Remaining: ${remaining.toPrecision(8)} ${watched.token}` : 'Position closed.'}`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          console.error(`[monitor] Swap failed:`, err.message);
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
