/**
 * JSON-RPC Example — demonstrates paid JSON-RPC requests through the x402 proxy.
 *
 * Supports both payment models:
 *   - Credit drawdown: authenticate, buy credits, consume until exhausted
 *   - Pay-per-request: no auth, each request pays $0.001 automatically
 *
 * Usage:
 *   npm run start:jsonrpc
 *   JSONRPC_NETWORK=base-sepolia npm run start:jsonrpc
 */
import { formatUnits } from 'viem';
import {
  createPaymentTracker,
  getCredits,
  getTokenBalanceRaw,
  jsonRpc,
  setupExample,
  TOKEN_DECIMALS,
  X402_BASE_URL,
} from './lib/x402-helpers.js';

// ── Config ───────────────────────────────────────────────
const JSONRPC_NETWORK = process.env.JSONRPC_NETWORK || 'base-sepolia';
const JSONRPC_URL = `${X402_BASE_URL}/${JSONRPC_NETWORK}`;
const BOOTSTRAPPED = process.env.X402_BOOTSTRAPPED === '1';
const PER_REQUEST_DEMO_LIMIT = 5;

// ── Shared state ─────────────────────────────────────────
const tracker = createPaymentTracker();

// ── Always exit clean ────────────────────────────────────
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('\n  x402 Example - Paid JSON-RPC Requests\n');
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
    // Per-request: each request pays $0.001, demo for N requests then stop
    tracker.maxPayments = PER_REQUEST_DEMO_LIMIT;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`   Mode: pay-per-request ($0.001/request)`);
    console.log(`   Demo: ${PER_REQUEST_DEMO_LIMIT} paid requests`);
    console.log('='.repeat(60));
  } else {
    // Credit-drawdown: check credits, buy if needed
    const getToken = () => client.getToken();
    console.log(`\n${'='.repeat(60)}`);
    console.log('   Checking credits...');
    const creditsInfo = await getCredits(getToken);
    initialCredits = creditsInfo.credits;
    console.log(`   Account: ${creditsInfo.accountId}`);
    console.log(`   Credits: ${initialCredits}`);
    console.log('='.repeat(60));

    // Bootstrap mode: never pay (credits pre-purchased). Standalone: buy once.
    tracker.maxPayments = BOOTSTRAPPED ? 0 : 1;

    if (initialCredits <= 0 && BOOTSTRAPPED) {
      console.log('   No credits — exiting (bootstrap should have purchased).\n');
      return;
    }
  }

  // ── Request Loop ───────────────────────────────────────
  console.log(`\n-- JSON-RPC Loop (${JSONRPC_NETWORK}) --`);
  if (isPerRequest) {
    console.log(`   Making ${PER_REQUEST_DEMO_LIMIT} paid requests...\n`);
  } else if (initialCredits <= 0 && !BOOTSTRAPPED) {
    console.log('   No credits — first request will trigger x402 payment\n');
  } else {
    console.log(`   Running until credits exhausted or 500 requests...\n`);
  }

  let requestCount = 0;
  const requestLimit = isPerRequest ? PER_REQUEST_DEMO_LIMIT + 50 : 500;

  while (true) {
    try {
      const result = await jsonRpc(x402Fetch, JSONRPC_URL, 'eth_blockNumber');
      requestCount++;
      const blockNumber = BigInt(result as string);

      const timestamp = new Date().toISOString().slice(11, 23);
      console.log(`   ${timestamp} Request #${requestCount}: Block ${blockNumber}`);

      if (requestCount >= requestLimit) {
        console.log('\n   Reached request limit, stopping.');
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error: any) {
      if (error.message?.startsWith('HTTP 402')) {
        if (isPerRequest) {
          console.log(
            `\n   Pay-per-request demo complete (${tracker.successfulPaymentCount} payments).`,
          );
        } else {
          console.log('\n   All credits consumed. Demo complete!');
        }
        break;
      }
      if (
        !isPerRequest &&
        (error.message?.includes('401') || error.message?.includes('Token expired'))
      ) {
        console.log('   Token expired, re-authenticating...');
        await client.authenticate();
        continue;
      }
      console.error(`   Request #${requestCount + 1} failed:`, error.message);
      await new Promise((resolve) => setTimeout(resolve, 1000));
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

  const durationMs = Date.now() - startTime;

  console.log(`\n${'='.repeat(60)}`);
  console.log('   Summary');
  console.log('='.repeat(60));
  console.log(`   Network:                   ${JSONRPC_NETWORK}`);
  console.log(`   Protocol:                  JSON-RPC`);
  console.log(`   Payment model:             ${paymentModel}`);
  console.log(`   Auth chain:                ${chainType}`);
  console.log(`   Total requests:            ${requestCount}`);
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
  if (requestCount > 0) {
    console.log(`   Avg time per request:      ${(durationMs / requestCount).toFixed(0)}ms`);
  }
  console.log(`${'='.repeat(60)}\n`);
  process.exit(0);
}

main().catch(() => process.exit(0));
