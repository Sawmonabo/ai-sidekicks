# Rate Limit And Retention Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Spec-019 — Rate Limiting

Shapes below are canonical per [Plan-018](../../plans/018-rate-limiting-policy.md) (D-018-3/D-018-4/D-018-5). The relay counts requests on its sign-in routes only; code home is the control plane's `crates/sidekicks-control-plane/src/rate_limit/` for the limiter and its check types, and `crates/sidekicks-contracts/src/rate_limiter.rs` for what a device reads (its generated TypeScript at `packages/contracts/src/rate-limiter.ts`): the 429 envelope `RateLimitResponse`, and the sign-in routes' two refusal codes, `RATE_LIMITED_CODE` and `SOURCE_ADDRESS_UNRESOLVABLE_CODE` (Plan-018 Phase 1). Endpoint-group keys come from [Spec-019 §Canonical Endpoint Group Registry](../../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry).

```ts
// RateLimitCheck (internal operation, both backends). A counter error fails that one request like
// any backend error.
interface RateLimitCheckRequest {
  identity: string; // the caller's source address, canonical form (D-018-4): IPv4 exact dotted-quad / IPv6 normalized to its /64 prefix (D-018-5)
  endpoint: RateLimitEndpointGroup; // registry-key union (Spec-019 registry): the sign-in routes' one group
}
interface RateLimitCheckResponse {
  allowed: boolean;
  remaining: number;
  resetAt: string; // ISO 8601
  limit: number; // total threshold for this window
}
```

## Spec-020 — Data Retention, Export And Deletion

The data acts are daemon JSON-RPC verbs on the `daemon` root, registered by Plan-019 on Plan-005's `MethodRegistry`, with their params and result types in `crates/sidekicks-contracts/src/daemon/data.rs`: `daemon.dataExport.start {destination}` with `daemon.dataExport.subscribe` for its progress (`Export all data`), and `daemon.data.erase {}` (`Erase all data`) (api-payload-contracts.md §Operations Not Yet Built, `daemon.*`). They are daemon verbs rather than control-plane routes because the handlers read the daemon's own database and the machine's credential store, which a Cloudflare-Workers control plane cannot reach (Plan-019 D-019-1). A session's purge is `daemon.retention.purge` (`Delete old data`). Deleting the hosted account is the control plane's `account.delete`, and `account.export` answers the export's `hosted-account.json` (api-payload-contracts.md §Operations Not Yet Built, `account.*`).
