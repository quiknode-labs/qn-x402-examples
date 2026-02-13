/**
 * REST API Example — demonstrates true RESTful HTTP GET requests through the x402 proxy.
 *
 * Uses Aptos blockchain REST API (not JSON-RPC) to showcase genuine REST endpoints:
 *   GET /v1/                               → Ledger info
 *   GET /v1/blocks/by_height/{height}      → Block by height
 *   GET /v1/accounts/{address}             → Account info
 *   GET /v1/accounts/{address}/resources   → Account resources
 *   GET /v1/transactions/by_version/{ver}  → Transaction by version
 *
 * Phase 1: Individual REST calls to different endpoints
 * Phase 2: Credit consumption loop using lightweight ledger-info GET
 *
 * Usage:
 *   npm run example:rest
 *   REST_NETWORK=aptos-testnet npm run example:rest
 */
import { formatUnits } from 'viem';
import {
  createPaymentTracker,
  createTokenRef,
  getCredits,
  getUsdcBalanceRaw,
  setupExample,
  USDC_DECIMALS,
  X402_BASE_URL,
} from './lib/x402-helpers.js';

// ── Config ───────────────────────────────────────────────
const REST_NETWORK = process.env.REST_NETWORK || 'aptos-mainnet';
const REST_BASE = `${X402_BASE_URL}/${REST_NETWORK}`;
const BOOTSTRAPPED = process.env.X402_BOOTSTRAPPED === '1';

// Well-known Aptos addresses for demo queries
const APTOS_FRAMEWORK = '0x1';

// ── Shared state ─────────────────────────────────────────
const tokenRef = createTokenRef();
const tracker = createPaymentTracker();

// ── Always exit clean ────────────────────────────────────
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// ── REST helper ──────────────────────────────────────────

async function restGet(
  x402Fetch: typeof globalThis.fetch,
  path: string,
): Promise<{ data: unknown; status: number }> {
  const url = `${REST_BASE}/${path}`;
  const response = await x402Fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();
  return { data, status: response.status };
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('\n  x402 Example - Aptos REST API via x402\n');
  console.log('='.repeat(60));

  // ── Setup (chain-aware: EVM or Solana) ───────────────────
  const { chainType, walletAddress, startBalance, x402Fetch, reAuth } = await setupExample(
    tokenRef,
    tracker,
  );

  // ── Check initial credits ────────────────────────────────
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

  console.log(
    `   Mode: ${BOOTSTRAPPED ? 'bootstrapped (no payments)' : 'standalone (1 payment max)'}`,
  );

  if (initialCredits <= 0 && BOOTSTRAPPED) {
    console.log('   No credits — exiting (bootstrap should have purchased).\n');
    return;
  }

  // ── Phase 1: Individual REST Calls ─────────────────────
  console.log(`\n-- Phase 1: Aptos REST Endpoints (${REST_NETWORK}) --\n`);

  let callsMade = 0;

  // 1. Ledger info (root endpoint)
  try {
    const { data } = await restGet(x402Fetch, 'v1/');
    callsMade++;
    const ledger = data as {
      chain_id: number;
      epoch: string;
      ledger_version: string;
      block_height: string;
    };
    creditsInfo = await getCredits(tokenRef);
    console.log(
      `   [${callsMade}] GET /v1/                      ` +
        `chain=${ledger.chain_id} epoch=${ledger.epoch} height=${ledger.block_height}`.padEnd(50) +
        ` | Credits: ${creditsInfo.credits}`,
    );
  } catch (err: any) {
    console.error(`   [${callsMade + 1}] GET /v1/  FAILED: ${err.message}`);
  }

  // 2. Block by height (use a recent block)
  try {
    // First get current height from ledger info
    const { data: ledgerData } = await restGet(x402Fetch, 'v1/');
    callsMade++;
    const currentHeight = Number((ledgerData as { block_height: string }).block_height);
    creditsInfo = await getCredits(tokenRef);

    const targetHeight = Math.max(1, currentHeight - 5);
    const { data } = await restGet(
      x402Fetch,
      `v1/blocks/by_height/${targetHeight}?with_transactions=false`,
    );
    callsMade++;
    const block = data as {
      block_height: string;
      block_hash: string;
      first_version: string;
      last_version: string;
    };
    creditsInfo = await getCredits(tokenRef);
    console.log(
      `   [${callsMade}] GET /v1/blocks/by_height/${targetHeight}  ` +
        `hash=${block.block_hash.slice(0, 16)}... versions=${block.first_version}-${block.last_version}`.padEnd(
          50,
        ) +
        ` | Credits: ${creditsInfo.credits}`,
    );
  } catch (err: any) {
    console.error(`   [${callsMade + 1}] GET /v1/blocks/by_height/  FAILED: ${err.message}`);
  }

  // 3. Account info (Aptos framework account 0x1)
  try {
    const { data } = await restGet(x402Fetch, `v1/accounts/${APTOS_FRAMEWORK}`);
    callsMade++;
    const acct = data as { sequence_number: string; authentication_key: string };
    creditsInfo = await getCredits(tokenRef);
    console.log(
      `   [${callsMade}] GET /v1/accounts/0x1          ` +
        `seq=${acct.sequence_number} auth_key=[REDACTED]`.padEnd(50) +
        ` | Credits: ${creditsInfo.credits}`,
    );
  } catch (err: any) {
    console.error(`   [${callsMade + 1}] GET /v1/accounts/0x1  FAILED: ${err.message}`);
  }

  // 4. Account resources (first few from 0x1)
  try {
    const { data } = await restGet(x402Fetch, `v1/accounts/${APTOS_FRAMEWORK}/resources?limit=5`);
    callsMade++;
    const resources = data as { type: string }[];
    const types = resources.map((r) => r.type.split('::').pop()).slice(0, 3);
    creditsInfo = await getCredits(tokenRef);
    console.log(
      `   [${callsMade}] GET /v1/accounts/0x1/resources ` +
        `${resources.length} resources [${types.join(', ')}...]`.padEnd(50) +
        ` | Credits: ${creditsInfo.credits}`,
    );
  } catch (err: any) {
    console.error(`   [${callsMade + 1}] GET /v1/accounts/.../resources  FAILED: ${err.message}`);
  }

  // 5. Transaction by version (version 1 always exists)
  try {
    const { data } = await restGet(x402Fetch, 'v1/transactions/by_version/1');
    callsMade++;
    const tx = data as { type: string; hash: string; version: string };
    creditsInfo = await getCredits(tokenRef);
    console.log(
      `   [${callsMade}] GET /v1/transactions/by_version/1  ` +
        `type=${tx.type} hash=${tx.hash.slice(0, 16)}...`.padEnd(50) +
        ` | Credits: ${creditsInfo.credits}`,
    );
  } catch (err: any) {
    console.error(
      `   [${callsMade + 1}] GET /v1/transactions/by_version/1  FAILED: ${err.message}`,
    );
  }

  // ── Phase 2: Credit Consumption Loop ───────────────────

  console.log(`\n${'='.repeat(60)}`);
  console.log('-- Phase 2: Credit Consumption Loop (GET /v1/ ledger info) --');

  creditsInfo = await getCredits(tokenRef);
  const creditsBeforeLoop = creditsInfo.credits;
  console.log(`   Credits before loop: ${creditsBeforeLoop}`);

  if (creditsBeforeLoop <= 0 && BOOTSTRAPPED) {
    console.log('   No credits remaining — demo complete.\n');
    // Skip Phase 2 entirely; bootstrap mode won't pay for more.
  } else if (creditsBeforeLoop <= 0 && tracker.successfulPaymentCount === 0) {
    console.log('   No credits — first request will trigger x402 payment\n');
  } else {
    console.log(`   Running until credits exhausted or 500 requests...\n`);
  }

  let loopRequests = 0;
  let lastCredits = creditsBeforeLoop;

  while (true) {
    try {
      const { data } = await restGet(x402Fetch, 'v1/');
      loopRequests++;

      const ledger = data as { block_height: string; ledger_version: string };

      // Check credits to show remaining
      creditsInfo = await getCredits(tokenRef);

      // Detect credit changes
      const creditDelta = lastCredits - creditsInfo.credits;
      const creditInfo =
        creditDelta !== 0 ? ` (${creditDelta > 0 ? '-' : '+'}${Math.abs(creditDelta)})` : '';
      lastCredits = creditsInfo.credits;

      const timestamp = new Date().toISOString().slice(11, 23);
      console.log(
        `   ${timestamp} Request #${loopRequests}: height=${ledger.block_height} ver=${ledger.ledger_version} | Credits: ${creditsInfo.credits}${creditInfo}`,
      );

      // Stop when credits exhausted
      if (creditsInfo.credits <= 0 && (BOOTSTRAPPED || tracker.successfulPaymentCount >= 1)) {
        console.log('\n   All credits consumed. Demo complete!');
        break;
      }

      // Safety limit
      if (loopRequests >= 500) {
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
        await reAuth();
        continue;
      }
      console.error(`   Request #${loopRequests + 1} failed:`, error.message);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // ── Summary ────────────────────────────────────────────
  let currentBalance = startBalance;
  if (chainType === 'evm') {
    try {
      currentBalance = await getUsdcBalanceRaw(walletAddress);
    } catch {
      console.log('   (Could not fetch final balance)');
    }
  }

  let finalCredits = { credits: 0 };
  try {
    finalCredits = await getCredits(tokenRef);
  } catch {
    console.log('   (Could not fetch final credits)');
  }
  const totalSpent = startBalance - currentBalance;
  const totalRequests = callsMade + loopRequests;
  const durationMs = Date.now() - startTime;

  console.log(`\n${'='.repeat(60)}`);
  console.log('   Summary');
  console.log('='.repeat(60));
  console.log(`   Network:                   ${REST_NETWORK}`);
  console.log(`   Protocol:                  REST (HTTP GET)`);
  console.log(`   Auth chain:                ${chainType}`);
  console.log(`   Total REST calls:          ${totalRequests}`);
  console.log(`     Phase 1 (endpoints):     ${callsMade}`);
  console.log(`     Phase 2 (loop):          ${loopRequests}`);
  console.log(`   Total fetch calls:         ${tracker.totalFetchCount}`);
  console.log(`   x402 payments:             ${tracker.successfulPaymentCount}`);
  console.log(`   Initial credits:           ${initialCredits}`);
  console.log(`   Final credits:             ${finalCredits.credits}`);
  if (chainType === 'evm') {
    console.log(`   Starting USDC:             $${formatUnits(startBalance, USDC_DECIMALS)}`);
    console.log(`   Final USDC:                $${formatUnits(currentBalance, USDC_DECIMALS)}`);
    console.log(`   USDC spent:                $${formatUnits(totalSpent, USDC_DECIMALS)}`);
  }
  console.log(`   Duration:                  ${(durationMs / 1000).toFixed(2)}s`);
  if (totalRequests > 0) {
    console.log(`   Avg time per request:      ${(durationMs / totalRequests).toFixed(0)}ms`);
  }
  console.log(`${'='.repeat(60)}\n`);
  process.exit(0);
}

main().catch(() => process.exit(0));
