import 'dotenv/config';
import { Telegraf, session, Markup } from 'telegraf';
import { scheduleMonitoring, stopMonitoring } from './monitor.js';
import { getUserPolicy, setUserPolicy, evaluatePolicy } from './policies.js';
import { getPortfolio, getPositions } from './utils.js';
import { saveWatcher, loadWatcher, deleteWatcher, savePolicy } from './store.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.use(session());

// ─── START ───────────────────────────────────────────────────────────────────

bot.start((ctx) => {
  ctx.session ??= {};
  ctx.reply(
    `⚡ *Welcome to ZenGuard*\n\n` +
    `Your autonomous onchain bodyguard — powered by Zerion.\n\n` +
    `ZenGuard watches crypto wallets 24/7 and alerts you the moment something goes wrong. ` +
    `Set your rules once. We handle the rest.\n\n` +
    `*What would you like to do?*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🛡️ Protect My Wallet', 'mode_protect')],
        [Markup.button.callback('🔍 Watch Any Wallet', 'mode_watch')],
      ]),
    }
  );
});

// ─── MODE SELECTION ───────────────────────────────────────────────────────────

bot.action('mode_protect', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    `🛡️ *Protection Mode*\n\n` +
    `ZenGuard will monitor your wallet and automatically swap to USDC if your rules are triggered.\n\n` +
    `Your private key is encrypted and never stored in plain text. ` +
    `All trades route through Zerion with spend limits you control.\n\n` +
    `*Do you have an existing wallet?*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📥 Import My Wallet', 'wallet_import')],
        [Markup.button.callback('✨ Create New Wallet', 'wallet_create')],
      ]),
    }
  );
});

bot.action('mode_watch', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingWatchAddress = true;
  ctx.reply(
    `🔍 *Surveillance Mode*\n\n` +
    `Watch any public wallet — a dev wallet, a whale, or your own.\n\n` +
    `ZenGuard will alert you instantly when:\n` +
    `• Token prices drop sharply\n` +
    `• Funds move to unexpected chains\n` +
    `• Spend limits are breached\n\n` +
    `Paste the wallet address you want to watch:`
  );
});

// ─── WALLET SETUP ─────────────────────────────────────────────────────────────

bot.action('wallet_import', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingImport = true;
  ctx.reply(
    `📥 *Import Wallet*\n\n` +
    `Send your Solana wallet address to begin.\n\n` +
    `⚠️ ZenGuard only needs your *public address* for monitoring.\n` +
    `Private key setup is handled securely via Zerion agent tokens — never stored here.`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('wallet_create', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    `✨ *Create New Wallet*\n\n` +
    `This feature is coming soon.\n\n` +
    `For now, use *Import My Wallet* with your existing Solana address.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📥 Import Instead', 'wallet_import')],
      ]),
    }
  );
});

// ─── TEXT INPUT HANDLER ───────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  ctx.session ??= {};

  // Handle watch address input
  if (ctx.session.awaitingWatchAddress || ctx.session.awaitingImport) {
    const address = ctx.message.text.trim();

    if (address.startsWith('/')) return;

    const isSolana = address.length >= 32 && address.length <= 44;
    const isEVM = address.startsWith('0x') && address.length === 42;

    if (!isSolana && !isEVM) {
      return ctx.reply(
        '⚠️ That doesn\'t look like a valid wallet address.\n\nPaste a Solana or EVM address.'
      );
    }

    ctx.session.watchedWallet = address;
    ctx.session.awaitingWatchAddress = false;
    ctx.session.awaitingImport = false;

    await saveWatcher(ctx.from.id, address);
    await scheduleMonitoring(address, ctx);

    const mode = ctx.session.awaitingImport ? '🛡️ Protection' : '🔍 Surveillance';

    ctx.reply(
      `✅ *Wallet Added*\n\n` +
      `\`${address.slice(0, 6)}...${address.slice(-4)}\`\n` +
      `Mode: ${mode}\n\n` +
      `Now set your guard rules:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Set Protection Rules', 'show_policy')],
        ]),
      }
    );
    return;
  }

  // Handle custom policy input
  if (ctx.session.awaitingCustomPolicy) {
    const input = parseFloat(ctx.message.text);

    if (isNaN(input) || input <= 0 || input > 100) {
      return ctx.reply('⚠️ Enter a number between 1 and 100. Example: 15');
    }

    const wallet = ctx.session.watchedWallet ?? await loadWatcher(ctx.from.id);

    if (!wallet) {
      return ctx.reply('No wallet found. Use /start to begin.');
    }

    const data = {
      wallet,
      rule: `drop_${input}`,
      config: {
        label: `Alert if drop > ${input}%`,
        dropThreshold: input / 100,
        spendLimit: null,
        chainLock: null,
      },
      since: new Date().toISOString(),
      dailySpend: 0,
      lastReset: Date.now(),
    };

    await savePolicy(ctx.from.id, data);
    ctx.session.awaitingCustomPolicy = false;

    ctx.reply(
      `✅ *Custom rule saved*\n\n` +
      `ZenGuard will alert you if any position drops more than *${input}%* in 24h.\n\n` +
      `Use /status to view your active guard.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ─── POLICY ───────────────────────────────────────────────────────────────────

bot.action('show_policy', (ctx) => {
  ctx.answerCbQuery();
  showPolicyMenu(ctx);
});

bot.command('policy', (ctx) => showPolicyMenu(ctx));

function showPolicyMenu(ctx) {
  ctx.reply(
    `⚙️ *Set Guard Rules*\n\n` +
    `Choose what triggers ZenGuard:\n\n` +
    `🔻 *Drop alerts* — notify when a token drops sharply\n` +
    `💵 *Spend limits* — alert if daily spend exceeds limit\n` +
    `🔒 *Chain lock* — alert if funds move to another chain`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔻 Alert if drop > 20%', 'policy_drop_20')],
        [Markup.button.callback('🔻 Alert if drop > 30%', 'policy_drop_30')],
        [Markup.button.callback('✏️ Custom drop threshold', 'policy_custom')],
        [Markup.button.callback('💵 Spend limit $50/day', 'policy_spend_50')],
        [Markup.button.callback('💵 Spend limit $100/day', 'policy_spend_100')],
        [Markup.button.callback('🔒 Lock to Solana only', 'policy_chain_solana')],
        [Markup.button.callback('🔒 Lock to Base only', 'policy_chain_base')],
        [Markup.button.callback('🔒 Lock to Ethereum only', 'policy_chain_ethereum')],
        [Markup.button.callback('🔒 Lock to Arbitrum only', 'policy_chain_arbitrum')],
        [Markup.button.callback('🌐 All chains — no lock', 'policy_chain_all')],
      ]),
    }
  );
}

bot.action(/policy_((?!custom).+)/, async (ctx) => {
  const rule = ctx.match[1];
  const wallet = ctx.session?.watchedWallet ?? await loadWatcher(ctx.from.id);

  if (!wallet) {
    return ctx.answerCbQuery('No wallet found. Use /start to begin.');
  }

  await setUserPolicy(ctx.from.id, wallet, rule);
  await ctx.answerCbQuery('Rule saved.');

  const policy = await getUserPolicy(ctx.from.id);

  ctx.reply(
    `✅ *Rule saved*\n\n` +
    `${policy.config.label}\n\n` +
    `ZenGuard is now watching \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\`\n\n` +
    `Use /status to view your guard anytime.`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('policy_custom', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingCustomPolicy = true;
  ctx.reply(
    `✏️ *Custom Drop Threshold*\n\n` +
    `Enter the % drop that should trigger an alert.\n\n` +
    `Example: type *15* for 15% drop`,
    { parse_mode: 'Markdown' }
  );
});

// ─── STATUS ───────────────────────────────────────────────────────────────────

bot.command('status', async (ctx) => {
  const [policy, address] = await Promise.all([
    getUserPolicy(ctx.from.id),
    loadWatcher(ctx.from.id),
  ]);

  if (!policy || !address) {
    return ctx.reply(
      '🔴 No active guards.\n\nUse /start to set up wallet monitoring.',
    );
  }

  ctx.reply(
    `🛡️ *ZenGuard Active*\n\n` +
    `Wallet: \`${address.slice(0, 6)}...${address.slice(-4)}\`\n` +
    `Rule: ${policy.config.label}\n` +
    `Monitoring since: ${new Date(policy.since).toUTCString()}\n\n` +
    `Checks run every minute. You'll be alerted immediately if rules are triggered.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⚙️ Change Rules', 'show_policy')],
        [Markup.button.callback('📊 Analyze Wallet', 'analyze_watched')],
        [Markup.button.callback('🔴 Stop Monitoring', 'stop_monitoring')],
      ]),
    }
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
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('[bot] Analyze failed:', err.message);
    ctx.reply('⚠️ Could not fetch wallet data. Check the address and try again.');
  }
}

// ─── STOP ─────────────────────────────────────────────────────────────────────

bot.action('stop_monitoring', async (ctx) => {
  await ctx.answerCbQuery();
  await handleStop(ctx);
});

bot.command('stop', async (ctx) => handleStop(ctx));

async function handleStop(ctx) {
  const address = ctx.session?.watchedWallet ?? await loadWatcher(ctx.from.id);
  if (address) stopMonitoring(address);

  ctx.session ??= {};
  ctx.session.watchedWallet = null;

  await deleteWatcher(ctx.from.id);
  ctx.reply(
    '🔴 *Monitoring stopped.*\n\nUse /start anytime to set up a new guard.',
    { parse_mode: 'Markdown' }
  );
}

// ─── WATCH COMMAND (direct) ───────────────────────────────────────────────────

bot.command('watch', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const address = parts[1];

  if (!address) {
    return ctx.reply('Usage: /watch <wallet_address>');
  }

  ctx.session ??= {};
  ctx.session.watchedWallet = address;

  await saveWatcher(ctx.from.id, address);
  await scheduleMonitoring(address, ctx);

  ctx.reply(
    `🛡️ Watching \`${address}\`\n\nUse /policy to set your protection rules.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── LAUNCH ───────────────────────────────────────────────────────────────────
// Keep Render web service alive
import http from 'http';
http.createServer((req, res) => res.end('ZenGuard running.')).listen(process.env.PORT || 3000);

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));