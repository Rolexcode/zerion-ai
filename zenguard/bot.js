import 'dotenv/config';
import { Telegraf, session, Markup } from 'telegraf';
import { scheduleMonitoring } from './monitor.js';
import { getUserPolicy, setUserPolicy } from './policies.js';
import { getPortfolio, getPositions } from './utils.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.use(session());

bot.start((ctx) => {
  ctx.reply(
    `⚡ *ZenGuard* — Your autonomous onchain bodyguard.\n\n` +
    `Set your protection rules once. ZenGuard monitors your wallet 24/7 and acts before damage is done.\n\n` +
    `*Commands:*\n` +
    `/watch — Add a wallet to monitor\n` +
    `/policy — Set your protection rules\n` +
    `/status — View active guards\n` +
    `/stop — Remove a wallet from monitoring`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('watch', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const address = parts[1];

  if (!address) {
    return ctx.reply('Usage: /watch <wallet_address>');
  }

  ctx.session ??= {};
  ctx.session.watchedWallet = address;

  await scheduleMonitoring(address, ctx);
  ctx.reply(`🛡️ Watching \`${address}\`\n\nUse /policy to set your protection rules.`, {
    parse_mode: 'Markdown',
  });
});

bot.command('policy', (ctx) => {
  ctx.reply(
    '⚙️ *Set Protection Policy*\n\nChoose your guard rules:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔻 Auto-swap if drop > 20%', 'policy_drop_20')],
        [Markup.button.callback('🔻 Auto-swap if drop > 30%', 'policy_drop_30')],
        [Markup.button.callback('💵 Max spend $50/day', 'policy_spend_50')],
        [Markup.button.callback('💵 Max spend $100/day', 'policy_spend_100')],
        [Markup.button.callback('🔒 Lock to Solana only', 'policy_chain_solana')],
        [Markup.button.callback('🔒 Lock to Base only', 'policy_chain_base')],
        [Markup.button.callback('🔒 Lock to Ethereum only', 'policy_chain_ethereum')],
        [Markup.button.callback('🔒 Lock to Arbitrum only', 'policy_chain_arbitrum')],
        [Markup.button.callback('🌐 All chains — no lock', 'policy_chain_all')],
      ]),
    }
  );
});

bot.action(/policy_(.+)/, async (ctx) => {
  const rule = ctx.match[1];
  const wallet = ctx.session?.watchedWallet;

  if (!wallet) {
    return ctx.answerCbQuery('No wallet being watched. Use /watch first.');
  }

  await setUserPolicy(ctx.from.id, wallet, rule);
  await ctx.answerCbQuery('Policy set.');
  ctx.reply(`✅ Policy *${rule}* active for \`${wallet}\``, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
  const policy = await getUserPolicy(ctx.from.id);

  if (!policy) {
    return ctx.reply('No active guards. Use /watch to start monitoring a wallet.');
  }

  ctx.reply(
    `🛡️ *Active Guard*\n\n` +
    `Wallet: \`${policy.wallet}\`\n` +
    `Rule: ${policy.rule}\n` +
    `Since: ${policy.since}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('stop', (ctx) => {
  ctx.session ??= {};
  ctx.session.watchedWallet = null;
  ctx.reply('🔴 Monitoring stopped.');
});

bot.command('analyze', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const address = parts[1] ?? ctx.session?.watchedWallet;

  if (!address) {
    return ctx.reply('Usage: /analyze <wallet_address>');
  }

  await ctx.reply('🔍 Analyzing wallet...');

  try {
    const portfolio = await getPortfolio(address);
    const positions = await getPositions(address);

    const total = portfolio?.total?.positions ?? 0;
    const topPositions = positions.slice(0, 5);

    const lines = topPositions.map((p) => {
      const attr = p?.attributes ?? {};
      const value = attr?.value ?? 0;
      const change = attr?.changes?.percent_1d ?? 0;
      const symbol = attr?.fungible_info?.symbol ?? '???';
      const arrow = change >= 0 ? '📈' : '📉';
      return `${arrow} *${symbol}* — $${Number(value).toFixed(2)} (${Number(change).toFixed(1)}% 24h)`;
    });

    await ctx.reply(
      `📊 *Wallet Analysis*\n\n` +
      `\`${address.slice(0, 6)}...${address.slice(-4)}\`\n\n` +
      `💼 Total Value: *$${Number(total).toFixed(2)}*\n\n` +
      `*Top Positions:*\n${lines.length ? lines.join('\n') : 'No qualifying positions found.'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('[bot] Analyze failed:', err.message);
    ctx.reply('⚠️ Could not fetch wallet data. Check the address and try again.');
  }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));