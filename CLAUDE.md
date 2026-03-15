# qn-x402-examples

Public example scripts demonstrating Quicknode's x402 RPC proxy using the `@quicknode/x402` client package. Two payment models: per-request ($0.001/req, no auth) and credit drawdown (SIWX auth + bulk credits).

## Run

```bash
npm install
npm start              # All 4 examples in parallel (stmux)
npm run start:jsonrpc  # JSON-RPC only
npm run start:grpc     # gRPC-Web only
npm run start:rest     # REST only
npm run start:ws       # WebSocket only
npm run typecheck      # tsc --noEmit
```

## Protocols

| Script | Protocol | Network | What it does |
|--------|----------|---------|-------------|
| `jsonrpc.ts` | JSON-RPC | Base Sepolia | eth_blockNumber credit consumption loop |
| `rest.ts` | REST | Aptos Mainnet | HTTP GET endpoints |
| `grpc.ts` | gRPC-Web | Flow Mainnet | Unary + streaming calls |
| `websocket.ts` | WebSocket | Base Mainnet | newHeads subscription |

## Chain Detection

- `.env` with `SOLANA_PRIVATE_KEY` → Solana path
- `.env` with `PRIVATE_KEY` (or empty) → EVM path
- `X402_EVM_CHAIN` env var selects chain: `base-sepolia`, `polygon-amoy`, `polygon-mainnet`

## Rules

- **Public repo** — no staging URLs, no internal references
- **Naming:** "Quicknode" (not "QuickNode")
- **URLs:** Always `x402.quicknode.com`
- All auth/payment handled by `@quicknode/x402` — no manual SIWE message construction

## Key Files

- `lib/x402-helpers.ts` — Shared setup: wallet management, client creation, credit tracking
- `bootstrap.ts` — Orchestrator: chain detection, auth, funding, launches stmux
- `proto/flow/` — Flow Access API protobuf definitions
- `gen/flow/` — Generated protobuf types (via `buf generate`)
