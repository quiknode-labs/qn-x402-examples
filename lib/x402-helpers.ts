import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/signers';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm';
import bs58 from 'bs58';
import { config } from 'dotenv';
import { generateNonce, SiweMessage } from 'siwe';
import nacl from 'tweetnacl';
import { createWalletClient, formatUnits, type Hex, http, type WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// Load environment variables
config();

// ── Constants ────────────────────────────────────────────
export const ENV_FILE = '.env';
export const USDC_CONTRACT_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
export const USDC_DECIMALS = 6;
export const MIN_USDC_BALANCE = BigInt(10000); // $0.01 = 10000 raw units

export const X402_BASE_URL = process.env.X402_BASE_URL || 'https://x402.quicknode.com';
export const X402_AUTH_URL = `${X402_BASE_URL}/auth`;
export const X402_CREDITS_URL = `${X402_BASE_URL}/credits`;
export const X402_DRIP_URL = `${X402_BASE_URL}/drip`;

export const BASE_SEPOLIA_CAIP2 = 'eip155:84532';
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const SOLANA_DEVNET_CHAIN_REF = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

export type ChainType = 'evm' | 'solana';

export const SIWX_STATEMENT =
  'I accept the Quicknode Terms of Service: https://www.quicknode.com/terms';

// Public RPC for balance checks (not metered, no x402)
export const PUBLIC_RPC_URL = 'https://docs-demo.base-sepolia.quiknode.pro/';

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

// ── JWT token state ──────────────────────────────────────
// Shared mutable ref so helpers and callers see the same token
export type TokenRef = { value: string | null };

export function createTokenRef(): TokenRef {
  return { value: null };
}

// ── Wallet ───────────────────────────────────────────────
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

export function createWallet() {
  const privateKey = getOrCreatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  });
  return { privateKey, account, walletClient };
}

// ── SIWE Auth ────────────────────────────────────────────
export async function authenticate(
  walletClient: WalletClient,
  tokenRef: TokenRef,
): Promise<string> {
  console.log('   Authenticating with SIWE...');

  const siweMessage = new SiweMessage({
    domain: new URL(X402_BASE_URL).host,
    address: walletClient.account!.address,
    statement: SIWX_STATEMENT,
    uri: X402_BASE_URL,
    version: '1',
    chainId: BASE_SEPOLIA_CHAIN_ID,
    nonce: generateNonce(),
    issuedAt: new Date().toISOString(),
  });

  const message = siweMessage.prepareMessage();
  const signature = await walletClient.signMessage({
    account: walletClient.account!,
    message,
  });

  const response = await fetch(X402_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Authentication failed: ${JSON.stringify(error)}`);
  }

  const { token, accountId, expiresAt } = (await response.json()) as {
    token: string;
    accountId: string;
    expiresAt: string;
  };

  tokenRef.value = token;
  console.log(`   Authenticated as ${accountId}`);
  console.log(`   Token expires: ${expiresAt}`);

  return token;
}

// ── Credits ──────────────────────────────────────────────
export async function getCredits(
  tokenRef: TokenRef,
): Promise<{ accountId: string; credits: number }> {
  if (!tokenRef.value) throw new Error('Not authenticated - call authenticate() first');

  const response = await fetch(X402_CREDITS_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenRef.value}` },
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('Token expired - re-authentication required');
    throw new Error(`Failed to get credits: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

// ── Credit Poller ────────────────────────────────────────
// Non-blocking credit tracker. Call poll() without await — it fires a
// background HTTP request that updates .credits and .delta when it resolves.
// Used by WebSocket where awaiting getCredits() on every event blocks the
// message handler and causes burst-pause-burst output.
export type CreditPoller = {
  /** Most recently observed credit count. */
  credits: number;
  /** Delta string for display, e.g. " (-1)" or " (+95)". Empty when unchanged. */
  delta: string;
  /** Fire-and-forget: starts a background credit fetch. */
  poll(): void;
};

export function createCreditPoller(tokenRef: TokenRef): CreditPoller {
  let latest = 0;
  let deltaStr = '';
  let inflight = false;

  return {
    get credits() {
      return latest;
    },
    set credits(v: number) {
      latest = v;
    },
    get delta() {
      const d = deltaStr;
      // Clear after reading so the delta only shows once per update
      deltaStr = '';
      return d;
    },
    poll() {
      // Skip if a request is already in flight — avoids piling up HTTP calls
      if (inflight) return;
      inflight = true;
      getCredits(tokenRef)
        .then((info) => {
          const diff = latest - info.credits;
          if (diff !== 0) {
            deltaStr = ` (${diff > 0 ? '-' : '+'}${Math.abs(diff)})`;
          }
          latest = info.credits;
        })
        .catch(() => {
          // Silently ignore — display stale value
        })
        .finally(() => {
          inflight = false;
        });
    },
  };
}

// ── USDC Balance ─────────────────────────────────────────
export async function getUsdcBalanceRaw(address: string): Promise<bigint> {
  const paddedAddress = address.slice(2).toLowerCase().padStart(64, '0');
  const data = `0x70a08231${paddedAddress}`;

  const response = await fetch(PUBLIC_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'eth_call',
      params: [{ to: USDC_CONTRACT_ADDRESS, data }, 'latest'],
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
export async function requestDripUsdc(tokenRef: TokenRef): Promise<boolean> {
  console.log('   Requesting USDC from x402 drip...');

  if (!tokenRef.value) {
    console.error('   ERROR: Not authenticated');
    return false;
  }

  try {
    const response = await fetch(X402_DRIP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenRef.value}`,
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

  console.log(`   Waiting for USDC balance >= ${formatUnits(minBalance, USDC_DECIMALS)} USDC...`);

  while (Date.now() - startTime < maxWaitMs) {
    const balance = await getUsdcBalanceRaw(address);
    console.log(`   Current balance: ${formatUnits(balance, USDC_DECIMALS)} USDC`);
    if (balance >= minBalance) return true;
    await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
  }

  return false;
}

// ── Ensure funded ────────────────────────────────────────
export async function ensureFunded(address: string, tokenRef: TokenRef): Promise<bigint> {
  let usdcBalance = await getUsdcBalanceRaw(address);
  console.log(`   USDC balance: ${formatUnits(usdcBalance, USDC_DECIMALS)} USDC`);

  if (usdcBalance < MIN_USDC_BALANCE) {
    console.log(
      `\n   Insufficient USDC (need >= ${formatUnits(MIN_USDC_BALANCE, USDC_DECIMALS)} USDC)`,
    );
    const faucetSuccess = await requestDripUsdc(tokenRef);
    if (faucetSuccess) {
      const gotBalance = await waitForBalance(address, MIN_USDC_BALANCE);
      if (!gotBalance) {
        console.log('\n   Timed out waiting for faucet funds.');
        console.log(`   Wallet address: ${address}`);
        process.exit(1);
      }
      usdcBalance = await getUsdcBalanceRaw(address);
      console.log(`   Updated USDC balance: ${formatUnits(usdcBalance, USDC_DECIMALS)} USDC`);
    } else {
      console.log('\n   Could not get funds from faucet.');
      console.log(`   Fund manually: ${address}`);
      process.exit(1);
    }
  }

  return usdcBalance;
}

// ── WebSocket ─────────────────────────────────────────────
export function createWebSocket(network: string, tokenRef: TokenRef): WebSocket {
  if (!tokenRef.value) throw new Error('Not authenticated - call authenticate() first');
  const wsUrl = `${X402_BASE_URL.replace('https', 'wss')}/${network}/ws?token=${tokenRef.value}`;
  return new WebSocket(wsUrl);
}

// ── Chain Detection ───────────────────────────────────────
export function detectChainType(): ChainType {
  if (existsSync(ENV_FILE)) {
    const envContent = readFileSync(ENV_FILE, 'utf8');
    if (envContent.match(/^SOLANA_PRIVATE_KEY=(.+)/m)) return 'solana';
  }
  return 'evm';
}

// ── Solana Wallet ─────────────────────────────────────────
export type SolanaKeypair = {
  secretKey: Uint8Array; // 64 bytes (private + public)
  publicKey: Uint8Array; // 32 bytes
  address: string; // Base58 public key
};

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

export function createSolanaWallet(): SolanaKeypair {
  const secretKeyBase58 = getOrCreateSolanaPrivateKey();
  const secretKey = bs58.decode(secretKeyBase58);
  const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
  const address = bs58.encode(Buffer.from(keypair.publicKey));
  return { secretKey: keypair.secretKey, publicKey: keypair.publicKey, address };
}

// ── SIWX/Solana Auth ──────────────────────────────────────
function generateSiwxNonce(): string {
  return randomBytes(16).toString('hex');
}

function formatSiwsMessage(params: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainRef: string;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    `${params.domain} wants you to sign in with your Solana account:`,
    params.address,
    '',
    params.statement,
    '',
    `URI: ${params.uri}`,
    `Version: ${params.version}`,
    `Chain ID: ${params.chainRef}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
  ].join('\n');
}

export async function authenticateSolana(
  keypair: SolanaKeypair,
  tokenRef: TokenRef,
): Promise<string> {
  console.log('   Authenticating with SIWX/Solana...');

  const message = formatSiwsMessage({
    domain: new URL(X402_BASE_URL).host,
    address: keypair.address,
    statement: SIWX_STATEMENT,
    uri: X402_BASE_URL,
    version: '1',
    chainRef: SOLANA_DEVNET_CHAIN_REF,
    nonce: generateSiwxNonce(),
    issuedAt: new Date().toISOString(),
  });

  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
  const signature = bs58.encode(Buffer.from(signatureBytes));

  const response = await fetch(X402_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature, type: 'siwx' }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Authentication failed: ${JSON.stringify(error)}`);
  }

  const { token, accountId, expiresAt } = (await response.json()) as {
    token: string;
    accountId: string;
    expiresAt: string;
  };

  tokenRef.value = token;
  console.log(`   Authenticated as ${accountId}`);
  console.log(`   Token expires: ${expiresAt}`);

  return token;
}

// ── Solana x402 Fetch ────────────────────────────────────
export async function createSolanaX402Fetch(
  keypair: SolanaKeypair,
  tokenRef: TokenRef,
  tracker: PaymentTracker,
): Promise<typeof globalThis.fetch> {
  // Base fetch that injects JWT
  const authedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) {
      const request = input.clone();
      if (tokenRef.value) request.headers.set('Authorization', `Bearer ${tokenRef.value}`);
      return fetch(request);
    }
    const headers = new Headers(init?.headers);
    if (tokenRef.value) headers.set('Authorization', `Bearer ${tokenRef.value}`);
    return fetch(input, { ...init, headers });
  };

  // x402 v2 SVM payment handling
  const signer = await createKeyPairSignerFromBytes(keypair.secretKey);
  const svmScheme = new ExactSvmScheme(signer);
  const client = new x402Client().register(SOLANA_DEVNET_CAIP2, svmScheme);
  const x402Fetch = wrapFetchWithPayment(authedFetch, client);

  // Tracking wrapper — same pattern as EVM
  const trackingFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const fetchFn =
      tracker.maxPayments !== undefined && tracker.successfulPaymentCount >= tracker.maxPayments
        ? authedFetch
        : x402Fetch;
    const response = await fetchFn(input, init);
    tracker.totalFetchCount++;

    const paymentHeader = response.headers.get('PAYMENT-RESPONSE');
    if (paymentHeader) {
      tracker.paymentResponseCount++;
      try {
        const decoded = decodePaymentResponseHeader(paymentHeader);
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
      } catch (_e) {
        console.log(
          `   PAYMENT-RESPONSE #${tracker.paymentResponseCount} - raw: ${paymentHeader.slice(0, 50)}...`,
        );
      }
    }

    return response;
  };

  return trackingFetch as typeof globalThis.fetch;
}

// ── Authed Fetch (JWT only, no x402 payment) ──────────────
// Used in bootstrapped mode where credits are pre-purchased.
export function createAuthedFetch(
  tokenRef: TokenRef,
  tracker: PaymentTracker,
): typeof globalThis.fetch {
  const authedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) {
      const request = input.clone();
      if (tokenRef.value) request.headers.set('Authorization', `Bearer ${tokenRef.value}`);
      const response = await fetch(request);
      tracker.totalFetchCount++;
      return response;
    }
    const headers = new Headers(init?.headers);
    if (tokenRef.value) headers.set('Authorization', `Bearer ${tokenRef.value}`);
    const response = await fetch(input, { ...init, headers });
    tracker.totalFetchCount++;
    return response;
  };
  return authedFetch as typeof globalThis.fetch;
}

// ── x402 Fetch (EVM) ──────────────────────────────────────
export function createX402Fetch(
  walletClient: WalletClient,
  tokenRef: TokenRef,
  tracker: PaymentTracker,
): typeof globalThis.fetch {
  // Base fetch that injects JWT
  const authedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) {
      const request = input.clone();
      if (tokenRef.value) request.headers.set('Authorization', `Bearer ${tokenRef.value}`);
      return fetch(request);
    }
    const headers = new Headers(init?.headers);
    if (tokenRef.value) headers.set('Authorization', `Bearer ${tokenRef.value}`);
    return fetch(input, { ...init, headers });
  };

  // x402 v2 payment handling
  const evmSigner = toClientEvmSigner({
    address: walletClient.account!.address,
    signTypedData: (params) =>
      walletClient.signTypedData(params as Parameters<typeof walletClient.signTypedData>[0]),
  });
  const client = new x402Client().register(BASE_SEPOLIA_CAIP2, new ExactEvmScheme(evmSigner));
  const x402Fetch = wrapFetchWithPayment(authedFetch, client);

  // Tracking wrapper — reads headers without touching body (safe for streaming)
  const trackingFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // When maxPayments is reached, bypass x402 so 402 passes through to the caller
    const fetchFn =
      tracker.maxPayments !== undefined && tracker.successfulPaymentCount >= tracker.maxPayments
        ? authedFetch
        : x402Fetch;
    const response = await fetchFn(input, init);
    tracker.totalFetchCount++;

    const paymentHeader = response.headers.get('PAYMENT-RESPONSE');
    if (paymentHeader) {
      tracker.paymentResponseCount++;
      try {
        const decoded = decodePaymentResponseHeader(paymentHeader);
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
      } catch (_e) {
        console.log(
          `   PAYMENT-RESPONSE #${tracker.paymentResponseCount} - raw: ${paymentHeader.slice(0, 50)}...`,
        );
      }
    }

    return response;
  };

  return trackingFetch as typeof globalThis.fetch;
}

// ── Example Setup (shared across all example scripts) ─────
// Handles wallet creation, auth, faucet, and x402 fetch for both EVM and Solana.
export type ExampleSetup = {
  chainType: ChainType;
  walletAddress: string;
  /** EVM USDC balance (0n for Solana — no EVM balance to track). */
  startBalance: bigint;
  x402Fetch: typeof globalThis.fetch;
  /** Re-authenticate on 401. Chain-aware. */
  reAuth: () => Promise<void>;
};

export async function setupExample(
  tokenRef: TokenRef,
  tracker: PaymentTracker,
): Promise<ExampleSetup> {
  const chainType = detectChainType();
  const bootstrapped = process.env.X402_BOOTSTRAPPED === '1';

  if (chainType === 'solana') {
    const keypair = createSolanaWallet();
    console.log(`   Wallet: ${keypair.address} (Solana)\n`);

    if (bootstrapped && process.env.X402_JWT) {
      tokenRef.value = process.env.X402_JWT;
      console.log('   Using JWT from bootstrap.\n');
    } else {
      await authenticateSolana(keypair, tokenRef);
    }

    const x402Fetch = bootstrapped
      ? createAuthedFetch(tokenRef, tracker)
      : await createSolanaX402Fetch(keypair, tokenRef, tracker);

    return {
      chainType,
      walletAddress: keypair.address,
      startBalance: 0n,
      x402Fetch,
      reAuth: async () => {
        await authenticateSolana(keypair, tokenRef);
      },
    };
  }

  // EVM path
  const { account, walletClient } = createWallet();
  console.log(`   Wallet: ${account.address}\n`);

  if (bootstrapped && process.env.X402_JWT) {
    tokenRef.value = process.env.X402_JWT;
    console.log('   Using JWT from bootstrap.\n');
  } else {
    await authenticate(walletClient, tokenRef);
  }

  const startBalance = await ensureFunded(account.address, tokenRef);
  const x402Fetch = createX402Fetch(walletClient, tokenRef, tracker);

  return {
    chainType,
    walletAddress: account.address,
    startBalance,
    x402Fetch,
    reAuth: async () => {
      await authenticate(walletClient, tokenRef);
    },
  };
}
