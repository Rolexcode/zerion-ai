/**
 * ZenGuard swap execution layer.
 *
 * Quote routing: forked Zerion CLI's getSwapQuote (cli/lib/trading/swap.js)
 * Token data: DexScreener API for accurate real-time market data
 * Signing: user's decrypted keypair (AES-256 encrypted in Redis)
 */

import axios from 'axios';
import { Connection, VersionedTransaction, Transaction } from '@solana/web3.js';
import { ethers } from 'ethers';
import { getSolanaKeypair, getEVMWallet } from './wallet.js';

const connection = new Connection(
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  'confirmed'
);

const RPC_URLS = {
  ethereum: 'https://eth.llamarpc.com',
  base: 'https://mainnet.base.org',
  arbitrum: 'https://arb1.llamarpc.com',
  polygon: 'https://polygon.llamarpc.com',
  optimism: 'https://mainnet.optimism.io',
  'binance-smart-chain': 'https://bsc-dataseed.binance.org',
};

const NATIVE_CURRENCY = {
  solana: 'SOL',
  ethereum: 'ETH',
  base: 'ETH',
  arbitrum: 'ETH',
  optimism: 'ETH',
  polygon: 'MATIC',
  'binance-smart-chain': 'BNB',
};

const zerion = axios.create({
  baseURL: 'https://api.zerion.io/v1',
  headers: {
    Authorization: `Basic ${Buffer.from(`${process.env.ZERION_API_KEY}:`).toString('base64')}`,
    Accept: 'application/json',
  },
});

// ─── ADDRESS VALIDATION ───────────────────────────────────────────────────────

const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

export function isContractAddress(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  return SOLANA_ADDRESS_REGEX.test(t) || EVM_ADDRESS_REGEX.test(t);
}

export function detectChain(address) {
  if (!address) return null;
  if (EVM_ADDRESS_REGEX.test(address.trim())) return 'evm';
  if (SOLANA_ADDRESS_REGEX.test(address.trim())) return 'solana';
  return null;
}

function validateAddress(address, type = 'any') {
  if (!address || typeof address !== 'string') throw new Error('Invalid address.');
  const a = address.trim();
  if (type === 'solana' && !SOLANA_ADDRESS_REGEX.test(a)) throw new Error('Invalid Solana address.');
  if (type === 'evm' && !EVM_ADDRESS_REGEX.test(a)) throw new Error('Invalid EVM address.');
  if (type === 'any' && !SOLANA_ADDRESS_REGEX.test(a) && !EVM_ADDRESS_REGEX.test(a)) throw new Error('Invalid address format.');
  return a;
}

// ─── GET TOKEN INFO — DEXSCREENER ─────────────────────────────────────────────

export async function getTokenInfo(addressInput) {
  const address = validateAddress(addressInput);

  const { data } = await axios.get(
    `https://api.dexscreener.com/latest/dex/tokens/${address}`,
    { timeout: 10000 }
  );

  const pairs = data?.pairs;
  if (!pairs || pairs.length === 0) throw new Error('Token not found on DexScreener.');

  const sorted = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const best = sorted[0];

  const chainMap = {
    solana: 'solana',
    ethereum: 'ethereum',
    base: 'base',
    arbitrum: 'arbitrum',
    optimism: 'optimism',
    polygon: 'polygon',
    bsc: 'binance-smart-chain',
  };

  const ourChain = chainMap[best.chainId] ?? best.chainId;
  const nativeCurrency = NATIVE_CURRENCY[ourChain] ?? 'ETH';

  return {
    name: best.baseToken?.name ?? 'Unknown',
    symbol: best.baseToken?.symbol ?? '???',
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

// ─── SOLANA SWAP — via Zerion CLI getSwapQuote ────────────────────────────────

export async function swapToUSDCSolana(encryptedKey, tokenMint, amount) {
  validateAddress(tokenMint, 'solana');
  if (!amount || isNaN(amount) || amount <= 0) throw new Error('Invalid swap amount.');

  const keypair = getSolanaKeypair(encryptedKey);
  const walletAddress = keypair.publicKey.toString();
  const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  // Route through Zerion CLI's getSwapQuote
let getSwapQuote;
  try {
    const swapModule = await import('../cli/lib/trading/swap.js');
    getSwapQuote = swapModule.getSwapQuote;
    console.log('[swapper] Using Zerion CLI getSwapQuote — Solana');
  } catch (err) {
    console.log('[swapper] CLI import failed, using direct API — Solana:', err.message);
    getSwapQuote = null;
  }
  let txData;

  if (getSwapQuote) {
    // Use CLI's getSwapQuote — proper routing through Zerion
    const quote = await getSwapQuote({
      fromToken: tokenMint,
      toToken: USDC_SOLANA,
      amount: String(amount),
      fromChain: 'solana',
      toChain: 'solana',
      walletAddress,
    });

    if (!quote?.transaction) throw new Error('No transaction from Zerion CLI swap quote.');
    txData = quote.transaction.data;
  } else {
    // Direct Zerion API fallback
    const { data: quoteData } = await zerion.get('/swap/quote', {
      params: {
        from_chain: 'solana',
        to_chain: 'solana',
        from_token: tokenMint,
        to_token: USDC_SOLANA,
        amount,
        slippage: 0.02,
        from_address: walletAddress,
      },
    });

    const tx = quoteData?.data?.attributes?.transaction;
    if (!tx) throw new Error('No swap transaction returned from Zerion.');
    txData = tx.data;
  }

  const txBuffer = Buffer.from(txData, 'base64');

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

  await connection.confirmTransaction(txHash, 'confirmed');
  return txHash;
}

// ─── EVM SWAP — via Zerion CLI getSwapQuote ───────────────────────────────────

export async function swapToUSDCEVM(encryptedKey, chain, tokenAddress, amount) {
  validateAddress(tokenAddress, 'evm');
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) throw new Error('Invalid swap amount.');
  if (!RPC_URLS[chain]) throw new Error(`Unsupported chain: ${chain}`);

  const wallet = getEVMWallet(encryptedKey);
  const provider = new ethers.JsonRpcProvider(RPC_URLS[chain]);
  const connectedWallet = wallet.connect(provider);
  const USDC_EVM = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

let getSwapQuote;
  try {
    const swapModule = await import('../cli/lib/trading/swap.js');
    getSwapQuote = swapModule.getSwapQuote;
    console.log('[swapper] Using Zerion CLI getSwapQuote — EVM');
  } catch (err) {
    console.log('[swapper] CLI import failed, using direct API — EVM:', err.message);
    getSwapQuote = null;
  }

  let txData;
  let needsApproval = false;
  let spender = null;

  if (getSwapQuote) {
    const quote = await getSwapQuote({
      fromToken: tokenAddress,
      toToken: USDC_EVM,
      amount: String(amount),
      fromChain: chain,
      toChain: chain,
      walletAddress: wallet.address,
    });

    if (!quote?.transaction) throw new Error('No transaction from Zerion CLI swap quote.');
    txData = quote.transaction;
    needsApproval = quote.preconditions?.enough_allowance === false;
    spender = quote.spender;
  } else {
    const { data: quoteData } = await zerion.get('/swap/quote', {
      params: {
        from_chain: chain,
        to_chain: chain,
        from_token: tokenAddress,
        to_token: USDC_EVM,
        amount,
        slippage: 0.02,
        from_address: wallet.address,
      },
    });

    const attrs = quoteData?.data?.attributes;
    if (!attrs?.transaction) throw new Error('No swap transaction returned from Zerion.');
    txData = attrs.transaction;
    needsApproval = attrs.preconditions?.enough_allowance === false;
    spender = attrs.asset_spender;
  }

  // Handle ERC-20 approval if needed
  if (needsApproval && spender) {
    validateAddress(spender, 'evm');
    const erc20Abi = ['function approve(address spender, uint256 amount) returns (bool)'];
    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, connectedWallet);
    const approvalTx = await tokenContract.approve(spender, ethers.MaxUint256);
    await approvalTx.wait();
  }

  const tx = await connectedWallet.sendTransaction({
    to: txData.to,
    data: txData.data,
    value: txData.value ? BigInt(txData.value) : 0n,
    gasLimit: txData.gas ? BigInt(txData.gas) : 300000n,
  });

  await tx.wait();
  return tx.hash;
}