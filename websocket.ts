/**
 * WebSocket Example — real-time subscriptions through the x402 proxy.
 *
 * Subscribes to `newHeads` on Ethereum Mainnet via WebSocket,
 * receives block header events with per-message credit metering,
 * and handles credit exhaustion gracefully.
 *
 * Usage:
 *   npm run example:ws
 *   WS_NETWORK=base-sepolia npm run example:ws
 */
import { formatUnits } from 'viem';
import {
  createCreditPoller,
  createPaymentTracker,
  getCredits,
  getUsdcBalanceRaw,
  setupExample,
  USDC_DECIMALS,
  X402_BASE_URL,
} from './lib/x402-helpers.js';

// ── Config ───────────────────────────────────────────────
const WS_NETWORK = process.env.WS_NETWORK || 'base-mainnet';
const MAX_EVENTS = 50;
const TIMEOUT_MS = 120_000;
const BOOTSTRAPPED = process.env.X402_BOOTSTRAPPED === '1';

// ── Shared state ─────────────────────────────────────────
const tracker = createPaymentTracker();

// ── Always exit clean — suppress stray WebSocket/Node errors ──
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('\n  x402 Example - WebSocket Subscriptions\n');
  console.log('='.repeat(60));

  // ── Setup (chain-aware: EVM or Solana) ───────────────────
  const { chainType, walletAddress, startBalance, client, x402Fetch } = await setupExample(tracker);
  const getToken = () => client.getToken();

  // ── Ensure credits ─────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log('   Checking credits...');
  let creditsInfo = await getCredits(getToken);
  const initialCredits = creditsInfo.credits;
  console.log(`   Account: ${creditsInfo.accountId}`);
  console.log(`   Credits: ${initialCredits}`);

  console.log(
    `   Mode: ${BOOTSTRAPPED ? 'bootstrapped (no payments)' : 'standalone (1 payment max)'}`,
  );
  // Bootstrap mode: never pay. Standalone: allow 1 proactive payment.
  tracker.maxPayments = BOOTSTRAPPED ? 0 : 1;

  if (initialCredits <= 0 && BOOTSTRAPPED) {
    console.log('   No credits — exiting (bootstrap should have purchased).\n');
    return;
  } else if (initialCredits <= 0) {
    // WebSocket connections can't trigger x402 payments (no HTTP 402 handshake),
    // so we make a proactive HTTP request to purchase credits first.
    console.log('   No credits — making a paid HTTP request to trigger x402 payment...');
    await x402Fetch(`${X402_BASE_URL}/${WS_NETWORK}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    creditsInfo = await getCredits(getToken);
    console.log(`   Credits after payment: ${creditsInfo.credits}`);
  }
  console.log('='.repeat(60));

  // Reset counters for the test run
  tracker.paymentResponseCount = 0;
  tracker.successfulPaymentCount = 0;
  tracker.totalFetchCount = 0;

  // ── Phase 1: WebSocket Connection & Subscription ───────
  console.log(`\n-- Phase 1: WebSocket Connection (${WS_NETWORK}) --\n`);

  const creditsBeforeWs = creditsInfo.credits;
  console.log(`   Credits before connection: ${creditsBeforeWs}`);
  console.log(`   Target: ${MAX_EVENTS} events (or until credits exhausted)`);
  console.log(`   Timeout: ${TIMEOUT_MS / 1000}s\n`);

  let eventsReceived = 0;
  let subscriptionId: string | null = null;
  let closeCode = 0;
  let closeReason = '';

  // Non-blocking credit poller — fires-and-forgets HTTP requests so the
  // message handler never blocks waiting for a credit check response.
  const poller = createCreditPoller(getToken);
  poller.credits = creditsBeforeWs;

  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timeout = setTimeout(() => {
      console.log(`\n   Timeout after ${TIMEOUT_MS / 1000}s — closing connection.`);
      ws.close();
      settle();
    }, TIMEOUT_MS);

    let ws: WebSocket;
    try {
      ws = client.createWebSocket(WS_NETWORK);
    } catch (err) {
      clearTimeout(timeout);
      console.log(`   WebSocket creation failed: ${err}`);
      settle();
      return;
    }

    ws.addEventListener('open', () => {
      console.log('   WebSocket connected!');
      console.log('   Subscribing to newHeads...\n');

      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_subscribe',
          params: ['newHeads'],
          id: 1,
        }),
      );
    });

    ws.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(String(event.data));

        // Credit exhaustion error from proxy
        if (data.error?.code === -32000 && data.error?.message === 'credits exhausted') {
          console.log(`\n   Credits exhausted (JSON-RPC error from proxy).`);
          clearTimeout(timeout);
          ws.close();
          settle();
          return;
        }

        // Subscription confirmation
        if (data.id === 1 && data.result) {
          subscriptionId = data.result;
          console.log(`   Subscribed! ID: ${subscriptionId}`);
          return;
        }

        // Subscription event (newHeads)
        if (data.params?.result) {
          eventsReceived++;
          const block = data.params.result;
          const blockNumber = parseInt(block.number, 16);
          const timestamp = new Date().toISOString().slice(11, 23);

          poller.poll(); // fire-and-forget
          console.log(
            `   ${timestamp} Block #${eventsReceived}: height=${blockNumber} ` +
              `hash=${block.hash?.slice(0, 18)}... | Credits: ${poller.credits}${poller.delta}`,
          );

          if (eventsReceived >= MAX_EVENTS) {
            console.log(`\n   Received ${MAX_EVENTS} events — closing.`);
            clearTimeout(timeout);
            ws.close();
            settle();
          }
        }
      } catch {
        // Non-JSON message (e.g., pong) — ignore
      }
    });

    ws.addEventListener('close', (event) => {
      clearTimeout(timeout);
      closeCode = event.code;
      closeReason = event.reason || '(none)';

      if (event.code === 4402) {
        console.log('\n   Connection closed: credits exhausted (code 4402)');
      } else if (event.code === 1000 || event.code === 1005) {
        console.log(`\n   WebSocket closed cleanly: code=${event.code}`);
      } else {
        console.log(`\n   WebSocket closed: code=${event.code} reason=${closeReason}`);
      }
      settle();
    });

    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      if (settled) return;
      console.log('   WebSocket connection failed.');
      settle();
    });
  });

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
    finalCredits = await getCredits(getToken, { forceRefresh: true });
  } catch {
    // Token may have expired
  }

  const totalSpent = startBalance - currentBalance;
  const durationMs = Date.now() - startTime;

  console.log(`\n${'='.repeat(60)}`);
  console.log('   Summary');
  console.log('='.repeat(60));
  console.log(`   Network:                   ${WS_NETWORK}`);
  console.log(`   Protocol:                  WebSocket`);
  console.log(`   Auth chain:                ${chainType}`);
  console.log(`   Events received:           ${eventsReceived}`);
  console.log(`   Subscription ID:           ${subscriptionId || '(none)'}`);
  console.log(`   Close code:                ${closeCode || '(clean)'}`);
  if (closeCode && closeCode !== 1000 && closeCode !== 1005) {
    console.log(`   Close reason:              ${closeReason}`);
  }
  console.log(`   x402 payments:             ${tracker.successfulPaymentCount}`);
  console.log(`   Initial credits:           ${initialCredits}`);
  console.log(`   Final credits:             ${finalCredits.credits}`);
  if (chainType === 'evm') {
    console.log(`   Starting USDC:             $${formatUnits(startBalance, USDC_DECIMALS)}`);
    console.log(`   Final USDC:                $${formatUnits(currentBalance, USDC_DECIMALS)}`);
    console.log(`   USDC spent:                $${formatUnits(totalSpent, USDC_DECIMALS)}`);
  }
  console.log(`   Duration:                  ${(durationMs / 1000).toFixed(2)}s`);
  if (eventsReceived > 0) {
    console.log(`   Avg time per event:        ${(durationMs / eventsReceived).toFixed(0)}ms`);
  }
  console.log(`${'='.repeat(60)}\n`);
  process.exit(0);
}

main().catch(() => process.exit(0));
