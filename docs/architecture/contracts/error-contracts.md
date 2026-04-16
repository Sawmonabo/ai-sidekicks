# Error Contracts

Canonical error shapes, error code namespaces, and standard error responses for the AI Sidekicks platform.

See also [API Payload Contracts](./api-payload-contracts.md) for the base `ErrorResponse` and `RateLimitResponse` types.

---

## Error Response Shape

All API errors use the canonical `ErrorResponse` envelope defined in API Payload Contracts:

```ts
interface ErrorResponse {
  code: string          // namespaced: 'session.not_found', 'auth.token_expired', etc.
  message: string       // human-readable description
  details?: Record<string, unknown>  // structured context
}
```

---

## Error Codes

### Session

| Code | Description | HTTP Status |
| --- | --- | --- |
| `session.not_found` | Session does not exist or is not accessible | 404 |
| `session.already_closed` | Session has already been closed and cannot be modified | 409 |
| `session.limit_exceeded` | Session creation rate limit exceeded | 429 |

### Auth

| Code | Description | HTTP Status |
| --- | --- | --- |
| `auth.token_expired` | Authentication token has expired | 401 |
| `auth.token_invalid` | Authentication token is malformed or invalid | 401 |
| `auth.insufficient_scope` | Token does not have the required scope for this operation | 403 |
| `auth.dpop_mismatch` | DPoP proof does not match the bound token | 401 |

### Run

| Code | Description | HTTP Status |
| --- | --- | --- |
| `run.invalid_transition` | Requested state transition is not allowed from the current run state | 409 |
| `run.not_found` | Run does not exist or is not accessible | 404 |
| `run.limit_exceeded` | Concurrent run limit exceeded | 429 |
| `run.recovery_failed` | Run recovery failed due to an internal error | 500 |

### Approval

| Code | Description | HTTP Status |
| --- | --- | --- |
| `approval.not_found` | Approval request does not exist | 404 |
| `approval.already_resolved` | Approval request has already been resolved | 409 |
| `approval.expired` | Approval request has expired and can no longer be resolved | 410 |

### Invite

| Code | Description | HTTP Status |
| --- | --- | --- |
| `invite.not_found` | Invite does not exist | 404 |
| `invite.already_accepted` | Invite has already been accepted | 409 |
| `invite.expired` | Invite has expired and can no longer be accepted | 410 |
| `invite.revoked` | Invite has been revoked by the issuer | 410 |
| `invite.limit_exceeded` | Invite creation rate limit exceeded | 429 |

### Workspace

| Code | Description | HTTP Status |
| --- | --- | --- |
| `workspace.not_found` | Workspace does not exist | 404 |
| `workspace.provisioning_failed` | Workspace provisioning failed due to an internal error | 500 |
| `workspace.mode_unsupported` | Requested execution mode is not supported for this workspace | 400 |

### Artifact

| Code | Description | HTTP Status |
| --- | --- | --- |
| `artifact.not_found` | Artifact does not exist | 404 |
| `artifact.too_large` | Artifact exceeds the maximum allowed size | 413 |
| `artifact.hash_mismatch` | Artifact content hash does not match the expected value | 409 |

### Workflow

| Code | Description | HTTP Status |
| --- | --- | --- |
| `workflow.not_found` | Workflow definition does not exist | 404 |
| `workflow.invalid_phase` | Requested phase transition is invalid | 400 |
| `workflow.gate_closed` | Workflow gate has not been resolved and blocks progression | 409 |

### Driver

| Code | Description | HTTP Status |
| --- | --- | --- |
| `driver.unavailable` | Provider driver is currently unavailable | 503 |
| `driver.capability_unsupported` | Requested capability is not supported by the driver | 400 |
| `driver.timeout` | Provider driver operation timed out | 504 |

### Relay

| Code | Description | HTTP Status |
| --- | --- | --- |
| `relay.connection_failed` | Relay connection to the upstream service failed | 502 |
| `relay.group_full` | Relay group has reached its participant limit | 429 |
| `relay.authentication_failed` | Relay authentication failed | 401 |

### Resource

| Code | Description | HTTP Status |
| --- | --- | --- |
| `resource.limit_exceeded` | General resource limit exceeded | 429 |

### System

| Code | Description | HTTP Status |
| --- | --- | --- |
| `system.internal_error` | Unexpected internal error | 500 |
| `system.maintenance` | System is undergoing maintenance | 503 |

---

## Rate Limiting

Standard 429 response shape (from API Payload Contracts):

```ts
interface RateLimitResponse {
  code: 'rate_limited'
  retryAfter: number    // seconds until retry is allowed
  limit: number         // total allowed requests in the window
  remaining: number     // requests remaining in the current window
  resetAt: string       // ISO 8601 timestamp when the limit resets
}
```

All rate-limited endpoints return the `RateLimitResponse` envelope with HTTP status 429. The `resetAt` field provides the absolute timestamp (ISO 8601) when the rate limit window resets, complementing the relative `retryAfter` seconds value.

Rate limit error codes that trigger this response:

- `session.limit_exceeded`
- `run.limit_exceeded`
- `invite.limit_exceeded`
- `relay.group_full`
- `resource.limit_exceeded`
