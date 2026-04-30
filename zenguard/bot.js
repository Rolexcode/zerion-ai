import 'dotenv/config';
import http from 'http';
import { Telegraf, session, Markup } from 'telegraf';
import { scheduleMonitoring, stopMonitoring } from './monitor.js';
import { getPortfolio, getPositions } from './utils.js';
import { importSolanaWallet, importEVMWallet, generateSolanaWallet, generateEVMWallet } from './wallet.js';
import { swapToUSDCSolana, swapToUSDCEVM, getTokenInfo } from './swapper.js';
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
    `*What ZenGuard does:*\n\n` +
    `🔐 *My Wallets* — Connect Solana and EVM wallets separately. ZenGuard auto-swaps to USDC when your rules trigger.\n\n` +
    `👁 *Spy on a Wallet* — Watch any wallet. Get instant alerts on price moves.\n\n` +
    `⚡ *Quick Trade* — Buy and sell tokens directly from Telegram.\n\n` +
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

// ─── MY WALLETS ───────────────────────────────────────────────────────────────

bot.action('my_wallets', async (ctx) => {
  await ctx.answerCbQuery();
  const { solana, evm } = await loadAllAddresses(ctx.from.id);

  const solanaStatus = solana
    ? `✅ \`${solana.slice(0, 6)}...${solana.slice(-4)}\``
    : '❌ Not connected';
  const evmStatus = evm
    ? `✅ \`${evm.slice(0, 6)}...${evm.slice(-4)}\``
    : '❌ Not connected';

  ctx.reply(
    `🔐 *My Wallets*\n\n` +
    `🟣 *Solana:* ${solanaStatus}\n` +
    `🔵 *EVM (ETH/Base/Arbitrum):* ${evmStatus}\n\n` +
    `Connect wallets to enable auto-swap protection and trading.`,
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
      `🟣 *Solana Wallet*\n\n` +
      `Connected: \`${address}\`\n\n` +
      `What would you like to do?`,
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
    ctx.reply(
      `🟣 *Solana Wallet*\n\n` +
      `No Solana wallet connected yet.\n\n` +
      `Choose an option:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📥 Import Existing', 'import_solana')],
          [Markup.button.callback('✨ Generate New', 'gen_solana')],
        ]),
      }
    );
  }
});

bot.action('manage_evm', async (ctx) => {
  await ctx.answerCbQuery();
  const address = await loadWalletAddress(ctx.from.id, 'evm');

  if (address) {
    ctx.reply(
      `🔵 *EVM Wallet*\n\n` +
      `Connected: \`${address}\`\n\n` +
      `What would you like to do?`,
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
    ctx.reply(
      `🔵 *EVM Wallet*\n\n` +
      `No EVM wallet connected yet.\n\n` +
      `Choose an option:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📥 Import Existing', 'import_evm')],
          [Markup.button.callback('✨ Generate New', 'gen_evm')],
        ]),
      }
    );
  }
});

bot.action('disconnect_solana', async (ctx) => {
  await ctx.answerCbQuery();
  await deleteEncryptedKey(ctx.from.id, 'solana');
  await redis_del_address(ctx.from.id, 'solana');
  ctx.reply('🟣 Solana wallet disconnected.');
});

bot.action('disconnect_evm', async (ctx) => {
  await ctx.answerCbQuery();
  await deleteEncryptedKey(ctx.from.id, 'evm');
  await redis_del_address(ctx.from.id, 'evm');
  ctx.reply('🔵 EVM wallet disconnected.');
});

async function redis_del_address(userId, chain) {
  const { Redis } = await import('@upstash/redis');
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  await redis.del(`zenguard:address:${chain}:${userId}`);
}

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
    `🟣 *Import Solana Wallet*\n\n` +
    `Send your base58 private key.\n\n` +
    `⚠️ Encrypted with AES-256 immediately. Never stored in plain text.\n` +
    `Delete your message after sending for extra safety.`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('import_evm', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingPrivateKey = 'evm';
  ctx.reply(
    `🔵 *Import EVM Wallet*\n\n` +
    `Send your hex private key (starts with 0x).\n\n` +
    `⚠️ Encrypted with AES-256 immediately. Never stored in plain text.\n` +
    `Delete your message after sending for extra safety.`,
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
    `✨ *New Solana Wallet Created*\n\n` +
    `Address: \`${walletData.address}\`\n\n` +
    `🔑 *Private Key — save this now, shown once only:*\n` +
    `\`${walletData.privateKey}\`\n\n` +
    `⚠️ Screenshot this and store safely.\n\n` +
    `Fund this address with SOL to start trading.`,
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
    `✨ *New EVM Wallet Created*\n\n` +
    `Address: \`${walletData.address}\`\n\n` +
    `🔑 *Private Key — save this now, shown once only:*\n` +
    `\`${walletData.privateKey}\`\n\n` +
    `${walletData.mnemonic ? `📝 *Seed Phrase:*\n\`${walletData.mnemonic}\`\n\n` : ''}` +
    `⚠️ Screenshot this and store safely.\n\n` +
    `Fund this address with ETH/MATIC/BNB to start trading.`,
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
  ctx.reply(
    `👁 *Spy on a Wallet*\n\n` +
    `Paste any Solana or EVM wallet address.\n\n` +
    `ZenGuard will fetch the holdings and let you pick which tokens to guard.`
  );
});

bot.action('mode_trade', async (ctx) => {
  await ctx.answerCbQuery();
  const { solana, evm } = await loadAllKeys(ctx.from.id);

  if (!solana && !evm) {
    return ctx.reply(
      `⚠️ *No wallets connected.*\n\n` +
      `Connect at least one wallet to start trading.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔐 My Wallets', 'my_wallets')],
        ]),
      }
    );
  }

  const walletLines = [];
  if (solana) walletLines.push(`🟣 Solana: connected`);
  if (evm) walletLines.push(`🔵 EVM: connected`);

  ctx.reply(
    `⚡ *Quick Trade*\n\n` +
    `${walletLines.join('\n')}\n\n` +
    `Commands:\n\n` +
    `*/buy <contract>* — Buy a token (chain auto-detected)\n` +
    `*/sell* — View and sell positions\n` +
    `*/positions* — View open positions with ROI\n\n` +
    `Example:\n\`/buy EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\``,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 View Positions', 'view_positions')],
      ]),
    }
  );
});

// ─── HOLDINGS PICKER ──────────────────────────────────────────────────────────

async function showHoldingsPicker(ctx, address) {
  const positions = ctx.session.positions ?? [];

  const buttons = positions.map((p) => {
    const arrow = p.change >= 0 ? '📈' : '📉';
    const label = `${arrow} ${p.symbol} — $${Number(p.value).toFixed(2)} (${Number(p.change).toFixed(1)}%)`;
    return [Markup.button.callback(label, `pick_token_${p.symbol}`)];
  });

  buttons.push([Markup.button.callback('✅ Done selecting', 'done_picking')]);

  ctx.reply(
    `💼 *Wallet Holdings*\n\n` +
    `\`${address.slice(0, 6)}...${address.slice(-4)}\`\n\n` +
    `Select the tokens you want ZenGuard to watch:\n` +
    `_(tap a token to set your alert threshold)_`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    }
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
    `⚙️ *Set Alert Threshold for ${symbol}*\n\n` +
    `Current price: $${Number(position.price).toFixed(6)}\n` +
    `24h change: ${Number(position.change).toFixed(1)}%\n` +
    `Position value: $${Number(position.value).toFixed(2)}\n\n` +
    `Enter the % drop that should trigger an alert.\n` +
    `Example: type *20* to alert on a 20% drop`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('done_picking', async (ctx) => {
  await ctx.answerCbQuery();
  const tokens = await loadWatchedTokens(ctx.from.id);

  if (!tokens.length) return ctx.reply('No tokens selected yet. Tap a token from the list to set a guard.');

  const lines = tokens.map(t => `• *${t.token}* — alert at ${t.threshold}% drop`);

  ctx.reply(
    `🛡️ *Active Guards*\n\n${lines.join('\n')}\n\nZenGuard is monitoring 24/7. Use /status to manage.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── DASHBOARD / STATUS ───────────────────────────────────────────────────────

bot.command('status', async (ctx) => showStatus(ctx));
bot.action('show_status', async (ctx) => {
  await ctx.answerCbQuery();
  showStatus(ctx);
});

async function showStatus(ctx) {
  const [tokens, { solana, evm }] = await Promise.all([
    loadWatchedTokens(ctx.from.id),
    loadAllAddresses(ctx.from.id),
  ]);

  const solanaStatus = solana ? `✅ \`${solana.slice(0, 6)}...${solana.slice(-4)}\`` : '❌ Not connected';
  const evmStatus = evm ? `✅ \`${evm.slice(0, 6)}...${evm.slice(-4)}\`` : '❌ Not connected';

  const guardLines = tokens.length
    ? tokens.map((t, i) =>
        `${i + 1}. *${t.token}* — alert at ${t.threshold}% drop\n` +
        `   Since: ${new Date(t.since).toDateString()}`
      ).join('\n\n')
    : 'No active guards yet.';

  ctx.reply(
    `📋 *My Dashboard*\n\n` +
    `🟣 Solana: ${solanaStatus}\n` +
    `🔵 EVM: ${evmStatus}\n\n` +
    `*Active Guards:*\n${guardLines}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔐 My Wallets', 'my_wallets')],
        [Markup.button.callback('➕ Add Token Guard', 'mode_watch')],
        [Markup.button.callback('⚡ Quick Trade', 'mode_trade')],
        [Markup.button.callback('📈 My Positions', 'view_positions')],
        [Markup.button.callback('🔴 Stop All Monitoring', 'stop_all')],
      ]),
    }
  );
}

// ─── TRADE — BUY ─────────────────────────────────────────────────────────────

bot.command('buy', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const mint = parts[1];

  if (!mint) {
    return ctx.reply(
      `Usage: /buy <contract_address>\n\nExample:\n\`/buy EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\``,
      { parse_mode: 'Markdown' }
    );
  }

  await ctx.reply('🔍 Fetching token info...');

  try {
    const token = await getTokenInfo(mint);
    const encryptedKey = await loadEncryptedKey(ctx.from.id, token.chain === 'solana' ? 'solana' : 'evm');

    if (!encryptedKey) {
      return ctx.reply(
        `⚠️ No ${token.chain === 'solana' ? '🟣 Solana' : '🔵 EVM'} wallet connected.\n\n` +
        `Connect one first to trade this token.`,
        {
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔐 My Wallets', 'my_wallets')],
          ]),
        }
      );
    }

    const verified = token.verified ? '✅ Verified' : '⚠️ Unverified';
    const chainLabel = token.chain === 'solana' ? '🟣 Solana' : '🔵 EVM';

    ctx.session ??= {};
    ctx.session.pendingBuy = { mint, token };
    ctx.session.awaitingBuyAmount = true;

    ctx.reply(
      `📊 *Token Info*\n\n` +
      `Name: *${token.name}* (${token.symbol})\n` +
      `Price: $${Number(token.price).toFixed(6)}\n` +
      `24h Change: ${Number(token.change24h).toFixed(1)}%\n` +
      `24h Volume: $${Number(token.volume24h).toLocaleString()}\n` +
      `Liquidity: $${Number(token.liquidity).toLocaleString()}\n` +
      `Chain: ${chainLabel}\n` +
      `Status: ${verified}\n\n` +
      `💬 How much *${token.nativeCurrency}* do you want to spend?\n` +
      `Type an amount — e.g. *0.1* for 0.1 ${token.nativeCurrency}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Cancel', 'cancel_buy')],
        ]),
      }
    );
  } catch (err) {
    console.error('[bot] Token fetch failed:', err.message);
    ctx.reply('⚠️ Could not fetch token info. Check the contract address and try again.');
  }
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

  if (!mint) return ctx.reply('Session expired. Use /buy to try again.');

  const chain = token.chain === 'solana' ? 'solana' : 'evm';
  const encryptedKey = await loadEncryptedKey(ctx.from.id, chain);

  await ctx.reply(
    `🔄 *Executing Buy*\n\n` +
    `Token: *${token.symbol}*\n` +
    `Spending: *${amount} ${nativeCurrency}*\n` +
    `Routing via Zerion...`,
    { parse_mode: 'Markdown' }
  );

  try {
    let txHash;

    if (chain === 'solana') {
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const amountLamports = Math.floor(amount * 1e9);
      txHash = await swapToUSDCSolana(encryptedKey, SOL_MINT, amountLamports);
    } else {
      const { ethers } = await import('ethers');
      const amountWei = ethers.parseEther(amount.toString());
      txHash = await swapToUSDCEVM(encryptedKey, token.chain, mint, amountWei.toString());
    }

    await savePosition(ctx.from.id, {
      mint,
      symbol: token.symbol,
      amount: estimatedTokens,
      buyPrice: token.price,
      chain: token.chain,
      nativeCurrency,
      openedAt: new Date().toISOString(),
      txHash,
    });

    ctx.session.pendingBuyConfirm = null;

    ctx.reply(
      `✅ *Buy Executed*\n\n` +
      `Bought ~${estimatedTokens} *${token.symbol}*\n` +
      `Spent: ${amount} ${nativeCurrency}\n` +
      `Tx: \`${txHash}\``,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📈 View Positions', 'view_positions')],
        ]),
      }
    );
  } catch (err) {
    console.error('[bot] Buy failed:', err.message);
    ctx.reply(`⚠️ Buy failed: ${err.message}`);
  }
});

// ─── TRADE — POSITIONS ────────────────────────────────────────────────────────

bot.command('positions', async (ctx) => showPositions(ctx));
bot.action('view_positions', async (ctx) => {
  await ctx.answerCbQuery();
  showPositions(ctx);
});

async function showPositions(ctx) {
  const positions = await loadPositions(ctx.from.id);

  if (!positions.length) {
    return ctx.reply(
      `📭 *No open positions.*\n\nUse /buy to open your first trade.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⚡ Quick Trade', 'mode_trade')]]),
      }
    );
  }

  let totalPnL = 0;

  for (const position of positions) {
    try {
      const info = await getTokenInfo(position.mint);
      const currentPrice = info.price ?? position.buyPrice;
      const roiPct = ((currentPrice - position.buyPrice) / position.buyPrice) * 100;
      const roiUSD = (currentPrice - position.buyPrice) * parseFloat(position.amount);

      totalPnL += roiUSD;

      const roiArrow = roiPct >= 0 ? '📈' : '📉';
      const roiSign = roiPct >= 0 ? '+' : '';
      const chainLabel = position.chain === 'solana' ? '🟣' : '🔵';

      await ctx.reply(
        `${roiArrow} *${position.symbol}* ${chainLabel}\n\n` +
        `Amount: ${position.amount} tokens\n` +
        `Entry: $${Number(position.buyPrice).toFixed(6)}\n` +
        `Current: $${Number(currentPrice).toFixed(6)}\n` +
        `ROI: *${roiSign}${roiPct.toFixed(2)}%* (${roiSign}$${roiUSD.toFixed(4)})\n` +
        `Opened: ${new Date(position.openedAt).toDateString()}`,
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

  const pnlSign = totalPnL >= 0 ? '+' : '';
  await ctx.reply(
    `📊 *Portfolio Summary*\n\nTotal PnL: *${pnlSign}$${totalPnL.toFixed(4)}*`,
    { parse_mode: 'Markdown' }
  );
}

// ─── TRADE — SELL ─────────────────────────────────────────────────────────────

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
    `⚠️ *Confirm Sell*\n\n` +
    `Selling *${pct}%* of your *${position.symbol}* position\n` +
    `Amount: ${sellAmount} tokens → USDC\n\n` +
    `Are you sure?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Confirm Sell', 'confirm_sell'),
          Markup.button.callback('❌ Cancel', 'cancel_sell'),
        ],
      ]),
    }
  );
});

bot.action('confirm_sell', async (ctx) => {
  await ctx.answerCbQuery();
  const { mint, pct, sellAmount, symbol, originalAmount, chain } = ctx.session?.pendingSell ?? {};

  if (!mint) return ctx.reply('Session expired. Use /sell to try again.');

  const encryptedKey = await loadEncryptedKey(ctx.from.id, chain === 'solana' ? 'solana' : 'evm');

  await ctx.reply(
    `📤 *Executing Sell...*\n\nSelling ${sellAmount} ${symbol} → USDC via Zerion`,
    { parse_mode: 'Markdown' }
  );

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
      const position = positions.find(p => p.mint === mint);
      if (position) {
        position.amount = (parseFloat(originalAmount) - parseFloat(sellAmount)).toFixed(4);
        await savePosition(ctx.from.id, position);
      }
    }

    ctx.session.pendingSell = null;

    ctx.reply(
      `✅ *Sold Successfully*\n\n` +
      `${sellAmount} ${symbol} → USDC\n` +
      `Tx: \`${txHash}\`\n\n` +
      `${pct === 100 ? 'Position fully closed.' : `Remaining: ${(parseFloat(originalAmount) - parseFloat(sellAmount)).toFixed(4)} ${symbol}`}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📈 View Positions', 'view_positions')],
        ]),
      }
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
  ctx.reply('❌ Sell cancelled.');
});

// ─── AUTO-SELL SETUP ──────────────────────────────────────────────────────────

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
    `🛡️ *Set Auto-Sell for ${position.symbol}*\n\n` +
    `ZenGuard will automatically sell 100% of this position when your rules trigger.\n\n` +
    `Enter your *stop loss %*\n(e.g. type *20* to auto-sell if it drops 20%):`,
    { parse_mode: 'Markdown' }
  );
});

// ─── ANALYZE ──────────────────────────────────────────────────────────────────

bot.action('analyze_watched', async (ctx) => {
  await ctx.answerCbQuery();
  const address = ctx.session?.watchedWallet ?? await loadWatcher(ctx.from.id);
  if (!address) return ctx.reply('No wallet found. Use /start to begin.');
  await runAnalyze(ctx, address);
});

bot.command('analyze', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const address = parts[1] ?? ctx.session?.watchedWallet ?? await loadWatcher(ctx.from.id);
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

    const lines = top.map((p) => {
      const value = p?.attributes?.value ?? 0;
      const change = p?.attributes?.changes?.percent_1d ?? 0;
      const symbol = p?.attributes?.fungible_info?.symbol ?? '???';
      const arrow = change >= 0 ? '📈' : '📉';
      return `${arrow} *${symbol}* — $${Number(value).toFixed(2)} (${Number(change).toFixed(1)}% 24h)`;
    });

    await ctx.reply(
      `📊 *Wallet Snapshot*\n\n` +
      `\`${address.slice(0, 6)}...${address.slice(-4)}\`\n\n` +
      `💼 Total Value: *$${Number(total).toFixed(2)}*\n\n` +
      `*Top Positions:*\n${lines.length ? lines.join('\n') : 'No qualifying positions found.'}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚡ Quick Trade', 'mode_trade')],
          [Markup.button.callback('📋 My Dashboard', 'show_status')],
        ]),
      }
    );
  } catch (err) {
    console.error('[bot] Analyze failed:', err.message);
    ctx.reply('⚠️ Could not fetch wallet data. Check the address and try again.');
  }
}

// ─── STOP ─────────────────────────────────────────────────────────────────────

bot.action('stop_all', async (ctx) => {
  await ctx.answerCbQuery();
  await handleStop(ctx);
});

bot.command('stop', async (ctx) => handleStop(ctx));

async function handleStop(ctx) {
  const address = ctx.session?.watchedWallet ?? await loadWatcher(ctx.from.id);
  if (address) stopMonitoring(ctx.from.id, address);

  ctx.session ??= {};
  ctx.session.watchedWallet = null;
  ctx.session.positions = null;

  await Promise.all([
    deleteWatcher(ctx.from.id),
    clearWatchedTokens(ctx.from.id),
  ]);

  ctx.reply(
    '🔴 *All monitoring stopped.*\n\nUse /start anytime to set up new guards.',
    { parse_mode: 'Markdown' }
  );
}

// ─── WATCH COMMAND ────────────────────────────────────────────────────────────

bot.command('watch', async (ctx) => {
  ctx.session ??= {};
  ctx.session.awaitingWatchAddress = true;
  ctx.reply('Paste the wallet address you want to watch:');
});

// ─── TEXT INPUT HANDLER ───────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  ctx.session ??= {};

  if (ctx.message.text.startsWith('/')) return;

  // Handle private key import
  if (ctx.session.awaitingPrivateKey) {
    const keyType = ctx.session.awaitingPrivateKey;
    const rawKey = ctx.message.text.trim();
    ctx.session.awaitingPrivateKey = null;

    try {
      let walletData;
      if (keyType === 'solana') {
        walletData = importSolanaWallet(rawKey);
      } else {
        walletData = importEVMWallet(rawKey);
      }

      await saveEncryptedKey(ctx.from.id, walletData.encrypted, keyType);
      await saveWalletAddress(ctx.from.id, walletData.address, keyType);

      if (keyType === 'solana') {
        await saveWatcher(ctx.from.id, walletData.address);
        ctx.session.watchedWallet = walletData.address;
      }

      await ctx.reply(
        `✅ *${keyType === 'solana' ? '🟣 Solana' : '🔵 EVM'} Wallet Connected*\n\n` +
        `Address: \`${walletData.address}\`\n\n` +
        `Your key is encrypted and secured.\n\n` +
        `Now fetching your holdings...`,
        { parse_mode: 'Markdown' }
      );

      const positions = await getPositions(walletData.address);

      if (!positions.length) {
        return ctx.reply(
          `⚠️ *Wallet is empty*\n\n` +
          `Address: \`${walletData.address}\`\n\n` +
          `Fund your wallet then use /analyze to check your balance.\n\n` +
          `Once funded you can:\n` +
          `• 🛡️ Set protection rules\n` +
          `• ⚡ Start trading with /buy`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔐 My Wallets', 'my_wallets')],
              [Markup.button.callback('⚡ Start Trading', 'mode_trade')],
            ]),
          }
        );
      }

      ctx.session.positions = positions.slice(0, 20).map((p) => ({
        symbol: p?.attributes?.fungible_info?.symbol ?? '???',
        mint: p?.attributes?.fungible_info?.implementations?.find(
          i => i.chain_id === keyType
        )?.address ?? p?.id ?? p?.attributes?.fungible_info?.symbol,
        value: p?.attributes?.value ?? 0,
        change: p?.attributes?.changes?.percent_1d ?? 0,
        price: p?.attributes?.price ?? 0,
      }));

      await showHoldingsPicker(ctx, walletData.address);

    } catch (err) {
      console.error('[bot] Wallet import failed:', err.message);
      ctx.reply(
        `⚠️ *Invalid private key.*\n\n` +
        `• Solana: base58 encoded key\n` +
        `• EVM: hex key starting with 0x`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  // Handle wallet address input
  if (ctx.session.awaitingWatchAddress) {
    const address = ctx.message.text.trim();
    const isSolana = address.length >= 32 && address.length <= 44;
    const isEVM = address.startsWith('0x') && address.length === 42;

    if (!isSolana && !isEVM) {
      return ctx.reply('⚠️ Invalid address. Paste a valid Solana or EVM wallet address.');
    }

    ctx.session.watchedWallet = address;
    ctx.session.awaitingWatchAddress = false;

    await saveWatcher(ctx.from.id, address);
    await ctx.reply('🔍 Fetching wallet holdings...');

    try {
      const positions = await getPositions(address);

      if (!positions.length) {
        return ctx.reply('⚠️ No qualifying positions found in this wallet.\n\nTry a different address.');
      }

      ctx.session.positions = positions.slice(0, 20).map((p) => ({
        symbol: p?.attributes?.fungible_info?.symbol ?? '???',
        mint: p?.attributes?.fungible_info?.implementations?.find(
          i => i.chain_id === 'solana'
        )?.address ?? p?.id ?? p?.attributes?.fungible_info?.symbol,
        value: p?.attributes?.value ?? 0,
        change: p?.attributes?.changes?.percent_1d ?? 0,
        price: p?.attributes?.price ?? 0,
      }));

      await showHoldingsPicker(ctx, address);
    } catch (err) {
      console.error('[bot] Holdings fetch failed:', err.message);
      ctx.reply('⚠️ Could not fetch wallet data. Try again.');
    }
    return;
  }

  // Handle buy amount input
  if (ctx.session.awaitingBuyAmount) {
    const amount = parseFloat(ctx.message.text);

    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('⚠️ Enter a valid amount. Example: 0.1');
    }

    const { mint, token } = ctx.session.pendingBuy ?? {};
    if (!mint || !token) return ctx.reply('Session expired. Use /buy to try again.');

    ctx.session.awaitingBuyAmount = false;

    const estimatedTokens = (amount / token.price).toFixed(4);
    const nativeCurrency = token.nativeCurrency ?? 'SOL';

    ctx.session.pendingBuyConfirm = { mint, token, amount, estimatedTokens, nativeCurrency };

    ctx.reply(
      `⚠️ *Confirm Buy*\n\n` +
      `Buying ~*${estimatedTokens} ${token.symbol}*\n` +
      `Spending: *${amount} ${nativeCurrency}*\n` +
      `Price: $${Number(token.price).toFixed(6)}\n\n` +
      `Are you sure?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Confirm Buy', 'confirm_buy'),
            Markup.button.callback('❌ Cancel', 'cancel_buy'),
          ],
        ]),
      }
    );
    return;
  }

  // Handle auto-sell stop loss input
  if (ctx.session.awaitingAutoSell && ctx.session.awaitingAutoSellStage === 'stoploss') {
    const stopLoss = parseFloat(ctx.message.text);

    if (isNaN(stopLoss) || stopLoss <= 0 || stopLoss > 100) {
      return ctx.reply('⚠️ Enter a number between 1 and 100. Example: 20');
    }

    ctx.session.awaitingAutoSell.stopLoss = stopLoss;
    ctx.session.awaitingAutoSellStage = 'takeprofit';

    ctx.reply(
      `✅ Stop loss set at *${stopLoss}%*\n\n` +
      `Now enter your *take profit %*\n(e.g. *100* to auto-sell when it doubles)\n\nType *0* to skip.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Handle auto-sell take profit input
  if (ctx.session.awaitingAutoSell && ctx.session.awaitingAutoSellStage === 'takeprofit') {
    const takeProfit = parseFloat(ctx.message.text);

    if (isNaN(takeProfit) || takeProfit < 0) {
      return ctx.reply('⚠️ Enter a valid number. Type 0 to skip.');
    }

    const { mint, symbol, stopLoss, chain } = ctx.session.awaitingAutoSell;
    const address = ctx.session.watchedWallet ?? await loadWatcher(ctx.from.id);

    await addWatchedToken(ctx.from.id, {
      address,
      token: symbol,
      mint,
      threshold: stopLoss,
      takeProfit: takeProfit > 0 ? takeProfit : null,
      since: new Date().toISOString(),
      autoSell: true,
      chain,
    });

    if (address) await scheduleMonitoring(ctx.from.id, address, ctx);

    ctx.session.awaitingAutoSell = null;
    ctx.session.awaitingAutoSellStage = null;

    ctx.reply(
      `🛡️ *Auto-Sell Active for ${symbol}*\n\n` +
      `Stop Loss: *${stopLoss}%* drop → auto-sell 100%\n` +
      `${takeProfit > 0 ? `Take Profit: *${takeProfit}%* gain → auto-sell 100%` : 'Take Profit: Not set'}\n\n` +
      `ZenGuard is watching.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Handle alert threshold input
  if (ctx.session.awaitingThreshold) {
    const input = parseFloat(ctx.message.text);

    if (isNaN(input) || input <= 0 || input > 100) {
      return ctx.reply('⚠️ Enter a number between 1 and 100. Example: 15');
    }

    const { selectedToken, watchedWallet } = ctx.session;

    if (!selectedToken || !watchedWallet) {
      return ctx.reply('Session expired. Use /start to begin again.');
    }

    await addWatchedToken(ctx.from.id, {
      address: watchedWallet,
      token: selectedToken.symbol,
      mint: selectedToken.mint,
      threshold: input,
      since: new Date().toISOString(),
    });

    await scheduleMonitoring(ctx.from.id, watchedWallet, ctx);

    ctx.session.awaitingThreshold = false;
    ctx.session.selectedToken = null;

    ctx.reply(
      `✅ *Guard Active*\n\n` +
      `Token: *${selectedToken.symbol}*\n` +
      `Alert threshold: *${input}%* drop in 24h\n` +
      `Wallet: \`${watchedWallet.slice(0, 6)}...${watchedWallet.slice(-4)}\`\n\n` +
      `ZenGuard is watching. You'll be alerted immediately if triggered.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ─── KEEP ALIVE ───────────────────────────────────────────────────────────────

http.createServer((req, res) => res.end('ZenGuard running.')).listen(process.env.PORT || 0);

// ─── LAUNCH ───────────────────────────────────────────────────────────────────

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));