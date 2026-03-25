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
 * Supports both payment models:
 *   - Credit drawdown: authenticate, buy credits, consume until exhausted
 *   - Pay-per-request: no auth, each request pays $0.001 automatically
 *
 * Usage:
 *   npm run start:rest
 *   REST_NETWORK=aptos-testnet npm run start:rest
 */
import { formatUnits } from 'viem';
import {
  createPaymentTracker,
  getCredits,
  getTokenBalanceRaw,
  setupExample,
  TOKEN_DECIMALS,
  X402_BASE_URL,
} from './lib/x402-helpers.js';

// ── Config ───────────────────────────────────────────────
const REST_NETWORK = process.env.REST_NETWORK || 'aptos-mainnet';
const REST_BASE = `${X402_BASE_URL}/${REST_NETWORK}`;
const BOOTSTRAPPED = process.env.X402_BOOTSTRAPPED === '1';

// Well-known Aptos addresses for demo queries
const APTOS_FRAMEWORK = '0x1';

// ── Shared state ─────────────────────────────────────────
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
  const { chainType, walletAddress, startBalance, client, x402Fetch, paymentModel } =
    await setupExample(tracker);
  const isPerRequest = paymentModel === 'pay-per-request' || paymentModel === 'nanopayment';

  // ── Payment model–specific setup ──────────────────────────
  let initialCredits = 0;

  // Reset counters
  tracker.paymentResponseCount = 0;
  tracker.successfulPaymentCount = 0;
  tracker.totalFetchCount = 0;

  if (isPerRequest) {
    // No maxPayments cap — Phase 1 endpoints are the full demo, Phase 2 is skipped
    console.log(`\n${'='.repeat(60)}`);
    console.log(
      `   Mode: ${paymentModel} ($${paymentModel === 'nanopayment' ? '0.0001' : '0.001'}/request)`,
    );
    console.log('='.repeat(60));
  } else {
    const getToken = () => client.getToken();
    console.log(`\n${'='.repeat(60)}`);
    console.log('   Checking credits...');
    const creditsInfo = await getCredits(getToken);
    initialCredits = creditsInfo.credits;
    console.log(`   Account: ${creditsInfo.accountId}`);
    console.log(`   Credits: ${initialCredits}`);
    console.log('='.repeat(60));

    tracker.maxPayments = BOOTSTRAPPED ? 0 : 1;

    if (initialCredits <= 0 && BOOTSTRAPPED) {
      console.log('   No credits — exiting (bootstrap should have purchased).\n');
      return;
    }
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
    console.log(
      `   [${callsMade}] GET /v1/                      ` +
        `chain=${ledger.chain_id} epoch=${ledger.epoch} height=${ledger.block_height}`,
    );
  } catch (err: any) {
    console.error(`   [${callsMade + 1}] GET /v1/  FAILED: ${err.message}`);
  }

  // 2. Block by height (use a recent block)
  try {
    const { data: ledgerData } = await restGet(x402Fetch, 'v1/');
    callsMade++;
    const currentHeight = Number((ledgerData as { block_height: string }).block_height);
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
    console.log(
      `   [${callsMade}] GET /v1/blocks/by_height/${targetHeight}  ` +
        `hash=${block.block_hash.slice(0, 16)}... versions=${block.first_version}-${block.last_version}`,
    );
  } catch (err: any) {
    console.error(`   [${callsMade + 1}] GET /v1/blocks/by_height/  FAILED: ${err.message}`);
  }

  // 3. Account info (Aptos framework account 0x1)
  try {
    const { data } = await restGet(x402Fetch, `v1/accounts/${APTOS_FRAMEWORK}`);
    callsMade++;
    const acct = data as { sequence_number: string; authentication_key: string };
    console.log(
      `   [${callsMade}] GET /v1/accounts/0x1          ` +
        `seq=${acct.sequence_number} auth_key=[REDACTED]`,
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
    console.log(
      `   [${callsMade}] GET /v1/accounts/0x1/resources ` +
        `${resources.length} resources [${types.join(', ')}...]`,
    );
  } catch (err: any) {
    console.error(`   [${callsMade + 1}] GET /v1/accounts/.../resources  FAILED: ${err.message}`);
  }

  // 5. Transaction by version (version 1 always exists)
  try {
    const { data } = await restGet(x402Fetch, 'v1/transactions/by_version/1');
    callsMade++;
    const tx = data as { type: string; hash: string; version: string };
    console.log(
      `   [${callsMade}] GET /v1/transactions/by_version/1  ` +
        `type=${tx.type} hash=${tx.hash.slice(0, 16)}...`,
    );
  } catch (err: any) {
    console.error(
      `   [${callsMade + 1}] GET /v1/transactions/by_version/1  FAILED: ${err.message}`,
    );
  }

  // ── Phase 2: Credit Consumption Loop (credit drawdown only) ──
  let loopRequests = 0;

  if (isPerRequest) {
    // Per-request: Phase 1 IS the demo (each endpoint call paid $0.001)
    console.log(`\n${'='.repeat(60)}`);
    console.log(
      `   ${paymentModel === 'nanopayment' ? 'Nanopayment' : 'Pay-per-request'} demo complete (${tracker.successfulPaymentCount} payments across ${callsMade} endpoints).`,
    );
  } else {
    console.log(`\n${'='.repeat(60)}`);
    console.log('-- Phase 2: Credit Consumption Loop (GET /v1/ ledger info) --');
    const loopCredits = await getCredits(() => client.getToken());
    const creditsBeforeLoop = loopCredits.credits;
    console.log(`   Credits before loop: ${creditsBeforeLoop}`);

    if (creditsBeforeLoop <= 0 && BOOTSTRAPPED) {
      console.log('   No credits remaining — demo complete.\n');
    } else {
      if (creditsBeforeLoop <= 0 && tracker.successfulPaymentCount === 0) {
        console.log('   No credits — first request will trigger x402 payment\n');
      } else {
        console.log(`   Running until credits exhausted or 500 requests...\n`);
      }

      while (true) {
        try {
          const { data } = await restGet(x402Fetch, 'v1/');
          loopRequests++;

          const ledger = data as { block_height: string; ledger_version: string };

          const timestamp = new Date().toISOString().slice(11, 23);
          console.log(
            `   ${timestamp} Request #${loopRequests}: height=${ledger.block_height} ver=${ledger.ledger_version}`,
          );

          if (loopRequests >= 500) {
            console.log('\n   Reached 500 request limit, stopping.');
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error: any) {
          if (error.message?.startsWith('HTTP 402')) {
            console.log('\n   All credits consumed. Demo complete!');
            break;
          }
          if (error.message?.includes('401') || error.message?.includes('Token expired')) {
            console.log('   Token expired, re-authenticating...');
            await client.authenticate();
            continue;
          }
          console.error(`   Request #${loopRequests + 1} failed:`, error.message);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }

  // ── Summary ────────────────────────────────────────────
  let currentBalance = startBalance;
  if (chainType === 'evm') {
    try {
      currentBalance = await getTokenBalanceRaw(walletAddress);
    } catch {
      console.log('   (Could not fetch final balance)');
    }
  }

  const totalRequests = callsMade + loopRequests;
  const durationMs = Date.now() - startTime;

  console.log(`\n${'='.repeat(60)}`);
  console.log('   Summary');
  console.log('='.repeat(60));
  console.log(`   Network:                   ${REST_NETWORK}`);
  console.log(`   Protocol:                  REST (HTTP GET)`);
  console.log(`   Payment model:             ${paymentModel}`);
  console.log(`   Auth chain:                ${chainType}`);
  console.log(`   Total REST calls:          ${totalRequests}`);
  console.log(`     Phase 1 (endpoints):     ${callsMade}`);
  console.log(`     Phase 2 (loop):          ${loopRequests}`);
  console.log(`   Total fetch calls:         ${tracker.totalFetchCount}`);
  console.log(`   x402 payments:             ${tracker.successfulPaymentCount}`);
  if (!isPerRequest) {
    let finalCredits = { credits: 0 };
    try {
      finalCredits = await getCredits(() => client.getToken(), { forceRefresh: true });
    } catch {
      /* token may have expired */
    }
    console.log(`   Initial credits:           ${initialCredits}`);
    console.log(`   Final credits:             ${finalCredits.credits}`);
  }
  if (chainType === 'evm') {
    const totalSpent = startBalance - currentBalance;
    console.log(`   Starting balance:          $${formatUnits(startBalance, TOKEN_DECIMALS)}`);
    console.log(`   Final balance:             $${formatUnits(currentBalance, TOKEN_DECIMALS)}`);
    console.log(`   Tokens spent:              $${formatUnits(totalSpent, TOKEN_DECIMALS)}`);
  }
  console.log(`   Duration:                  ${(durationMs / 1000).toFixed(2)}s`);
  if (totalRequests > 0) {
    console.log(`   Avg time per request:      ${(durationMs / totalRequests).toFixed(0)}ms`);
  }
  console.log(`${'='.repeat(60)}\n`);
  process.exit(0);
}

main().catch(() => process.exit(0));
