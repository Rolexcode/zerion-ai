import { savePolicy, loadPolicy } from './store.js';

const POLICY_CONFIG = {
  drop_20: {
    label: 'Auto-swap if drop > 20%',
    dropThreshold: 0.2,
    spendLimit: null,
    chainLock: null,
  },
  drop_30: {
    label: 'Auto-swap if drop > 30%',
    dropThreshold: 0.3,
    spendLimit: null,
    chainLock: null,
  },
  spend_50: {
    label: 'Max spend $50/day',
    dropThreshold: null,
    spendLimit: 50,
    chainLock: null,
  },
  spend_100: {
    label: 'Max spend $100/day',
    dropThreshold: null,
    spendLimit: 100,
    chainLock: null,
  },
  chain_solana: {
    label: 'Lock to Solana only',
    dropThreshold: null,
    spendLimit: null,
    chainLock: 'solana',
  },
  chain_base: {
    label: 'Lock to Base only',
    dropThreshold: null,
    spendLimit: null,
    chainLock: 'base',
  },
  chain_ethereum: {
    label: 'Lock to Ethereum only',
    dropThreshold: null,
    spendLimit: null,
    chainLock: 'ethereum',
  },
  chain_arbitrum: {
    label: 'Lock to Arbitrum only',
    dropThreshold: null,
    spendLimit: null,
    chainLock: 'arbitrum',
  },
  chain_all: {
    label: 'All chains — no lock',
    dropThreshold: null,
    spendLimit: null,
    chainLock: null,
  },
};

export async function setUserPolicy(userId, wallet, rule) {
  const config = POLICY_CONFIG[rule];
  if (!config) throw new Error(`Unknown policy rule: ${rule}`);

  const data = {
    wallet,
    rule,
    config,
    since: new Date().toISOString(),
    dailySpend: 0,
    lastReset: Date.now(),
  };

  await savePolicy(userId, data);
  return data;
}

export async function getUserPolicy(userId) {
  return await loadPolicy(userId);
}

export async function evaluatePolicy(userId, portfolio, positions) {
  const policy = await loadPolicy(userId);
  if (!policy) return { triggered: false };

  const { config } = policy;

  // Reset daily spend counter after 24hrs
  if (Date.now() - policy.lastReset > 86_400_000) {
    policy.dailySpend = 0;
    policy.lastReset = Date.now();
    await savePolicy(userId, policy);
  }

  // Evaluate drop threshold
  if (config.dropThreshold) {
    for (const position of positions) {
      const change = position?.attributes?.changes?.percent_1d;
      const symbol = position?.attributes?.fungible_info?.symbol;
      const quantity = position?.attributes?.quantity?.float ?? 0;
      const chain = position?.relationships?.chain?.data?.id ?? 'solana';

      if (change && Math.abs(change) >= config.dropThreshold * 100) {
        return {
          triggered: true,
          reason: `${symbol} dropped ${Math.abs(change).toFixed(1)}% in 24h`,
          token: symbol,
          amount: quantity,
          chain,
        };
      }
    }
  }

  // Evaluate daily spend limit
  if (config.spendLimit && policy.dailySpend >= config.spendLimit) {
    return {
      triggered: true,
      reason: `Daily spend limit of $${config.spendLimit} reached`,
      token: null,
      amount: 0,
      chain: null,
    };
  }

  // Evaluate chain lock
  if (config.chainLock) {
    const offChain = positions.find(
      (p) => p?.relationships?.chain?.data?.id !== config.chainLock
    );
    if (offChain) {
      return {
        triggered: true,
        reason: `Position detected outside locked chain (${offChain?.relationships?.chain?.data?.id})`,
        token: offChain?.attributes?.fungible_info?.symbol,
        amount: offChain?.attributes?.quantity?.float ?? 0,
        chain: offChain?.relationships?.chain?.data?.id,
      };
    }
  }

  return { triggered: false };
}