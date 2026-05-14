import "dotenv/config";
import http from "http";
import { Telegraf, session, Markup, Input } from "telegraf";
import { scheduleMonitoring, stopMonitoring } from "./monitor.js";
import { getPortfolio, getPositions } from "./utils.js";
import {
  importSolanaWallet,
  importEVMWallet,
  generateSolanaWallet,
  generateEVMWallet,
} from "./wallet.js";
import {
  swapToUSDCSolana,
  swapToUSDCEVM,
  swapSolanaTokens,
  getEVMTokenBalance,
  getSolanaTokenBalance,
  getTokenInfo,
  isContractAddress,
} from "./swapper.js";
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
} from "./store.js";

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("[bot] TELEGRAM_BOT_TOKEN is required.");
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(session());

function normalizeSwapResult(result) {
  if (typeof result === "string") {
    return { hash: result, outputAmount: null };
  }
  return {
    hash: result?.hash,
    outputAmount: result?.outputAmount ?? null,
  };
}

function formatTokenAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value ?? "0");
  if (amount >= 1) return amount.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return amount.toPrecision(6);
}

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "$0.00";
  return `$${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: amount >= 1 ? 2 : 6,
  })}`;
}

function formatSignedUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "+$0.00";
  return `${amount >= 0 ? "+" : "-"}${formatUsd(Math.abs(amount))}`;
}

function formatHoldDuration(openedAt) {
  const started = new Date(openedAt).getTime();
  const elapsedMs = Date.now() - started;
  if (!Number.isFinite(started) || elapsedMs <= 0) return "just now";

  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getPositionPair(position) {
  const quote = position.chain === "solana" ? "SOL" : "ETH";
  return `${position.symbol}/${quote}`;
}

function getTxExplorerUrl(chain, hash) {
  if (!hash) return null;
  if (chain === "solana") return `https://solscan.io/tx/${hash}`;
  const explorers = {
    base: "https://basescan.org/tx",
    ethereum: "https://etherscan.io/tx",
    arbitrum: "https://arbiscan.io/tx",
    optimism: "https://optimistic.etherscan.io/tx",
    polygon: "https://polygonscan.com/tx",
    bsc: "https://bscscan.com/tx",
  };
  const baseUrl = explorers[chain] ?? "https://etherscan.io/tx";
  return `${baseUrl}/${hash}`;
}

function formatTxLink(chain, hash) {
  const url = getTxExplorerUrl(chain, hash);
  if (!url) return "`pending`";
  return `[${hash.slice(0, 10)}...${hash.slice(-8)}](${url})`;
}

function sizeSellAmount(amount, pct) {
  const raw = (Number(amount) * Number(pct)) / 100;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const buffer = Number(pct) >= 100 ? 0.999 : 0.995;
  return Number((raw * buffer).toPrecision(12));
}

function isDustPosition(amount, usdValue = null) {
  const tokenAmount = Number(amount);
  const value = Number(usdValue);
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) return true;
  return Number.isFinite(value) && value > 0 && value < 0.01;
}

const LIVE_BALANCE_TIMEOUT_MS = Number(process.env.LIVE_BALANCE_TIMEOUT_MS || 2500);

function withTimeout(promise, ms, label) {
  let timeoutId;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timeoutId)),
    new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);
}

async function getLivePositionAmount(userId, position) {
  if (position.chain === "solana") {
    const encryptedKey = await loadEncryptedKey(userId, "solana");
    if (!encryptedKey) return Number(position.amount);
    return Number(await getSolanaTokenBalance(encryptedKey, position.mint));
  }

  const encryptedKey = await loadEncryptedKey(userId, "evm");
  if (!encryptedKey) return Number(position.amount);
  return Number(await getEVMTokenBalance(encryptedKey, position.chain, position.mint));
}

function readableTradeError(err, { action = "trade", chain, symbol } = {}) {
  const message = err?.message || String(err);
  if (/not_enough_input_asset_balance|Input asset balance is not enough/i.test(message)) {
    return (
      `Not enough ${symbol ? `${symbol} ` : ""}balance to execute this ${action}.\n\n` +
      `ZenGuard already sizes sells below your live balance, but this position may be too small, recently sold, or held below Zerion's executable minimum.\n\n` +
      `Try *Sell 25%*, tap *Refresh*, or add a little ${chain === "solana" ? "SOL" : "ETH"} for fees.`
    );
  }
  if (/swap cannot be performed/i.test(message)) {
    return (
      `Zerion could not route this ${chain === "solana" ? "Solana" : "EVM"} token right now.\n\n` +
      `Try a more liquid token, reduce size, or try again later.`
    );
  }
  if (/No executable swap transaction/i.test(message)) {
    return (
      `Zerion returned a quote, but no executable transaction.\n\n` +
      `This usually means the balance is too low, liquidity is thin, or the route is temporarily unavailable.`
    );
  }
  return message;
}

function buildPnlChartConfig({
  isProfit,
  symbol,
  pair,
  chainName,
  currentValue,
  entryValue,
  roiPct,
  roiUSD,
  openedAt,
  duration,
}) {
  const accent = isProfit ? "#4DFF88" : "#FF5D73";
  const accentSoft = isProfit ? "rgba(77,255,136,0.15)" : "rgba(255,93,115,0.16)";
  const roiText = `${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(2)}%`;
  const gainLabel = isProfit ? "CURRENT GAIN" : "CURRENT LOSS";
  const pnlText = `${roiUSD >= 0 ? "+" : "-"}${formatUsd(Math.abs(roiUSD))}`;
  const config = `{
    type: 'bar',
    data: { labels: [''], datasets: [{ data: [0], backgroundColor: 'rgba(0,0,0,0)' }] },
    options: {
      responsive: false,
      animation: false,
      events: [],
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } }
    },
    plugins: [{
      id: 'zenguard-card',
      beforeDraw: function(chart) {
        const ctx = chart.ctx;
        const w = chart.width;
        const h = chart.height;
        const pair = ${JSON.stringify(pair ?? `${symbol}/${chainName}`)};
        const roi = ${JSON.stringify(roiText)};
        const duration = ${JSON.stringify(duration)};
        const invested = ${JSON.stringify(formatUsd(entryValue))};
        const current = ${JSON.stringify(formatUsd(currentValue))};
        const pnl = ${JSON.stringify(pnlText)};
        const opened = ${JSON.stringify(openedAt)};
        const gainLabel = ${JSON.stringify(gainLabel)};

        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#041B38');
        grad.addColorStop(0.55, '#06111F');
        grad.addColorStop(1, '#020711');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        ctx.fillStyle = ${JSON.stringify(accentSoft)};
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(w * 0.42, 0);
        ctx.lineTo(w * 0.58, 0);
        ctx.lineTo(w * 0.18, h);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(w * 0.45, 0);
        ctx.lineTo(w * 0.18, h);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        for (let i = 0; i < 7; i++) {
          const x = 70 + i * 140;
          const y = 560 - (i % 3) * 58;
          ctx.fillRect(x, y, 54, 120);
        }

        ctx.fillStyle = '#EAF4FF';
        ctx.font = '700 34px Inter, Arial';
        ctx.fillText('ZENGUARD', 760, 78);
        ctx.font = '500 20px Inter, Arial';
        ctx.fillStyle = 'rgba(234,244,255,0.72)';
        ctx.fillText('by RolextheExplorer', 760, 108);

        ctx.textAlign = 'left';
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '800 52px Inter, Arial';
        ctx.fillText(pair, 650, 210);

        ctx.fillStyle = ${JSON.stringify(accent)};
        ctx.font = '900 96px Inter, Arial';
        ctx.fillText(roi, 650, 320);

        ctx.fillStyle = 'rgba(255,255,255,0.82)';
        ctx.font = '600 26px Inter, Arial';
        ctx.fillText('Held ' + duration, 650, 365);

        ctx.fillStyle = 'rgba(255,255,255,0.62)';
        ctx.font = '700 22px Inter, Arial';
        ctx.fillText('INVESTED', 650, 455);
        ctx.fillText(gainLabel, 875, 455);
        ctx.fillText('OPENED', 650, 555);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '800 34px Inter, Arial';
        ctx.fillText(invested, 650, 497);
        ctx.fillText(pnl, 875, 497);

        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.font = '600 24px Inter, Arial';
        ctx.fillText('Current ' + current, 875, 535);
        ctx.fillText(opened, 650, 592);

        ctx.fillStyle = ${JSON.stringify(accent)};
        ctx.font = '900 38px Inter, Arial';
        ctx.fillText('ONCHAIN', 92, 120);
        ctx.fillText('POSITION', 92, 166);
        ctx.fillStyle = 'rgba(255,255,255,0.84)';
        ctx.font = '600 24px Inter, Arial';
        ctx.fillText('Autonomous exits. Scoped rules.', 92, 214);
        ctx.fillText('Routed through Zerion.', 92, 248);
      }
    }]
  }`;

  return config;
}

async function buildPnlImageFile(positionData) {
  const config = buildPnlChartConfig(positionData);

  try {
    const response = await fetch("https://quickchart.io/chart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chart: config,
        width: 1200,
        height: 675,
        format: "png",
        version: "4",
        backgroundColor: "transparent",
      }),
    });

    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";
    const isPng =
      bytes.length > 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47;

    if (contentType.includes("image/") || isPng) {
      return Input.fromBuffer(bytes, "zenguard-pnl.png");
    }

    const detail = bytes.toString("utf8", 0, Math.min(bytes.length, 240));
    if (!response.ok) {
      throw new Error(`QuickChart ${response.status}: ${detail.slice(0, 160)}`);
    }

    throw new Error(`QuickChart returned ${contentType || "unknown content"}: ${detail.slice(0, 160)}`);
  } catch (err) {
    console.error("[bot] PnL image render failed:", err.message);
    return null;
  }
}

async function replyPositionCard(ctx, { imageFile, text, keyboard, editMessageId = null }) {
  if (editMessageId && imageFile) {
    try {
      await ctx.telegram.editMessageMedia(
        ctx.chat.id,
        editMessageId,
        undefined,
        {
          type: "photo",
          media: imageFile,
          caption: text,
          parse_mode: "Markdown",
        },
        keyboard,
      );
      return { message_id: editMessageId };
    } catch (err) {
      console.error("[bot] PnL image edit failed:", err.message);
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, editMessageId, undefined, text, {
          parse_mode: "Markdown",
          ...keyboard,
        });
        return { message_id: editMessageId };
      } catch (textErr) {
        if (/message is not modified/i.test(textErr.message)) {
          return { message_id: editMessageId };
        }
        console.error("[bot] Position text edit failed:", textErr.message);
      }
    }
  }

  if (editMessageId && !imageFile) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, editMessageId, undefined, text, {
        parse_mode: "Markdown",
        ...keyboard,
      });
      return { message_id: editMessageId };
    } catch (textErr) {
      if (/message is not modified/i.test(textErr.message)) {
        return { message_id: editMessageId };
      }
      console.error("[bot] Position text edit failed:", textErr.message);
    }
  }

  try {
    if (imageFile) {
      return await ctx.replyWithPhoto(imageFile, {
        caption: text,
        parse_mode: "Markdown",
        ...keyboard,
      });
    }
  } catch (err) {
    console.error("[bot] PnL image send failed:", err.message);
  }

  return await ctx.reply(text, {
    parse_mode: "Markdown",
    ...keyboard,
  });
}

async function clearPreviousPositionMessages(ctx) {
  ctx.session ??= {};
  const ids = ctx.session?.positionMessageIds ?? [];
  ctx.session.positionMessageIds = [];

  for (const id of ids) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, id);
    } catch {
      // Message may already be gone or too old to delete.
    }
  }
}

function rememberPositionMessage(ctx, message) {
  if (!message?.message_id) return;
  ctx.session ??= {};
  ctx.session.positionMessageIds ??= [];
  ctx.session.positionMessageIds.push(message.message_id);
}

// ─── START ────────────────────────────────────────────────────────────────────

bot.start((ctx) => {
  ctx.session ??= {};
  ctx.reply(
    `⚡ *Welcome to ZenGuard*\n\n` +
      `Your autonomous onchain bodyguard — powered by Zerion.\n\n` +
      `🔐 *My Wallets* — Connect Solana and EVM wallets. ZenGuard auto-swaps to ETH when your rules trigger.\n\n` +
      `👁 *Spy on a Wallet* — Watch any wallet 24/7. Get instant alerts on price moves.\n\n` +
      `⚡ *Quick Trade* — Paste any contract address to buy. Sell with one tap.\n\n` +
      `*What would you like to do?*`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("🔐 My Wallets", "my_wallets"),
          Markup.button.callback("⚡ Quick Trade", "mode_trade"),
        ],
        [
          Markup.button.callback("👁 Spy Wallet", "mode_watch"),
          Markup.button.callback("📋 Dashboard", "show_status"),
        ],
      ]),
    },
  );
});


// ─── MY WALLETS ───────────────────────────────────────────────────────────────

bot.action("my_wallets", async (ctx) => {
  await ctx.answerCbQuery();
  const { solana, evm } = await loadAllAddresses(ctx.from.id);
  const solanaStatus = solana
    ? `✅ \`${solana.slice(0, 6)}...${solana.slice(-4)}\``
    : "❌ Not connected";
  const evmStatus = evm
    ? `✅ \`${evm.slice(0, 6)}...${evm.slice(-4)}\``
    : "❌ Not connected";
  ctx.reply(
    `🔐 *My Wallets*\n\n🟣 *Solana:* ${solanaStatus}\n🔵 *EVM (ETH/Base/BSC/Arbitrum):* ${evmStatus}\n\nConnect wallets to enable auto-swap protection and trading.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("🟣 Solana", "manage_solana"),
          Markup.button.callback("🔵 EVM", "manage_evm"),
        ],
      ]),
    },
  );
});

bot.action("manage_solana", async (ctx) => {
  await ctx.answerCbQuery();
  const address = await loadWalletAddress(ctx.from.id, "solana");
  if (address) {
    ctx.reply(
      `🟣 *Solana Wallet*\n\nConnected: \`${address}\`\n\nWhat would you like to do?`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("📊 Balance", "analyze_solana"),
            Markup.button.callback("🔄 Replace", "import_solana"),
          ],
          [Markup.button.callback("🗑 Disconnect", "disconnect_solana")],
        ]),
      },
    );
  } else {
    ctx.reply(`🟣 *Solana Wallet*\n\nNo Solana wallet connected yet.`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📥 Import", "import_solana"),
          Markup.button.callback("✨ Generate", "gen_solana"),
        ],
      ]),
    });
  }
});

bot.action("manage_evm", async (ctx) => {
  await ctx.answerCbQuery();
  const address = await loadWalletAddress(ctx.from.id, "evm");
  if (address) {
    ctx.reply(
      `🔵 *EVM Wallet*\n\nConnected: \`${address}\`\n\nWhat would you like to do?`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("📊 Balance", "analyze_evm"),
            Markup.button.callback("🔄 Replace", "import_evm"),
          ],
          [Markup.button.callback("🗑 Disconnect", "disconnect_evm")],
        ]),
      },
    );
  } else {
    ctx.reply(`🔵 *EVM Wallet*\n\nNo EVM wallet connected yet.`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📥 Import", "import_evm"),
          Markup.button.callback("✨ Generate", "gen_evm"),
        ],
      ]),
    });
  }
});

bot.action("disconnect_solana", async (ctx) => {
  await ctx.answerCbQuery();
  await deleteEncryptedKey(ctx.from.id, "solana");
  const { Redis } = await import("@upstash/redis");
  const r = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  await r.del(`zenguard:address:solana:${ctx.from.id}`);
  ctx.reply("🟣 Solana wallet disconnected.");
});

bot.action("disconnect_evm", async (ctx) => {
  await ctx.answerCbQuery();
  await deleteEncryptedKey(ctx.from.id, "evm");
  const { Redis } = await import("@upstash/redis");
  const r = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  await r.del(`zenguard:address:evm:${ctx.from.id}`);
  ctx.reply("🔵 EVM wallet disconnected.");
});

// FIX: analyze_solana and analyze_evm now use own wallet address directly
bot.action("analyze_solana", async (ctx) => {
  await ctx.answerCbQuery();
  const address = await loadWalletAddress(ctx.from.id, "solana");
  if (!address) return ctx.reply("No Solana wallet connected.");
  await runAnalyze(ctx, address);
});

bot.action("analyze_evm", async (ctx) => {
  await ctx.answerCbQuery();
  const address = await loadWalletAddress(ctx.from.id, "evm");
  if (!address) return ctx.reply("No EVM wallet connected.");
  await runAnalyze(ctx, address);
});

// ─── WALLET IMPORT & GENERATE ─────────────────────────────────────────────────

bot.action("import_solana", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingPrivateKey = "solana";
  ctx.reply(
    `🟣 *Import Solana Wallet*\n\nSend your base58 private key.\n\n⚠️ Encrypted with AES-256 immediately. Delete your message after sending.`,
    { parse_mode: "Markdown" },
  );
});

bot.action("import_evm", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingPrivateKey = "evm";
  ctx.reply(
    `🔵 *Import EVM Wallet*\n\nSend your hex private key (starts with 0x).\n\n⚠️ Encrypted with AES-256 immediately. Delete your message after sending.`,
    { parse_mode: "Markdown" },
  );
});

bot.action("gen_solana", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  const walletData = generateSolanaWallet();
  await saveEncryptedKey(ctx.from.id, walletData.encrypted, "solana");
  await saveWalletAddress(ctx.from.id, walletData.address, "solana");
  await saveWatcher(ctx.from.id, walletData.address);
  ctx.session.watchedWallet = walletData.address;
  ctx.reply(
    `✨ *New Solana Wallet Created*\n\nAddress: \`${walletData.address}\`\n\n🔑 *Private Key — save this now, shown once only:*\n\`${walletData.privateKey}\`\n\n⚠️ Screenshot and store safely. ZenGuard never stores your raw key.\n\nFund this address with SOL to start trading.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📊 Check Balance", "analyze_solana")],
        [Markup.button.callback("🔵 Connect EVM Wallet", "manage_evm")],
      ]),
    },
  );
});

bot.action("gen_evm", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  const walletData = generateEVMWallet();
  await saveEncryptedKey(ctx.from.id, walletData.encrypted, "evm");
  await saveWalletAddress(ctx.from.id, walletData.address, "evm");
  ctx.reply(
    `✨ *New EVM Wallet Created*\n\nAddress: \`${walletData.address}\`\n\n🔑 *Private Key — save this now, shown once only:*\n\`${walletData.privateKey}\`\n\n${walletData.mnemonic ? `📝 *Seed Phrase:*\n\`${walletData.mnemonic}\`\n\n` : ""}⚠️ Screenshot and store safely.\n\nFund with ETH/BNB/MATIC to start trading.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📊 Check Balance", "analyze_evm")],
        [Markup.button.callback("🟣 Connect Solana Wallet", "manage_solana")],
      ]),
    },
  );
});

// ─── MODE SELECTION ───────────────────────────────────────────────────────────

bot.action("mode_watch", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingWatchAddress = true;
  ctx.reply(
    `👁 *Spy on a Wallet*\n\nPaste any Solana or EVM wallet address.\n\nZenGuard fetches holdings and lets you pick which tokens to guard.`,
  );
});

bot.action("mode_trade", async (ctx) => {
  await ctx.answerCbQuery();
  const { solana, evm } = await loadAllKeys(ctx.from.id);
  if (!solana && !evm) {
    return ctx.reply(
      `⚠️ *No wallets connected.*\n\nConnect at least one wallet to start trading.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔐 My Wallets", "my_wallets")],
        ]),
      },
    );
  }
  const lines = [];
  if (solana) lines.push("🟣 Solana: connected");
  if (evm) lines.push("🔵 EVM: connected");
  ctx.reply(
    `⚡ *Quick Trade*\n\n${lines.join("\n")}\n\nJust paste any contract address to buy.\n\n*/sell* — manage open positions\n*/positions* — view ROI`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📊 View Positions", "view_positions")],
      ]),
    },
  );
});

// ─── HOLDINGS PICKER ──────────────────────────────────────────────────────────

async function showHoldingsPicker(ctx, address) {
  const positions = ctx.session.positions ?? [];
  if (!positions.length) {
    return ctx.reply(
      `⚠️ *No qualifying positions found.*\n\nThis wallet may be empty or hold untracked tokens.`,
      { parse_mode: "Markdown" },
    );
  }
  const buttons = positions.map((p) => {
    const arrow = p.change >= 0 ? "📈" : "📉";
    return [
      Markup.button.callback(
        `${arrow} ${p.symbol} — $${Number(p.value).toFixed(2)} (${Number(p.change).toFixed(1)}%)`,
        `pick_token_${p.symbol}`,
      ),
    ];
  });
  buttons.push([Markup.button.callback("✅ Done selecting", "done_picking")]);
  ctx.reply(
    `💼 *Wallet Holdings*\n\n\`${address.slice(0, 6)}...${address.slice(-4)}\`\n\nTap a token to set your alert threshold:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) },
  );
}

// ─── TOKEN SELECTION ──────────────────────────────────────────────────────────

bot.action(/pick_token_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  const symbol = ctx.match[1];
  const position = ctx.session.positions?.find((p) => p.symbol === symbol);
  if (!position)
    return ctx.reply("Token not found. Use /start to begin again.");
  ctx.session.selectedToken = position;
  ctx.session.awaitingThreshold = true;
  ctx.reply(
    `⚙️ *Set Alert for ${symbol}*\n\nPrice: $${Number(position.price).toFixed(6)}\n24h: ${Number(position.change).toFixed(1)}%\nValue: $${Number(position.value).toFixed(2)}\n\nEnter the % move that should trigger.\nExample: *20* = alert if drops or pumps 20%`,
    { parse_mode: "Markdown" },
  );
});

bot.action("done_picking", async (ctx) => {
  await ctx.answerCbQuery();
  const tokens = await loadWatchedTokens(ctx.from.id);
  if (!tokens.length) return ctx.reply("No tokens selected yet.");
  const lines = tokens.map(
    (t) => `• *${t.token}* — alert at ${t.threshold}% move`,
  );
  ctx.reply(
    `🛡️ *Guards Active*\n\n${lines.join("\n")}\n\nZenGuard is monitoring 24/7.`,
    { parse_mode: "Markdown" },
  );
});

// FIX: swap % selection buttons after threshold input
bot.action(/swap_pct_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  const swapPercent = parseInt(ctx.match[1]);
  const { selectedToken, watchedWallet, pendingThreshold } = ctx.session;

  if (!selectedToken || !watchedWallet || !pendingThreshold) {
    return ctx.reply("Session expired. Use /start to begin again.");
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
      `Auto-swap: *${swapPercent}%* of holdings → ETH\n` +
      `Wallet: \`${watchedWallet.slice(0, 6)}...${watchedWallet.slice(-4)}\`\n\n` +
      `ZenGuard is watching. It will execute automatically when triggered.`,
    { parse_mode: "Markdown" },
  );
});

// ─── DASHBOARD / STATUS ───────────────────────────────────────────────────────

bot.command("status", async (ctx) => showStatus(ctx));
bot.action("show_status", async (ctx) => {
  await ctx.answerCbQuery();
  showStatus(ctx);
});

async function showStatus(ctx) {
  const [tokens, { solana, evm }] = await Promise.all([
    loadWatchedTokens(ctx.from.id),
    loadAllAddresses(ctx.from.id),
  ]);
  const solanaStatus = solana
    ? `✅ \`${solana.slice(0, 6)}...${solana.slice(-4)}\``
    : "❌ Not connected";
  const evmStatus = evm
    ? `✅ \`${evm.slice(0, 6)}...${evm.slice(-4)}\``
    : "❌ Not connected";
  const guardLines = tokens.length
    ? tokens
        .map(
          (t, i) =>
            `${i + 1}. *${t.token}* — ${t.threshold}% alert${t.autoSell ? ` (auto-swap ${t.swapPercent ?? 100}%)` : ""}\n   Since: ${new Date(t.since).toDateString()}`,
        )
        .join("\n\n")
    : "No active guards yet.";
  ctx.reply(
    `📋 *My Dashboard*\n\n🟣 Solana: ${solanaStatus}\n🔵 EVM: ${evmStatus}\n\n*Guards:*\n${guardLines}`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("🔐 Wallets", "my_wallets"),
          Markup.button.callback("⚡ Trade", "mode_trade"),
        ],
        [
          Markup.button.callback("➕ Guard", "mode_watch"),
          Markup.button.callback("📈 Positions", "view_positions"),
        ],
        [Markup.button.callback("🔴 Stop All", "stop_all")],
      ]),
    },
  );
}

// ─── TOKEN INFO + BUY FLOW ────────────────────────────────────────────────────

async function handleTokenLookup(ctx, mint) {
  await ctx.reply("🔍 Fetching token info...");
  try {
    const token = await getTokenInfo(mint);
    const chainKey = token.chain === "solana" ? "solana" : "evm";
    const encryptedKey = await loadEncryptedKey(ctx.from.id, chainKey);
    if (!encryptedKey) {
      return ctx.reply(
        `⚠️ No ${token.chain === "solana" ? "🟣 Solana" : "🔵 EVM"} wallet connected.\n\nConnect one to trade this token.`,
        {
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔐 My Wallets", "my_wallets")],
          ]),
        },
      );
    }
    const verified = token.verified ? "✅ Verified" : "⚠️ Unverified";
    const chainLabel =
      token.chain === "solana"
        ? "🟣 Solana"
        : `🔵 ${token.dexChain?.toUpperCase() ?? "EVM"}`;
    const mcap =
      token.marketCap > 0
        ? `$${Number(token.marketCap).toLocaleString()}`
        : "N/A";
    const volumeToLiquidity =
      token.liquidity > 0
        ? `${((Number(token.volume24h) / Number(token.liquidity)) * 100).toFixed(1)}%`
        : "N/A";
    ctx.session ??= {};
    ctx.session.pendingBuy = { mint: token.address, token };
    ctx.session.awaitingBuyAmount = true;
    ctx.reply(
      `📊 *${token.name}* (${token.symbol})\n\n` +
        `Contract: \`${token.address.slice(0, 8)}...${token.address.slice(-6)}\`\n` +
        `Network: ${chainLabel}\n` +
        `DEX: ${token.dex ?? "unknown"}\n` +
        `Status: ${verified}\n\n` +
        `💲 Price: $${Number(token.price).toFixed(8)}\n` +
        `📈 24h Change: ${Number(token.change24h).toFixed(2)}%\n` +
        `💧 Liquidity: $${Number(token.liquidity).toLocaleString()}\n` +
        `📊 24h Volume: $${Number(token.volume24h).toLocaleString()}\n` +
        `🔁 Vol/Liq: ${volumeToLiquidity}\n` +
        `🏦 Market Cap: ${mcap}\n` +
        `Native Asset: ${token.nativeCurrency}\n\n` +
        `💬 How much *${token.nativeCurrency}* should ZenGuard spend?\n` +
        `Example: type *0.1* for 0.1 ${token.nativeCurrency}`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("🔄 Refresh Token", `refresh_token_${token.address}`),
            Markup.button.callback("❌ Cancel", "cancel_buy"),
          ],
        ]),
      },
    );
  } catch (err) {
    console.error("[bot] Token fetch failed:", err.message);
    ctx.reply("⚠️ Token not found. Check the contract address and try again.");
  }
}

bot.command("buy", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  const mint = parts[1];
  if (!mint)
    return ctx.reply(
      `Just paste a contract address directly — no command needed.`,
    );
  await handleTokenLookup(ctx, mint);
});

bot.action("cancel_buy", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.awaitingBuyAmount = false;
  ctx.session.pendingBuy = null;
  ctx.reply("❌ Buy cancelled.");
});

bot.action("confirm_buy", async (ctx) => {
  await ctx.answerCbQuery();
  const { mint, token, amount, estimatedTokens, nativeCurrency } =
    ctx.session?.pendingBuyConfirm ?? {};
  if (!mint) return ctx.reply("Session expired. Try again.");
  const chain = token.chain === "solana" ? "solana" : "evm";
  const encryptedKey = await loadEncryptedKey(ctx.from.id, chain);
  await ctx.reply(
    `🔄 *Executing Buy*\n\nToken: *${token.symbol}*\nSpending: *${amount} ${nativeCurrency}*\nRouting via Zerion...`,
    { parse_mode: "Markdown" },
  );
  try {
    let swapResult;
    if (chain === "solana") {
      swapResult = await swapSolanaTokens(
        encryptedKey,
        "SOL",
        mint,
        amount.toString(),
      );
    } else {
      const { ethers } = await import("ethers");
      const ETH_ADDRESS = 'eth';
      swapResult = await swapToUSDCEVM(
        encryptedKey,
        token.chain,
        ETH_ADDRESS,
        amount.toString(),
        mint,
      );
    }
    const { hash: txHash, outputAmount } = normalizeSwapResult(swapResult);
    const positionAmount = outputAmount ?? estimatedTokens;
    const positionValueUsd = Number(positionAmount) * Number(token.price);

    await savePosition(ctx.from.id, {
      mint,
      symbol: token.symbol,
      amount: positionAmount,
      estimatedAmount: estimatedTokens,
      buyPrice: token.price,
      entryValueUsd: positionValueUsd,
      chain: token.chain,
      nativeCurrency,
      openedAt: new Date().toISOString(),
      txHash,
    });
    ctx.session.pendingBuyConfirm = null;
    const buyPrice = Number(token.price);
    ctx.reply(
      `✅ *Buy Executed*\n\nToken: *${token.symbol}*\nChain: ${token.chain === "solana" ? "Solana" : token.chain.toUpperCase()}\nBought: ${outputAmount ? "" : "~"}${formatTokenAmount(positionAmount)} ${token.symbol}\nEntry Price: $${buyPrice.toFixed(8)}\nPosition Value: *${formatUsd(positionValueUsd)}*\nSpent: ${amount} ${nativeCurrency}\nTx: ${formatTxLink(token.chain, txHash)}`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.url("🔎 Tx", getTxExplorerUrl(token.chain, txHash)),
            Markup.button.callback("📈 Positions", "view_positions"),
          ],
        ]),
      },
    );
  } catch (err) {
    console.error("[bot] Buy failed:", err.message);
    ctx.reply(`⚠️ *Buy Failed*\n\n${readableTradeError(err, {
      action: "buy",
      chain: token?.chain,
      symbol: token?.symbol,
    })}`, { parse_mode: "Markdown" });
  }
});

bot.action(/refresh_token_(.+)/, async (ctx) => {
  await ctx.answerCbQuery("Refreshing token...");
  await handleTokenLookup(ctx, ctx.match[1]);
});

// ─── POSITIONS ────────────────────────────────────────────────────────────────

bot.command("positions", async (ctx) => showPositions(ctx));
bot.action("view_positions", async (ctx) => {
  await ctx.answerCbQuery();
  showPositions(ctx);
});
bot.action("refresh_positions", async (ctx) => {
  await ctx.answerCbQuery("Refreshing positions...");
  showPositions(ctx, { replaceList: true });
});
bot.action(/refresh_position_(.+)/, async (ctx) => {
  await ctx.answerCbQuery("Refreshing position...");
  showPositions(ctx, {
    singleMint: ctx.match[1],
    editMessageId: ctx.callbackQuery?.message?.message_id,
  });
});

bot.action(/generate_pnl_(.+)/, async (ctx) => {
  await ctx.answerCbQuery("Generating PnL card...");

  const mint = ctx.match[1];
  const positions = await loadPositions(ctx.from.id);
  const position = positions.find((p) => p.mint === mint);
  if (!position) {
    return ctx.reply("Position not found. Tap Refresh and try again.");
  }

  try {
    const info = await getTokenInfo(position.mint);
    const currentPrice = info.price ?? position.buyPrice;
    let tokenAmount = parseFloat(position.amount);
    try {
      const liveAmount = await withTimeout(
        getLivePositionAmount(ctx.from.id, position),
        LIVE_BALANCE_TIMEOUT_MS,
        "Live position balance",
      );
      if (Number.isFinite(liveAmount)) tokenAmount = liveAmount;
    } catch (err) {
      console.error(`[bot] PnL card live balance failed for ${position.symbol}:`, err.message);
    }

    const currentValue = currentPrice * tokenAmount;
    const entryValue = position.entryValueUsd ?? position.buyPrice * tokenAmount;
    const roiPct = ((currentPrice - position.buyPrice) / position.buyPrice) * 100;
    const roiUSD = currentValue - entryValue;
    const sign = roiPct >= 0 ? "+" : "";
    const chainName = position.chain === "solana" ? "Solana" : position.chain?.toUpperCase();
    const openedAt = new Date(position.openedAt).toDateString();
    const duration = formatHoldDuration(position.openedAt);
    const pair = getPositionPair(position);
    const caption =
      `📊 *${pair} PnL Card*\n\n` +
      `Invested: ${formatUsd(entryValue)}\n` +
      `Current Value: *${formatUsd(currentValue)}*\n` +
      `PnL: *${sign}${formatUsd(Math.abs(roiUSD))}*\n` +
      `ROI: *${sign}${roiPct.toFixed(2)}%*\n` +
      `Held: ${duration}\n\n` +
      `by RolextheExplorer`;

    const imageFile = await withTimeout(
      buildPnlImageFile({
        isProfit: roiUSD >= 0,
        symbol: position.symbol,
        pair,
        chainName,
        currentValue,
        entryValue,
        roiPct,
        roiUSD,
        openedAt,
        duration,
      }),
      10000,
      "PnL image render",
    );

    if (!imageFile) {
      return ctx.reply(`PnL card could not be generated right now.\n\n${caption}`, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Refresh Position", `refresh_position_${position.mint}`)],
        ]),
      });
    }

    return ctx.replyWithPhoto(imageFile, {
      caption,
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("🔄 Refresh Position", `refresh_position_${position.mint}`),
          Markup.button.callback("📈 Positions", "view_positions"),
        ],
      ]),
    });
  } catch (err) {
    console.error("[bot] PnL card failed:", err.message);
    return ctx.reply(
      `Could not generate the PnL card right now.\n\n${err.message}`,
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Refresh Position", `refresh_position_${mint}`)],
        ]),
      },
    );
  }
});

async function showPositions(ctx, { singleMint = null, editMessageId = null, replaceList = false } = {}) {
  if (!singleMint) {
    if (replaceList) {
      await clearPreviousPositionMessages(ctx);
    } else {
      ctx.session ??= {};
      ctx.session.positionMessageIds = [];
    }
  }

  const allPositions = await loadPositions(ctx.from.id);
  const positions = singleMint
    ? allPositions.filter((position) => position.mint === singleMint)
    : allPositions;
  if (!positions.length) {
    const emptyMessage = await ctx.reply(
      `📭 *No open positions.*\n\nPaste a contract address to open a trade.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("⚡ Quick Trade", "mode_trade"),
            Markup.button.callback("🔄 Refresh", "refresh_positions"),
          ],
        ]),
      },
    );
    if (!singleMint) rememberPositionMessage(ctx, emptyMessage);
    return emptyMessage;
  }
  let totalPnL = 0;
  let visiblePositions = 0;
  let removedDust = 0;
  for (const position of positions) {
    try {
      const info = await getTokenInfo(position.mint);
      const currentPrice = info.price ?? position.buyPrice;
      let tokenAmount = parseFloat(position.amount);
      try {
        const liveAmount = await withTimeout(
          getLivePositionAmount(ctx.from.id, position),
          LIVE_BALANCE_TIMEOUT_MS,
          "Live position balance",
        );
        if (Number.isFinite(liveAmount)) tokenAmount = liveAmount;
      } catch (err) {
        console.error(`[bot] Live position balance failed for ${position.symbol}:`, err.message);
      }
      const currentValue = currentPrice * tokenAmount;
      if (isDustPosition(tokenAmount, currentValue)) {
        await removePosition(ctx.from.id, position.mint);
        removedDust += 1;
        continue;
      }
      if (String(tokenAmount) !== String(position.amount)) {
        await savePosition(ctx.from.id, {
          ...position,
          amount: tokenAmount.toPrecision(12),
          lastRefreshedAt: new Date().toISOString(),
        });
      }
      const entryValue = position.entryValueUsd ?? position.buyPrice * tokenAmount;
      const roiPct =
        ((currentPrice - position.buyPrice) / position.buyPrice) * 100;
      const roiUSD = currentValue - entryValue;
      totalPnL += roiUSD;
      visiblePositions += 1;
      const arrow = roiPct >= 0 ? "📈" : "📉";
      const sign = roiPct >= 0 ? "+" : "";
      const chainLabel = position.chain === "solana" ? "🟣" : "🔵";
      const chainName = position.chain === "solana" ? "Solana" : position.chain?.toUpperCase();
      const openedAt = new Date(position.openedAt).toDateString();
      const duration = formatHoldDuration(position.openedAt);
      const pair = getPositionPair(position);
      const positionText = `${arrow} *${pair}* ${chainLabel}\n\nChain: ${chainName}\nHeld: ${duration}\nLive Amount: ${formatTokenAmount(tokenAmount)} ${position.symbol}\nInvested: ${formatUsd(entryValue)}\nCurrent Value: *${formatUsd(currentValue)}*\nEntry Price: $${Number(position.buyPrice).toFixed(8)}\nCurrent Price: $${Number(currentPrice).toFixed(8)}\nPnL: *${sign}${formatUsd(Math.abs(roiUSD))}*\nROI: *${sign}${roiPct.toFixed(2)}%*\nOpened: ${openedAt}\n\nSynced from wallet balance. Sell buttons use a small safety buffer.`;
      const positionMessage = await replyPositionCard(ctx, {
        imageFile: null,
        text: positionText,
        keyboard: {
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "Sell 25%",
                `sell_pct_${position.mint}_25`,
              ),
              Markup.button.callback(
                "Sell 50%",
                `sell_pct_${position.mint}_50`,
              ),
              Markup.button.callback(
                "Sell 100%",
                `sell_pct_${position.mint}_100`,
              ),
            ],
            [
              Markup.button.callback("📊 PnL Card", `generate_pnl_${position.mint}`),
            ],
            [
              Markup.button.callback(
                "🛡️ Auto-Sell",
                `autosell_${position.mint}`,
              ),
              Markup.button.callback("Custom %", `sell_custom_${position.mint}`),
              Markup.button.callback("🔄 Refresh", `refresh_position_${position.mint}`),
            ],
          ]),
        },
        editMessageId,
      });
      if (!singleMint) rememberPositionMessage(ctx, positionMessage);
    } catch (err) {
      console.error(
        `[bot] Price fetch failed for ${position.symbol}:`,
        err.message,
      );
    }
  }
  if (!visiblePositions) {
    if (singleMint && editMessageId) {
      try {
        await ctx.telegram.editMessageCaption(
          ctx.chat.id,
          editMessageId,
          undefined,
          `📭 *Position closed or dusted.*\n\n${removedDust ? "ZenGuard removed it from tracking." : "No live balance found."}`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback("⚡ Trade", "mode_trade"),
                Markup.button.callback("📈 Positions", "view_positions"),
              ],
            ]),
          },
        );
        return;
      } catch (err) {
        console.error("[bot] Position close edit failed:", err.message);
      }
    }
    const emptyMessage = await ctx.reply(
      `📭 *No open positions.*\n\n${removedDust ? `Removed ${removedDust} closed/dust position${removedDust === 1 ? "" : "s"} from tracking.\n\n` : ""}Paste a contract address to open a trade.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("⚡ Quick Trade", "mode_trade"),
            Markup.button.callback("🔄 Refresh", "refresh_positions"),
          ],
        ]),
      },
    );
    if (!singleMint) rememberPositionMessage(ctx, emptyMessage);
    return emptyMessage;
  }
  if (singleMint) return;
  const sign = totalPnL >= 0 ? "+" : "";
  const summaryMessage = await ctx.reply(`${removedDust ? `🧹 Removed ${removedDust} closed/dust position${removedDust === 1 ? "" : "s"}.\n\n` : ""}📊 *Portfolio PnL: ${sign}$${totalPnL.toFixed(4)}*`, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("🔄 Refresh", "refresh_positions"),
        Markup.button.callback("⚡ Trade", "mode_trade"),
      ],
    ]),
  });
  rememberPositionMessage(ctx, summaryMessage);
}

// ─── SELL ─────────────────────────────────────────────────────────────────────

bot.command("sell", async (ctx) => showPositions(ctx));

async function prepareSell(ctx, mint, pct) {
  const sellPct = Number(pct);
  if (!Number.isFinite(sellPct) || sellPct <= 0 || sellPct > 100) {
    return ctx.reply("⚠️ Enter a sell percentage from 1 to 100.");
  }
  const positions = await loadPositions(ctx.from.id);
  const position = positions.find((p) => p.mint === mint);
  if (!position) return ctx.reply("Position not found.");
  let sourceAmount = parseFloat(position.amount);
  if (position.chain === "solana") {
    try {
      const encryptedKey = await loadEncryptedKey(ctx.from.id, "solana");
      sourceAmount = parseFloat(await getSolanaTokenBalance(encryptedKey, mint));
    } catch (err) {
      console.error("[bot] Live Solana balance fetch failed:", err.message);
    }
  } else if (position.chain) {
    try {
      const encryptedKey = await loadEncryptedKey(ctx.from.id, "evm");
      sourceAmount = parseFloat(await getEVMTokenBalance(encryptedKey, position.chain, mint));
    } catch (err) {
      console.error("[bot] Live balance fetch failed:", err.message);
    }
  }
  const sellAmount = sizeSellAmount(sourceAmount, sellPct);
  if (!Number.isFinite(sellAmount) || sellAmount <= 0) {
    return ctx.reply("No sellable token balance found for this position.");
  }
  let currentPrice = Number(position.buyPrice);
  try {
    const info = await getTokenInfo(mint);
    currentPrice = Number(info.price ?? currentPrice);
  } catch (err) {
    console.error("[bot] Sell price fetch failed:", err.message);
  }
  const trackedAmount = Number(position.amount);
  const entryValue = Number(position.entryValueUsd ?? Number(position.buyPrice) * trackedAmount);
  const costBasisUsd =
    Number.isFinite(entryValue) && Number.isFinite(trackedAmount) && trackedAmount > 0
      ? (entryValue * sellAmount) / trackedAmount
      : Number(position.buyPrice) * sellAmount;
  const sellValueUsd = currentPrice * sellAmount;
  const estimatedPnlUsd = sellValueUsd - costBasisUsd;
  ctx.session ??= {};
  ctx.session.pendingSell = {
    mint,
    pct: sellPct,
    sellAmount,
    symbol: position.symbol,
    originalAmount: sourceAmount,
    chain: position.chain,
    costBasisUsd,
    sellValueUsd,
    estimatedPnlUsd,
    currentPrice,
  };
  const exitAsset = position.chain === "solana" ? "SOL" : "ETH";
  const bufferNote = sellPct >= 100 ? "100% sells request 99.9% so tiny dust is left instead of failing from rounding." : "ZenGuard leaves a tiny dust buffer so real swaps do not fail from rounding.";
  ctx.reply(
    `⚠️ *Confirm Sell*\n\nToken: *${position.symbol}*\nChain: ${position.chain === "solana" ? "Solana" : position.chain?.toUpperCase()}\nSelected: ${sellPct}%\nLive Balance: ${formatTokenAmount(sourceAmount)} ${position.symbol}\nSell Amount: ${formatTokenAmount(sellAmount)} ${position.symbol}\nExit Asset: ${exitAsset}\n\nEst. Value: *${formatUsd(sellValueUsd)}*\nCost Basis: ${formatUsd(costBasisUsd)}\nEst. PnL: *${formatSignedUsd(estimatedPnlUsd)}*\n\n${bufferNote}\n\nConfirm?`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Confirm", "confirm_sell"),
          Markup.button.callback("❌ Cancel", "cancel_sell"),
        ],
      ]),
    },
  );
}

bot.action(/sell_pct_(.+)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  return prepareSell(ctx, ctx.match[1], ctx.match[2]);
});

bot.action(/sell_custom_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const mint = ctx.match[1];
  const positions = await loadPositions(ctx.from.id);
  const position = positions.find((p) => p.mint === mint);
  if (!position) return ctx.reply("Position not found.");
  ctx.session ??= {};
  ctx.session.awaitingCustomSell = {
    mint,
    symbol: position.symbol,
  };
  ctx.reply(
    `🎚️ *Custom Sell Percentage*\n\nToken: *${position.symbol}*\n\nEnter the percentage to sell.\nExample: *12.5* sells 12.5%.\n\nUse *100* to sell almost all (99.9%) and leave tiny dust.`,
    { parse_mode: "Markdown" },
  );
});

bot.action("confirm_sell", async (ctx) => {
  await ctx.answerCbQuery();
  const {
    mint,
    pct,
    sellAmount,
    symbol,
    originalAmount,
    chain,
    costBasisUsd,
    sellValueUsd,
    estimatedPnlUsd,
  } =
    ctx.session?.pendingSell ?? {};
  if (!mint) return ctx.reply("Session expired.");
  const encryptedKey = await loadEncryptedKey(
    ctx.from.id,
    chain === "solana" ? "solana" : "evm",
  );
  const exitAsset = chain === "solana" ? "SOL" : "ETH";
  await ctx.reply(`📤 Selling ${formatTokenAmount(sellAmount)} ${symbol} → ${exitAsset}...`, {
    parse_mode: "Markdown",
  });
  try {
    let swapResult;
    if (chain === "solana" || !chain) {
      swapResult = await swapToUSDCSolana(
        encryptedKey,
        mint,
        parseFloat(sellAmount),
      );
    } else {
      swapResult = await swapToUSDCEVM(
        encryptedKey,
        chain,
        mint,
        parseFloat(sellAmount),
        "eth",
      );
    }
    const { hash: txHash } = normalizeSwapResult(swapResult);
    if (pct === 100) {
      await removePosition(ctx.from.id, mint);
    } else {
      const positions = await loadPositions(ctx.from.id);
      const pos = positions.find((p) => p.mint === mint);
      if (pos) {
        pos.amount = (
          parseFloat(originalAmount) - parseFloat(sellAmount)
        ).toPrecision(12);
        await savePosition(ctx.from.id, pos);
      }
    }
    ctx.session.pendingSell = null;
    ctx.reply(
      `✅ *Sell Executed*\n\nSold: ${formatTokenAmount(sellAmount)} *${symbol}*\nReceived: ${exitAsset}\nSold Value: *${formatUsd(sellValueUsd)}*\nBought With: ${formatUsd(costBasisUsd)}\nPnL: *${formatSignedUsd(estimatedPnlUsd)}*\nTx: ${formatTxLink(chain, txHash)}\n${pct === 100 ? "Position closed." : `Remaining: ${formatTokenAmount(parseFloat(originalAmount) - parseFloat(sellAmount))} ${symbol}`}`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.url("🔎 Tx", getTxExplorerUrl(chain, txHash)),
            Markup.button.callback("📈 Positions", "view_positions"),
          ],
        ]),
      },
    );
  } catch (err) {
    console.error("[bot] Sell failed:", err.message);
    ctx.reply(`⚠️ *Sell Failed*\n\n${readableTradeError(err, {
      action: "sell",
      chain,
      symbol,
    })}`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("Sell 25%", `sell_pct_${mint}_25`),
          Markup.button.callback("🔄 Refresh", "refresh_positions"),
        ],
      ]),
    });
  }
});

bot.action("cancel_sell", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session ??= {};
  ctx.session.pendingSell = null;
  ctx.reply("❌ Cancelled.");
});

// ─── AUTO-SELL ────────────────────────────────────────────────────────────────

bot.action(/autosell_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const mint = ctx.match[1];
  const positions = await loadPositions(ctx.from.id);
  const position = positions.find((p) => p.mint === mint);
  if (!position) return ctx.reply("Position not found.");
  ctx.session ??= {};
  ctx.session.awaitingAutoSell = {
    mint,
    symbol: position.symbol,
    chain: position.chain,
  };
  ctx.session.awaitingAutoSellStage = "stoploss";
  ctx.reply(
    `🛡️ *Auto-Sell for ${position.symbol}*\n\nZenGuard auto-sells when triggered.\n\nEnter *stop loss %*\n(e.g. *20* = sell if drops 20%):`,
    { parse_mode: "Markdown" },
  );
});

// ─── ANALYZE ──────────────────────────────────────────────────────────────────

bot.action("analyze_watched", async (ctx) => {
  await ctx.answerCbQuery();
  // FIX: use spy wallet for this action specifically
  const address =
    ctx.session?.watchedWallet ?? (await loadWatcher(ctx.from.id));
  if (!address) return ctx.reply("No wallet found. Use /start to begin.");
  await runAnalyze(ctx, address);
});

bot.command("analyze", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  // FIX: /analyze defaults to own Solana wallet, not spy wallet
  const ownSolana = await loadWalletAddress(ctx.from.id, "solana");
  const address = parts[1] ?? ownSolana ?? (await loadWatcher(ctx.from.id));
  if (!address) return ctx.reply("Usage: /analyze <wallet_address>");
  await runAnalyze(ctx, address);
});

async function runAnalyze(ctx, address) {
  await ctx.reply("🔍 Analyzing wallet...");
  try {
    // Use stored positions from Redis + DexScreener — no Zerion API calls
    const savedPositions = await loadPositions(ctx.from.id);

    if (!savedPositions.length) {
      return ctx.reply(
        `📊 *Wallet*\n\n\`${address.slice(0, 6)}...${address.slice(-4)}\`\n\n` +
          `No ZenGuard positions yet.\n\nPaste a contract address to start trading.`,
        { parse_mode: "Markdown" },
      );
    }

    let totalPnL = 0;
    const lines = [];

    for (const position of savedPositions) {
      try {
        const info = await getTokenInfo(position.mint); // DexScreener — no rate limit
        const currentPrice = info.price ?? position.buyPrice;
        const tokenAmount = parseFloat(position.amount);
        const currentValue = currentPrice * tokenAmount;
        const entryValue = position.entryValueUsd ?? position.buyPrice * tokenAmount;
        const roiPct =
          ((currentPrice - position.buyPrice) / position.buyPrice) * 100;
        const roiUSD = currentValue - entryValue;
        totalPnL += roiUSD;
        const sign = roiPct >= 0 ? "+" : "";
        const arrow = roiPct >= 0 ? "📈" : "📉";
        lines.push(
          `${arrow} *${position.symbol}* — ${formatTokenAmount(position.amount)} tokens, ${formatUsd(currentValue)} (${sign}${roiPct.toFixed(1)}%)`,
        );
      } catch {
        lines.push(`• *${position.symbol}* — price unavailable`);
      }
    }

    const pnlSign = totalPnL >= 0 ? "+" : "";
    await ctx.reply(
      `📊 *Wallet Snapshot*\n\n\`${address.slice(0, 6)}...${address.slice(-4)}\`\n\n` +
        `*Positions:*\n${lines.join("\n")}\n\n` +
        `Portfolio PnL: *${pnlSign}${formatUsd(Math.abs(totalPnL))}*`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⚡ Quick Trade", "mode_trade")],
          [Markup.button.callback("📋 Dashboard", "show_status")],
        ]),
      },
    );
  } catch (err) {
    console.error("[bot] Analyze failed:", err.message);
    ctx.reply(
      `📊 Wallet: \`${address.slice(0, 6)}...${address.slice(-4)}\`\n\nUse /positions to view your trades.`,
      { parse_mode: "Markdown" },
    );
  }
}

// ─── STOP ─────────────────────────────────────────────────────────────────────

bot.action("stop_all", async (ctx) => {
  await ctx.answerCbQuery();
  await handleStop(ctx);
});
bot.command("stop", async (ctx) => handleStop(ctx));

async function handleStop(ctx) {
  const address =
    ctx.session?.watchedWallet ?? (await loadWatcher(ctx.from.id));
  if (address) stopMonitoring(ctx.from.id, address);
  ctx.session ??= {};
  ctx.session.watchedWallet = null;
  ctx.session.positions = null;
  await Promise.all([
    deleteWatcher(ctx.from.id),
    clearWatchedTokens(ctx.from.id),
  ]);
  ctx.reply(
    "🔴 *All monitoring stopped.*\n\nUse /start to set up new guards.",
    { parse_mode: "Markdown" },
  );
}

bot.command("watch", async (ctx) => {
  ctx.session ??= {};
  ctx.session.awaitingWatchAddress = true;
  ctx.reply("Paste the wallet address you want to watch:");
});

// ─── TEXT INPUT HANDLER ───────────────────────────────────────────────────────

bot.on("text", async (ctx) => {
  ctx.session ??= {};
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  if (ctx.session.awaitingCustomSell) {
    const pct = Number(text);
    const { mint, symbol } = ctx.session.awaitingCustomSell;
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return ctx.reply("⚠️ Enter a percentage from 1 to 100. Example: 12.5");
    }
    ctx.session.awaitingCustomSell = null;
    await ctx.reply(`Preparing custom sell for *${symbol}* at *${pct}%*...`, {
      parse_mode: "Markdown",
    });
    await prepareSell(ctx, mint, pct);
    return;
  }

  // Auto-detect contract address
  if (
    !ctx.session.awaitingPrivateKey &&
    !ctx.session.awaitingWatchAddress &&
    !ctx.session.awaitingBuyAmount &&
    !ctx.session.awaitingCustomSell &&
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
      if (keyType === "solana") {
        walletData = importSolanaWallet(rawKey);
      } else {
        walletData = importEVMWallet(rawKey);
      }
      await saveEncryptedKey(ctx.from.id, walletData.encrypted, keyType);
      await saveWalletAddress(ctx.from.id, walletData.address, keyType);
      if (keyType === "solana") {
        await saveWatcher(ctx.from.id, walletData.address);
        ctx.session.watchedWallet = walletData.address;
      }
      await ctx.reply(
        `✅ *${keyType === "solana" ? "🟣 Solana" : "🔵 EVM"} Wallet Connected*\n\nAddress: \`${walletData.address}\`\n\nFetching holdings...`,
        { parse_mode: "Markdown" },
      );
      const positions = await getPositions(walletData.address);
      if (!positions.length) {
        return ctx.reply(
          `⚠️ *Wallet is empty*\n\nAddress: \`${walletData.address}\`\n\nFund it to get started. Use /analyze to check balance anytime.`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback("🔐 My Wallets", "my_wallets"),
                Markup.button.callback("⚡ Start Trading", "mode_trade"),
              ],
            ]),
          },
        );
      }
      ctx.session.positions = positions.slice(0, 20).map((p) => ({
        symbol: p?.attributes?.fungible_info?.symbol ?? "???",
        mint:
          p?.attributes?.fungible_info?.implementations?.find(
            (i) => i.chain_id === keyType,
          )?.address ??
          p?.id ??
          p?.attributes?.fungible_info?.symbol,
        value: p?.attributes?.value ?? 0,
        change: p?.attributes?.changes?.percent_1d ?? 0,
        price: p?.attributes?.price ?? 0,
      }));
      await showHoldingsPicker(ctx, walletData.address);
    } catch (err) {
      console.error("[bot] Wallet import failed:", err.message);
      ctx.reply(
        `⚠️ *Invalid private key.*\n\n• Solana: base58 key\n• EVM: hex key starting with 0x`,
        { parse_mode: "Markdown" },
      );
    }
    return;
  }

  // Handle watch address
  if (ctx.session.awaitingWatchAddress) {
    const isSolana =
      !text.startsWith("0x") && text.length >= 32 && text.length <= 44;
    const isEVM = text.startsWith("0x") && text.length === 42;
    if (!isSolana && !isEVM)
      return ctx.reply(
        "⚠️ Invalid address. Paste a valid Solana or EVM wallet address.",
      );
    ctx.session.watchedWallet = text;
    ctx.session.awaitingWatchAddress = false;
    await saveWatcher(ctx.from.id, text);
    await ctx.reply("🔍 Fetching wallet holdings...");
    try {
      const positions = await getPositions(text);
      if (!positions.length)
        return ctx.reply(
          "⚠️ No qualifying positions found. Try a different address.",
        );
      ctx.session.positions = positions.slice(0, 20).map((p) => ({
        symbol: p?.attributes?.fungible_info?.symbol ?? "???",
        mint:
          p?.attributes?.fungible_info?.implementations?.find(
            (i) => i.chain_id === "solana",
          )?.address ??
          p?.id ??
          p?.attributes?.fungible_info?.symbol,
        value: p?.attributes?.value ?? 0,
        change: p?.attributes?.changes?.percent_1d ?? 0,
        price: p?.attributes?.price ?? 0,
      }));
      await showHoldingsPicker(ctx, text);
    } catch (err) {
      console.error("[bot] Holdings fetch failed:", err.message);
      ctx.reply("⚠️ Could not fetch wallet data. Try again.");
    }
    return;
  }

  // Handle buy amount
  if (ctx.session.awaitingBuyAmount) {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0)
      return ctx.reply("⚠️ Enter a valid amount. Example: 0.1");
    const { mint, token } = ctx.session.pendingBuy ?? {};
    if (!mint || !token)
      return ctx.reply("Session expired. Paste the CA again.");
    ctx.session.awaitingBuyAmount = false;
    const estimatedTokens = (amount / token.price).toFixed(4);
    const nativeCurrency = token.nativeCurrency ?? "SOL";
    const price = Number(token.price);
    ctx.session.pendingBuyConfirm = {
      mint,
      token,
      amount,
      estimatedTokens,
      nativeCurrency,
    };
    ctx.reply(
      `⚠️ *Confirm Buy*\n\nToken: *${token.symbol}*\nChain: ${token.chain === "solana" ? "Solana" : token.chain.toUpperCase()}\nSpending: *${amount} ${nativeCurrency}*\nPrice: $${price.toFixed(8)}\nEst. Tokens: ~${formatTokenAmount(estimatedTokens)} ${token.symbol}\nSlippage: 2%\nRoute: Zerion\n\nFinal amount comes from the onchain swap receipt after execution.\n\nConfirm?`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Confirm", "confirm_buy"),
            Markup.button.callback("❌ Cancel", "cancel_buy"),
          ],
        ]),
      },
    );
    return;
  }

  // Handle auto-sell stop loss
  if (
    ctx.session.awaitingAutoSell &&
    ctx.session.awaitingAutoSellStage === "stoploss"
  ) {
    const stopLoss = parseFloat(text);
    if (isNaN(stopLoss) || stopLoss <= 0 || stopLoss > 100)
      return ctx.reply("⚠️ Enter 1-100. Example: 20");
    ctx.session.awaitingAutoSell.stopLoss = stopLoss;
    ctx.session.awaitingAutoSellStage = "takeprofit";
    ctx.reply(
      `✅ Stop loss: *${stopLoss}%*\n\nNow enter *take profit %*\n(e.g. *100* to sell when it 2x)\n\nType *0* to skip.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  // Handle auto-sell take profit
  if (
    ctx.session.awaitingAutoSell &&
    ctx.session.awaitingAutoSellStage === "takeprofit"
  ) {
    const takeProfit = parseFloat(text);
    if (isNaN(takeProfit) || takeProfit < 0)
      return ctx.reply("⚠️ Enter a valid number. Type 0 to skip.");
    const { mint, symbol, stopLoss, chain } = ctx.session.awaitingAutoSell;
    const address =
      ctx.session.watchedWallet ?? (await loadWatcher(ctx.from.id));
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
      `🛡️ *Auto-Sell Active for ${symbol}*\n\nStop Loss: *${stopLoss}%* drop\n${takeProfit > 0 ? `Take Profit: *${takeProfit}%* gain` : "Take Profit: Not set"}\n\nZenGuard is watching.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  // FIX: Handle alert threshold — asks swap % if own wallet
  if (ctx.session.awaitingThreshold) {
    const input = parseFloat(text);
    if (isNaN(input) || input <= 0 || input > 100)
      return ctx.reply("⚠️ Enter 1-100. Example: 15");
    const { selectedToken, watchedWallet } = ctx.session;
    if (!selectedToken || !watchedWallet)
      return ctx.reply("Session expired. Use /start to begin again.");

    // Check if this is the user's own wallet
    const [ownSolana, ownEVM] = await Promise.all([
      loadWalletAddress(ctx.from.id, "solana"),
      loadWalletAddress(ctx.from.id, "evm"),
    ]);
    const isOwnWallet = watchedWallet === ownSolana || watchedWallet === ownEVM;

    if (isOwnWallet) {
      // Own wallet — ask swap percentage
      ctx.session.pendingThreshold = input;
      ctx.reply(
        `⚙️ *Protection Mode*\n\nThreshold set at *${input}%*\n\nIf triggered, how much of your *${selectedToken.symbol}* should ZenGuard auto-swap to ETH?`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback("25%", `swap_pct_25`),
              Markup.button.callback("50%", `swap_pct_50`),
              Markup.button.callback("100%", `swap_pct_100`),
            ],
          ]),
        },
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
        { parse_mode: "Markdown" },
      );
    }
  }
});

// ─── HTTP + TELEGRAM LAUNCH ───────────────────────────────────────────────────

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || "/telegram-webhook";
const webhookCallback = bot.webhookCallback(WEBHOOK_PATH);

const server = http.createServer((req, res) => {
  if (PUBLIC_URL && req.url?.startsWith(WEBHOOK_PATH)) {
    return webhookCallback(req, res);
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ZenGuard running.");
});

await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`[bot] HTTP server listening on port ${PORT}.`);

async function launchBot() {
  if (PUBLIC_URL) {
    const webhookUrl = `${PUBLIC_URL}${WEBHOOK_PATH}`;
    await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: true });
    console.log(`[bot] ZenGuard webhook registered at ${webhookUrl}`);
    return;
  }

  await bot.launch({ dropPendingUpdates: true });
  console.log("[bot] ZenGuard polling started.");
}

try {
  await launchBot();
} catch (err) {
  console.error("[bot] Launch failed:", err.message);
  process.exit(1);
}
function shutdown(signal) {
  try {
    if (bot.polling || bot.webhookServer) {
      bot.stop(signal);
    }
  } catch (err) {
    if (err.message !== "Bot is not running!") {
      console.error(`[bot] Stop failed during ${signal}:`, err.message);
    }
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  }
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
