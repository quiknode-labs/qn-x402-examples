/**
 * gRPC-Web Example — demonstrates gRPC calls through the x402 proxy.
 *
 * Phase 1: Unary gRPC calls (Ping, GetLatestBlock)
 * Phase 2: Streaming (SubscribeBlocksFromLatest)
 *
 * NOTE: Pay-per-request is NOT supported for gRPC (worker returns 400).
 * Credit drawdown only.
 *
 * Usage:
 *   npm run start:grpc
 */
import { Code, ConnectError, createClient, type Interceptor } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { formatUnits } from 'viem';
import { bytesToHex } from 'viem/utils';
import { AccessAPI, BlockStatus } from './gen/flow/access/access_pb.js';
import {
  createPaymentTracker,
  getCredits,
  getTokenBalanceRaw,
  setupExample,
  TOKEN_DECIMALS,
  X402_BASE_URL,
} from './lib/x402-helpers.js';

// ── Config ───────────────────────────────────────────────
const X402_GRPC_BASE_URL = `${process.env.X402_GRPC_BASE_URL || `${X402_BASE_URL}/flow-mainnet`}`;
const BOOTSTRAPPED = process.env.X402_BOOTSTRAPPED === '1';

// ── Shared state ─────────────────────────────────────────
const tracker = createPaymentTracker();

// ── Always exit clean — suppress stray gRPC/Node errors ──
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// ── Debug interceptor — logs every gRPC request URL ──────
const debugInterceptor: Interceptor = (next) => async (req) => {
  const url = req.url;
  console.log(`   [gRPC] --> ${req.method.kind.toUpperCase()} ${url}`);
  try {
    const res = await next(req);
    console.log(`   [gRPC] <-- OK`);
    return res;
  } catch (err) {
    if (err instanceof ConnectError) {
      console.error(`   [gRPC] <-- ${Code[err.code]}: ${err.rawMessage}`);
    } else {
      console.error(`   [gRPC] <-- ERROR: ${err}`);
    }
    throw err;
  }
};

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('\n  x402 Example - gRPC-Web on Flow Mainnet\n');
  console.log('='.repeat(60));

  // ── Per-request guard (before setup to avoid unnecessary wallet/balance work) ──
  if (process.env.X402_PAYMENT_MODEL === 'pay-per-request') {
    console.log('\n   gRPC requires credit drawdown (worker rejects per-request for gRPC).');
    console.log(
      '   Use JSON-RPC or REST examples for pay-per-request, or switch to credit drawdown.\n',
    );
    process.exit(0);
  }

  // ── Setup (chain-aware: EVM or Solana) ───────────────────
  const { chainType, walletAddress, startBalance, client, x402Fetch } = await setupExample(tracker);
  const getToken = () => client.getToken();

  // ── Create connect-web gRPC client ───────────────────────
  const debugFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await x402Fetch(input, init);
    if (!response.ok && response.status !== 402) {
      const clone = response.clone();
      const errorBody = await clone.text();
      console.error(`   [fetch] HTTP ${response.status}: ${errorBody}`);
    }
    return response;
  };

  const transport = createGrpcWebTransport({
    baseUrl: X402_GRPC_BASE_URL,
    useBinaryFormat: true,
    fetch: debugFetch,
    interceptors: [debugInterceptor],
  });

  const flowClient = createClient(AccessAPI, transport);

  // ── Check initial credits ────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log('   Checking credits...');

  // Reset counters
  tracker.paymentResponseCount = 0;
  tracker.successfulPaymentCount = 0;
  tracker.totalFetchCount = 0;
  tracker.maxPayments = BOOTSTRAPPED ? 0 : 1;

  const creditsInfo = await getCredits(getToken);
  const initialCredits = creditsInfo.credits;
  console.log(`   Account: ${creditsInfo.accountId}`);
  console.log(`   Credits: ${initialCredits}`);
  console.log('='.repeat(60));

  if (initialCredits <= 0 && BOOTSTRAPPED) {
    console.log('   No credits — exiting (bootstrap should have purchased).\n');
    return;
  }

  let unaryCalls = 0;

  // ── Phase 1: Unary gRPC calls ─────────────────────────
  console.log('\n-- Phase 1: Unary gRPC-Web Calls --\n');

  // Ping
  try {
    await flowClient.ping({});
    unaryCalls++;
    console.log(`   [1] Ping                  OK`);
  } catch (err: any) {
    console.error(`   [1] Ping                  FAILED: ${err.message}`);
  }

  // GetLatestBlock
  try {
    const blockRes = await flowClient.getLatestBlock({ isSealed: true });
    unaryCalls++;
    const block = blockRes.block;
    if (block) {
      const ts = block.timestamp
        ? new Date(Number(block.timestamp.seconds) * 1000).toISOString()
        : 'n/a';
      console.log(`   [2] GetLatestBlock        OK  | Height: ${block.height} | Time: ${ts}`);
      console.log(`       Block ID: ${bytesToHex(block.id).slice(0, 34)}...`);
    } else {
      console.log(`   [2] GetLatestBlock        OK  | (no block in response)`);
    }
  } catch (err: any) {
    console.error(`   [2] GetLatestBlock        FAILED: ${err.message}`);
  }

  // ── Phase 2: Streaming gRPC call ────────────────────────
  let blocksReceived = 0;
  let streamError: string | null = null;

  {
    console.log(`\n${'='.repeat(60)}`);
    console.log('-- Phase 2: Streaming gRPC-Web (SubscribeBlocksFromLatest) --');

    const streamCredits = await getCredits(getToken);
    const creditsBeforeStream = streamCredits.credits;
    console.log(`   Credits before stream: ${creditsBeforeStream}`);

    if (creditsBeforeStream <= 0 && BOOTSTRAPPED) {
      console.log('   No credits remaining — demo complete.\n');
    } else if (creditsBeforeStream <= 0 && tracker.successfulPaymentCount === 0) {
      console.log('   No credits — stream request will trigger x402 payment\n');
    } else {
      console.log(`   Streaming blocks until credits exhausted or 500 blocks...\n`);
    }

    const streamAbort = new AbortController();
    let streamAttempts = 0;
    const MAX_STREAM_ATTEMPTS = 3;

    while (streamAttempts < MAX_STREAM_ATTEMPTS) {
      streamAttempts++;
      try {
        for await (const response of flowClient.subscribeBlocksFromLatest(
          { blockStatus: BlockStatus.BLOCK_SEALED },
          { signal: streamAbort.signal },
        )) {
          blocksReceived++;

          const block = response.block;
          const ts = block?.timestamp
            ? new Date(Number(block.timestamp.seconds) * 1000).toISOString().slice(11, 23)
            : '';

          if (block) {
            const local = new Date().toISOString().slice(11, 23);
            console.log(`   ${local} Block #${blocksReceived}: height=${block.height} time=${ts}`);
          }

          if (blocksReceived >= 500) {
            console.log('\n   Reached 500 block limit, stopping.');
            streamAbort.abort();
            break;
          }
        }

        console.log(`\n   Stream ended after ${blocksReceived} blocks.`);
        break;
      } catch (err) {
        if (streamAbort.signal.aborted) {
          console.log(`\n   Stream ended after ${blocksReceived} blocks (client abort).`);
          break;
        }

        if (err instanceof ConnectError && err.code === Code.ResourceExhausted) {
          streamError = 'credits exhausted';
          console.log(
            `\n   Stream ended: RESOURCE_EXHAUSTED (credits exhausted) after ${blocksReceived} blocks.`,
          );
          break;
        }

        if (
          err instanceof ConnectError &&
          err.code === Code.Unauthenticated &&
          streamAttempts < MAX_STREAM_ATTEMPTS
        ) {
          console.log('   Token expired mid-stream, re-authenticating...');
          await client.authenticate();
          continue;
        }

        if (blocksReceived === 0 && streamAttempts < MAX_STREAM_ATTEMPTS) {
          const errMsg =
            err instanceof ConnectError ? `${Code[err.code]}: ${err.rawMessage}` : `${err}`;
          console.log(
            `   Stream failed to open (attempt ${streamAttempts}/${MAX_STREAM_ATTEMPTS}): ${errMsg}`,
          );
          console.log('   Retrying in 2s...');
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        if (err instanceof ConnectError) {
          streamError = `gRPC error: ${Code[err.code]} - ${err.rawMessage}`;
        } else {
          streamError = `${err}`;
        }
        console.log(`\n   Stream error: ${streamError}`);
        break;
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

  const totalGrpcCalls = unaryCalls + blocksReceived;
  const durationMs = Date.now() - startTime;

  console.log(`\n${'='.repeat(60)}`);
  console.log('   Summary');
  console.log('='.repeat(60));
  console.log(`   Network:                   flow-mainnet`);
  console.log(`   Protocol:                  gRPC-Web`);
  console.log(`   Payment model:             credit-drawdown`);
  console.log(`   Auth chain:                ${chainType}`);
  console.log(`   Total gRPC calls:          ${totalGrpcCalls}`);
  console.log(`     Unary calls:             ${unaryCalls}`);
  console.log(`     Stream blocks received:  ${blocksReceived}`);
  console.log(`   Total fetch calls:         ${tracker.totalFetchCount}`);
  console.log(`   x402 payments:             ${tracker.successfulPaymentCount}`);
  {
    let finalCredits = { credits: 0 };
    try {
      finalCredits = await getCredits(getToken, { forceRefresh: true });
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
  if (streamError) {
    console.log(`   Stream termination:        ${streamError}`);
  }
  console.log(`   Duration:                  ${(durationMs / 1000).toFixed(2)}s`);
  if (totalGrpcCalls > 0) {
    console.log(`   Avg time per call:         ${(durationMs / totalGrpcCalls).toFixed(0)}ms`);
  }
  console.log(`${'='.repeat(60)}\n`);
  process.exit(0);
}

main().catch(() => process.exit(0));
