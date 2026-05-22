---
name: Test fixture — Spec-002 shape
status: test-fixture-only
---

# Test Spec — line-anchor fixture for preflight Gate 4 tests

## Interfaces and Contracts

- `InviteCreate` payload — session id, inviter, expiry.
- `MembershipUpdate` supports role change and revocation.
- `PresenceHeartbeat` carries participant id and activity state.
- `PresenceUpdate` (JSON-RPC, local IPC) — daemon-to-client push.
- `PresenceRead` (JSON-RPC, local IPC) — client-to-daemon read.
- `ChannelList` — read-only projection of channels in a session.

### Rate Limiting

| Limit                                | Threshold |
| ------------------------------------ | --------- |
| Max invites per session per hour     | 20        |
| Max invites per participant per hour | 50        |
| Max pending invites per session      | 100       |

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

- [ ] An invited participant joins active sessions without resetting active runs.
- [ ] Membership remains durable across presence offline → online cycle.
- [ ] ChannelList projects all channels in a session at join time.
