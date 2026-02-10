/**
 * JSON-RPC Example — demonstrates paid JSON-RPC requests through the x402 proxy.
 *
 * Makes eth_blockNumber calls via x402-metered RPC endpoint,
 * consuming credits until exhausted, then exits with a summary.
 *
 * Usage:
 *   npm run example
 *   JSONRPC_NETWORK=base-sepolia npm run example
 */
import { formatUnits } from 'viem';
import {
  authenticate,
  createPaymentTracker,
  createTokenRef,
  createWallet,
  createX402Fetch,
  ensureFunded,
  getCredits,
  getUsdcBalanceRaw,
  USDC_DECIMALS,
  X402_BASE_URL,
} from './lib/x402-helpers.js';

// ── Config ───────────────────────────────────────────────
const JSONRPC_NETWORK = process.env.JSONRPC_NETWORK || 'base-sepolia';
const JSONRPC_URL = `${X402_BASE_URL}/${JSONRPC_NETWORK}`;
const BOOTSTRAPPED = process.env.X402_BOOTSTRAPPED === '1';

// ── Shared state ─────────────────────────────────────────
const tokenRef = createTokenRef();
const tracker = createPaymentTracker();

// ── Always exit clean ────────────────────────────────────
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// ── JSON-RPC helper ──────────────────────────────────────

async function jsonRpc(
  x402Fetch: typeof globalThis.fetch,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const response = await x402Fetch(JSONRPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('\n  x402 Example - Paid JSON-RPC Requests (SIWE + JWT Auth)\n');
  console.log('='.repeat(60));

  // ── Step 1: Wallet ─────────────────────────────────────
  const { account, walletClient } = createWallet();
  console.log(`   Wallet: ${account.address}\n`);

  // ── Step 2: Authenticate ───────────────────────────────
  if (process.env.X402_JWT) {
    tokenRef.value = process.env.X402_JWT;
    console.log('   Using JWT from bootstrap.\n');
  } else {
    await authenticate(walletClient, tokenRef);
  }

  // ── Step 3: USDC balance & faucet ──────────────────────
  const startBalance = await ensureFunded(account.address, tokenRef);

  // ── Step 4: Create x402 fetch ──────────────────────────
  const x402Fetch = createX402Fetch(walletClient, tokenRef, tracker);

  // ── Step 5: Check initial credits ──────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log('   Checking credits...');
  let creditsInfo = await getCredits(tokenRef);
  const initialCredits = creditsInfo.credits;
  console.log(`   Account: ${creditsInfo.accountId}`);
  console.log(`   Credits: ${initialCredits}`);
  console.log('='.repeat(60));

  // Reset counters for the test run
  tracker.paymentResponseCount = 0;
  tracker.successfulPaymentCount = 0;
  tracker.totalFetchCount = 0;
  // Bootstrap mode: never pay (credits pre-purchased). Standalone: buy once.
  tracker.maxPayments = BOOTSTRAPPED ? 0 : 1;

  // ── Credit Consumption Loop ────────────────────────────
  console.log(`\n-- JSON-RPC Credit Consumption Loop (${JSONRPC_NETWORK}) --`);
  console.log(
    `   Mode: ${BOOTSTRAPPED ? 'bootstrapped (no payments)' : 'standalone (1 payment max)'}`,
  );

  if (initialCredits <= 0 && !BOOTSTRAPPED) {
    console.log('   No credits — first request will trigger x402 payment\n');
  } else if (initialCredits <= 0 && BOOTSTRAPPED) {
    console.log('   No credits — exiting (bootstrap should have purchased).\n');
    return;
  } else {
    console.log(`   Running until credits exhausted or 500 requests...\n`);
  }

  let requestCount = 0;
  let lastCredits = initialCredits;

  while (true) {
    try {
      const result = await jsonRpc(x402Fetch, 'eth_blockNumber');
      requestCount++;
      const blockNumber = BigInt(result as string);

      // Check credits
      creditsInfo = await getCredits(tokenRef);

      // Detect credit changes
      const creditDelta = lastCredits - creditsInfo.credits;
      const creditInfo =
        creditDelta !== 0 ? ` (${creditDelta > 0 ? '-' : '+'}${Math.abs(creditDelta)})` : '';
      lastCredits = creditsInfo.credits;

      const timestamp = new Date().toISOString().slice(11, 23);
      console.log(
        `   ${timestamp} Request #${requestCount}: Block ${blockNumber} | Credits: ${creditsInfo.credits}${creditInfo}`,
      );

      // Stop when credits exhausted
      if (creditsInfo.credits <= 0 && (BOOTSTRAPPED || tracker.successfulPaymentCount >= 1)) {
        console.log('\n   All credits consumed. Demo complete!');
        break;
      }

      // Safety limit
      if (requestCount >= 500) {
        console.log('\n   Reached 500 request limit, stopping.');
        break;
      }

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error: any) {
      // 402 after maxPayments reached — credits exhausted, clean exit
      if (error.message?.startsWith('HTTP 402')) {
        console.log('\n   All credits consumed. Demo complete!');
        break;
      }
      // Handle 401 by re-authenticating
      if (error.message?.includes('401') || error.message?.includes('Token expired')) {
        console.log('   Token expired, re-authenticating...');
        await authenticate(walletClient, tokenRef);
        continue;
      }
      console.error(`   Request #${requestCount + 1} failed:`, error.message);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // ── Summary ────────────────────────────────────────────
  let currentBalance = startBalance;
  try {
    currentBalance = await getUsdcBalanceRaw(account.address);
  } catch {
    console.log('   (Could not fetch final balance)');
  }

  let finalCredits = { credits: 0 };
  try {
    finalCredits = await getCredits(tokenRef);
  } catch {
    console.log('   (Could not fetch final credits)');
  }
  const totalSpent = startBalance - currentBalance;
  const durationMs = Date.now() - startTime;

  console.log(`\n${'='.repeat(60)}`);
  console.log('   Summary');
  console.log('='.repeat(60));
  console.log(`   Network:                   ${JSONRPC_NETWORK}`);
  console.log(`   Protocol:                  JSON-RPC`);
  console.log(`   Total requests:            ${requestCount}`);
  console.log(`   Total fetch calls:         ${tracker.totalFetchCount}`);
  console.log(`   x402 payments:             ${tracker.successfulPaymentCount}`);
  console.log(`   Initial credits:           ${initialCredits}`);
  console.log(`   Final credits:             ${finalCredits.credits}`);
  console.log(`   Starting USDC:             $${formatUnits(startBalance, USDC_DECIMALS)}`);
  console.log(`   Final USDC:                $${formatUnits(currentBalance, USDC_DECIMALS)}`);
  console.log(`   USDC spent:                $${formatUnits(totalSpent, USDC_DECIMALS)}`);
  console.log(`   Duration:                  ${(durationMs / 1000).toFixed(2)}s`);
  if (requestCount > 0) {
    console.log(`   Avg time per request:      ${(durationMs / requestCount).toFixed(0)}ms`);
  }
  console.log(`${'='.repeat(60)}\n`);
  process.exit(0);
}

main().catch(() => process.exit(0));
