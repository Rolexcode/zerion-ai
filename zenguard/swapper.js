/**
 * ZenGuard swap execution layer.
 *
 * Uses the forked Zerion CLI's getSwapQuote for routing and quote resolution,
 * then signs and broadcasts using the user's decrypted keypair.
 * All swaps route through the Zerion API as required by the track.
 */

import { Connection, VersionedTransaction, Transaction } from '@solana/web3.js';
import { ethers } from 'ethers';
import { getSolanaKeypair, getEVMWallet } from './wallet.js';

// Import directly from the forked Zerion CLI lib
import { getSwapQuote } from '../cli/lib/trading/swap.js';

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

// ─── SOLANA SWAP ──────────────────────────────────────────────────────────────

export async function swapToUSDCSolana(encryptedKey, tokenMint, amount) {
  const keypair = getSolanaKeypair(encryptedKey);
  const walletAddress = keypair.publicKey.toString();

  // Use CLI's getSwapQuote — routes through Zerion API
  const quote = await getSwapQuote({
    fromToken: tokenMint,
    toToken: 'USDC',
    amount: String(amount),
    fromChain: 'solana',
    toChain: 'solana',
    walletAddress,
  });

  if (!quote.transaction) {
    throw new Error('No transaction returned from Zerion swap quote.');
  }

  // Deserialize the transaction returned by Zerion API
  const txData = quote.transaction.data;
  const txBuffer = Buffer.from(txData, 'hex');

  let signed;
  try {
    // Try VersionedTransaction first (newer Solana txs)
    const tx = VersionedTransaction.deserialize(txBuffer);
    tx.sign([keypair]);
    signed = tx.serialize();
  } catch {
    // Fall back to legacy Transaction
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

  // Use CLI's getSwapQuote — routes through Zerion API
  const quote = await getSwapQuote({
    fromToken: tokenAddress,
    toToken: 'USDC',
    amount: String(amount),
    fromChain: chain,
    toChain: chain,
    walletAddress: wallet.address,
  });

  if (!quote.transaction) {
    throw new Error('No transaction returned from Zerion swap quote.');
  }

  const txData = quote.transaction;

  // Handle ERC-20 approval if needed
  if (quote.preconditions?.enough_allowance === false && quote.spender) {
    const erc20Abi = ['function approve(address spender, uint256 amount) returns (bool)'];
    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, connectedWallet);
    const approvalTx = await tokenContract.approve(quote.spender, ethers.MaxUint256);
    await approvalTx.wait();
  }

  // Sign and broadcast
  const tx = await connectedWallet.sendTransaction({
    to: txData.to,
    data: txData.data,
    value: txData.value ? BigInt(txData.value) : 0n,
    gasLimit: txData.gas ? BigInt(txData.gas) : 300000n,
  });

  await tx.wait();
  return tx.hash;
}

// ─── GET TOKEN INFO ───────────────────────────────────────────────────────────

export async function getTokenInfo(mintAddress) {
  try {
    // Use CLI's getSwapQuote to resolve token info via Zerion API
    const isEVM = mintAddress.startsWith('0x') && mintAddress.length === 42;
    const chainId = isEVM ? 'ethereum' : 'solana';

    // Import Zerion API client from CLI lib
    const { default: axios } = await import('axios');
    const ZERION_BASE = 'https://api.zerion.io/v1';

    const zerion = axios.create({
      baseURL: ZERION_BASE,
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.ZERION_API_KEY}:`).toString('base64')}`,
        Accept: 'application/json',
      },
    });

    const { data } = await zerion.get('/fungibles', {
      params: {
        'filter[implementation_address]': mintAddress,
        'filter[chain_id]': chainId,
        currency: 'usd',
      },
    });

    const fungible = data?.data?.[0];
    if (!fungible) throw new Error('Token not found');

    const attr = fungible?.attributes ?? {};
    const nativeCurrency = NATIVE_CURRENCY[chainId] ?? 'ETH';

    return {
      name: attr?.name ?? 'Unknown',
      symbol: attr?.symbol ?? '???',
      price: attr?.market_data?.price ?? 0,
      change24h: attr?.market_data?.changes?.percent_1d ?? 0,
      volume24h: attr?.market_data?.volume_24h ?? 0,
      liquidity: attr?.market_data?.total_liquidity ?? 0,
      verified: attr?.flags?.verified ?? false,
      chain: chainId,
      nativeCurrency,
    };
  } catch (err) {
    console.error('[swapper] Token info failed:', err.message);
    throw new Error('Token not found. Check the contract address.');
  }
}