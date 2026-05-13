# ZenGuard - Autonomous Onchain Bodyguard

> Zerion CLI Frontier Hackathon submission for Superteam Earn.

ZenGuard is a Telegram-native autonomous onchain agent built on a fork of Zerion CLI. It lets a user create or import wallets, inspect tokens, execute real swaps, track positions, and set scoped protection rules that can exit a position automatically when risk limits are triggered.

This is not a simulation and not just a chatbot. ZenGuard uses the forked Zerion CLI as its wallet and execution layer, routes swaps through Zerion, and broadcasts real transactions onchain.

## Live Execution Proof

ZenGuard has already executed a real Base mainnet swap through the bot flow.

| Field | Value |
| --- | --- |
| Network | Base |
| Action | Swap ETH to VIRTUAL |
| Paid | 0.0006 ETH |
| Received | 1.662036 VIRTUAL |
| Transaction | `312b64bb97e40d9ef4bea5b54b383f840e8cc427988e286da1cca460539fd17d` |
| Wallet | `0xa7dD55EDE00dEC31e44AFFd404f1Ddcb1E8FB106` |
| Route | Zerion quote and swap transaction, executed onchain |

Production logs show the forked CLI preparing Zerion swap quote params, including `from`, `to`, input chain/token, output chain/token, amount, and slippage, before signing and broadcasting from the user's wallet.

## Why ZenGuard Exists

Crypto users miss exits because markets move while they are offline. Most tools only notify the user after price movement has already happened. ZenGuard closes that gap by combining wallet custody, token discovery, real execution, and policy-scoped automation in one Telegram interface.

The goal is simple: the user decides the rules, and the agent acts only inside those rules.

## Core Features

### 1. Real Onchain Swaps

Users can paste a token contract or mint address into Telegram, inspect market data, choose how much native currency to spend, confirm the trade, and execute a real swap.

Current production path:

- Base/EVM buy: ETH to token.
- Base/EVM sell: token back to ETH.
- Solana path: SOL to token and token back to SOL.
- Swap quotes are routed through the forked Zerion CLI.
- EVM swaps support Zerion approval transactions before the final swap.
- The final transaction hash is returned to the user in Telegram.

### 2. Position Tracking

After a buy, ZenGuard stores a tracked position with:

- token symbol and contract or mint address
- chain
- actual output amount when available from transaction receipt logs
- estimated output amount as a fallback
- entry price
- entry USD value
- current price
- current USD value
- ROI percentage
- dollar PnL
- opened timestamp

The `/positions` view shows both token quantity and dollar value, so users can understand position size without doing mental math.

### 3. Manual Sell Flow

Every tracked position has one-tap sell controls:

- Sell 25%
- Sell 50%
- Sell 100%

For EVM positions, ZenGuard checks the live ERC-20 wallet balance before sizing the sell. This prevents selling from stale tracked data if a user transferred or partially sold tokens outside the bot.

By default, sells return to the same native asset users bought with:

- EVM/Base positions sell back to ETH.
- Solana positions sell back to SOL.

### 4. Autonomous Protection Mode

Users can set stop-loss and take-profit rules for a tracked token. ZenGuard then monitors the token and executes a scoped sell only when the configured rule is triggered.

Supported protection controls:

- chain-scoped execution
- token-scoped execution
- percentage-based stop loss
- percentage-based take profit
- sell size limited to 25%, 50%, or 100%
- live balance check before EVM auto-sells
- native-asset exit target: ETH on EVM, SOL on Solana

Example:

```text
Token: VIRTUAL on Base
Stop loss: 20%
Take profit: 100%
Sell size: 50%
Exit asset: ETH
```

If the trigger fires, ZenGuard can sell only that scoped amount of that scoped token. It cannot freely drain unrelated assets.

### 5. Surveillance Mode

ZenGuard also supports watch-only monitoring for public wallets. In this mode it can alert the user about movement in another wallet, but it cannot execute transactions because it does not hold that wallet's private key.

This keeps monitoring and execution clearly separated:

- Own wallet: alerts plus optional auto-sell.
- Public wallet: alerts only.

### 6. Telegram-First UX

The interface is designed for fast mobile use:

- `/start` onboarding
- wallet create/import flow
- token contract paste-to-trade flow
- confirmation before buys and sells
- position dashboard
- one-tap sell buttons
- auto-sell setup flow
- clear success and failure messages
- Render webhook deployment for stable Telegram delivery

## How ZenGuard Uses Zerion CLI

ZenGuard keeps Zerion CLI as the execution layer. The Telegram bot does not call random swap routers directly. Instead, it imports the forked CLI swap helper and uses it to request Zerion swap quotes.

Simplified flow:

```js
const swapModule = await import("../cli/lib/trading/swap.js");
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

1. Resolves token identifiers for the requested chain.
2. Builds Zerion quote parameters.
3. Includes both `from` and `to` wallet addresses.
4. Requests the Zerion swap quote.
5. Returns the swap transaction.
6. Returns an approval transaction when Zerion requires allowance.
7. Lets ZenGuard sign and broadcast from the user's wallet.

This keeps the hackathon requirement intact: Zerion remains the routing and execution engine, while ZenGuard adds the agent, policy, and Telegram product layer.

## Scoped Policy Design

ZenGuard is intentionally not a "god mode" agent. Execution is constrained by user-defined policies and wallet scope.

| Policy | Implementation |
| --- | --- |
| Wallet scope | Execution only uses the user's encrypted imported/generated wallet. |
| Chain lock | Each watched token stores its chain, and auto-sell executes on that chain only. |
| Token lock | Auto-sell uses the specific token contract or mint stored in the policy. |
| Spend/sell limit | Auto-sell is limited to the configured percentage: 25%, 50%, or 100%. |
| Trigger limits | Stop-loss and take-profit thresholds are configured by the user. |
| Public wallet safety | Public wallet surveillance cannot execute transactions. |
| Balance safety | EVM sell sizing checks the live ERC-20 balance before execution. |
| Confirmation | Manual buys and sells require user confirmation in Telegram. |
| Native exit asset | Protection exits to ETH on EVM and SOL on Solana. |

## Architecture

```text
Telegram user
  |
  v
zenguard/bot.js
  |-- wallet onboarding
  |-- token discovery
  |-- buy/sell confirmations
  |-- position dashboard
  |-- webhook server for Render
  |
  +--> zenguard/swapper.js
  |      |-- decrypt wallet key
  |      |-- request Zerion CLI swap quote
  |      |-- send approval transaction when required
  |      |-- sign and broadcast swap transaction
  |      |-- parse EVM receipt logs for real output amount
  |
  +--> zenguard/monitor.js
  |      |-- scheduled protection checks
  |      |-- stop-loss and take-profit triggers
  |      |-- scoped auto-sell execution
  |
  +--> zenguard/store.js
         |-- Upstash Redis persistence
         |-- encrypted wallet records
         |-- watched tokens
         |-- tracked positions
         |-- user policies

Forked Zerion CLI
  |
  v
cli/lib/trading/swap.js
  |-- chain-aware token resolution
  |-- Zerion quote params
  |-- swap transaction
  |-- approval transaction
  |
  v
Zerion API -> Onchain transaction
```

## Key Files

| File | Purpose |
| --- | --- |
| `zenguard/bot.js` | Telegram bot, webhook server, trading UX, positions, manual sell, auto-sell setup. |
| `zenguard/swapper.js` | Wallet signing, Zerion CLI quote usage, approval handling, receipt parsing. |
| `zenguard/monitor.js` | Autonomous monitoring and scoped auto-sell execution. |
| `zenguard/store.js` | Redis persistence for wallets, policies, watched tokens, and positions. |
| `zenguard/wallet.js` | Wallet creation/import and encryption helpers. |
| `zenguard/crypto.js` | Secret encryption/decryption utilities. |
| `cli/lib/trading/swap.js` | Forked Zerion CLI swap quote helper. |
| `cli/lib/trading/resolve-token.js` | Chain-aware token and fungible ID resolution. |
| `cli/lib/api/client.js` | Zerion API client and detailed API error handling. |

## Tech Stack

- Node.js ESM
- Telegraf for Telegram bot UX
- Zerion CLI fork for wallet and swap execution
- Zerion API for swap routing
- ethers v6 for EVM signing, balances, and receipt parsing
- Solana web3.js for Solana wallet and transaction support
- DexScreener for token discovery and market data
- Upstash Redis for persistence
- node-cron for monitoring jobs
- Render web service deployment with Telegram webhook mode

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

Notes:

- `WEBHOOK_URL` is required on Render so Telegram uses webhook delivery instead of polling.
- `ZERION_SWAP_API_KEY` can be set separately from `ZERION_API_KEY`; if omitted, the app can fall back to the standard Zerion key where supported.
- RPC URLs are required for chains the agent will sign and broadcast on.

## Local Development

```bash
npm install
npm start
```

Useful checks:

```bash
node --check zenguard/bot.js
node --check zenguard/monitor.js
node --check zenguard/swapper.js
node --check cli/lib/trading/swap.js
node --test tests/unit.test.mjs tests/tool-catalog.test.mjs tests/consistency.test.mjs
```

## Render Deployment

1. Create a Render web service from the public GitHub repository.
2. Set the start command to:

```bash
npm start
```

3. Add the required environment variables.
4. Set `WEBHOOK_URL` to the Render service URL.
5. Deploy.

Successful production logs should include:

```text
[bot] HTTP server listening on port 10000.
[bot] ZenGuard webhook registered at https://your-service.onrender.com/telegram-webhook
```

## Demo Flow

A complete hackathon demo can show:

1. Open the Telegram bot.
2. Create or import a wallet.
3. Paste a Base token contract.
4. Review token info from DexScreener.
5. Buy with ETH through Zerion.
6. Show the onchain transaction hash.
7. Open `/positions` and show token amount plus USD value.
8. Sell 25%, 50%, or 100% back to ETH.
9. Set auto-sell stop-loss and take-profit rules.
10. Explain that public wallet surveillance is alert-only, while own-wallet mode can execute inside policy.

## Hackathon Requirement Mapping

| Requirement | ZenGuard Status |
| --- | --- |
| Fork Zerion CLI | Built on a forked Zerion CLI codebase. |
| Autonomous onchain agent | Telegram agent monitors positions and can auto-sell inside policy. |
| Real transaction | Base mainnet ETH to VIRTUAL swap executed successfully. |
| No simulations | Production bot signs and broadcasts real wallet transactions. |
| Scoped policy | Chain, token, trigger, and sell-size policies implemented. |
| Zerion routing | Swaps request Zerion CLI quote data before execution. |
| Open source repo | Designed for public GitHub submission. |
| Demo-ready UX | Telegram bot supports buy, sell, positions, and auto-sell setup. |

## Security Notes

- Private keys are encrypted before storage.
- Users must explicitly confirm manual buys and sells.
- Public wallet monitoring cannot execute transactions.
- Auto-sell only acts on a tracked token and configured chain.
- Sell amount is limited by the selected policy percentage.
- EVM sells check live token balance before execution.
- The testing-only `/reset` command has been removed from the final bot flow.

## Current Limitations

- The completed live execution proof is on Base/EVM. The Solana path is wired to use SOL as the native buy/sell asset, but it should be demonstrated with a funded Solana wallet before relying on it in the final video.
- Monitoring currently uses market data polling rather than direct onchain event subscriptions.
- The current Telegram UI is intentionally lightweight for demo speed; richer controls can be added without changing the execution layer.

## Future Improvements

- Per-user daily spend caps.
- Expiring policies with start and end windows.
- More detailed approval previews.
- Multi-agent approval flow for shared wallets.
- Portfolio-level rebalancing across multiple tokens.
- Web dashboard for richer position history and charts.

## License

MIT
