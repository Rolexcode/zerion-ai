import 'dotenv/config';
import http from 'http';
import { Telegraf, session, Markup } from 'telegraf';
import { scheduleMonitoring, stopMonitoring } from './monitor.js';
import { getPortfolio, getPositions } from './utils.js';
import { importSolanaWallet, importEVMWallet, generateSolanaWallet, generateEVMWallet } from './wallet.js';
import { swapToUSDCSolana, swapToUSDCEVM, getTokenInfo, isContractAddress } from './swapper.js';
import {
  saveWatcher,
  loadWatcher,
  deleteWatcher,
  addWatchedToken,
  loadWatchedTokens,
  clearWatchedTokens,
  saveEncryptedKey,
  loadEncryptedKey,
  deleteEncryptedKey,
  loadAllKeys,
  saveWalletAddress,
  loadWalletAddress,
  loadAllAddresses,
  savePosition,
  loadPositions,
  removePosition,
  clearPositions,
} from './store.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(session());

// ─── START ────────────────────────────────────────────────────────────────────

bot.start((ctx) => {
  ctx.session ??= {};
  ctx.reply(
    `⚡ *Welcome to ZenGuard*\n\n` +
    `Your autonomous onchain bodyguard — powered by Zerion.\n\n` +
    `🔐 *My Wallets* — Connect Solana and EVM wallets. ZenGuard auto-swaps to USDC when your rules trigger.\n\n` +
    `👁 *Spy on a Wallet* — Watch any wallet 24/7. Get instant alerts on price moves.\n\n` +
    `⚡ *Quick Trade* — Paste any contract address to buy. Sell with one tap.\n\n` +
    `*What would you like to do?*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔐 My Wallets', 'my_wallets')],
        [Markup.button.callback('👁 Spy on a Wallet', 'mode_watch')],
        [Markup.button.callback('⚡ Quick Trade', 'mode_trade')],
        [Markup.button.callback('📋 My Dashboard', 'show_status')],
      ]),
    }
  );
});

// ─── RESET (testing only — remove before final submission) ────────────────────

bot.command('reset', async (ctx) => {
  const { Redis } = await import('@upstash/redis');
  const r = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  const userId = ctx.from.id;
  const keys = [
    `zenguard:tokens:${userId}`,
    `zenguard:watcher:${userId}`,
    `zenguard:key:solana:${userId}`,
    `zenguard:key:evm:${userId}`,
    `zenguard:address:solana:${userId}`,
    `zenguard:address:evm:${userId}`,
    `zenguard:positions:${userId}`,
    `zenguard:policy:${userId}`,
  ];
  await Promise.all(keys.map(k => r.del(k)));
  ctx.session = {};
  ctx.reply('✅ Account reset. Use /start to begin fresh.');
});

// ─── MY WALLETS ───────────────────────────────────────────────────────────────

bot.action('my_wallets', async (ctx) => {
  await ctx.answerCbQuery();
  const { solana, evm } = await loadAllAddresses(ctx.from.id);
  const solanaStatus = solana ? `✅ \`${solana.slice(0, 6)}...${solana.slice(-4)}\`` : '❌ Not connected';
  const evmStatus = evm ? `✅ \`${evm.slice(0, 6)}...${evm.slice(-4)}\`` : '❌ Not connected';
  ctx.reply(
    `🔐 *My Wallets*\n\n🟣 *Solana:* ${solanaStatus}\n🔵 *EVM (ETH/Base/BSC/Arbitrum):* ${evmStatus}\n\nConnect wallets to enable auto-swap protection and trading.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🟣 Manage Solana Wallet', 'manage_solana')],
        [Markup.button.callback('🔵 Manage EVM Wallet', 'manage_evm')],
      ]),
    }
  );
});

bot.action('manage_solana', async (ctx) => {
  await ctx.answerCbQuery();
  const address = await loadWalletAddress(ctx.from.id, 'solana');
  if (address) {
    ctx.reply(
      `🟣 *Solana Wallet*\n\nConnected: \`${address}\`\n\nWhat would you like to do?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Check Balance', 'analyze_solana')],
          [Markup.button.callback('🔄 Replace Wallet', 'import_solana')],
          [Markup.button.callback('🗑 Disconnect', 'disconnect_solana')],
        ]),
      }
    );
  } else {
    ctx.reply(`🟣 *Solana Wallet*\n\nNo Solana wallet connected yet.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📥 Import Existing', 'import_solana')],
        [Markup.button.callback('✨ Generate New', 'gen_solana')],
      ]),
    });
  }
});

bot.action('manage_evm', async (ctx) => {
  await ctx.answerCbQuery();
  const address = await loadWalletAddress(ctx.from.id, 'evm');
  if (address) {
    ctx.reply(
      `🔵 *EVM Wallet*\n\nConnected: \`${address}\`\n\nWhat would you like to do?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Check Balance', 'analyze_evm')],
          [Markup.button.callback('🔄 Replace Wallet', 'import_evm')],
          [Markup.button.callback('🗑 Disconnect', 'disconnect_evm')],
        ]),
      }
    );
  } else {
    ctx.reply(`🔵 *EVM Wallet*\n\nNo EVM wallet connected yet.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📥 Import Existing', 'import_evm')],
        [Markup.button.callback('✨ Generate New', 'gen_evm')],
      ]),
    });
  }
});

bot.action('disconnect_solana', async (ctx) => {
  await ctx.answerCbQuery();
  await deleteEncryptedKey(ctx.from.id, 'solana');
  const { Redis } = await import('@upstash/redis');
  const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  await r.del(`zenguard:address:solana:${ctx.from.id}`);
  ctx.reply('🟣 Solana wallet disconnected.');
});

bot.action('disconnect_evm', async (ctx) => {
  await ctx.answerCbQuery();
  await deleteEncryptedKey(ctx.from.id, 'evm');
  const { Redis } = await import('@upstash/redis');
  const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  await r.del(`zenguard:address:evm:${ctx.from.id}`);
  ctx.reply('🔵 EVM wallet disconnected.');
});

// FIX: analyze_solana and analyze_evm now use own wallet address directly
bot.action('analyze_solana', async (ctx) => {
  await ctx.answerCbQuery();
  const address = await loadWalletAddress(ctx.from.id, 'solana');
  if (!address) return ctx.reply('No Solana wallet connected.');
  await runAnalyze(ctx, address);
});

bot.action('analyze_evm', async (ctx) => {
  await ctx.answerCbQuery();
  const address = await loadWalletAddress(ctx.from.id, 'evm');
  if (!address) return ctx.reply('No EVM wallet connected.');
  await runAnalyze(ctx, address);
});

// ─── WALLET IMPORT & GENERATE ─────────────────────────────────────────────────

bot.action('import_solana', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingPrivateKey = 'solana';
  ctx.reply(
    `🟣 *Import Solana Wallet*\n\nSend your base58 private key.\n\n⚠️ Encrypted with AES-256 immediately. Delete your message after sending.`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('import_evm', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingPrivateKey = 'evm';
  ctx.reply(
    `🔵 *Import EVM Wallet*\n\nSend your hex private key (starts with 0x).\n\n⚠️ Encrypted with AES-256 immediately. Delete your message after sending.`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('gen_solana', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  const walletData = generateSolanaWallet();
  await saveEncryptedKey(ctx.from.id, walletData.encrypted, 'solana');
  await saveWalletAddress(ctx.from.id, walletData.address, 'solana');
  await saveWatcher(ctx.from.id, walletData.address);
  ctx.session.watchedWallet = walletData.address;
  ctx.reply(
    `✨ *New Solana Wallet Created*\n\nAddress: \`${walletData.address}\`\n\n🔑 *Private Key — save this now, shown once only:*\n\`${walletData.privateKey}\`\n\n⚠️ Screenshot and store safely. ZenGuard never stores your raw key.\n\nFund this address with SOL to start trading.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 Check Balance', 'analyze_solana')],
        [Markup.button.callback('🔵 Connect EVM Wallet', 'manage_evm')],
      ]),
    }
  );
});

bot.action('gen_evm', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  const walletData = generateEVMWallet();
  await saveEncryptedKey(ctx.from.id, walletData.encrypted, 'evm');
  await saveWalletAddress(ctx.from.id, walletData.address, 'evm');
  ctx.reply(
    `✨ *New EVM Wallet Created*\n\nAddress: \`${walletData.address}\`\n\n🔑 *Private Key — save this now, shown once only:*\n\`${walletData.privateKey}\`\n\n${walletData.mnemonic ? `📝 *Seed Phrase:*\n\`${walletData.mnemonic}\`\n\n` : ''}⚠️ Screenshot and store safely.\n\nFund with ETH/BNB/MATIC to start trading.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 Check Balance', 'analyze_evm')],
        [Markup.button.callback('🟣 Connect Solana Wallet', 'manage_solana')],
      ]),
    }
  );
});

// ─── MODE SELECTION ───────────────────────────────────────────────────────────

bot.action('mode_watch', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingWatchAddress = true;
  ctx.reply(`👁 *Spy on a Wallet*\n\nPaste any Solana or EVM wallet address.\n\nZenGuard fetches holdings and lets you pick which tokens to guard.`);
});

bot.action('mode_trade', async (ctx) => {
  await ctx.answerCbQuery();
  const { solana, evm } = await loadAllKeys(ctx.from.id);
  if (!solana && !evm) {
    return ctx.reply(
      `⚠️ *No wallets connected.*\n\nConnect at least one wallet to start trading.`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔐 My Wallets', 'my_wallets')]]) }
    );
  }
  const lines = [];
  if (solana) lines.push('🟣 Solana: connected');
  if (evm) lines.push('🔵 EVM: connected');
  ctx.reply(
    `⚡ *Quick Trade*\n\n${lines.join('\n')}\n\nJust paste any contract address to buy.\n\n*/sell* — manage open positions\n*/positions* — view ROI`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📊 View Positions', 'view_positions')]]) }
  );
});

// ─── HOLDINGS PICKER ──────────────────────────────────────────────────────────

async function showHoldingsPicker(ctx, address) {
  const positions = ctx.session.positions ?? [];
  if (!positions.length) {
    return ctx.reply(`⚠️ *No qualifying positions found.*\n\nThis wallet may be empty or hold untracked tokens.`, { parse_mode: 'Markdown' });
  }
  const buttons = positions.map((p) => {
    const arrow = p.change >= 0 ? '📈' : '📉';
    return [Markup.button.callback(`${arrow} ${p.symbol} — $${Number(p.value).toFixed(2)} (${Number(p.change).toFixed(1)}%)`, `pick_token_${p.symbol}`)];
  });
  buttons.push([Markup.button.callback('✅ Done selecting', 'done_picking')]);
  ctx.reply(
    `💼 *Wallet Holdings*\n\n\`${address.slice(0, 6)}...${address.slice(-4)}\`\n\nTap a token to set your alert threshold:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}

// ─── TOKEN SELECTION ──────────────────────────────────────────────────────────

bot.action(/pick_token_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  const symbol = ctx.match[1];
  const position = ctx.session.positions?.find(p => p.symbol === symbol);
  if (!position) return ctx.reply('Token not found. Use /start to begin again.');
  ctx.session.selectedToken = position;
  ctx.session.awaitingThreshold = true;
  ctx.reply(
    `⚙️ *Set Alert for ${symbol}*\n\nPrice: $${Number(position.price).toFixed(6)}\n24h: ${Number(position.change).toFixed(1)}%\nValue: $${Number(position.value).toFixed(2)}\n\nEnter the % move that should trigger.\nExample: *20* = alert if drops or pumps 20%`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('done_picking', async (ctx) => {
  await ctx.answerCbQuery();
  const tokens = await loadWatchedTokens(ctx.from.id);
  if (!tokens.length) return ctx.reply('No tokens selected yet.');
  const lines = tokens.map(t => `• *${t.token}* — alert at ${t.threshold}% move`);
  ctx.reply(`🛡️ *Guards Active*\n\n${lines.join('\n')}\n\nZenGuard is monitoring 24/7.`, { parse_mode: 'Markdown' });
});

// FIX: swap % selection buttons after threshold input
bot.action(/swap_pct_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  const swapPercent = parseInt(ctx.match[1]);
  const { selectedToken, watchedWallet, pendingThreshold } = ctx.session;

  if (!selectedToken || !watchedWallet || !pendingThreshold) {
    return ctx.reply('Session expired. Use /start to begin again.');
  }

  await addWatchedToken(ctx.from.id, {
    address: watchedWallet,
    token: selectedToken.symbol,
    mint: selectedToken.mint,
    threshold: pendingThreshold,
    swapPercent,
    autoSell: true,
    since: new Date().toISOString(),
  });

  await scheduleMonitoring(ctx.from.id, watchedWallet, ctx);

  ctx.session.awaitingThreshold = false;
  ctx.session.selectedToken = null;
  ctx.session.pendingThreshold = null;

  ctx.reply(
    `✅ *Protection Active*\n\n` +
    `Token: *${selectedToken.symbol}*\n` +
    `Trigger: *${pendingThreshold}%* move\n` +
    `Auto-swap: *${swapPercent}%* of holdings → USDC\n` +
    `Wallet: \`${watchedWallet.slice(0, 6)}...${watchedWallet.slice(-4)}\`\n\n` +
    `ZenGuard is watching. It will execute automatically when triggered.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── DASHBOARD / STATUS ───────────────────────────────────────────────────────

bot.command('status', async (ctx) => showStatus(ctx));
bot.action('show_status', async (ctx) => { await ctx.answerCbQuery(); showStatus(ctx); });

async function showStatus(ctx) {
  const [tokens, { solana, evm }] = await Promise.all([
    loadWatchedTokens(ctx.from.id),
    loadAllAddresses(ctx.from.id),
  ]);
  const solanaStatus = solana ? `✅ \`${solana.slice(0, 6)}...${solana.slice(-4)}\`` : '❌ Not connected';
  const evmStatus = evm ? `✅ \`${evm.slice(0, 6)}...${evm.slice(-4)}\`` : '❌ Not connected';
  const guardLines = tokens.length
    ? tokens.map((t, i) => `${i + 1}. *${t.token}* — ${t.threshold}% alert${t.autoSell ? ` (auto-swap ${t.swapPercent ?? 100}%)` : ''}\n   Since: ${new Date(t.since).toDateString()}`).join('\n\n')
    : 'No active guards yet.';
  ctx.reply(
    `📋 *My Dashboard*\n\n🟣 Solana: ${solanaStatus}\n🔵 EVM: ${evmStatus}\n\n*Guards:*\n${guardLines}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔐 My Wallets', 'my_wallets')],
        [Markup.button.callback('➕ Add Token Guard', 'mode_watch')],
        [Markup.button.callback('⚡ Quick Trade', 'mode_trade')],
        [Markup.button.callback('📈 My Positions', 'view_positions')],
        [Markup.button.callback('🔴 Stop All', 'stop_all')],
      ]),
    }
  );
}

// ─── TOKEN INFO + BUY FLOW ────────────────────────────────────────────────────

async function handleTokenLookup(ctx, mint) {
  await ctx.reply('🔍 Fetching token info...');
  try {
    const token = await getTokenInfo(mint);
    const chainKey = token.chain === 'solana' ? 'solana' : 'evm';
    const encryptedKey = await loadEncryptedKey(ctx.from.id, chainKey);
    if (!encryptedKey) {
      return ctx.reply(
        `⚠️ No ${token.chain === 'solana' ? '🟣 Solana' : '🔵 EVM'} wallet connected.\n\nConnect one to trade this token.`,
        { ...Markup.inlineKeyboard([[Markup.button.callback('🔐 My Wallets', 'my_wallets')]]) }
      );
    }
    const verified = token.verified ? '✅ Verified' : '⚠️ Unverified';
    const chainLabel = token.chain === 'solana' ? '🟣 Solana' : `🔵 ${token.dexChain?.toUpperCase() ?? 'EVM'}`;
    const mcap = token.marketCap > 0 ? `$${Number(token.marketCap).toLocaleString()}` : 'N/A';
    ctx.session ??= {};
    ctx.session.pendingBuy = { mint: token.address, token };
    ctx.session.awaitingBuyAmount = true;
    ctx.reply(
      `📊 *${token.name}* (${token.symbol})\n\n` +
      `💲 Price: $${Number(token.price).toFixed(8)}\n` +
      `📈 24h Change: ${Number(token.change24h).toFixed(2)}%\n` +
      `💧 Liquidity: $${Number(token.liquidity).toLocaleString()}\n` +
      `📊 24h Volume: $${Number(token.volume24h).toLocaleString()}\n` +
      `🏦 Market Cap: ${mcap}\n` +
      `🔗 Chain: ${chainLabel} (${token.dex})\n` +
      `${verified}\n\n` +
      `💬 How much *${token.nativeCurrency}* to spend?\n` +
      `e.g. type *0.1* for 0.1 ${token.nativeCurrency}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_buy')]]) }
    );
  } catch (err) {
    console.error('[bot] Token fetch failed:', err.message);
    ctx.reply('⚠️ Token not found. Check the contract address and try again.');
  }
}

bot.command('buy', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const mint = parts[1];
  if (!mint) return ctx.reply(`Just paste a contract address directly — no command needed.`);
  await handleTokenLookup(ctx, mint);
});

bot.action('cancel_buy', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingBuyAmount = false;
  ctx.session.pendingBuy = null;
  ctx.reply('❌ Buy cancelled.');
});

bot.action('confirm_buy', async (ctx) => {
  await ctx.answerCbQuery();
  const { mint, token, amount, estimatedTokens, nativeCurrency } = ctx.session?.pendingBuyConfirm ?? {};
  if (!mint) return ctx.reply('Session expired. Try again.');
  const chain = token.chain === 'solana' ? 'solana' : 'evm';
  const encryptedKey = await loadEncryptedKey(ctx.from.id, chain);
  await ctx.reply(`🔄 *Executing Buy*\n\nToken: *${token.symbol}*\nSpending: *${amount} ${nativeCurrency}*\nRouting via Zerion...`, { parse_mode: 'Markdown' });
  try {
    let txHash;
    if (chain === 'solana') {
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      txHash = await swapToUSDCSolana(encryptedKey, SOL_MINT, Math.floor(amount * 1e9));
    } else {
      const { ethers } = await import('ethers');
      txHash = await swapToUSDCEVM(encryptedKey, token.chain, mint, ethers.parseEther(amount.toString()).toString());
    }
    await savePosition(ctx.from.id, { mint, symbol: token.symbol, amount: estimatedTokens, buyPrice: token.price, chain: token.chain, nativeCurrency, openedAt: new Date().toISOString(), txHash });
    ctx.session.pendingBuyConfirm = null;
    ctx.reply(
      `✅ *Buy Executed*\n\nBought ~${estimatedTokens} *${token.symbol}*\nSpent: ${amount} ${nativeCurrency}\nTx: \`${txHash}\``,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📈 View Positions', 'view_positions')]]) }
    );
  } catch (err) {
    console.error('[bot] Buy failed:', err.message);
    ctx.reply(`⚠️ Buy failed: ${err.message}`);
  }
});

// ─── POSITIONS ────────────────────────────────────────────────────────────────

bot.command('positions', async (ctx) => showPositions(ctx));
bot.action('view_positions', async (ctx) => { await ctx.answerCbQuery(); showPositions(ctx); });

async function showPositions(ctx) {
  const positions = await loadPositions(ctx.from.id);
  if (!positions.length) {
    return ctx.reply(`📭 *No open positions.*\n\nPaste a contract address to open a trade.`, {
      parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⚡ Quick Trade', 'mode_trade')]])
    });
  }
  let totalPnL = 0;
  for (const position of positions) {
    try {
      const info = await getTokenInfo(position.mint);
      const currentPrice = info.price ?? position.buyPrice;
      const roiPct = ((currentPrice - position.buyPrice) / position.buyPrice) * 100;
      const roiUSD = (currentPrice - position.buyPrice) * parseFloat(position.amount);
      totalPnL += roiUSD;
      const arrow = roiPct >= 0 ? '📈' : '📉';
      const sign = roiPct >= 0 ? '+' : '';
      const chainLabel = position.chain === 'solana' ? '🟣' : '🔵';
      await ctx.reply(
        `${arrow} *${position.symbol}* ${chainLabel}\n\nAmount: ${position.amount}\nEntry: $${Number(position.buyPrice).toFixed(8)}\nNow: $${Number(currentPrice).toFixed(8)}\nROI: *${sign}${roiPct.toFixed(2)}%* (${sign}$${roiUSD.toFixed(4)})\nOpened: ${new Date(position.openedAt).toDateString()}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('Sell 25%', `sell_pct_${position.mint}_25`),
              Markup.button.callback('Sell 50%', `sell_pct_${position.mint}_50`),
              Markup.button.callback('Sell 100%', `sell_pct_${position.mint}_100`),
            ],
            [Markup.button.callback('🛡️ Set Auto-Sell', `autosell_${position.mint}`)],
          ]),
        }
      );
    } catch (err) {
      console.error(`[bot] Price fetch failed for ${position.symbol}:`, err.message);
    }
  }
  const sign = totalPnL >= 0 ? '+' : '';
  await ctx.reply(`📊 *Portfolio PnL: ${sign}$${totalPnL.toFixed(4)}*`, { parse_mode: 'Markdown' });
}

// ─── SELL ─────────────────────────────────────────────────────────────────────

bot.command('sell', async (ctx) => showPositions(ctx));

bot.action(/sell_pct_(.+)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const mint = ctx.match[1];
  const pct = parseInt(ctx.match[2]);
  const positions = await loadPositions(ctx.from.id);
  const position = positions.find(p => p.mint === mint);
  if (!position) return ctx.reply('Position not found.');
  const sellAmount = (parseFloat(position.amount) * pct / 100).toFixed(4);
  ctx.session ??= {};
  ctx.session.pendingSell = { mint, pct, sellAmount, symbol: position.symbol, originalAmount: position.amount, chain: position.chain };
  ctx.reply(
    `⚠️ *Confirm Sell*\n\nSelling *${pct}%* of *${position.symbol}*\nAmount: ${sellAmount} tokens → USDC\n\nConfirm?`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Confirm', 'confirm_sell'), Markup.button.callback('❌ Cancel', 'cancel_sell')]]) }
  );
});

bot.action('confirm_sell', async (ctx) => {
  await ctx.answerCbQuery();
  const { mint, pct, sellAmount, symbol, originalAmount, chain } = ctx.session?.pendingSell ?? {};
  if (!mint) return ctx.reply('Session expired.');
  const encryptedKey = await loadEncryptedKey(ctx.from.id, chain === 'solana' ? 'solana' : 'evm');
  await ctx.reply(`📤 Selling ${sellAmount} ${symbol} → USDC...`, { parse_mode: 'Markdown' });
  try {
    let txHash;
    if (chain === 'solana' || !chain) {
      txHash = await swapToUSDCSolana(encryptedKey, mint, parseFloat(sellAmount));
    } else {
      txHash = await swapToUSDCEVM(encryptedKey, chain, mint, parseFloat(sellAmount));
    }
    if (pct === 100) {
      await removePosition(ctx.from.id, mint);
    } else {
      const positions = await loadPositions(ctx.from.id);
      const pos = positions.find(p => p.mint === mint);
      if (pos) { pos.amount = (parseFloat(originalAmount) - parseFloat(sellAmount)).toFixed(4); await savePosition(ctx.from.id, pos); }
    }
    ctx.session.pendingSell = null;
    ctx.reply(
      `✅ *Sold*\n\n${sellAmount} ${symbol} → USDC\nTx: \`${txHash}\`\n${pct === 100 ? 'Position closed.' : `Remaining: ${(parseFloat(originalAmount) - parseFloat(sellAmount)).toFixed(4)} ${symbol}`}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📈 Positions', 'view_positions')]]) }
    );
  } catch (err) {
    console.error('[bot] Sell failed:', err.message);
    ctx.reply(`⚠️ Sell failed: ${err.message}`);
  }
});

bot.action('cancel_sell', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.pendingSell = null;
  ctx.reply('❌ Cancelled.');
});

// ─── AUTO-SELL ────────────────────────────────────────────────────────────────

bot.action(/autosell_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const mint = ctx.match[1];
  const positions = await loadPositions(ctx.from.id);
  const position = positions.find(p => p.mint === mint);
  if (!position) return ctx.reply('Position not found.');
  ctx.session ??= {};
  ctx.session.awaitingAutoSell = { mint, symbol: position.symbol, chain: position.chain };
  ctx.session.awaitingAutoSellStage = 'stoploss';
  ctx.reply(
    `🛡️ *Auto-Sell for ${position.symbol}*\n\nZenGuard auto-sells when triggered.\n\nEnter *stop loss %*\n(e.g. *20* = sell if drops 20%):`,
    { parse_mode: 'Markdown' }
  );
});

// ─── ANALYZE ──────────────────────────────────────────────────────────────────

bot.action('analyze_watched', async (ctx) => {
  await ctx.answerCbQuery();
  // FIX: use spy wallet for this action specifically
  const address = ctx.session?.watchedWallet ?? await loadWatcher(ctx.from.id);
  if (!address) return ctx.reply('No wallet found. Use /start to begin.');
  await runAnalyze(ctx, address);
});

bot.command('analyze', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  // FIX: /analyze defaults to own Solana wallet, not spy wallet
  const ownSolana = await loadWalletAddress(ctx.from.id, 'solana');
  const address = parts[1] ?? ownSolana ?? await loadWatcher(ctx.from.id);
  if (!address) return ctx.reply('Usage: /analyze <wallet_address>');
  await runAnalyze(ctx, address);
});

async function runAnalyze(ctx, address) {
  await ctx.reply('🔍 Analyzing wallet...');
  try {
    const [portfolio, positions] = await Promise.all([
      getPortfolio(address),
      getPositions(address),
    ]);
    const total = portfolio?.total?.positions ?? 0;
    const top = positions.slice(0, 5);
    if (top.length === 0) {
      return ctx.reply(
        `📊 *Wallet Snapshot*\n\n\`${address.slice(0, 6)}...${address.slice(-4)}\`\n\n💼 Total Value: *$${Number(total).toFixed(2)}*\n\nNo positions found. Fund this wallet to get started.`,
        { parse_mode: 'Markdown' }
      );
    }
    const lines = top.map((p) => {
      const value = p?.attributes?.value ?? 0;
      const change = p?.attributes?.changes?.percent_1d ?? 0;
      const symbol = p?.attributes?.fungible_info?.symbol ?? '???';
      return `${change >= 0 ? '📈' : '📉'} *${symbol}* — $${Number(value).toFixed(2)} (${Number(change).toFixed(1)}% 24h)`;
    });
    await ctx.reply(
      `📊 *Wallet Snapshot*\n\n\`${address.slice(0, 6)}...${address.slice(-4)}\`\n\n💼 Total Value: *$${Number(total).toFixed(2)}*\n\n*Top Positions:*\n${lines.join('\n')}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⚡ Quick Trade', 'mode_trade'), Markup.button.callback('📋 Dashboard', 'show_status')]]) }
    );
  } catch (err) {
    console.error('[bot] Analyze failed:', err.message);
    ctx.reply(
      `📊 *Wallet Snapshot*\n\n\`${address.slice(0, 6)}...${address.slice(-4)}\`\n\nCould not fetch data. This wallet may be new or have no history yet.\n\nFund it and try again with /analyze.`,
      { parse_mode: 'Markdown' }
    );
  }
}

// ─── STOP ─────────────────────────────────────────────────────────────────────

bot.action('stop_all', async (ctx) => { await ctx.answerCbQuery(); await handleStop(ctx); });
bot.command('stop', async (ctx) => handleStop(ctx));

async function handleStop(ctx) {
  const address = ctx.session?.watchedWallet ?? await loadWatcher(ctx.from.id);
  if (address) stopMonitoring(ctx.from.id, address);
  ctx.session ??= {};
  ctx.session.watchedWallet = null;
  ctx.session.positions = null;
  await Promise.all([deleteWatcher(ctx.from.id), clearWatchedTokens(ctx.from.id)]);
  ctx.reply('🔴 *All monitoring stopped.*\n\nUse /start to set up new guards.', { parse_mode: 'Markdown' });
}

bot.command('watch', async (ctx) => {
  ctx.session ??= {};
  ctx.session.awaitingWatchAddress = true;
  ctx.reply('Paste the wallet address you want to watch:');
});

// ─── TEXT INPUT HANDLER ───────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  ctx.session ??= {};
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  // Auto-detect contract address
  if (
    !ctx.session.awaitingPrivateKey &&
    !ctx.session.awaitingWatchAddress &&
    !ctx.session.awaitingBuyAmount &&
    !ctx.session.awaitingThreshold &&
    !ctx.session.awaitingAutoSell &&
    isContractAddress(text)
  ) {
    await handleTokenLookup(ctx, text);
    return;
  }

  // Handle private key import
  if (ctx.session.awaitingPrivateKey) {
    const keyType = ctx.session.awaitingPrivateKey;
    const rawKey = text;
    ctx.session.awaitingPrivateKey = null;
    try {
      let walletData;
      if (keyType === 'solana') { walletData = importSolanaWallet(rawKey); }
      else { walletData = importEVMWallet(rawKey); }
      await saveEncryptedKey(ctx.from.id, walletData.encrypted, keyType);
      await saveWalletAddress(ctx.from.id, walletData.address, keyType);
      if (keyType === 'solana') {
        await saveWatcher(ctx.from.id, walletData.address);
        ctx.session.watchedWallet = walletData.address;
      }
      await ctx.reply(
        `✅ *${keyType === 'solana' ? '🟣 Solana' : '🔵 EVM'} Wallet Connected*\n\nAddress: \`${walletData.address}\`\n\nFetching holdings...`,
        { parse_mode: 'Markdown' }
      );
      const positions = await getPositions(walletData.address);
      if (!positions.length) {
        return ctx.reply(
          `⚠️ *Wallet is empty*\n\nAddress: \`${walletData.address}\`\n\nFund it to get started. Use /analyze to check balance anytime.`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔐 My Wallets', 'my_wallets'), Markup.button.callback('⚡ Start Trading', 'mode_trade')]]) }
        );
      }
      ctx.session.positions = positions.slice(0, 20).map((p) => ({
        symbol: p?.attributes?.fungible_info?.symbol ?? '???',
        mint: p?.attributes?.fungible_info?.implementations?.find(i => i.chain_id === keyType)?.address ?? p?.id ?? p?.attributes?.fungible_info?.symbol,
        value: p?.attributes?.value ?? 0,
        change: p?.attributes?.changes?.percent_1d ?? 0,
        price: p?.attributes?.price ?? 0,
      }));
      await showHoldingsPicker(ctx, walletData.address);
    } catch (err) {
      console.error('[bot] Wallet import failed:', err.message);
      ctx.reply(`⚠️ *Invalid private key.*\n\n• Solana: base58 key\n• EVM: hex key starting with 0x`, { parse_mode: 'Markdown' });
    }
    return;
  }

  // Handle watch address
  if (ctx.session.awaitingWatchAddress) {
    const isSolana = !text.startsWith('0x') && text.length >= 32 && text.length <= 44;
    const isEVM = text.startsWith('0x') && text.length === 42;
    if (!isSolana && !isEVM) return ctx.reply('⚠️ Invalid address. Paste a valid Solana or EVM wallet address.');
    ctx.session.watchedWallet = text;
    ctx.session.awaitingWatchAddress = false;
    await saveWatcher(ctx.from.id, text);
    await ctx.reply('🔍 Fetching wallet holdings...');
    try {
      const positions = await getPositions(text);
      if (!positions.length) return ctx.reply('⚠️ No qualifying positions found. Try a different address.');
      ctx.session.positions = positions.slice(0, 20).map((p) => ({
        symbol: p?.attributes?.fungible_info?.symbol ?? '???',
        mint: p?.attributes?.fungible_info?.implementations?.find(i => i.chain_id === 'solana')?.address ?? p?.id ?? p?.attributes?.fungible_info?.symbol,
        value: p?.attributes?.value ?? 0,
        change: p?.attributes?.changes?.percent_1d ?? 0,
        price: p?.attributes?.price ?? 0,
      }));
      await showHoldingsPicker(ctx, text);
    } catch (err) {
      console.error('[bot] Holdings fetch failed:', err.message);
      ctx.reply('⚠️ Could not fetch wallet data. Try again.');
    }
    return;
  }

  // Handle buy amount
  if (ctx.session.awaitingBuyAmount) {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) return ctx.reply('⚠️ Enter a valid amount. Example: 0.1');
    const { mint, token } = ctx.session.pendingBuy ?? {};
    if (!mint || !token) return ctx.reply('Session expired. Paste the CA again.');
    ctx.session.awaitingBuyAmount = false;
    const estimatedTokens = (amount / token.price).toFixed(4);
    const nativeCurrency = token.nativeCurrency ?? 'SOL';
    ctx.session.pendingBuyConfirm = { mint, token, amount, estimatedTokens, nativeCurrency };
    ctx.reply(
      `⚠️ *Confirm Buy*\n\nBuying ~*${estimatedTokens} ${token.symbol}*\nSpending: *${amount} ${nativeCurrency}*\nPrice: $${Number(token.price).toFixed(8)}\n\nConfirm?`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Confirm', 'confirm_buy'), Markup.button.callback('❌ Cancel', 'cancel_buy')]]) }
    );
    return;
  }

  // Handle auto-sell stop loss
  if (ctx.session.awaitingAutoSell && ctx.session.awaitingAutoSellStage === 'stoploss') {
    const stopLoss = parseFloat(text);
    if (isNaN(stopLoss) || stopLoss <= 0 || stopLoss > 100) return ctx.reply('⚠️ Enter 1-100. Example: 20');
    ctx.session.awaitingAutoSell.stopLoss = stopLoss;
    ctx.session.awaitingAutoSellStage = 'takeprofit';
    ctx.reply(`✅ Stop loss: *${stopLoss}%*\n\nNow enter *take profit %*\n(e.g. *100* to sell when it 2x)\n\nType *0* to skip.`, { parse_mode: 'Markdown' });
    return;
  }

  // Handle auto-sell take profit
  if (ctx.session.awaitingAutoSell && ctx.session.awaitingAutoSellStage === 'takeprofit') {
    const takeProfit = parseFloat(text);
    if (isNaN(takeProfit) || takeProfit < 0) return ctx.reply('⚠️ Enter a valid number. Type 0 to skip.');
    const { mint, symbol, stopLoss, chain } = ctx.session.awaitingAutoSell;
    const address = ctx.session.watchedWallet ?? await loadWatcher(ctx.from.id);
    await addWatchedToken(ctx.from.id, { address, token: symbol, mint, threshold: stopLoss, takeProfit: takeProfit > 0 ? takeProfit : null, since: new Date().toISOString(), autoSell: true, chain });
    if (address) await scheduleMonitoring(ctx.from.id, address, ctx);
    ctx.session.awaitingAutoSell = null;
    ctx.session.awaitingAutoSellStage = null;
    ctx.reply(
      `🛡️ *Auto-Sell Active for ${symbol}*\n\nStop Loss: *${stopLoss}%* drop\n${takeProfit > 0 ? `Take Profit: *${takeProfit}%* gain` : 'Take Profit: Not set'}\n\nZenGuard is watching.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // FIX: Handle alert threshold — asks swap % if own wallet
  if (ctx.session.awaitingThreshold) {
    const input = parseFloat(text);
    if (isNaN(input) || input <= 0 || input > 100) return ctx.reply('⚠️ Enter 1-100. Example: 15');
    const { selectedToken, watchedWallet } = ctx.session;
    if (!selectedToken || !watchedWallet) return ctx.reply('Session expired. Use /start to begin again.');

    // Check if this is the user's own wallet
    const [ownSolana, ownEVM] = await Promise.all([
      loadWalletAddress(ctx.from.id, 'solana'),
      loadWalletAddress(ctx.from.id, 'evm'),
    ]);
    const isOwnWallet = watchedWallet === ownSolana || watchedWallet === ownEVM;

    if (isOwnWallet) {
      // Own wallet — ask swap percentage
      ctx.session.pendingThreshold = input;
      ctx.reply(
        `⚙️ *Protection Mode*\n\nThreshold set at *${input}%*\n\nIf triggered, how much of your *${selectedToken.symbol}* should ZenGuard auto-swap to USDC?`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[
            Markup.button.callback('25%', `swap_pct_25`),
            Markup.button.callback('50%', `swap_pct_50`),
            Markup.button.callback('100%', `swap_pct_100`),
          ]]),
        }
      );
    } else {
      // Spy wallet — alert only, no swap
      await addWatchedToken(ctx.from.id, {
        address: watchedWallet,
        token: selectedToken.symbol,
        mint: selectedToken.mint,
        threshold: input,
        since: new Date().toISOString(),
        autoSell: false,
      });
      await scheduleMonitoring(ctx.from.id, watchedWallet, ctx);
      ctx.session.awaitingThreshold = false;
      ctx.session.selectedToken = null;
      ctx.reply(
        `✅ *Alert Active*\n\n*${selectedToken.symbol}* — alert at *${input}%* move\nWallet: \`${watchedWallet.slice(0, 6)}...${watchedWallet.slice(-4)}\`\n\nZenGuard is watching. You'll be alerted immediately.`,
        { parse_mode: 'Markdown' }
      );
    }
  }
});

// ─── KEEP ALIVE ───────────────────────────────────────────────────────────────

http.createServer((req, res) => res.end('ZenGuard running.')).listen(process.env.PORT || 0);

// ─── LAUNCH ───────────────────────────────────────────────────────────────────

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));