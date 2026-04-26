import axios from 'axios';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { ethers } from 'ethers';
import { getSolanaKeypair, getEVMWallet } from './wallet.js';

const ZERION_BASE = 'https://api.zerion.io/v1';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_EVM = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const zerion = axios.create({
  baseURL: ZERION_BASE,
  headers: {
    Authorization: `Basic ${Buffer.from(`${process.env.ZERION_API_KEY}:`).toString('base64')}`,
    Accept: 'application/json',
  },
});

const connection = new Connection(
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  'confirmed'
);

// ─── SOLANA SWAP ──────────────────────────────────────────────────────────────

export async function swapToUSDCSolana(encryptedKey, tokenMint, amount) {
  const keypair = getSolanaKeypair(encryptedKey);

  // Get swap quote from Zerion
  const { data: quoteData } = await zerion.get('/swap/quote', {
    params: {
      from_chain: 'solana',
      to_chain: 'solana',
      from_token: tokenMint,
      to_token: USDC_SOLANA,
      amount,
      slippage: 0.02,
      from_address: keypair.publicKey.toString(),
    },
  });

  const txData = quoteData?.data?.attributes?.transaction;
  if (!txData) throw new Error('No swap transaction returned from Zerion.');

  // Deserialize and sign
  const txBuffer = Buffer.from(txData.data, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuffer);
  transaction.sign([keypair]);

  // Submit
  const txHash = await connection.sendRawTransaction(
    transaction.serialize(),
    { skipPreflight: false, maxRetries: 3 }
  );

  await connection.confirmTransaction(txHash, 'confirmed');
  return txHash;
}

// ─── EVM SWAP ─────────────────────────────────────────────────────────────────

export async function swapToUSDCEVM(encryptedKey, chain, tokenAddress, amount) {
  const wallet = getEVMWallet(encryptedKey);

  const RPC_URLS = {
    ethereum: 'https://eth.llamarpc.com',
    base: 'https://mainnet.base.org',
    arbitrum: 'https://arb1.llamarpc.com',
    polygon: 'https://polygon.llamarpc.com',
    optimism: 'https://mainnet.optimism.io',
  };

  const provider = new ethers.JsonRpcProvider(RPC_URLS[chain] || RPC_URLS.ethereum);
  const connectedWallet = wallet.connect(provider);

  // Get swap quote from Zerion
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

  // Sign and submit
  const tx = await connectedWallet.sendTransaction({
    to: txData.to,
    data: txData.data,
    value: txData.value ?? 0,
    gasLimit: txData.gas ?? 300000,
  });

  await tx.wait();
  return tx.hash;
}