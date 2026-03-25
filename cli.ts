/**
 * Interactive CLI entry point for qn-x402-examples.
 *
 * Replaces env-var driven config with interactive prompts for:
 * 1. Chain type (EVM / Solana)
 * 2. Payment network (Base Sepolia, Polygon Amoy, etc.)
 * 3. Payment model (per-request / credit drawdown)
 * 4. Example to run
 *
 * Falls back to env-var behavior in non-interactive environments (CI, piped stdin).
 *
 * Base URL: defaults to https://x402.quicknode.com
 *   Override: --base-url <url>  OR  X402_BASE_URL=<url>
 */
import { execSync } from 'node:child_process';
import { select } from '@inquirer/prompts';
import { type ChainType, EVM_CHAINS, SOLANA_CHAINS } from './lib/x402-helpers.js';

const DEFAULT_BASE_URL = 'https://x402.quicknode.com';

interface CliConfig {
  chainType: ChainType;
  chainSlug: string;
  paymentModel: 'credit-drawdown' | 'pay-per-request' | 'nanopayment';
  example: string;
  baseUrl: string;
}

/** Parse --base-url from argv, fall back to X402_BASE_URL env, then default. */
function resolveBaseUrl(): string {
  const idx = process.argv.indexOf('--base-url');
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return process.env.X402_BASE_URL || DEFAULT_BASE_URL;
}

async function resolveConfig(): Promise<CliConfig> {
  const baseUrl = resolveBaseUrl();

  const chainType = await select<ChainType>({
    message: 'Chain type',
    choices: [
      { name: 'EVM (Base, Polygon, XLayer)', value: 'evm' },
      { name: 'Solana', value: 'solana' },
    ],
  });

  const chains = chainType === 'evm' ? EVM_CHAINS : SOLANA_CHAINS;
  const chainSlug = await select<string>({
    message: 'Payment network',
    choices: Object.entries(chains).map(([slug, info]) => ({
      name: `${slug} (${info.caip2})`,
      value: slug,
    })),
  });

  // Chain-aware payment model choices:
  // - Arc Testnet: nanopayment only (no exact per-request or credit drawdown)
  // - Solana: no nanopayment (not supported)
  // - Other EVM: all options
  const NANOPAYMENT_ONLY_CHAINS = new Set(['arc-testnet']);
  const NANOPAYMENT_ELIGIBLE_CHAINS = new Set(['base-sepolia', 'polygon-amoy', 'arc-testnet']);

  type PaymentModelChoice = {
    name: string;
    value: 'credit-drawdown' | 'pay-per-request' | 'nanopayment';
  };
  let paymentModelChoices: PaymentModelChoice[];

  if (NANOPAYMENT_ONLY_CHAINS.has(chainSlug)) {
    paymentModelChoices = [
      {
        name: 'Nanopayment ($0.0001/request, Circle Gateway)',
        value: 'nanopayment',
      },
    ];
  } else {
    paymentModelChoices = [
      {
        name: 'Pay per request ($0.001/request, no auth)',
        value: 'pay-per-request',
      },
      {
        name: 'Credit drawdown (testnet: $1/1k credits, mainnet: $10/1M credits, SIWX auth)',
        value: 'credit-drawdown',
      },
      ...(chainType === 'evm' && NANOPAYMENT_ELIGIBLE_CHAINS.has(chainSlug)
        ? [
            {
              name: 'Nanopayment ($0.0001/request, Circle Gateway, EVM testnets only)',
              value: 'nanopayment' as const,
            },
          ]
        : []),
    ];
  }

  const paymentModel = await select<'credit-drawdown' | 'pay-per-request' | 'nanopayment'>({
    message: 'Payment model',
    choices: paymentModelChoices,
  });

  // Per-request and nanopayment only work with JSON-RPC and REST
  const isPerRequestLike = paymentModel === 'pay-per-request' || paymentModel === 'nanopayment';
  const exampleChoices =
    paymentModel === 'nanopayment'
      ? [{ name: 'Nanopayment (JSON-RPC)', value: 'nanopayment' }]
      : isPerRequestLike
        ? [
            { name: 'JSON-RPC', value: 'jsonrpc' },
            { name: 'REST', value: 'rest' },
            { name: 'All (stmux split view)', value: 'all' },
          ]
        : [
            { name: 'JSON-RPC', value: 'jsonrpc' },
            { name: 'REST', value: 'rest' },
            { name: 'gRPC', value: 'grpc' },
            { name: 'WebSocket', value: 'websocket' },
            { name: 'All (stmux split view)', value: 'all' },
          ];

  const example = await select<string>({
    message: 'Example to run',
    choices: exampleChoices,
  });

  return { chainType, chainSlug, paymentModel, example, baseUrl };
}

async function runCli() {
  const baseUrl = resolveBaseUrl();

  // Non-interactive detection: fall back to bootstrap.ts
  if (process.env.CI || !process.stdin.isTTY) {
    console.log('Non-interactive environment detected. Falling back to legacy bootstrap.');
    execSync('npx tsx bootstrap.ts', {
      stdio: 'inherit',
      cwd: import.meta.dirname,
      env: { ...process.env, X402_BASE_URL: baseUrl },
    });
    return;
  }

  console.log('\n  Quicknode x402 Examples — Interactive Setup');
  console.log(`  Base URL: ${baseUrl}${baseUrl !== DEFAULT_BASE_URL ? ' (custom)' : ''}\n`);

  let config: CliConfig;
  try {
    config = await resolveConfig();
  } catch {
    // User pressed Ctrl+C
    console.log('\nExiting.');
    process.exit(0);
  }

  // Set env vars for the selected config
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.X402_BASE_URL = config.baseUrl;
  env.X402_PAYMENT_MODEL = config.paymentModel;

  if (config.chainType === 'evm') {
    env.X402_EVM_CHAIN = config.chainSlug;
  } else {
    env.X402_SOLANA_CHAIN = config.chainSlug;
  }

  console.log(`\n  Base URL: ${config.baseUrl}`);
  console.log(`  Chain: ${config.chainSlug}`);
  console.log(`  Model: ${config.paymentModel}`);
  console.log(`  Example: ${config.example}\n`);

  if (config.example === 'all') {
    // Launch bootstrap which handles wallet + stmux
    execSync('npx tsx bootstrap.ts', {
      stdio: 'inherit',
      cwd: import.meta.dirname,
      env,
    });
  } else {
    execSync(`npx tsx ${config.example}.ts`, {
      stdio: 'inherit',
      cwd: import.meta.dirname,
      env,
    });
  }
}

runCli().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});

export { resolveBaseUrl, resolveConfig, runCli };
