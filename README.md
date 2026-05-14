# ZenGuard — Autonomous Onchain Bodyguard

> **Zerion CLI Frontier Hackathon** | Superteam Earn  
> *The user decides the rules. The agent acts inside them.*

Crypto markets don't sleep. A token rugs at 3am. A whale dumps while you're at work. By the time you check your phone, the exit has closed. Most protection tools alert you after the damage is done.

ZenGuard closes that gap — combining wallet custody, token discovery, real swap execution, and policy-scoped automation in one Telegram interface. It is not a simulation. It signs and broadcasts real transactions onchain.

**Live bot:** [@zerionautonomousbot](https://t.me/zerionautonomousbot)  
**Repository:** [github.com/Rolexcode/zerion-ai](https://github.com/Rolexcode/zerion-ai)

---

## Live Execution Proof

ZenGuard has executed a real Base mainnet swap through the full bot flow.

| Field | Value |
|---|---|
| Network | Base |
| Action | ETH → VIRTUAL |
| Paid | 0.0006 ETH |
| Received | 1.662036 VIRTUAL |
| Transaction | `312b64bb97e40d9ef4bea5b54b383f840e8cc427988e286da1cca460539fd17d` |
| Wallet | `0xa7dD55EDE00dEC31e44AFFd404f1Ddcb1E8FB106` |
| Route | Zerion CLI quote → signed by user wallet → broadcast onchain |

Production logs confirm the forked CLI preparing Zerion swap quote params — `from`, `to`, `input[chain_id]`, `input[fungible_id]`, `input[amount]`, `output[chain_id]`, `output[fungible_id]`, `slippage_percent` — before signing and broadcasting.

---

## What ZenGuard Does

### 1. Real Onchain Swaps
Paste any contract address into Telegram. ZenGuard fetches live market data, shows price, liquidity, volume and market cap, asks how much to spend, confirms, then executes a real swap through Zerion CLI.

- **Base/EVM buy:** ETH → token
- **Base/EVM sell:** token → ETH
- **Solana buy:** SOL → token
- **Solana sell:** token → SOL
- EVM swaps handle Zerion approval transactions automatically before the final swap
- The onchain transaction hash is returned to the user in Telegram

### 2. Position Tracking
After a buy, ZenGuard stores a tracked position with:

- Token symbol and contract/mint address
- Chain
- Actual output amount parsed from transaction receipt logs (estimated as fallback)
- Entry price and entry USD value
- Current price and current USD value
- ROI percentage and dollar PnL
- Opened timestamp

### 3. Manual Sell Flow
Every tracked position shows one-tap sell controls:

- **Sell 25%**
- **Sell 50%**
- **Sell 100%**

For EVM positions, ZenGuard checks the live ERC-20 wallet balance before sizing the sell — preventing stale data issues if tokens were moved outside the bot.

### 4. Autonomous Protection Mode
Users set a stop-loss and take-profit percentage for any tracked token. ZenGuard monitors price and executes a scoped sell when the rule triggers.

**Protection controls:**
- Chain-scoped execution
- Token-scoped execution
- Percentage-based stop-loss and take-profit
- Sell size limited to 25%, 50%, or 100%
- Live balance check before EVM auto-sells
- Exits to native asset: ETH on EVM, SOL on Solana

**Example policy:**  
Token: VIRTUAL on Base | Stop loss: 20% | Take profit: 100% | Sell: 50%

If triggered, ZenGuard sells exactly that scoped amount of that scoped token. It cannot freely drain unrelated assets.

### 5. Surveillance Mode
Watch any public wallet 24/7. ZenGuard fetches holdings and sends instant Telegram alerts on price moves. Since the agent doesn't hold a public wallet's private key, it alerts only — it never executes.

- **Own wallet:** alerts + optional auto-sell
- **Public wallet:** alerts only

### 6. Telegram-First UX
- `/start` onboarding
- Wallet create/import flow with AES-256 key encryption
- Token contract paste-to-trade
- Confirmation before every buy and sell
- Position dashboard with live ROI
- One-tap sell buttons
- Auto-sell setup flow
- Webhook deployment for stable Telegram delivery on Render

---

## How ZenGuard Uses Zerion CLI

ZenGuard keeps the Zerion CLI as its execution layer. The bot does not call swap routers directly. It imports the forked CLI swap helper and uses it to request Zerion quotes.

```javascript
const swapModule = await import('../cli/lib/trading/swap.js');
const getSwapQuote = swapModule.getSwapQuote;

const quote = await getSwapQuote({
  fromToken,
  toToken,
  amount: String(amount),
  fromChain: chain,
  toChain: chain,
  walletAddress,
});
```

The forked CLI then:
- Resolves token identifiers for the requested chain
- Builds Zerion `/swap/quotes/` parameters
- Requests the Zerion swap quote
- Returns the swap transaction and approval transaction when required

ZenGuard signs and broadcasts from the user's own wallet. Zerion remains the routing and execution engine. ZenGuard adds the agent, policy, and Telegram product layer.

Production log confirming CLI integration:
```
[swapper] Using Zerion CLI getSwapQuote — EVM
[swap] params being sent: {
  "from": "0xa7dD55...",
  "input[chain_id]": "base",
  "input[fungible_id]": "eth",
  "input[amount]": "0.0006",
  "output[chain_id]": "base",
  "output[fungible_id]": "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
  "slippage_percent": 2
}
```

---

## Scoped Policy Design

ZenGuard is intentionally not a "god mode" agent. Every action is constrained by user-defined policies and wallet scope.

| Policy | Implementation |
|---|---|
| Wallet scope | Execution only uses the user's encrypted imported/generated wallet |
| Chain lock | Each watched token stores its chain; auto-sell executes on that chain only |
| Token lock | Auto-sell uses the specific contract/mint stored in the policy |
| Spend/sell limit | Auto-sell is limited to the configured percentage: 25%, 50%, or 100% |
| Trigger limits | Stop-loss and take-profit thresholds are configured by the user |
| Public wallet safety | Public wallet surveillance cannot execute transactions |
| Balance safety | EVM sell sizing checks live ERC-20 balance before execution |
| Confirmation | Manual buys and sells require explicit user confirmation in Telegram |
| Native exit asset | Protection exits to ETH on EVM and SOL on Solana |

---

## Architecture

```
Telegram user
  │
  ▼
zenguard/bot.js
  ├── wallet onboarding
  ├── token discovery
  ├── buy/sell confirmations
  ├── position dashboard
  └── webhook server (Render)
  │
  ├──▶ zenguard/swapper.js
  │      ├── decrypt wallet key
  │      ├── request Zerion CLI swap quote
  │      ├── send ERC-20 approval when required
  │      ├── sign and broadcast swap transaction
  │      └── parse EVM receipt logs for real output amount
  │
  ├──▶ zenguard/monitor.js
  │      ├── scheduled protection checks (node-cron)
  │      ├── stop-loss and take-profit triggers
  │      └── scoped auto-sell execution
  │
  └──▶ zenguard/store.js
         ├── Upstash Redis persistence
         ├── encrypted wallet records (per-chain)
         ├── watched tokens and policies
         └── tracked positions

Forked Zerion CLI
  │
  ▼
cli/lib/trading/swap.js
  ├── chain-aware token resolution
  ├── Zerion /swap/quotes/ params
  ├── swap transaction
  └── approval transaction
  │
  ▼
Zerion API → Onchain transaction
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ES Modules) |
| Bot framework | Telegraf v4 |
| Swap routing | Zerion CLI fork — `getSwapQuote` from `cli/lib/trading/swap.js` |
| EVM signing | ethers v6 |
| Solana signing | @solana/web3.js |
| Token data | DexScreener API |
| Key storage | AES-256 encryption in Upstash Redis (per-chain, per-user) |
| Persistence | Upstash Redis |
| Monitoring | node-cron (5-minute intervals, 1-hour cooldown per token) |
| Deployment | Render web service — Telegram webhook mode |

---

## Key Files

| File | Purpose |
|---|---|
| `zenguard/bot.js` | Telegram bot, webhook server, trading UX, positions, manual sell, auto-sell setup |
| `zenguard/swapper.js` | Wallet signing, Zerion CLI quote usage, approval handling, receipt parsing |
| `zenguard/monitor.js` | Autonomous monitoring and scoped auto-sell execution |
| `zenguard/store.js` | Redis persistence for wallets, policies, watched tokens, and positions |
| `zenguard/wallet.js` | Wallet creation/import and AES-256 encryption helpers |
| `zenguard/crypto.js` | Secret encryption/decryption utilities |
| `cli/lib/trading/swap.js` | Forked Zerion CLI swap quote helper — modified for `/swap/quotes/` endpoint |
| `cli/lib/api/client.js` | Zerion API client with detailed error handling |

---

## Hackathon Requirement Mapping

| Requirement | ZenGuard Status |
|---|---|
| Fork Zerion CLI | Built on a forked Zerion CLI codebase |
| Autonomous onchain agent | Telegram agent monitors positions and auto-sells inside policy |
| Real transaction | Base mainnet ETH → VIRTUAL swap executed and confirmed |
| No simulations | Production bot signs and broadcasts real wallet transactions |
| Scoped policy | Chain, token, trigger, and sell-size policies implemented |
| Zerion routing | All swaps request Zerion CLI quote data before execution |
| Open source repo | Public GitHub — github.com/Rolexcode/zerion-ai |
| Demo-ready UX | Telegram bot supports buy, sell, positions, and auto-sell setup |

---

## Environment Variables

```env
TELEGRAM_BOT_TOKEN=
ZERION_API_KEY=
ZERION_SWAP_API_KEY=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
ENCRYPTION_KEY=
WEBHOOK_URL=https://your-render-service.onrender.com
SOLANA_RPC_URL=
BASE_RPC_URL=
ETHEREUM_RPC_URL=
ARBITRUM_RPC_URL=
OPTIMISM_RPC_URL=
POLYGON_RPC_URL=
```

`WEBHOOK_URL` is required on Render so Telegram uses webhook delivery instead of polling. `ZERION_SWAP_API_KEY` can be set separately from `ZERION_API_KEY`; if omitted, the app falls back to the standard key.

---

## Local Development

```bash
npm install
npm start
```

Syntax checks:
```bash
node --check zenguard/bot.js
node --check zenguard/monitor.js
node --check zenguard/swapper.js
node --check cli/lib/trading/swap.js
```

---

## Render Deployment

1. Create a Render web service from the public GitHub repository
2. Set start command to `npm start`
3. Add all environment variables
4. Set `WEBHOOK_URL` to the Render service URL
5. Deploy

Successful logs:
```
[bot] HTTP server listening on port 10000.
[bot] ZenGuard webhook registered at https://your-service.onrender.com/telegram-webhook
```

---

## Demo Flow

1. Open [@zerionautonomousbot](https://t.me/zerionautonomousbot)
2. Create or import a wallet
3. Paste a Base token contract address
4. Review live token data from DexScreener
5. Buy with ETH — routed through Zerion CLI
6. Receive onchain transaction hash
7. Open `/positions` — see token amount and USD value with ROI
8. Sell 25%, 50%, or 100% back to ETH
9. Set auto-sell stop-loss and take-profit rules
10. Paste a public wallet address — surveillance mode sends alerts, never executes

---

## Security

- Private keys are AES-256 encrypted before storage in Redis
- Raw keys are never logged or persisted in plaintext
- Users must explicitly confirm all manual buys and sells
- Public wallet surveillance cannot execute transactions
- Auto-sell is scoped to a specific token, chain, and percentage
- EVM sells verify live token balance before execution

---

## Current Limitations

- Monitoring uses price polling (DexScreener) rather than direct onchain event subscriptions.
- Telegram UI is intentionally lightweight for demo speed.

---

## Future Improvements

- Expiring policies with time windows
- Multi-token portfolio rebalancing
- Web dashboard for position history and charts
- Multi-agent approval flow for shared wallets

---

## License

MIT
