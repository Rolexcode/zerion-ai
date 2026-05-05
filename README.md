# ZenGuard — Autonomous Onchain Bodyguard

> **Zerion CLI Hackathon Submission** | Frontier Track | Superteam Earn  
> Built on top of the [Zerion CLI](https://github.com/zeriontech/zerion-ai)

---

## The Problem

Crypto traders lose money while sleeping.

A token drops 40% overnight. A whale dumps. A rug pull happens at 3am. By the time you check your phone, it's too late. Manual monitoring is exhausting and impossible to sustain — and no existing tool combines real-time wallet protection, autonomous execution, and a simple Telegram interface in one place.

---

## The Solution

**ZenGuard** is an autonomous onchain agent that watches your wallets 24/7 and executes protective swaps to USDC the moment your rules trigger — without you lifting a finger.

It runs entirely in Telegram. No app to install. No dashboard to check. Just set your rules and let ZenGuard guard your portfolio.

---

## What ZenGuard Does

### 🔐 Protection Mode
Connect your Solana or EVM wallet. Set a threshold — say, 20% drop on any token. If that token moves beyond your threshold in either direction — a 20% drop triggers a protective swap to USDC; a 100% pump triggers a take-profit exit. You define both limits independently, ZenGuard automatically swaps your chosen percentage (25%, 50%, or 100%) to USDC. Your capital is protected before you even wake up.

### 👁 Surveillance Mode
Watch any public wallet on Solana or EVM chains. ZenGuard fetches live holdings and lets you pick which tokens to monitor. When the threshold triggers, you get an instant Telegram alert — price, change, wallet address, and direct action buttons.

### ⚡ Quick Trade
Paste any contract address — Solana or EVM — directly into the chat. ZenGuard auto-detects the chain, pulls accurate market data from DexScreener, and walks you through a buy in under 30 seconds. Track all positions with live ROI. Close them with one tap.

---

## How It Uses the Zerion CLI

ZenGuard is built **on top of the forked Zerion CLI** as required by the hackathon track.

The core swap routing imports `getSwapQuote` directly from the CLI's own library:

```javascript
// zenguard/swapper.js
import { getSwapQuote } from '../cli/lib/trading/swap.js';

const quote = await getSwapQuote({
  fromToken: fromMint,
  toToken: toMint,
  amount: String(amount),
  fromChain: 'solana',
  toChain: 'solana',
  walletAddress,
});
```

This means every swap quote — for both buy execution and protection mode auto-swaps — routes through the Zerion CLI's own token resolution, API parameter handling, and slippage logic. The CLI is the execution layer, not a wrapper.

Confirmed working in production logs:
```
[swapper] Using Zerion CLI getSwapQuote — Solana buy
[swapper] Using Zerion CLI getSwapQuote — EVM
```

---

## Scoped Policies

ZenGuard implements multiple scoped policies that constrain agent behavior:

| Policy | Implementation |
|---|---|
| **Chain lock** | Token guards are chain-specific — a Solana guard only executes Solana swaps |
| **Spend limit** | User sets exact swap percentage (25/50/100%) before any auto-execution |
| **Threshold guard** | Agent only acts when price change exceeds user-defined % — never on normal volatility |
| **Take profit** | Optional upper bound — auto-sells if token pumps above target % |
| **Cooldown policy** | 1-hour cooldown per token after any trigger — prevents API hammering and repeated execution |
| **Ownership check** | Auto-swap only executes on wallets the user owns — spy mode is alert-only, never executes |
| **Address validation** | Strict regex validation on all addresses before any operation (Solana base58, EVM hex) |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Telegram Interface                  │
│              (Telegraf v4 + inline buttons)          │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                    bot.js                           │
│   Session management, command routing, UX flow      │
└──────┬──────────────┬─────────────────┬─────────────┘
       │              │                 │
┌──────▼──────┐ ┌─────▼──────┐ ┌───────▼──────┐
│  swapper.js  │ │ monitor.js │ │   store.js   │
│             │ │            │ │              │
│ Zerion CLI  │ │ node-cron  │ │ Upstash Redis│
│ getSwapQuote│ │ 5min checks│ │ AES-256 keys │
│ DexScreener │ │ 1hr cooldown│ │ Per-chain    │
│ token data  │ │ Own vs spy  │ │ wallet storage│
└──────┬──────┘ └─────┬──────┘ └──────────────┘
       │              │
┌──────▼──────────────▼──────────────────────────────┐
│              Zerion CLI (forked)                    │
│         cli/lib/trading/swap.js                     │
│    getSwapQuote → Zerion API → transaction          │
└─────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ES Modules) |
| Bot framework | Telegraf v4 |
| Chains | Solana + EVM (Ethereum, Base, Arbitrum, Polygon, BSC, Optimism) |
| Swap routing | Zerion CLI `getSwapQuote` (forked from zeriontech/zerion-ai) |
| Token data | DexScreener API (real-time price, volume, liquidity, market cap) |
| Key storage | AES-256 encryption, per-chain, in Upstash Redis |
| Persistence | Upstash Redis |
| Monitoring | node-cron (5-minute intervals, 1-hour cooldowns) |
| Deployment | Render (Linux, auto-deploy from GitHub) |
| Uptime | UptimeRobot (5-minute ping interval) |

---

## Key Design Decisions

**Per-chain wallet isolation** — Solana and EVM wallets are stored separately (`zenguard:key:solana:userId` and `zenguard:key:evm:userId`). A user can connect both independently. The agent automatically selects the correct wallet based on token chain.

**DexScreener for token data** — Zerion's fungibles endpoint aggregates across chains which produces stale volume and liquidity data for newer tokens. DexScreener returns pair-level data that matches what traders see on DEX dashboards. Swap execution still routes through Zerion CLI.

**Surveillance vs Protection separation** — The monitor checks wallet ownership before any execution. If the watched address is not the user's own wallet, it fires an alert only. Auto-swap never executes on someone else's wallet.

**Fail-closed policy enforcement** — If a swap fails (API error, insufficient balance, policy violation), the cooldown is extended and the user is notified immediately. The agent never silently retries — every action is logged and reported.

---

## Installation

### Prerequisites
- Node.js 18+
- Upstash Redis account
- Zerion API key (from [dashboard.zerion.io](https://dashboard.zerion.io))
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))

### Setup

```bash
# Clone the repo
git clone https://github.com/Rolexcode/zerion-ai
cd zerion-ai

# Install dependencies
npm install

# Configure environment
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ZERION_API_KEY=zk_dev_your_zerion_api_key
UPSTASH_REDIS_REST_URL=https://your-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_token
ENCRYPTION_KEY=your_32_character_encryption_key
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

```bash
# Start the bot
npm start
```

### Deploy to Render

1. Fork this repo
2. Create a new Web Service on [render.com](https://render.com)
3. Connect your GitHub repo
4. Add environment variables in Render dashboard
5. Deploy — bot goes live automatically

---

## Usage

### Protect Your Wallet
1. Open the bot → **My Wallets** → **Manage Solana Wallet**
2. Import existing wallet or generate a new one
3. **Spy on a Wallet** → paste your funded wallet address
4. Select a token → enter threshold % (e.g. 20)
5. Choose auto-swap amount (25% / 50% / 100%)
6. ZenGuard watches 24/7 and executes when triggered

### Trade
1. Paste any contract address directly in chat
2. Bot auto-detects chain, shows live token data
3. Enter amount → confirm → swap executes via Zerion CLI
4. View positions with live ROI at any time

### Surveillance
1. **Spy on a Wallet** → paste any public wallet address
2. Select tokens to watch → set alert thresholds
3. Receive instant Telegram alerts on price moves

---

## Security

- Private keys are encrypted with AES-256 immediately upon receipt
- Raw keys are never stored or logged
- Keys are stored per-chain, per-user in Upstash Redis
- All addresses are validated with strict regex before any operation
- Solana: `[1-9A-HJ-NP-Za-km-z]{32,44}` (base58)
- EVM: `0x[0-9a-fA-F]{40}` (checksummed hex)
- Bot recommends users delete private key messages immediately after sending

---

## Live Demo

**Bot:** [@zerionautonomousbot](https://t.me/zerionautonomousbot)
**Deployment:** [https://zerion-ai-gt22.onrender.com](https://zerion-ai-gt22.onrender.com)

---

## Repository

Built on top of the official Zerion CLI fork:  
[github.com/Rolexcode/zerion-ai](https://github.com/Rolexcode/zerion-ai)

---

## License

MIT