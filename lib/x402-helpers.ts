import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createQuicknodeX402Client, type QuicknodeX402Client } from '@quicknode/x402';
import bs58 from 'bs58';
import { config } from 'dotenv';
import nacl from 'tweetnacl';
import { defineChain, formatUnits, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, polygon, polygonAmoy, xLayer } from 'viem/chains';

// Load environment variables
config();

const xlayerTestnet = defineChain({
  id: 1952,
  name: 'X Layer Testnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: ['https://testrpc.xlayer.tech'] } },
});

// ── EVM Chain Config Registry ────────────────────────────

/** EVM chain configurations keyed by human-readable slug */
export const EVM_CHAINS = {
  'base-sepolia': {
    caip2: 'eip155:84532',
    numericId: 84532,
    viemChain: baseSepolia,
    paymentToken: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    rpcSlug: 'base-sepolia',
    docsDemo: 'https://docs-demo.base-sepolia.quiknode.pro/',
    hasFaucet: true,
  },
  'base-mainnet': {
    caip2: 'eip155:8453',
    numericId: 8453,
    viemChain: base,
    paymentToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    rpcSlug: 'base-mainnet',
    docsDemo: 'https://docs-demo.base-mainnet.quiknode.pro/',
    hasFaucet: false,
  },
  'polygon-amoy': {
    caip2: 'eip155:80002',
    numericId: 80002,
    viemChain: polygonAmoy,
    paymentToken: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
    rpcSlug: 'matic-amoy',
    docsDemo: 'https://docs-demo.matic-amoy.quiknode.pro/',
    hasFaucet: false,
  },
  'polygon-mainnet': {
    caip2: 'eip155:137',
    numericId: 137,
    viemChain: polygon,
    paymentToken: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    rpcSlug: 'matic-mainnet',
    docsDemo: 'https://docs-demo.matic.quiknode.pro/',
    hasFaucet: false,
  },
  'xlayer-mainnet': {
    caip2: 'eip155:196',
    numericId: 196,
    viemChain: xLayer,
    paymentToken: '0x4ae46a509F6b1D9056937BA4500cb143933D2dc8',
    rpcSlug: 'xlayer-mainnet',
    docsDemo: 'https://docs-demo.xlayer-mainnet.quiknode.pro/',
    hasFaucet: false,
  },
  'xlayer-testnet': {
    caip2: 'eip155:1952',
    numericId: 1952,
    viemChain: xlayerTestnet,
    paymentToken: '0xF0863D7A29a55d0c4263c11bFac754312ff078DF',
    rpcSlug: 'xlayer-testnet',
    docsDemo: 'https://docs-demo.xlayer-testnet.quiknode.pro/',
    hasFaucet: false,
  },
} as const;

export type EvmChainSlug = keyof typeof EVM_CHAINS;

export function getEvmChain(): (typeof EVM_CHAINS)[EvmChainSlug] {
  const slug = (process.env.X402_EVM_CHAIN ?? 'base-sepolia') as EvmChainSlug;
  const chain = EVM_CHAINS[slug];
  if (!chain) {
    throw new Error(
      `Unknown X402_EVM_CHAIN="${slug}". Valid: ${Object.keys(EVM_CHAINS).join(', ')}`,
    );
  }
  return chain;
}

// ── Solana Chain Config Registry ─────────────────────────

/** Solana chain configurations keyed by human-readable slug */
export const SOLANA_CHAINS = {
  'solana-devnet': {
    caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    chainRef: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    paymentToken: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    rpcSlug: 'solana-devnet',
  },
  'solana-mainnet': {
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    chainRef: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    paymentToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    rpcSlug: 'solana-mainnet',
  },
} as const;

export type SolanaChainSlug = keyof typeof SOLANA_CHAINS;

export function getSolanaChain(): (typeof SOLANA_CHAINS)[SolanaChainSlug] {
  const slug = (process.env.X402_SOLANA_CHAIN ?? 'solana-devnet') as SolanaChainSlug;
  const chain = SOLANA_CHAINS[slug];
  if (!chain) {
    throw new Error(
      `Unknown X402_SOLANA_CHAIN="${slug}". Valid: ${Object.keys(SOLANA_CHAINS).join(', ')}`,
    );
  }
  return chain;
}

// Lazy-evaluated chain configs — deferred to first access so importing the
// module never throws (even when the env var is invalid / not yet set).
let _evmChain: (typeof EVM_CHAINS)[EvmChainSlug] | undefined;
let _solanaChain: (typeof SOLANA_CHAINS)[SolanaChainSlug] | undefined;

function lazyEvmChain() {
  if (!_evmChain) _evmChain = getEvmChain();
  return _evmChain;
}

function lazySolanaChain() {
  if (!_solanaChain) _solanaChain = getSolanaChain();
  return _solanaChain;
}

// ── Constants (lazy — evaluated on first access) ─────────
export const ENV_FILE = '.env';
export const TOKEN_DECIMALS = 6;
export const MIN_TOKEN_BALANCE = BigInt(5000); // $0.005 = 5000 raw units

export const X402_BASE_URL = process.env.X402_BASE_URL || 'https://x402.quicknode.com';
export const X402_CREDITS_URL = `${X402_BASE_URL}/credits`;
export const X402_DRIP_URL = `${X402_BASE_URL}/drip`;

export type ChainType = 'evm' | 'solana';

// ── Payment tracking ─────────────────────────────────────
export type PaymentTracker = {
  paymentResponseCount: number;
  successfulPaymentCount: number;
  totalFetchCount: number;
  /** When set, the x402 payment wrapper is bypassed once this many payments have been made.
   *  402 responses will pass through to the caller instead of triggering auto-payment. */
  maxPayments?: number;
};

export function createPaymentTracker(): PaymentTracker {
  return { paymentResponseCount: 0, successfulPaymentCount: 0, totalFetchCount: 0 };
}

// ── Wallet (EVM) ─────────────────────────────────────────
export function getOrCreatePrivateKey(): Hex {
  if (existsSync(ENV_FILE)) {
    const envContent = readFileSync(ENV_FILE, 'utf8');
    const match = envContent.match(/^PRIVATE_KEY=(.+)/m);
    if (match?.[1]) {
      console.log('   Loaded existing wallet from .env');
      return match[1].trim() as Hex;
    }
  }

  const privateKey = generatePrivateKey();
  const existingContent = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const separator = existingContent && !existingContent.endsWith('\n') ? '\n' : '';
  writeFileSync(ENV_FILE, `${existingContent}${separator}PRIVATE_KEY=${privateKey}\n`);
  console.log('   Generated new wallet and saved to .env');
  return privateKey;
}

// ── Wallet (Solana) ──────────────────────────────────────
export function getOrCreateSolanaPrivateKey(): string {
  if (existsSync(ENV_FILE)) {
    const envContent = readFileSync(ENV_FILE, 'utf8');
    const match = envContent.match(/^SOLANA_PRIVATE_KEY=(.+)/m);
    if (match?.[1]) {
      console.log('   Loaded existing Solana wallet from .env');
      return match[1].trim();
    }
  }

  const keypair = nacl.sign.keyPair();
  const secretKeyBase58 = bs58.encode(Buffer.from(keypair.secretKey));
  const existingContent = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const separator = existingContent && !existingContent.endsWith('\n') ? '\n' : '';
  writeFileSync(ENV_FILE, `${existingContent}${separator}SOLANA_PRIVATE_KEY=${secretKeyBase58}\n`);
  console.log('   Generated new Solana wallet and saved to .env');
  return secretKeyBase58;
}

// ── Chain Detection ───────────────────────────────────────
export function detectChainType(): ChainType {
  // Explicit X402_EVM_CHAIN takes priority over .env heuristic
  if (process.env.X402_EVM_CHAIN) return 'evm';
  if (existsSync(ENV_FILE)) {
    const envContent = readFileSync(ENV_FILE, 'utf8');
    if (envContent.match(/^SOLANA_PRIVATE_KEY=(.+)/m)) return 'solana';
  }
  return 'evm';
}

// ── Credits ──────────────────────────────────────────────

// The /credits endpoint is rate-limited in production, so the example scripts
// only call it at startup and in the final summary — never inside tight loops.
// A 429 backoff guard still protects against accidental bursts.
let _creditsCache: { accountId: string; credits: number } | null = null;
let _credits429BackoffUntilMs = 0;
let _creditsInflight: Promise<{ accountId: string; credits: number }> | null = null;
const CREDITS_429_BACKOFF_MS = 10_000;

async function _fetchCreditsRaw(token: string): Promise<{ accountId: string; credits: number }> {
  const response = await fetch(X402_CREDITS_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 429) {
    _credits429BackoffUntilMs = Date.now() + CREDITS_429_BACKOFF_MS;
    if (_creditsCache) return _creditsCache;
    throw new Error('Rate limited (429) and no cached credits available');
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error('Token expired - re-authentication required');
    throw new Error(`Failed to get credits: ${response.status} ${await response.text()}`);
  }

  const data: { accountId: string; credits: number } = await response.json();
  _creditsCache = data;
  return data;
}

export async function getCredits(
  getToken: () => string | null,
  opts?: { forceRefresh?: boolean },
): Promise<{ accountId: string; credits: number }> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated - call authenticate() first');

  // During 429 backoff, return last-known value (unless forceRefresh)
  if (!opts?.forceRefresh && _creditsCache && Date.now() < _credits429BackoffUntilMs) {
    return _creditsCache;
  }

  // Dedup in-flight requests (skip dedup when forceRefresh so we always get fresh data)
  if (!opts?.forceRefresh && _creditsInflight) return _creditsInflight;

  const promise = _fetchCreditsRaw(token).finally(() => {
    if (_creditsInflight === promise) _creditsInflight = null;
  });
  _creditsInflight = promise;

  return _creditsInflight;
}

// ── Token Balance ────────────────────────────────────────
export async function getTokenBalanceRaw(address: string): Promise<bigint> {
  const paddedAddress = address.slice(2).toLowerCase().padStart(64, '0');
  const data = `0x70a08231${paddedAddress}`;

  const response = await fetch(lazyEvmChain().docsDemo, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'eth_call',
      params: [{ to: lazyEvmChain().paymentToken, data }, 'latest'],
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  if (result.error) throw new Error(`eth_call failed: ${result.error.message}`);
  if (result.result === undefined || result.result === null) {
    throw new Error('eth_call returned no result (rate limited?)');
  }

  return BigInt(result.result);
}

// ── Faucet ───────────────────────────────────────────────
export async function requestDrip(getToken: () => string | null): Promise<boolean> {
  console.log('   Requesting tokens from x402 drip...');

  const token = getToken();
  if (!token) {
    console.error('   ERROR: Not authenticated');
    return false;
  }

  try {
    const response = await fetch(X402_DRIP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`   ERROR: Faucet request failed: ${response.status} - ${text}`);
      return false;
    }

    const data = (await response.json()) as {
      accountId: string;
      walletAddress: string;
      transactionHash: string;
    };
    console.log(`   Faucet request successful: tx ${data.transactionHash}`);
    return true;
  } catch (error) {
    console.error('   ERROR: Faucet request error:', error);
    return false;
  }
}

export async function waitForBalance(
  address: string,
  minBalance: bigint,
  maxWaitMs = 60000,
): Promise<boolean> {
  const startTime = Date.now();
  const checkIntervalMs = 5000;

  console.log(`   Waiting for token balance >= ${formatUnits(minBalance, TOKEN_DECIMALS)}...`);

  while (Date.now() - startTime < maxWaitMs) {
    const balance = await getTokenBalanceRaw(address);
    console.log(`   Current balance: ${formatUnits(balance, TOKEN_DECIMALS)}`);
    if (balance >= minBalance) return true;
    await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
  }

  return false;
}

// ── Ensure funded ────────────────────────────────────────
export async function ensureFunded(
  address: string,
  getToken: () => string | null,
): Promise<bigint> {
  let tokenBalance = await getTokenBalanceRaw(address);
  console.log(`   Token balance: ${formatUnits(tokenBalance, TOKEN_DECIMALS)}`);

  if (tokenBalance < MIN_TOKEN_BALANCE) {
    if (!lazyEvmChain().hasFaucet) {
      console.log(
        `\n   Insufficient token balance (need >= ${formatUnits(MIN_TOKEN_BALANCE, TOKEN_DECIMALS)})`,
      );
      console.log('   No faucet available for this chain. Ensure wallet is pre-funded.');
      console.log(`   Fund manually: ${address}`);
      process.exit(1);
    }

    console.log(
      `\n   Insufficient token balance (need >= ${formatUnits(MIN_TOKEN_BALANCE, TOKEN_DECIMALS)})`,
    );
    const faucetSuccess = await requestDrip(getToken);
    if (faucetSuccess) {
      const gotBalance = await waitForBalance(address, MIN_TOKEN_BALANCE);
      if (!gotBalance) {
        console.log('\n   Timed out waiting for faucet funds.');
        console.log(`   Wallet address: ${address}`);
        process.exit(1);
      }
      tokenBalance = await getTokenBalanceRaw(address);
      console.log(`   Updated token balance: ${formatUnits(tokenBalance, TOKEN_DECIMALS)}`);
    } else {
      console.log('\n   Could not get funds from faucet.');
      console.log(`   Fund manually: ${address}`);
      process.exit(1);
    }
  }

  return tokenBalance;
}

// ── @quicknode/x402 Client ───────────────────────────────

export type PaymentModel = 'credit-drawdown' | 'pay-per-request';

function getPaymentModel(): PaymentModel {
  const model = process.env.X402_PAYMENT_MODEL;
  if (model === 'pay-per-request') return 'pay-per-request';
  return 'credit-drawdown';
}

/** Create a @quicknode/x402 client configured for the detected chain type and payment model. */
export async function createClientForChain(paymentModel?: PaymentModel): Promise<{
  client: QuicknodeX402Client;
  chainType: ChainType;
  walletAddress: string;
  startBalance: bigint;
  paymentModel: PaymentModel;
}> {
  const chainType = detectChainType();
  const model = paymentModel ?? getPaymentModel();
  const isPerRequest = model === 'pay-per-request';

  console.log(`   Payment model: ${model}`);

  if (chainType === 'solana') {
    const secretKeyBase58 = getOrCreateSolanaPrivateKey();
    const secretKey = bs58.decode(secretKeyBase58);
    const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    const address = bs58.encode(Buffer.from(keypair.publicKey));
    console.log(`   Wallet: ${address} (Solana)\n`);

    const client = await createQuicknodeX402Client({
      baseUrl: X402_BASE_URL,
      network: lazySolanaChain().caip2,
      svmPrivateKey: secretKeyBase58,
      paymentModel: model,
      preAuth: !isPerRequest,
    });

    if (!isPerRequest) {
      console.log(`   Authenticated as ${client.getAccountId()}`);
    }
    return { client, chainType, walletAddress: address, startBalance: 0n, paymentModel: model };
  }

  // EVM path
  const privateKey = getOrCreatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`   Wallet: ${account.address}\n`);

  const client = await createQuicknodeX402Client({
    baseUrl: X402_BASE_URL,
    network: lazyEvmChain().caip2,
    evmPrivateKey: privateKey,
    paymentModel: model,
    preAuth: !isPerRequest,
  });

  if (!isPerRequest) {
    console.log(`   Authenticated as ${client.getAccountId()}`);
  }

  // Per-request users still need token balance (to pay per request), but skip credit checks
  const startBalance = await ensureFunded(account.address, () => client.getToken());

  return { client, chainType, walletAddress: account.address, startBalance, paymentModel: model };
}

// ── Tracking Fetch ───────────────────────────────────────

/** Wraps client.fetch with payment tracking and maxPayments cap. */
export function createTrackingFetch(
  client: QuicknodeX402Client,
  tracker: PaymentTracker,
): typeof globalThis.fetch {
  // Bearer-only fetch for when maxPayments cap is reached — 402 passes through
  const bearerOnlyFetch: typeof globalThis.fetch = async (input, init) => {
    if (input instanceof Request) {
      const request = input.clone();
      const token = client.getToken();
      if (token) request.headers.set('Authorization', `Bearer ${token}`);
      return globalThis.fetch(request);
    }
    const headers = new Headers(init?.headers);
    const token = client.getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return globalThis.fetch(input, { ...init, headers });
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const atCap =
      tracker.maxPayments !== undefined && tracker.successfulPaymentCount >= tracker.maxPayments;
    const fetchFn = atCap ? bearerOnlyFetch : client.fetch;
    const response = await fetchFn(input, init);
    tracker.totalFetchCount++;

    // Track PAYMENT-RESPONSE headers for display
    const paymentHeader = response.headers.get('PAYMENT-RESPONSE');
    if (paymentHeader) {
      tracker.paymentResponseCount++;
      try {
        const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
        if (decoded.success) {
          tracker.successfulPaymentCount++;
          console.log(
            `   PAYMENT-RESPONSE #${tracker.paymentResponseCount} - SUCCESS tx: ${decoded.transaction?.slice(0, 20)}...`,
          );
        } else {
          console.log(
            `   PAYMENT-RESPONSE #${tracker.paymentResponseCount} - FAILED: ${decoded.errorReason || 'unknown'}`,
          );
        }
      } catch {
        console.log(
          `   PAYMENT-RESPONSE #${tracker.paymentResponseCount} - raw: ${paymentHeader.slice(0, 50)}...`,
        );
      }
    }

    return response;
  };
}

// ── Example Setup (shared across all example scripts) ─────
export type ExampleSetup = {
  chainType: ChainType;
  walletAddress: string;
  /** EVM token balance (0n for Solana — no EVM balance to track). */
  startBalance: bigint;
  /** The @quicknode/x402 client instance. */
  client: QuicknodeX402Client;
  /** Tracking fetch that wraps client.fetch with payment counting + maxPayments cap. */
  x402Fetch: typeof globalThis.fetch;
  /** Active payment model. */
  paymentModel: PaymentModel;
};

export async function setupExample(tracker: PaymentTracker): Promise<ExampleSetup> {
  const { client, chainType, walletAddress, startBalance, paymentModel } =
    await createClientForChain();
  const x402Fetch = createTrackingFetch(client, tracker);
  return { chainType, walletAddress, startBalance, client, x402Fetch, paymentModel };
}
