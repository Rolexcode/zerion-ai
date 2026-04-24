import axios from 'axios';

const BASE_URL = 'https://api.zerion.io/v1';
const MIN_VOLUME_USD = 10_000;
const MIN_LIQUIDITY_USD = 5_000;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Basic ${Buffer.from(`${process.env.ZERION_API_KEY}:`).toString('base64')}`,
    Accept: 'application/json',
  },
});

export async function getPortfolio(address) {
  const res = await client.get(`/wallets/${address}/portfolio`);
  return res.data?.data?.attributes ?? {};
}

export async function getPositions(address) {
  const res = await client.get(`/wallets/${address}/positions`, {
    params: {
      'filter[position_types]': 'wallet',
      'filter[trash]': 'only_non_trash',
      currency: 'usd',
    },
  });

  const positions = res.data?.data ?? [];


return positions.filter((p) => {
    const value = p?.attributes?.value ?? 0;
    const verified = p?.attributes?.fungible_info?.flags?.verified ?? false;
    // Keep verified tokens or positions worth more than $1
    return verified || value > 1;
  });
}

export function formatUSD(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

export function shortenAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}