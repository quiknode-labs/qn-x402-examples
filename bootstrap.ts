/**
 * Bootstrap — runs wallet setup, auth, and faucet funding once before
 * launching all 4 example scripts via stmux.
 *
 * Detects chain type from .env:
 *   - SOLANA_PRIVATE_KEY → SIWX/Solana auth (no faucet)
 *   - PRIVATE_KEY (or nothing) → SIWE/EVM auth (with faucet)
 *
 * This avoids a race condition where 4 concurrent scripts each try to
 * create a wallet key, write to .env, and hit the faucet simultaneously.
 */
import { execSync } from 'node:child_process';
import { formatUnits } from 'viem';
import {
  authenticate,
  authenticateSolana,
  createPaymentTracker,
  createSolanaWallet,
  createSolanaX402Fetch,
  createTokenRef,
  createWallet,
  createX402Fetch,
  detectChainType,
  ensureFunded,
  getCredits,
  type TokenRef,
  USDC_DECIMALS,
  X402_BASE_URL,
} from './lib/x402-helpers.js';

async function purchaseCredits(
  x402Fetch: typeof globalThis.fetch,
  tokenRef: TokenRef,
  network: string,
) {
  const maxRetries = 3;
  let paymentResponse: Response | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      paymentResponse = await x402Fetch(`${X402_BASE_URL}/${network}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      if (paymentResponse.ok) break;
      console.log(
        `   Attempt ${attempt}/${maxRetries} failed: HTTP ${paymentResponse.status}` +
          (attempt < maxRetries ? ' — retrying...' : ''),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(
        `   Attempt ${attempt}/${maxRetries} failed: ${reason}` +
          (attempt < maxRetries ? ' — retrying...' : ''),
      );
    }
    if (attempt < maxRetries) {
      const delayMs = 2_000 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (!paymentResponse?.ok) {
    const detail = paymentResponse
      ? `HTTP ${paymentResponse.status}`
      : 'network error (upstream may be down)';
    console.error(`   ERROR: Payment request failed after ${maxRetries} attempts: ${detail}`);
    process.exit(1);
  }

  // Poll until credits show > 0
  const maxWaitMs = 30_000;
  const pollIntervalMs = 2_000;
  const start = Date.now();
  let creditsInfo = await getCredits(tokenRef);
  while (Date.now() - start < maxWaitMs) {
    creditsInfo = await getCredits(tokenRef);
    if (creditsInfo.credits > 0) break;
    console.log('   Waiting for credits to appear...');
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (creditsInfo.credits <= 0) {
    console.error('   ERROR: Credits still 0 after payment. Aborting.');
    process.exit(1);
  }
  return creditsInfo;
}

async function bootstrapEvm() {
  // Step 1: Wallet (creates .env if missing)
  const { account, walletClient } = createWallet();
  console.log(`   Wallet: ${account.address}`);

  // Step 2: Authenticate (validates JWT works)
  const tokenRef = createTokenRef();
  await authenticate(walletClient, tokenRef);

  // Step 3: Ensure funded (faucet drip if needed)
  const balance = await ensureFunded(account.address, tokenRef);
  console.log(`   USDC:   ${formatUnits(balance, USDC_DECIMALS)}`);

  // Step 4: Ensure credits > 0 (purchase if needed)
  let creditsInfo = await getCredits(tokenRef);
  console.log(`   Credits: ${creditsInfo.credits}`);

  if (creditsInfo.credits <= 0) {
    console.log('   No credits — purchasing via x402 payment...');
    const tracker = createPaymentTracker();
    const x402Fetch = createX402Fetch(walletClient, tokenRef, tracker);
    creditsInfo = await purchaseCredits(x402Fetch, tokenRef, 'base-sepolia');
    console.log(`   Credits after purchase: ${creditsInfo.credits}`);
  }

  return tokenRef;
}

async function bootstrapSolana() {
  // Step 1: Wallet (creates .env if missing)
  const keypair = createSolanaWallet();
  console.log(`   Wallet: ${keypair.address}`);

  // Step 2: Authenticate via SIWX/Solana
  const tokenRef = createTokenRef();
  await authenticateSolana(keypair, tokenRef);

  // Step 3: No faucet for Solana (drip is EVM-only)
  console.log('   Solana: no faucet available (drip is EVM-only)');
  console.log('   Wallet must be pre-funded with Solana devnet USDC to purchase credits.');

  // Step 4: Check credits
  let creditsInfo = await getCredits(tokenRef);
  console.log(`   Credits: ${creditsInfo.credits}`);

  if (creditsInfo.credits <= 0) {
    console.log('   No credits — purchasing via x402 SVM payment...');
    const tracker = createPaymentTracker();
    const x402Fetch = await createSolanaX402Fetch(keypair, tokenRef, tracker);
    creditsInfo = await purchaseCredits(x402Fetch, tokenRef, 'solana-devnet');
    console.log(`   Credits after purchase: ${creditsInfo.credits}`);
  }

  return tokenRef;
}

async function main() {
  const chainType = detectChainType();

  console.log(
    `\n  x402 Bootstrap — ${chainType === 'solana' ? 'Solana' : 'EVM'} wallet, auth & funding\n`,
  );
  console.log('='.repeat(60));
  console.log(`   Chain:  ${chainType}`);
  console.log(`   Target: ${X402_BASE_URL}`);

  const tokenRef = chainType === 'solana' ? await bootstrapSolana() : await bootstrapEvm();

  console.log('='.repeat(60));
  console.log('   Bootstrap complete. Launching examples...\n');

  // Step 5: Launch stmux with all 4 examples (bootstrapped = no x402 payments)
  execSync(
    'npx --yes stmux -- ' +
      '[ [ -t JSONRPC "npx tsx jsonrpc.ts" .. -t REST "npx tsx rest.ts" ] ' +
      ': [ -t WebSocket "npx tsx websocket.ts" .. -t gRPC "npx tsx grpc.ts" ] ]',
    {
      stdio: 'inherit',
      cwd: import.meta.dirname,
      env: { ...process.env, X402_BOOTSTRAPPED: '1', X402_JWT: tokenRef.value! },
    },
  );
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
