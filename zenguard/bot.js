import 'dotenv/config';
import http from 'http';
import { Telegraf, session, Markup } from 'telegraf';
import { scheduleMonitoring, stopMonitoring } from './monitor.js';
import { getPortfolio, getPositions } from './utils.js';
import {
  saveWatcher,
  loadWatcher,
  deleteWatcher,
  addWatchedToken,
  loadWatchedTokens,
  removeWatchedToken,
  clearWatchedTokens,
} from './store.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.use(session());

// ─── START ────────────────────────────────────────────────────────────────────

bot.start((ctx) => {
  ctx.session ??= {};
  ctx.reply(
    `⚡ *Welcome to ZenGuard*\n\n` +
    `Your autonomous onchain bodyguard — powered by Zerion.\n\n` +
    `ZenGuard watches specific tokens in any wallet 24/7 and alerts you the moment something goes wrong.\n\n` +
    `*What would you like to do?*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Watch a Wallet', 'mode_watch')],
        [Markup.button.callback('📊 My Active Guards', 'show_status')],
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
    `🔍 *Watch a Wallet*\n\n` +
    `Paste any Solana or EVM wallet address.\n\n` +
    `ZenGuard will fetch the holdings and let you pick which tokens to guard.`
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

  if (!position) {
    return ctx.reply('Token not found. Use /start to begin again.');
  }

  ctx.session.selectedToken = position;
  ctx.session.awaitingThreshold = true;

  ctx.reply(
    `⚙️ *Set Alert Threshold for ${symbol}*\n\n` +
    `Current price: $${Number(position.price).toFixed(6)}\n` +
    `24h change: ${Number(position.change).toFixed(1)}%\n` +
    `Position value: $${Number(position.value).toFixed(2)}\n\n` +
    `Enter the % move that should trigger an alert.\n` +
    `Example: type *20* to alert on 20% drop or pump`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('done_picking', async (ctx) => {
  await ctx.answerCbQuery();
  const tokens = await loadWatchedTokens(ctx.from.id);

  if (!tokens.length) {
    return ctx.reply('No tokens selected yet. Tap a token from the list to set a guard.');
  }

  const lines = tokens.map(t =>
    `• *${t.token}* — alert at ${t.threshold}% move`
  );

  ctx.reply(
    `🛡️ *Active Guards*\n\n` +
    `${lines.join('\n')}\n\n` +
    `ZenGuard is monitoring 24/7. Use /status to manage.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── STATUS ───────────────────────────────────────────────────────────────────

bot.command('status', async (ctx) => showStatus(ctx));
bot.action('show_status', async (ctx) => {
  await ctx.answerCbQuery();
  showStatus(ctx);
});

async function showStatus(ctx) {
  const [tokens, address] = await Promise.all([
    loadWatchedTokens(ctx.from.id),
    loadWatcher(ctx.from.id),
  ]);

  if (!tokens.length || !address) {
    return ctx.reply(
      '🔴 No active guards.\n\nUse /start to set up wallet monitoring.',
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔍 Watch a Wallet', 'mode_watch')],
        ]),
      }
    );
  }

  const lines = tokens.map((t, i) =>
    `${i + 1}. *${t.token}* — alert at ${t.threshold}% move\n` +
    `   Since: ${new Date(t.since).toDateString()}`
  );

  ctx.reply(
    `🛡️ *ZenGuard Active*\n\n` +
    `Wallet: \`${address.slice(0, 6)}...${address.slice(-4)}\`\n\n` +
    `*Watched Tokens:*\n${lines.join('\n\n')}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add More Tokens', 'mode_watch')],
        [Markup.button.callback('📊 Analyze Wallet', 'analyze_watched')],
        [Markup.button.callback('🔴 Stop All Monitoring', 'stop_all')],
      ]),
    }
  );
}

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
      { parse_mode: 'Markdown' }
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
        return ctx.reply(
          '⚠️ No qualifying positions found in this wallet.\n\nTry a different address.'
        );
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

  // Handle custom threshold input
  if (ctx.session.awaitingThreshold) {
    const input = parseFloat(ctx.message.text);

    if (isNaN(input) || input <= 0 || input > 100) {
      return ctx.reply('⚠️ Enter a number between 1 and 100. Example: 15');
    }

    const { selectedToken, watchedWallet } = ctx.session;

    if (!selectedToken || !watchedWallet) {
      return ctx.reply('Session expired. Use /start to begin again.');
    }

    const tokenData = {
      address: watchedWallet,
      token: selectedToken.symbol,
      mint: selectedToken.mint,
      threshold: input,
      since: new Date().toISOString(),
    };

    await addWatchedToken(ctx.from.id, tokenData);
    await scheduleMonitoring(ctx.from.id, watchedWallet, ctx);

    ctx.session.awaitingThreshold = false;
    ctx.session.selectedToken = null;

    ctx.reply(
      `✅ *Guard Active*\n\n` +
      `Token: *${selectedToken.symbol}*\n` +
      `Alert threshold: *${input}%* move in 24h\n` +
      `Wallet: \`${watchedWallet.slice(0, 6)}...${watchedWallet.slice(-4)}\`\n\n` +
      `ZenGuard is watching. You'll be alerted immediately if triggered.\n\n` +
      `Use /status to manage your active guards.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ─── KEEP ALIVE ───────────────────────────────────────────────────────────────

http.createServer((req, res) => res.end('ZenGuard running.')).listen(process.env.PORT || 3000);

// ─── LAUNCH ───────────────────────────────────────────────────────────────────

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));