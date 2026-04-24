import { execSync } from 'child_process';

const SLIPPAGE = 2;
const STABLE = 'USDC';

export async function executeProtectiveSwap(token, amount, chain = 'solana') {
  if (!token || amount <= 0) {
    throw new Error('Invalid swap parameters');
  }

  try {
    const raw = execSync(
      `zerion swap ${token} ${STABLE} ${amount} --chain ${chain} --slippage ${SLIPPAGE} --json`,
      { env: process.env }
    ).toString();

    const result = JSON.parse(raw);

    return {
      txHash: result?.transaction?.hash ?? 'pending',
      fromToken: token,
      toToken: STABLE,
      amount,
      chain,
      status: result?.status ?? 'submitted',
    };
  } catch (err) {
    console.error('[executor] Swap failed:', err.message);
    throw new Error(`Swap execution failed: ${err.message}`);
  }
}

export async function executeBridge(token, amount, fromChain, toChain) {
  try {
    const raw = execSync(
      `zerion bridge ${token} ${toChain} ${amount} --from-chain ${fromChain} --json`,
      { env: process.env }
    ).toString();

    const result = JSON.parse(raw);

    return {
      txHash: result?.transaction?.hash ?? 'pending',
      token,
      amount,
      fromChain,
      toChain,
      status: result?.status ?? 'submitted',
    };
  } catch (err) {
    console.error('[executor] Bridge failed:', err.message);
    throw new Error(`Bridge execution failed: ${err.message}`);
  }
}