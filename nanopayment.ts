/**
 * Nanopayment Example — demonstrates Circle Gateway batch payments at $0.0001/request.
 *
 * Uses Circle Gateway for sub-cent payments. Before making requests, the buyer
 * must deposit USDC into the Gateway Wallet contract (one-time on-chain tx).
 *
 * Usage:
 *   npm run start:nanopayment
 *   X402_EVM_CHAIN=arc-testnet npm run start:nanopayment
 */
import { CAIP2_TO_GATEWAY_CHAIN, type GatewayChainName } from '@quicknode/x402';
import {
  createPaymentTracker,
  EVM_CHAINS,
  type EvmChainSlug,
  jsonRpc,
  setupExample,
  X402_BASE_URL,
} from './lib/x402-helpers.js';

// ── Config ───────────────────────────────────────────────
const CHAIN_SLUG = (process.env.X402_EVM_CHAIN ?? 'base-sepolia') as EvmChainSlug;
const chain = EVM_CHAINS[CHAIN_SLUG];
if (!chain) {
  console.error(`Unknown chain: ${CHAIN_SLUG}. Valid: ${Object.keys(EVM_CHAINS).join(', ')}`);
  process.exit(1);
}
const JSONRPC_URL = `${X402_BASE_URL}/${chain.rpcSlug ?? CHAIN_SLUG}`;
const DEMO_REQUEST_COUNT = 10;

// ── Shared state ─────────────────────────────────────────
const tracker = createPaymentTracker();

// ── Always exit clean (log errors before exit) ──────────
process.on('uncaughtException', (err) => {
  console.error('Uncaught:', err.message);
  process.exit(1);
});
process.on('unhandledRejection', (err: any) => {
  console.error('Unhandled:', err?.message ?? err);
  process.exit(1);
});

// ── Gateway balance polling ───────────────────────────────
/** Poll Gateway balance until available > 0 or timeout (30s). */
async function waitForGatewayBalance(
  gw: NonNullable<Awaited<ReturnType<typeof setupExample>>['client']['gatewayClient']>,
  maxWaitMs = 30_000,
  intervalMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const b = await gw.getBalances();
    if (b.gateway.available > 0n) {
      console.log(`   Gateway avail: ${b.gateway.formattedAvailable}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('\n  x402 Example - Circle Gateway Nanopayments ($0.0001/request)\n');
  console.log('='.repeat(60));

  // Force nanopayment model
  process.env.X402_PAYMENT_MODEL = 'nanopayment';
  process.env.X402_EVM_CHAIN = CHAIN_SLUG;

  const { client, x402Fetch } = await setupExample(tracker);

  // ── Gateway Balance Check ──────────────────────────────
  const gatewayChainName = CAIP2_TO_GATEWAY_CHAIN[chain.caip2] as GatewayChainName | undefined;

  if (gatewayChainName && client.gatewayClient) {
    console.log(`\n   Checking Gateway Wallet balance on ${gatewayChainName}...`);
    try {
      const balances = await client.gatewayClient.getBalances();
      console.log(`   Wallet USDC:   ${balances.wallet.formatted}`);
      console.log(`   Gateway total: ${balances.gateway.formattedTotal}`);
      console.log(`   Gateway avail: ${balances.gateway.formattedAvailable}`);

      if (balances.gateway.available === 0n) {
        // Gateway shows 0 — but a recent deposit may not be indexed yet.
        // Poll a few times before deciding to deposit.
        let gatewayReady = false;
        if (balances.gateway.total > 0n) {
          console.log('\n   Gateway has pending funds, waiting for availability...');
          gatewayReady = await waitForGatewayBalance(client.gatewayClient);
        }

        if (!gatewayReady) {
          console.log('\n   No USDC deposited in Gateway Wallet.');
          const MIN_DEPOSIT_USDC = 0.001;
          if (balances.wallet.balance > 0n) {
            const walletUsdc = Number(balances.wallet.balance) / 1e6;
            const depositNum = Math.min(0.5, walletUsdc);
            if (depositNum < MIN_DEPOSIT_USDC) {
              console.log(`   Wallet balance too low to deposit (${walletUsdc.toFixed(6)} USDC, minimum ${MIN_DEPOSIT_USDC}).`);
              console.log(`   Fund your wallet with more USDC first:`);
              console.log(`   Wallet address: ${client.gatewayClient.address ?? '(see .env)'}\n`);
            } else {
              const depositAmount = depositNum.toFixed(6);
              console.log(`   Auto-depositing ${depositAmount} USDC into Gateway Wallet...`);
              try {
                const depositResult = await client.gatewayClient.deposit(depositAmount);
                console.log(`   Deposit successful! tx: ${depositResult.depositTxHash}`);

                // Poll until Gateway balance appears (deposit needs indexing time)
                console.log('   Waiting for Gateway to index deposit...');
                const funded = await waitForGatewayBalance(client.gatewayClient);
                if (!funded) {
                  console.log('   Gateway balance not yet visible — deposit may still be indexing.');
                  console.log('   Proceeding anyway (first request may trigger settlement retry).\n');
                }
              } catch (depositErr: any) {
                const msg = depositErr.message || '';
                if (msg.includes('insufficient funds') || msg.includes('gas')) {
                  console.log('   Auto-deposit failed: wallet has no native token for gas.');
                  console.log('   The deposit requires ETH/native token to pay for the approve + deposit transactions.');
                  console.log(`   Fund your wallet with native token first:`);
                  console.log(`   Wallet address: ${client.gatewayClient.address ?? '(see .env)'}\n`);
                } else {
                  console.log(`   Auto-deposit failed: ${msg}`);
                }
                console.log('   To deposit manually:\n');
                console.log(`     import { GatewayClient } from '@quicknode/x402';`);
                console.log(
                  `     const gw = new GatewayClient({ chain: '${gatewayChainName}', privateKey: '0x...' });`,
                );
                console.log(`     await gw.deposit('1.0'); // Deposit 1 USDC\n`);
              }
            }
          } else {
            console.log('   Wallet has no USDC either. Fund your wallet first:');
            console.log(`   Wallet address: ${client.gatewayClient.address ?? '(see .env)'}\n`);
          }
        }
      }
    } catch (err: any) {
      console.log(`   Could not check Gateway balance: ${err.message}`);
      console.log('   Proceeding anyway...\n');
    }
  } else {
    console.log(`\n   No Gateway chain mapping for ${chain.caip2} — skipping balance check.`);
  }

  // ── Request Loop ───────────────────────────────────────
  tracker.maxPayments = DEMO_REQUEST_COUNT;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`   Mode: nanopayment (Circle Gateway, $0.0001/request)`);
  console.log(`   Demo: ${DEMO_REQUEST_COUNT} paid requests`);
  console.log(`   Chain: ${CHAIN_SLUG} (${chain.caip2})`);
  console.log('='.repeat(60));
  console.log(`\n-- Nanopayment Request Loop --\n`);

  let requestCount = 0;
  let consecutiveErrors = 0;
  let insufficientBalanceRetries = 0;
  const MAX_BALANCE_RETRIES = 10; // Gateway indexing can take 30-60s on some chains

  while (requestCount < DEMO_REQUEST_COUNT + 10) {
    try {
      const result = await jsonRpc(x402Fetch, JSONRPC_URL, 'eth_blockNumber');
      requestCount++;
      const blockNumber = BigInt(result as string);

      consecutiveErrors = 0;
      insufficientBalanceRetries = 0;
      const timestamp = new Date().toISOString().slice(11, 23);
      console.log(`   ${timestamp} Request #${requestCount}: Block ${blockNumber}`);

      if (requestCount >= DEMO_REQUEST_COUNT) {
        console.log(`\n   Completed ${DEMO_REQUEST_COUNT} nanopayment requests.`);
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error: any) {
      const msg = error.message ?? '';

      // Check insufficient_balance BEFORE generic 402 — it comes as HTTP 402 with
      // the error reason in the body, so startsWith('HTTP 402') would match first.
      if (msg.includes('insufficient_balance') || msg.includes('insufficient balance')) {
        insufficientBalanceRetries++;
        if (insufficientBalanceRetries >= MAX_BALANCE_RETRIES) {
          console.log('\n   Gateway settlement failed: insufficient Gateway Wallet balance.');
          console.log('   The Circle Gateway may still be indexing your deposit.');
          console.log('   Try again in a few minutes, or deposit manually.');
          break;
        }
        const waitSec = Math.min(5, insufficientBalanceRetries);
        console.log(
          `   Gateway balance not available yet (attempt ${insufficientBalanceRetries}/${MAX_BALANCE_RETRIES}), ` +
            `retrying in ${waitSec}s... (Circle Gateway may still be indexing the deposit)`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
        continue;
      }
      if (msg.startsWith('HTTP 402')) {
        console.log(`\n   Payment cap reached after ${tracker.successfulPaymentCount} payments.`);
        break;
      }
      consecutiveErrors++;
      console.error(`   Request #${requestCount + 1} failed:`, msg);
      if (consecutiveErrors >= 3) {
        console.log('\n   Too many consecutive errors, stopping.');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // ── Summary ────────────────────────────────────────────
  const durationMs = Date.now() - startTime;
  const estimatedCost = tracker.successfulPaymentCount * 0.0001;

  console.log(`\n${'='.repeat(60)}`);
  console.log('   Summary');
  console.log('='.repeat(60));
  console.log(`   Network:                   ${CHAIN_SLUG}`);
  console.log(`   Protocol:                  JSON-RPC`);
  console.log(`   Payment model:             nanopayment (Circle Gateway)`);
  console.log(`   Total requests:            ${requestCount}`);
  console.log(`   Total fetch calls:         ${tracker.totalFetchCount}`);
  console.log(`   x402 payments:             ${tracker.successfulPaymentCount}`);
  console.log(`   Estimated cost:            $${estimatedCost.toFixed(4)}`);
  console.log(`   Cost per request:          $0.0001`);
  console.log(`   Duration:                  ${(durationMs / 1000).toFixed(2)}s`);
  if (requestCount > 0) {
    console.log(`   Avg time per request:      ${(durationMs / requestCount).toFixed(0)}ms`);
  }
  console.log(`${'='.repeat(60)}\n`);
  process.exit(0);
}

main().catch(() => process.exit(0));
