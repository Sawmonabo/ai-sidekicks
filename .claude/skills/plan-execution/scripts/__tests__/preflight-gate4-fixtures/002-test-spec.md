---
name: Test fixture — line-anchor spec shape
status: test-fixture-only
---

# Test Spec — line-anchor fixture for preflight Gate 4 tests

## Interfaces and Contracts

- `DeviceLink` payload — session id, requester, expiry.
- `DeviceRename` supports name change and revocation.
- `PresenceHeartbeat` carries device id and activity state.
- `PresenceUpdate` (JSON-RPC, local IPC) — daemon-to-client push.
- `PresenceRead` (JSON-RPC, local IPC) — client-to-daemon read.
- `ChannelList` — read-only projection of channels in a session.

### Rate Limiting

| Limit                                 | Threshold |
| ------------------------------------- | --------- |
| Max device links per session per hour | 20        |
| Max device links per user per hour    | 50        |
| Max pending device links per session  | 100       |

### Rate Limit Response

```typescript
// RateLimitResponse canonical shape:
{
  code: 'rate_limited',
  retryAfter: number,
  limit: number,
  remaining: number,
}
```

### Token Security Properties

- Tokens use HS256 signing.
- Tokens carry a 1-hour expiry by default.
- Token storage uses platform keychains (macOS Keychain, libsecret on Linux).

## Acceptance Criteria

- [ ] A newly linked device joins active sessions without resetting active runs.
- [ ] Device linkage remains durable across presence offline → online cycle.
- [ ] ChannelList projects all channels in a session at join time.

### Usage Telemetry (usage_telemetry)

- `usage.tokens` events carry prompt/completion token counts per turn.
- `usage.cost_estimate` events carry derived cost figures.

### Cache Policy (RFC 9111 (shared cache))

- `cache.directives` events carry shared-cache directive evaluations.
