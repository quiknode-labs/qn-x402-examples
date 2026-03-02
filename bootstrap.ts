/**
 * Bootstrap — runs wallet setup, auth, and faucet funding once before
 * launching all 4 example scripts via stmux.
 *
 * Uses @quicknode/x402 for SIWX authentication and x402 payment handling.
 * Each example script independently authenticates (preAuth: true), but
 * bootstrap ensures wallet creation, funding, and initial credit purchase
 * happen once to avoid race conditions.
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

  console.log(
    `\n  x402 Bootstrap — ${chainType === 'solana' ? 'Solana' : 'EVM'} wallet, auth & funding\n`,
  );
  console.log('='.repeat(60));
  const chainDetail =
    chainType === 'evm'
      ? ` (${process.env.X402_EVM_CHAIN ?? 'base-sepolia'})`
      : ` (${process.env.X402_SOLANA_CHAIN ?? 'solana-devnet'})`;
  console.log(`   Chain:  ${chainType}${chainDetail}`);
  console.log(`   Target: ${X402_BASE_URL}`);

  // Wallet creation, authentication, and funding handled by createClientForChain
  const { client } = await createClientForChain();
  const getToken = () => client.getToken();

  // Ensure credits > 0 (purchase if needed)
  let creditsInfo = await getCredits(getToken);
  console.log(`   Credits: ${creditsInfo.credits}`);

  if (creditsInfo.credits <= 0) {
    console.log('   No credits — purchasing via x402 payment...');
    const network = chainType === 'evm' ? getEvmChain().rpcSlug : getSolanaChain().rpcSlug;
    creditsInfo = await purchaseCredits(client.fetch, getToken, network);
    console.log(`   Credits after purchase: ${creditsInfo.credits}`);
  }

  console.log('='.repeat(60));
  console.log('   Bootstrap complete. Launching examples...\n');

  // Launch stmux with all 4 examples (bootstrapped = no x402 payments)
  execSync(
    'npx --yes stmux -- ' +
      '[ [ -t JSONRPC "npx tsx jsonrpc.ts" .. -t REST "npx tsx rest.ts" ] ' +
      ': [ -t WebSocket "npx tsx websocket.ts" .. -t gRPC "npx tsx grpc.ts" ] ]',
    {
      stdio: 'inherit',
      cwd: import.meta.dirname,
      env: { ...process.env, X402_BOOTSTRAPPED: '1' },
    },
  );
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
