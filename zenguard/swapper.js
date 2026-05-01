/**
 * ZenGuard swap execution layer.
 *
 * Uses the forked Zerion CLI's getSwapQuote for routing and quote resolution,
 * then signs and broadcasts using the user's decrypted keypair.
 * Token info sourced from DexScreener for accurate real-time market data.
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

// DexScreener chain slugs mapped to our chain IDs
const DEXSCREENER_CHAIN_MAP = {
  solana: 'solana',
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
  'binance-smart-chain': 'bsc',
};

const zerion = axios.create({
  baseURL: 'https://api.zerion.io/v1',
  headers: {
    Authorization: `Basic ${Buffer.from(`${process.env.ZERION_API_KEY}:`).toString('base64')}`,
    Accept: 'application/json',
  },
});

// ─── DETECT CHAIN FROM ADDRESS ────────────────────────────────────────────────

export function detectChain(address) {
  if (!address) return null;
  // Solana addresses are base58, 32-44 chars, no 0x prefix
  if (!address.startsWith('0x') && address.length >= 32 && address.length <= 44) {
    return 'solana';
  }
  // EVM addresses start with 0x and are 42 chars
  if (address.startsWith('0x') && address.length === 42) {
    return 'evm'; // generic EVM — DexScreener will find the exact chain
  }
  return null;
}

export function isContractAddress(text) {
  text = text.trim();
  // Solana CA
  if (!text.startsWith('0x') && text.length >= 32 && text.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) {
    return true;
  }
  // EVM CA
  if (text.startsWith('0x') && text.length === 42) {
    return true;
  }
  return false;
}

// ─── GET TOKEN INFO — DEXSCREENER ─────────────────────────────────────────────

export async function getTokenInfo(addressOrQuery) {
  try {
    const address = addressOrQuery.trim();

    // Search DexScreener by token address
    const { data } = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`
    );

    const pairs = data?.pairs;
    if (!pairs || pairs.length === 0) {
      throw new Error('Token not found on DexScreener.');
    }

    // Sort by liquidity to get the most liquid pair
    const sorted = pairs.sort((a, b) =>
      (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    );

    const best = sorted[0];
    const chainId = best.chainId; // e.g. 'solana', 'ethereum', 'bsc'

    // Map DexScreener chain to our chain ID
    const chainMap = {
      solana: 'solana',
      ethereum: 'ethereum',
      base: 'base',
      arbitrum: 'arbitrum',
      optimism: 'optimism',
      polygon: 'polygon',
      bsc: 'binance-smart-chain',
    };

    const ourChain = chainMap[chainId] ?? chainId;
    const nativeCurrency = NATIVE_CURRENCY[ourChain] ?? 'ETH';

    return {
      name: best.baseToken?.name ?? 'Unknown',
      symbol: best.baseToken?.symbol ?? '???',
      address: best.baseToken?.address ?? address,
      price: parseFloat(best.priceUsd ?? 0),
      change24h: best.priceChange?.h24 ?? 0,
      volume24h: best.volume?.h24 ?? 0,
      liquidity: best.liquidity?.usd ?? 0,
      marketCap: best.marketCap ?? 0,
      verified: best.boosts !== undefined || false,
      chain: ourChain,
      dexChain: chainId,
      nativeCurrency,
      pairAddress: best.pairAddress,
      dex: best.dexId,
    };
  } catch (err) {
    console.error('[swapper] Token info failed:', err.message);
    throw new Error('Token not found. Check the contract address.');
  }
}

// ─── SOLANA SWAP ──────────────────────────────────────────────────────────────

export async function swapToUSDCSolana(encryptedKey, tokenMint, amount) {
  const keypair = getSolanaKeypair(encryptedKey);
  const walletAddress = keypair.publicKey.toString();

  const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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

  const txData = quoteData?.data?.attributes?.transaction;
  if (!txData) throw new Error('No swap transaction returned from Zerion.');

  const txBuffer = Buffer.from(txData.data, 'base64');

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

// ─── EVM SWAP ─────────────────────────────────────────────────────────────────

export async function swapToUSDCEVM(encryptedKey, chain, tokenAddress, amount) {
  const wallet = getEVMWallet(encryptedKey);
  const provider = new ethers.JsonRpcProvider(RPC_URLS[chain] || RPC_URLS.ethereum);
  const connectedWallet = wallet.connect(provider);

  const USDC_EVM = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

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

  const txData = quoteData?.data?.attributes?.transaction;
  if (!txData) throw new Error('No swap transaction returned from Zerion.');

  if (quoteData?.data?.attributes?.preconditions?.enough_allowance === false && txData.spender) {
    const erc20Abi = ['function approve(address spender, uint256 amount) returns (bool)'];
    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, connectedWallet);
    const approvalTx = await tokenContract.approve(txData.spender, ethers.MaxUint256);
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