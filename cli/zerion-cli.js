#!/usr/bin/env node

import { parseFlags, basicAuthHeader, validateChain, validatePositions, resolvePositionFilter, summarizeAnalyze } from "./lib.mjs";

const API_BASE_DEFAULT = "https://api.zerion.io/v1";
const DEFAULT_TX_LIMIT = 10;
const API_KEY = process.env.ZERION_API_KEY || "";
const USE_X402 = process.env.ZERION_X402 === "true";
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || "";
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || "";
const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY || "";
const PREFER_SOLANA = process.env.ZERION_X402_PREFER_SOLANA === "true";

let debug = false;
function debugLog(...args) {
  if (debug) process.stderr.write(`[debug] ${args.join(" ")}\n`);
}

function isEvmKey(key) {
  return key.startsWith("0x");
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
// Solana keypairs are 64 bytes; base58-encoded they are 87-88 characters
function isSolanaKey(key) {
  return !key.startsWith("0x") && BASE58_RE.test(key) && key.length >= 80;
}

const HAS_SOLANA_KEY = !!(SOLANA_PRIVATE_KEY || isSolanaKey(WALLET_PRIVATE_KEY));

let _x402Fetch = null;
async function getX402Fetch() {
  if (_x402Fetch) return _x402Fetch;

  // Resolve keys: dedicated vars take precedence, fall back to WALLET_PRIVATE_KEY
  const evmKey = EVM_PRIVATE_KEY || (isEvmKey(WALLET_PRIVATE_KEY) ? WALLET_PRIVATE_KEY : "");
  const solKey = SOLANA_PRIVATE_KEY || (isSolanaKey(WALLET_PRIVATE_KEY) ? WALLET_PRIVATE_KEY : "");

  if (!evmKey && !solKey) {
    throw new Error(
      "No valid private key found for x402 mode. Set WALLET_PRIVATE_KEY (0x-hex for EVM, base58 for Solana), " +
      "or set EVM_PRIVATE_KEY and/or SOLANA_PRIVATE_KEY."
    );
  }

  const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
  const client = new x402Client();

  if (EVM_PRIVATE_KEY && !isEvmKey(EVM_PRIVATE_KEY)) {
    throw new Error("EVM_PRIVATE_KEY must be a 0x-prefixed hex string.");
  }

  if (evmKey) {
    const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
    const { privateKeyToAccount } = await import("viem/accounts");
    const signer = privateKeyToAccount(evmKey);
    registerExactEvmScheme(client, { signer });
    debugLog("x402 registered: EVM (Base)");
  }

  if (solKey) {
    const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
    const { createKeyPairSignerFromBytes, getBase58Codec } = await import("@solana/kit");
    const keyBytes = getBase58Codec().encode(solKey);
    const signer = await createKeyPairSignerFromBytes(keyBytes);
    registerExactSvmScheme(client, { signer });
    debugLog(`x402 registered: Solana (${signer.address})`);
  }

  if (PREFER_SOLANA && !(evmKey && solKey)) {
    debugLog("x402 warning: ZERION_X402_PREFER_SOLANA=true has no effect unless both EVM and Solana keys are set");
  }

  if (evmKey && solKey && PREFER_SOLANA) {
    client.registerPolicy((version, reqs) => {
      const sol = reqs.filter(r => r.network.startsWith("solana:"));
      const others = reqs.filter(r => !r.network.startsWith("solana:"));
      return [...sol, ...others];
    });
    debugLog("x402 policy: prefer Solana");
  }

  _x402Fetch = wrapFetchWithPayment(fetch, client);
  return _x402Fetch;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printError(code, message, details = {}) {
  process.stderr.write(`${JSON.stringify({ error: { code, message, ...details } }, null, 2)}\n`);
}

function usage() {
  print({
    name: "zerion-cli",
    usage: [
      "zerion-cli wallet analyze <address> [--positions all|simple|defi] [--x402]",
      "zerion-cli wallet portfolio <address> [--x402]",
      "zerion-cli wallet positions <address> [--chain ethereum] [--positions all|simple|defi] [--x402]",
      "zerion-cli wallet transactions <address> [--limit 10] [--chain ethereum] [--x402]",
      "zerion-cli wallet pnl <address> [--x402]",
      "zerion-cli chains list [--x402]"
    ],
    env: ["ZERION_API_KEY", "ZERION_API_BASE (optional)", "ZERION_X402=true (use x402 pay-per-call)", "WALLET_PRIVATE_KEY (x402: single key, auto-detected format)", "EVM_PRIVATE_KEY (x402: 0x-hex EVM key, overrides WALLET_PRIVATE_KEY for EVM)", "SOLANA_PRIVATE_KEY (x402: base58 Solana key, overrides WALLET_PRIVATE_KEY for Solana)", "ZERION_X402_PREFER_SOLANA=true (prefer Solana when both keys are set)"],
    x402: {
      description: "Pay $0.01 USDC per request. EVM (Base) or Solana supported — auto-detected from key format.",
      docs: "https://developers.zerion.io/reference/x402"
    }
  });
}

function ensureKey(useX402) {
  if (useX402) return; // x402 doesn't require an API key
  if (!API_KEY) {
    printError("missing_api_key", "ZERION_API_KEY is required. Alternatively, use --x402 for pay-per-call.");
    process.exit(1);
  }
}

function validateChainOrExit(chain) {
  const err = validateChain(chain);
  if (err) {
    printError(err.code, err.message, { supportedChains: err.supportedChains });
    process.exit(1);
  }
}

function validatePositionsOrExit(positions) {
  const err = validatePositions(positions);
  if (err) {
    printError(err.code, err.message, { supportedValues: err.supportedValues });
    process.exit(1);
  }
}

async function fetchAPI(pathname, params = {}, useX402 = false) {
  const apiBase = process.env.ZERION_API_BASE || API_BASE_DEFAULT;

  const url = new URL(`${apiBase}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const headers = { Accept: "application/json" };

  if (!useX402) {
    headers.Authorization = basicAuthHeader(API_KEY);
  }

  debugLog(`${useX402 ? "x402" : "api"} GET ${url}`);

  const fetchFn = useX402 ? await getX402Fetch() : fetch;
  let response = await fetchFn(url, { headers });

  // Retry on 402 only for Solana — facilitator fee-payer rotation can cause transient failures
  for (let attempt = 1; useX402 && HAS_SOLANA_KEY && response.status === 402 && attempt <= 2; attempt++) {
    debugLog(`x402 payment failed, retry ${attempt}/2...`);
    response = await fetchFn(url, { headers });
  }

  debugLog(`response ${response.status} ${url}`);

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    debugLog(`error body: ${text.slice(0, 500)}`);
    const err = new Error(`Zerion API request failed with status ${response.status}.`);
    err.status = response.status;
    err.response = payload;
    throw err;
  }

  return payload;
}

async function request(pathname, params = {}, useX402 = false) {
  ensureKey(useX402);
  try {
    return await fetchAPI(pathname, params, useX402);
  } catch (err) {
    printError("api_error", err.message, {
      status: err.status,
      response: err.response
    });
    process.exit(1);
  }
}

async function getPortfolio(address, useX402 = false) {
  return request(`/wallets/${encodeURIComponent(address)}/portfolio`, {}, useX402);
}

async function getPositions(address, chain, positionFilter, useX402 = false) {
  const params = { "filter[positions]": resolvePositionFilter(positionFilter) };
  if (chain) params["filter[chain_ids]"] = chain;
  return request(`/wallets/${encodeURIComponent(address)}/positions/`, params, useX402);
}

async function getTransactions(address, chain, limit, useX402 = false) {
  const params = {
    "page[size]": limit || DEFAULT_TX_LIMIT
  };
  if (chain) params["filter[chain_ids]"] = chain;
  return request(`/wallets/${encodeURIComponent(address)}/transactions/`, params, useX402);
}

async function getPnl(address, useX402 = false) {
  return request(`/wallets/${encodeURIComponent(address)}/pnl`, {}, useX402);
}

async function listChains(useX402 = false) {
  return request("/chains/", {}, useX402);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }

  const { rest, flags } = parseFlags(argv);
  const [scope, action, target] = rest;

  // x402 mode: pay-per-call, no API key needed
  const useX402 = flags.x402 === true || USE_X402;
  debug = flags.debug === true;

  if (scope === "chains" && action === "list") {
    print(await listChains(useX402));
    return;
  }

  if (scope !== "wallet" || !action) {
    usage();
    process.exit(1);
  }

  if (!target) {
    printError("missing_wallet", "A wallet address or ENS name is required.");
    process.exit(1);
  }

  validateChainOrExit(flags.chain);
  validatePositionsOrExit(flags.positions);

  switch (action) {
    case "portfolio":
      print(await getPortfolio(target, useX402));
      return;
    case "positions":
      print(await getPositions(target, flags.chain, flags.positions, useX402));
      return;
    case "transactions":
      print(await getTransactions(target, flags.chain, flags.limit, useX402));
      return;
    case "pnl":
      print(await getPnl(target, useX402));
      return;
    case "analyze": {
      ensureKey(useX402);
      const addr = encodeURIComponent(target);
      const txParams = { "page[size]": flags.limit || DEFAULT_TX_LIMIT };
      const posParams = { "filter[positions]": resolvePositionFilter(flags.positions) };
      if (flags.chain) posParams["filter[chain_ids]"] = flags.chain;
      if (flags.chain) txParams["filter[chain_ids]"] = flags.chain;
      const results = await Promise.allSettled([
        fetchAPI(`/wallets/${addr}/portfolio`, {}, useX402),
        fetchAPI(`/wallets/${addr}/positions/`, posParams, useX402),
        fetchAPI(`/wallets/${addr}/transactions/`, txParams, useX402),
        fetchAPI(`/wallets/${addr}/pnl`, {}, useX402)
      ]);
      const labels = ["portfolio", "positions", "transactions", "pnl"];
      const values = results.map((r) => r.status === "fulfilled" ? r.value : null);
      const failures = results
        .map((r, i) => {
          if (r.status === "rejected") {
            debugLog(`${labels[i]} failed: ${r.reason?.message}\n${r.reason?.stack}`);
            return labels[i];
          }
          return null;
        })
        .filter(Boolean);
      const summary = summarizeAnalyze(target, ...values);
      if (failures.length) summary.failures = failures;
      if (useX402) summary.auth = "x402";
      print(summary);
      return;
    }
    default:
      usage();
      process.exit(1);
  }
}

main().catch((error) => {
  printError("unexpected_error", error.message);
  process.exit(1);
});
