import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';
import { decrypt } from './crypto.js';

const connection = new Connection(
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  'confirmed'
);

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';

export function getKeypairFromEncrypted(encryptedKey) {
  const privateKey = decrypt(encryptedKey);
  const secretKey = bs58.decode(privateKey);
  return Keypair.fromSecretKey(secretKey);
}

export async function getQuote(inputMint, outputMint, amount) {
  const res = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
    params: {
      inputMint,
      outputMint,
      amount,
      slippageBps: 200, // 2% slippage
      onlyDirectRoutes: false,
    },
  });
  return res.data;
}

export async function executeSwap(encryptedKey, inputMint, amount) {
  const keypair = getKeypairFromEncrypted(encryptedKey);

  // Get best swap route via Jupiter
  const quote = await getQuote(inputMint, USDC_MINT, amount);

  // Get swap transaction from Jupiter
  const { data } = await axios.post(`${JUPITER_QUOTE_API}/swap`, {
    quoteResponse: quote,
    userPublicKey: keypair.publicKey.toString(),
    wrapAndUnwrapSol: true,
    prioritizationFeeLamports: 'auto', // Priority fees for fast execution
  });

  // Deserialize and sign transaction
  const swapTransactionBuf = Buffer.from(data.swapTransaction, 'base64');
  const transaction = Transaction.from(swapTransactionBuf);
  transaction.sign(keypair);

  // Submit with priority
  const rawTransaction = transaction.serialize();
  const txHash = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: 'confirmed',
  });

  await connection.confirmTransaction(txHash, 'confirmed');

  return txHash;
}

export async function getWalletAddress(encryptedKey) {
  const keypair = getKeypairFromEncrypted(encryptedKey);
  return keypair.publicKey.toString();
}