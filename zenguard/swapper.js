/**
 * ZenGuard swap execution layer.
 *
 * Quote routing: forked Zerion CLI's getSwapQuote (cli/lib/trading/swap.js)
 * Token data: DexScreener API for accurate real-time market data
 * Signing: user's decrypted keypair (AES-256 encrypted in Redis)
 */

import axios from "axios";
import { Connection, VersionedTransaction, Transaction } from "@solana/web3.js";
import { ethers } from "ethers";
import { getSolanaKeypair, getEVMWallet } from "./wallet.js";

// Use dedicated swap key if available
const SWAP_API_KEY =
  process.env.ZERION_SWAP_API_KEY || process.env.ZERION_API_KEY;
process.env.ZERION_API_KEY = SWAP_API_KEY;

const connection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  "confirmed",
);

const RPC_URLS = {
  ethereum: "https://eth.llamarpc.com",
  base: "https://mainnet.base.org",
  arbitrum: "https://arb1.llamarpc.com",
  polygon: "https://polygon.llamarpc.com",
  optimism: "https://mainnet.optimism.io",
  "binance-smart-chain": "https://bsc-dataseed.binance.org",
};

const NATIVE_CURRENCY = {
  solana: "SOL",
  ethereum: "ETH",
  base: "ETH",
  arbitrum: "ETH",
  optimism: "ETH",
  polygon: "MATIC",
  "binance-smart-chain": "BNB",
};

const ERC20_TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const zerion = axios.create({
  baseURL: "https://api.zerion.io/v1",
  headers: {
    Authorization: `Basic ${Buffer.from(`${process.env.ZERION_API_KEY}:`).toString("base64")}`,
    Accept: "application/json",
  },
});

// ─── ADDRESS VALIDATION ───────────────────────────────────────────────────────

const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

export function isContractAddress(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  return SOLANA_ADDRESS_REGEX.test(t) || EVM_ADDRESS_REGEX.test(t);
}

export function detectChain(address) {
  if (!address) return null;
  if (EVM_ADDRESS_REGEX.test(address.trim())) return "evm";
  if (SOLANA_ADDRESS_REGEX.test(address.trim())) return "solana";
  return null;
}

function validateAddress(address, type = "any") {
  if (!address || typeof address !== "string")
    throw new Error("Invalid address.");
  const a = address.trim();
  if (type === "solana" && !SOLANA_ADDRESS_REGEX.test(a))
    throw new Error("Invalid Solana address.");
  if (type === "evm" && !EVM_ADDRESS_REGEX.test(a))
    throw new Error("Invalid EVM address.");
  if (
    type === "any" &&
    !SOLANA_ADDRESS_REGEX.test(a) &&
    !EVM_ADDRESS_REGEX.test(a)
  )
    throw new Error("Invalid address format.");
  return a;
}

function normalizeAddress(address) {
  return address?.toLowerCase();
}

async function getErc20Decimals(provider, tokenAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_TRANSFER_ABI, provider);
  return Number(await token.decimals());
}

async function extractReceivedTokenAmount(receipt, provider, tokenAddress, walletAddress) {
  if (!tokenAddress || tokenAddress === "eth" || !EVM_ADDRESS_REGEX.test(tokenAddress)) {
    return null;
  }

  const iface = new ethers.Interface(ERC20_TRANSFER_ABI);
  const recipient = normalizeAddress(walletAddress);
  let total = 0n;

  for (const log of receipt.logs ?? []) {
    if (normalizeAddress(log.address) !== normalizeAddress(tokenAddress)) continue;

    try {
      const parsed = iface.parseLog(log);
      if (
        parsed?.name === "Transfer" &&
        normalizeAddress(parsed.args.to) === recipient
      ) {
        total += parsed.args.value;
      }
    } catch {
      // Ignore logs from the same token that do not match the standard event.
    }
  }

  if (total === 0n) return null;

  const decimals = await getErc20Decimals(provider, tokenAddress);
  return ethers.formatUnits(total, decimals);
}

export async function getEVMTokenBalance(encryptedKey, chain, tokenAddress) {
  validateAddress(tokenAddress, "evm");
  if (!RPC_URLS[chain]) throw new Error(`Unsupported chain: ${chain}`);

  const wallet = getEVMWallet(encryptedKey);
  const provider = new ethers.JsonRpcProvider(RPC_URLS[chain]);
  const token = new ethers.Contract(tokenAddress, ERC20_TRANSFER_ABI, provider);
  const [balance, decimals] = await Promise.all([
    token.balanceOf(wallet.address),
    token.decimals(),
  ]);

  return ethers.formatUnits(balance, Number(decimals));
}

// ─── GET TOKEN INFO — DEXSCREENER ─────────────────────────────────────────────

export async function getTokenInfo(addressInput) {
  const address = validateAddress(addressInput);

  const { data } = await axios.get(
    `https://api.dexscreener.com/latest/dex/tokens/${address}`,
    { timeout: 10000 },
  );

  const pairs = data?.pairs;
  if (!pairs || pairs.length === 0)
    throw new Error("Token not found on DexScreener.");

  const sorted = pairs.sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
  );
  const best = sorted[0];

  const chainMap = {
    solana: "solana",
    ethereum: "ethereum",
    base: "base",
    arbitrum: "arbitrum",
    optimism: "optimism",
    polygon: "polygon",
    bsc: "binance-smart-chain",
  };

  const ourChain = chainMap[best.chainId] ?? best.chainId;
  const nativeCurrency = NATIVE_CURRENCY[ourChain] ?? "ETH";

  return {
    name: best.baseToken?.name ?? "Unknown",
    symbol: best.baseToken?.symbol ?? "???",
    address: validateAddress(best.baseToken?.address ?? address),
    price: parseFloat(best.priceUsd ?? 0),
    change24h: best.priceChange?.h24 ?? 0,
    volume24h: best.volume?.h24 ?? 0,
    liquidity: best.liquidity?.usd ?? 0,
    marketCap: best.marketCap ?? 0,
    verified: !!best.boosts,
    chain: ourChain,
    dexChain: best.chainId,
    nativeCurrency,
    pairAddress: best.pairAddress,
    dex: best.dexId,
  };
}

// ─── SOLANA SWAP (protection mode: token → USDC) ─────────────────────────────

export async function swapToUSDCSolana(encryptedKey, tokenMint, amount) {
  validateAddress(tokenMint, "solana");
  if (!amount || isNaN(amount) || amount <= 0)
    throw new Error("Invalid swap amount.");

  const keypair = getSolanaKeypair(encryptedKey);
  const walletAddress = keypair.publicKey.toString();
  const SOL = "SOL";

  console.log("[swapper] Using Zerion CLI getSwapQuote — Solana protect");

  const swapModule = await import("../cli/lib/trading/swap.js");
  const getSwapQuote = swapModule.getSwapQuote;

  const quote = await getSwapQuote({
    fromToken: tokenMint,
    toToken: SOL,
    amount: String(amount),
    fromChain: "solana",
    toChain: "solana",
    walletAddress,
  });

  if (!quote?.transaction)
    throw new Error("No transaction from Zerion CLI swap quote.");

  const txRaw = quote.transaction?.raw ?? quote.transaction?.data;
  const txBuffer = Buffer.from(txRaw, "base64");
  let signed;
  try {
    const tx = VersionedTransaction.deserialize(txBuffer);
    tx.sign([keypair]);
    signed = tx.serialize();
  } catch {
    const tx = Transaction.from(txBuffer);
    tx.sign(keypair);
    signed = tx.serialize();
  }

  const txHash = await connection.sendRawTransaction(signed, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(txHash, "confirmed");
  return { hash: txHash, outputAmount: quote.estimatedOutput ?? null };
}

// ─── SOLANA BUY (trade mode: SOL → token) ────────────────────────────────────

export async function swapSolanaTokens(encryptedKey, fromMint, toMint, amount) {
  const keypair = getSolanaKeypair(encryptedKey);
  const walletAddress = keypair.publicKey.toString();

  console.log("[swapper] Using Zerion CLI getSwapQuote — Solana buy");

  const swapModule = await import("../cli/lib/trading/swap.js");
  const getSwapQuote = swapModule.getSwapQuote;

  const quote = await getSwapQuote({
    fromToken: fromMint,
    toToken: toMint,
    amount: String(amount),
    fromChain: "solana",
    toChain: "solana",
    walletAddress,
  });

  if (!quote?.transaction)
    throw new Error("No transaction from Zerion CLI swap quote.");

  const txRaw = quote.transaction?.raw ?? quote.transaction?.data;
  const txBuffer = Buffer.from(txRaw, "base64");
  let signed;
  try {
    const tx = VersionedTransaction.deserialize(txBuffer);
    tx.sign([keypair]);
    signed = tx.serialize();
  } catch {
    const tx = Transaction.from(txBuffer);
    tx.sign(keypair);
    signed = tx.serialize();
  }

  const txHash = await connection.sendRawTransaction(signed, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(txHash, "confirmed");
  return { hash: txHash, outputAmount: quote.estimatedOutput ?? null };
}

// ─── EVM SWAP ─────────────────────────────────────────────────────────────────

export async function swapToUSDCEVM(
  encryptedKey,
  chain,
  tokenAddress,
  amount,
  outputToken = null,
) {
  if (tokenAddress !== 'eth') validateAddress(tokenAddress, 'evm');
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0)
    throw new Error("Invalid swap amount.");
  if (!RPC_URLS[chain]) throw new Error(`Unsupported chain: ${chain}`);

  const wallet = getEVMWallet(encryptedKey);
  const provider = new ethers.JsonRpcProvider(RPC_URLS[chain]);
  const connectedWallet = wallet.connect(provider);
  const USDC_EVM = outputToken ?? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  console.log("[swapper] Using Zerion CLI getSwapQuote — EVM");
  console.log("[swapper] Chain:", chain, "| Token:", tokenAddress);

  const swapModule = await import("../cli/lib/trading/swap.js");
  const getSwapQuote = swapModule.getSwapQuote;

  const quote = await getSwapQuote({
    fromToken: tokenAddress,
    toToken: USDC_EVM,
    amount: String(amount),
    fromChain: chain,
    toChain: chain,
    walletAddress: wallet.address,
  });

  if (!quote?.transaction)
    throw new Error("No transaction from Zerion CLI swap quote.");

  const txData = quote.transaction;
  if (!txData?.to) {
    throw new Error("No executable swap transaction from Zerion quote.");
  }
  const swapCalldata = txData.data ?? txData.input ?? txData.raw ?? "0x";
  if (tokenAddress !== "eth" && swapCalldata === "0x") {
    throw new Error("Zerion quote did not include swap calldata for this token sell.");
  }

  const needsApproval = quote.preconditions?.enough_allowance === false;

  if (needsApproval && quote.approvalTransaction?.to) {
    const approvalTx = await connectedWallet.sendTransaction({
      to: quote.approvalTransaction.to,
      data: quote.approvalTransaction.data ?? quote.approvalTransaction.input ?? "0x",
      value: quote.approvalTransaction.value ? BigInt(quote.approvalTransaction.value) : 0n,
      gasLimit: quote.approvalTransaction.gas ? BigInt(quote.approvalTransaction.gas) : 120000n,
    });
    await approvalTx.wait();
  }

  const tx = await connectedWallet.sendTransaction({
    to: txData.to,
    data: swapCalldata,
    value: txData.value ? BigInt(txData.value) : 0n,
    gasLimit: txData.gas ? BigInt(txData.gas) : 300000n,
  });

  const receipt = await tx.wait();
  const outputAmount = await extractReceivedTokenAmount(
    receipt,
    provider,
    USDC_EVM,
    wallet.address,
  );

  return {
    hash: tx.hash,
    outputAmount: outputAmount ?? quote.estimatedOutput ?? null,
  };
}
