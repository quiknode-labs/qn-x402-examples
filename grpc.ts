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

  // ── Setup (chain-aware: EVM or Solana) ───────────────────
  const { chainType, walletAddress, startBalance, client, x402Fetch } = await setupExample(tracker);
  const getToken = () => client.getToken();

  // ── Create connect-web gRPC client ───────────────────────
  // Debug wrapper: log error response bodies (worker returns JSON on 502)
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
  let creditsInfo = await getCredits(getToken);
  const initialCredits = creditsInfo.credits;
  console.log(`   Account: ${creditsInfo.accountId}`);
  console.log(`   Credits: ${initialCredits}`);
  console.log('   (Checked at start/end only — /credits is rate-limited)');
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

  // ── Phase 2: Streaming gRPC call ──────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log('-- Phase 2: Streaming gRPC-Web (SubscribeBlocksFromLatest) --');

  creditsInfo = await getCredits(getToken);
  const creditsBeforeStream = creditsInfo.credits;
  console.log(`   Credits before stream: ${creditsBeforeStream}`);

  if (creditsBeforeStream <= 0 && BOOTSTRAPPED) {
    console.log('   No credits remaining — demo complete.\n');
  } else if (creditsBeforeStream <= 0 && tracker.successfulPaymentCount === 0) {
    console.log('   No credits — stream request will trigger x402 payment\n');
  } else {
    console.log(`   Streaming blocks until credits exhausted or 500 blocks...\n`);
  }

  let blocksReceived = 0;
  let streamError: string | null = null;
  const streamAbort = new AbortController();

  // Retry wrapper — handles re-auth, transient failures, and 402 on stream open
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
          console.log(
            `   ${local} Block #${blocksReceived}: height=${block.height} time=${ts}`,
          );
        }

        // Safety limit
        if (blocksReceived >= 500) {
          console.log('\n   Reached 500 block limit, stopping.');
          streamAbort.abort();
          break;
        }
      }

      // Stream ended normally
      console.log(`\n   Stream ended after ${blocksReceived} blocks.`);
      break; // exit retry loop
    } catch (err) {
      // Client-initiated abort (500 block limit) — not an error
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

      // Re-auth on Unauthenticated
      if (
        err instanceof ConnectError &&
        err.code === Code.Unauthenticated &&
        streamAttempts < MAX_STREAM_ATTEMPTS
      ) {
        console.log('   Token expired mid-stream, re-authenticating...');
        await client.authenticate();
        continue; // retry stream
      }

      // Transient failure (e.g., stream failed to open, 402 passthrough) — retry
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

  // ── Summary ────────────────────────────────────────────
  let currentBalance = startBalance;
  if (chainType === 'evm') {
    try {
      currentBalance = await getTokenBalanceRaw(walletAddress);
    } catch (_error) {
      console.log('   (Could not fetch final balance)');
    }
  }

  let finalCredits = { credits: 0 };
  try {
    finalCredits = await getCredits(getToken, { forceRefresh: true });
  } catch {
    console.log('   (Could not fetch final credits)');
  }
  const totalSpent = startBalance - currentBalance;
  const totalGrpcCalls = unaryCalls + blocksReceived;
  const durationMs = Date.now() - startTime;

  console.log(`\n${'='.repeat(60)}`);
  console.log('   Summary');
  console.log('='.repeat(60));
  console.log(`   Network:                   flow-mainnet`);
  console.log(`   Protocol:                  gRPC-Web`);
  console.log(`   Auth chain:                ${chainType}`);
  console.log(`   Total gRPC calls:          ${totalGrpcCalls}`);
  console.log(`     Unary calls:             ${unaryCalls}`);
  console.log(`     Stream blocks received:  ${blocksReceived}`);
  console.log(`   Total fetch calls:         ${tracker.totalFetchCount}`);
  console.log(`   x402 payments:             ${tracker.successfulPaymentCount}`);
  console.log(`   Initial credits:           ${initialCredits}`);
  console.log(`   Final credits:             ${finalCredits.credits}`);
  if (chainType === 'evm') {
    console.log(`   Starting balance:             $${formatUnits(startBalance, TOKEN_DECIMALS)}`);
    console.log(`   Final balance:                $${formatUnits(currentBalance, TOKEN_DECIMALS)}`);
    console.log(`   Tokens spent:                $${formatUnits(totalSpent, TOKEN_DECIMALS)}`);
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
