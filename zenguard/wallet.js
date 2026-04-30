import { Keypair } from '@solana/web3.js';
import { ethers } from 'ethers';
import bs58 from 'bs58';
import { encrypt, decrypt } from './crypto.js';

// ─── SOLANA ───────────────────────────────────────────────────────────────────

export function importSolanaWallet(privateKeyInput) {
  try {
    let secretKey;
    const input = privateKeyInput.trim();

    if (input.startsWith('[')) {
      // Byte array format: [1,2,3,...]
      const arr = JSON.parse(input);
      secretKey = Uint8Array.from(arr);
    } else if (/^[0-9a-fA-F]{128}$/.test(input)) {
      // Hex format
      secretKey = Buffer.from(input, 'hex');
    } else {
      // Base58 format — standard and what Backpack uses
      secretKey = bs58.decode(input);
    }

    const keypair = Keypair.fromSecretKey(secretKey);
    const base58Key = bs58.encode(secretKey);
    const encrypted = encrypt(base58Key);

    return {
      address: keypair.publicKey.toString(),
      encrypted,
      chain: 'solana',
    };
  } catch (err) {
    console.error('[wallet] Import error:', err.message);
    throw new Error('Invalid Solana private key.');
  }
}

export function generateSolanaWallet() {
  const keypair = Keypair.generate();
  const privateKey = bs58.encode(keypair.secretKey);
  const encrypted = encrypt(privateKey);

  return {
    address: keypair.publicKey.toString(),
    privateKey, // shown to user once then discarded
    encrypted,
    chain: 'solana',
  };
}


export function generateEVMWallet() {
  const wallet = ethers.Wallet.createRandom();
  const encrypted = encrypt(wallet.privateKey);

  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic?.phrase ?? null,
    encrypted,
    chain: 'evm',
  };
}


export function getSolanaKeypair(encryptedKey) {
  const raw = decrypt(encryptedKey);
  const secretKey = bs58.decode(raw);
  return Keypair.fromSecretKey(secretKey);
}

// ─── EVM ──────────────────────────────────────────────────────────────────────

export function importEVMWallet(privateKey) {
  try {
    const wallet = new ethers.Wallet(privateKey.trim());
    const encrypted = encrypt(privateKey.trim());
    return {
      address: wallet.address,
      encrypted,
      chain: 'evm',
    };
  } catch (err) {
    console.error('[wallet] EVM import error:', err.message);
    throw new Error('Invalid EVM private key.');
  }
}

export function getEVMWallet(encryptedKey) {
  const raw = decrypt(encryptedKey);
  return new ethers.Wallet(raw);
}

export function deriveAddress(encryptedKey, chain) {
  if (chain === 'solana') {
    const keypair = getSolanaKeypair(encryptedKey);
    return keypair.publicKey.toString();
  } else {
    const wallet = getEVMWallet(encryptedKey);
    return wallet.address;
  }
}