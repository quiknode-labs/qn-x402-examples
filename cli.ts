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
 */
import { execSync } from 'node:child_process';
import { select } from '@inquirer/prompts';
import { type ChainType, EVM_CHAINS, SOLANA_CHAINS } from './lib/x402-helpers.js';

interface CliConfig {
  chainType: ChainType;
  chainSlug: string;
  paymentModel: 'credit-drawdown' | 'pay-per-request';
  example: string;
}

async function resolveConfig(): Promise<CliConfig> {
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

  const paymentModel = await select<'credit-drawdown' | 'pay-per-request'>({
    message: 'Payment model',
    choices: [
      {
        name: 'Pay per request ($0.001/request, no auth)',
        value: 'pay-per-request',
      },
      {
        name: 'Credit drawdown (testnet: $1/1k credits, mainnet: $10/1M credits, SIWX auth)',
        value: 'credit-drawdown',
      },
    ],
  });

  const example = await select<string>({
    message: 'Example to run',
    choices: [
      { name: 'JSON-RPC', value: 'jsonrpc' },
      { name: 'REST', value: 'rest' },
      { name: 'gRPC', value: 'grpc' },
      { name: 'WebSocket (requires credit drawdown)', value: 'websocket' },
      { name: 'All (stmux split view)', value: 'all' },
    ],
  });

  // WebSocket requires credit drawdown
  if (example === 'websocket' && paymentModel === 'pay-per-request') {
    console.log(
      '\n  WebSocket requires credit drawdown (persistent connection). Switching to credit drawdown.\n',
    );
    return { chainType, chainSlug, paymentModel: 'credit-drawdown', example };
  }

  return { chainType, chainSlug, paymentModel, example };
}

async function runCli() {
  // Non-interactive detection: fall back to bootstrap.ts
  if (process.env.CI || !process.stdin.isTTY) {
    console.log('Non-interactive environment detected. Falling back to legacy bootstrap.');
    execSync('npx tsx bootstrap.ts', {
      stdio: 'inherit',
      cwd: import.meta.dirname,
      env: process.env,
    });
    return;
  }

  console.log('\n  Quicknode x402 Examples — Interactive Setup\n');

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
  env.X402_PAYMENT_MODEL = config.paymentModel;

  if (config.chainType === 'evm') {
    env.X402_EVM_CHAIN = config.chainSlug;
  } else {
    env.X402_SOLANA_CHAIN = config.chainSlug;
  }

  console.log(`\n  Chain: ${config.chainSlug}`);
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

export { resolveConfig, runCli };
