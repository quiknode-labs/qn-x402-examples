/**
 * Bootstrap — runs wallet setup and (for credit drawdown) auth + funding once
 * before launching all example scripts via stmux.
 *
 * Supports both payment models:
 *   - Credit drawdown: wallet + auth + faucet + credit purchase → stmux
 *   - Pay-per-request: wallet + balance check → stmux (no auth, no credits)
 */
import { execSync } from 'node:child_process';
import {
  createClientForChain,
  detectChainType,
  getCredits,
  getEvmChain,
  getSolanaChain,
  X402_BASE_URL,
} from './lib/x402-helpers.js';

async function purchaseCredits(
  x402Fetch: typeof globalThis.fetch,
  getToken: () => string | null,
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
  let creditsInfo = await getCredits(getToken);
  while (Date.now() - start < maxWaitMs) {
    creditsInfo = await getCredits(getToken, { forceRefresh: true });
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

async function main() {
  const chainType = detectChainType();

  console.log(`\n  x402 Bootstrap — ${chainType === 'solana' ? 'Solana' : 'EVM'} wallet setup\n`);
  console.log('='.repeat(60));
  const chainDetail =
    chainType === 'evm'
      ? ` (${process.env.X402_EVM_CHAIN ?? 'base-sepolia'})`
      : ` (${process.env.X402_SOLANA_CHAIN ?? 'solana-devnet'})`;
  console.log(`   Chain:  ${chainType}${chainDetail}`);
  console.log(`   Target: ${X402_BASE_URL}`);

  // Wallet creation (+ auth for credit drawdown) handled by createClientForChain
  const { client, paymentModel } = await createClientForChain();
  const isPerRequest = paymentModel === 'pay-per-request';
  console.log(`   Model:  ${paymentModel}`);

  if (!isPerRequest) {
    // Credit drawdown: ensure credits > 0 (purchase if needed)
    const getToken = () => client.getToken();
    let creditsInfo = await getCredits(getToken);
    console.log(`   Credits: ${creditsInfo.credits}`);

    if (creditsInfo.credits <= 0) {
      console.log('   No credits — purchasing via x402 payment...');
      const network = chainType === 'evm' ? getEvmChain().rpcSlug : getSolanaChain().rpcSlug;
      creditsInfo = await purchaseCredits(client.fetch, getToken, network);
      console.log(`   Credits after purchase: ${creditsInfo.credits}`);
    }
  } else {
    console.log('   Pay-per-request: no credits needed (each request pays $0.001)');
  }

  console.log('='.repeat(60));
  console.log('   Bootstrap complete. Launching examples...\n');

  const env = { ...process.env, X402_BOOTSTRAPPED: '1', X402_PAYMENT_MODEL: paymentModel };

  // Per-request: only JSON-RPC + REST (worker rejects gRPC/WebSocket per-request)
  // Credit drawdown: all 4 protocols
  const stmuxLayout = isPerRequest
    ? '[ -t JSONRPC "npx tsx jsonrpc.ts" .. -t REST "npx tsx rest.ts" ]'
    : '[ [ -t JSONRPC "npx tsx jsonrpc.ts" .. -t REST "npx tsx rest.ts" ] : [ -t WebSocket "npx tsx websocket.ts" .. -t gRPC "npx tsx grpc.ts" ] ]';

  execSync(`npx --yes stmux -- ${stmuxLayout}`, {
    stdio: 'inherit',
    cwd: import.meta.dirname,
    env,
  });
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
