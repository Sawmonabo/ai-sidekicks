# Hosted Account Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-015 — Hosted Account And Identity

```ts
// AccountRead
interface AccountReadRequest {}
interface AccountReadResponse {
  userId: UserId;
  displayName: string;
}

// AccountNameUpdate — self-scoped: the daemon's credential names the account
interface AccountNameUpdateRequest {
  displayName: string;
}
interface AccountNameUpdateResponse {
  updatedAt: string;
}
```

## Account Method-Name Registry

The hosted account's name read and update are exposed as `account.*` methods, beside `account.delete` and `account.export` (Plan-015 CP-015-3). The reciprocal `provides` is recorded on [Plan-005](../../plans/005-local-ipc-and-daemon-control.md). Same `dotted-camelCase` `METHOD_NAME_FORMAT` as the other namespaces.

| Method               | Procedure type | Request schema             | Response schema             |
| -------------------- | -------------- | -------------------------- | --------------------------- |
| `account.read`       | `query`        | `AccountReadRequest`       | `AccountReadResponse`       |
| `account.nameUpdate` | `mutation`     | `AccountNameUpdateRequest` | `AccountNameUpdateResponse` |

`account.read` returns the account's id and display name and carries no device presence. Which devices are connected is a fact of the device cards on the Devices page in Settings, which read each device's connected state and last-seen time from the live `device.list`, and each machine reports the devices connected to it through its own `presence.read {}` and `presence.subscribe {}`. `account.nameUpdate` is the one mutation. Every method's daemon-side responder is authored (T4.4) per the D-015-3 no-method-without-responder rule. Canonical Zod schemas live in `packages/contracts/` per the api-payload-contracts.md §Source-of-Truth Policy.

## WebAuthn Ceremony Procedure Registry

These are **control-plane tRPC procedures on the control plane's tRPC router** (remote-control-payloads.md §Plan-025 — Remote Control Bootstrap), not daemon JSON-RPC methods. Their callers are the web client, the phone apps and the device-code page, where the platform offers passkeys: the desktop app carries no WebAuthn, so no passkey is added or used from it. No method string is minted, and Plan-015's I-015-3 daemon-as-gateway rule is untouched. The table holds **the ceremony operations and the credential-lifecycle operation**.

| Operation | Procedure type | Authentication | Request schema | Response schema |
| --- | --- | --- | --- | --- |
| `WebAuthnRegistrationOptionsIssue` | `mutation` | required; **none** for account creation on the device-code page, which sends `{userCode, displayName}` in place of a session and receives the creation options with a `transactionId` (below) | `WebAuthnRegistrationOptionsIssueRequest` | `WebAuthnRegistrationOptionsIssueResponse` |
| `WebAuthnRegistrationVerify` | `mutation` | required: it adds a passkey to an account that exists; account creation's registration is verified by the device-code Approval row's creation arm (below) | `WebAuthnRegistrationVerifyRequest` | `WebAuthnRegistrationVerifyResponse` |
| `WebAuthnAuthenticationOptionsIssue` | `mutation` | **none** | `WebAuthnAuthenticationOptionsIssueRequest` | `WebAuthnAuthenticationOptionsIssueResponse` |
| `WebAuthnAuthenticationVerify` | `mutation` | **none** | `WebAuthnAuthenticationVerifyRequest` | `WebAuthnAuthenticationVerifyResponse` |
| `WebAuthnCredentialRevoke` | `mutation` | required | `WebAuthnCredentialRevokeRequest` | `WebAuthnCredentialRevokeResponse` |

Both issue legs are `mutation` rather than `query` because each one **writes** — it records a challenge row, which is the fence the whole ceremony rests on.

**The authentication pair is deliberately unauthenticated.** Sign-in is pre-authentication by construction: the ceremony is what produces the credential, so a new phone or browser holds nothing to present, and gating it would make the flow unreachable exactly when it is needed ([Spec-016 §Required Behavior](../../specs/016-hosted-account-and-identity.md#required-behavior)). What bounds that caller instead is the **ceremony transaction id** — server-minted on the options reply, quoted back on the verify request, single-use, and expiring on the challenge's own clock, so the caller is bound to one transaction rather than to a session. Throttling is the existing [Spec-019 §Canonical Endpoint Group Registry](../../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) `auth.endpoint` row (per source address); **no registry row is minted**, because a per-token budget beside the per-source one would have nothing to bound here, single-use consumption already capping attempts per transaction at exactly one. The registration pair stays authenticated: enrollment binds an authenticator to an existing user, and an unauthenticated enrollment would let anyone bind a key to someone else's account. **Account creation is the one exception.** `Create an account` on the device-code page makes a new account and adds nothing to one that exists, so it needs no sign-in: its registration is bound to the device-code transaction the page was opened with, good once, and limited per source address under the same `auth.endpoint` row as the passkey sign-in. Adding a passkey to an account that exists stays signed in. **`WebAuthnCredentialRevoke` is authenticated for the same reason and one more:** it resolves the credential row under the **caller's own** user id, which there is no way to know without a session. That resolution is also what makes the operation safe to expose — a request naming another user's credential id deletes nothing and returns success, exactly as a request naming an id that does not exist does, so the reply enumerates no one's authenticators. Revocation is a hard `DELETE` rather than a `revoked_at` tombstone: a tombstone would let the verify leg tell _revoked_ from _unknown_, the one distinction every refusal arm of this registry is written to withhold, and it would mint a column to obtain it. Removing the user's **last** credential is permitted — a new device still links through a link from a device already in use, and refusing would keep a compromised authenticator enrolled precisely when the user is trying to retire it.

**What the replies carry, and why the split is where it is.** The authentication-**options** reply carries the `rpId`, the origin, the challenge, and the transaction id. The authentication-**verify** reply carries the verdict and a **freshly issued PASETO access/refresh pair**. The token pair rides the verdict because that is the moment the user is known, and it is issued rather than merely unlocked because a new device holds no refresh token to unwrap — a sign-in that only unlocks a stored one is unreachable exactly on the device that needs it. It is sender-constrained per [ADR-010](../../decisions/010-tokens-passkeys-and-the-remote-channel.md) to the DPoP key the caller proves possession of on the verify request; that proof binds a key and establishes no identity, so it does not make this pair a credentialed one and the `Authentication` column above stays **none**.

**Which DPoP proof, and why the shipped validator cannot serve this route.** [RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449) defines two proof forms, and this route needs the one the corpus has not implemented. A **token-request** proof ([§5](https://datatracker.ietf.org/doc/html/rfc9449#section-5)) accompanies a request _for_ a token and carries no `ath`, because no access token exists yet. A **resource-request** proof ([§4.3](https://datatracker.ietf.org/doc/html/rfc9449#section-4.3)) accompanies a request that _presents_ one and **requires** `ath`, the hash of that token — which is the form every already-credentialed path in this corpus validates, including the CP-015-7 daemon credential seam. Pointing that validator at `WebAuthnAuthenticationVerify` would reject every legitimate sign-in for a missing `ath`; relaxing the check instead would accept a proof minted for some other request. So the verify leg validates the §5 form on its own terms: `typ` `dpop+jwt`, `htm` and `htu` matching this request's method and URI, `iat` inside the accepted window, a single-use `jti`, an embedded public `jwk` of a permitted algorithm carrying no private parameters, a signature verifying under that `jwk` — and **`ath` required to be absent** rather than merely unchecked, so an oversupplied proof is refused rather than accepted-and-ignored. The issued pair's `cnf.jkt` is the JWK SHA-256 thumbprint of that same key and is computed from the proof, never taken from a separate claim the caller makes; without that the route would hand an unauthenticated caller a bearer pair. A missing, malformed, replayed, or `ath`-bearing proof refuses the whole verification and issues nothing (Plan-015 I-015-9 / T6.3).

Refusals are `user.webauthn_challenge_invalid` (400) for an unknown, consumed, or expired challenge or transaction id, and `user.webauthn_verification_failed` (400) for every verification arm — bad signature, wrong origin, wrong `rpId`, UV mismatch, regressed counter — so the reply is no oracle for which check failed.

## Hosted Account Route Registry

The control plane's account routes that `sidekicks sign-in`, `sidekicks sign-out` and `sidekicks delete-account` run, the service's token trade, and the reply the data export writes as `hosted-account.json`. They are control-plane routes, never daemon methods; the device-code sign-in follows the OAuth 2.0 Device Authorization Grant ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)). The shapes are in `packages/contracts/src/account.ts` and the unit's refusal codes in `packages/contracts/src/error.ts`, each landing with the task that builds it ([Plan-015](../../plans/015-hosted-account-and-identity.md) T5.4, T5.5).

| Route | Caller | Authentication | Request | Reply |
| --- | --- | --- | --- | --- |
| Device authorization | `sidekicks sign-in` | none | the RFC 8628 device authorization request | a device code, a user code and the verification address; the command line prints the code and the address, opens the address where a browser exists, and polls the token route (T5.4) |
| Approval | the device-code page at the verification address | a passkey assertion; for `Create an account`, none: the new account's first passkey registration, bound to this device-code transaction, good once, and limited per source address under `auth.endpoint` like the passkey sign-in | `{userCode, transactionId, assertion}`, the assertion answering `WebAuthnAuthenticationOptionsIssue`; for `Create an account`, `{userCode, transactionId, attestation}`, the attestation answering `WebAuthnRegistrationOptionsIssue`'s creation options, and the user record, its first passkey and the approval commit in one transaction | approves the code for the account the passkey belongs to, or for the account `Create an account` made, and carries no token, so the page keeps nothing in the browser; refuses with `user.webauthn_challenge_invalid` or `user.webauthn_verification_failed` as the verify leg does, and an unknown or expired user code with the unit's own code (T5.4) |
| Token | `sidekicks sign-in`, polling | the device code, with a DPoP proof under this machine's key | the device code | a refresh token bound to the proved key (`cnf.jkt`, that key's JWK SHA-256 thumbprint); `authorization_pending` until the code is approved or expires (T5.4) |
| Enrollment | `sidekicks sign-in` once the refresh token is issued, and a removed machine linked again once its new key's statement is on the chain | an access token with a DPoP proof | the machine's id, the identity key's public half, its name, its platform and the installed service's version | writes the machine's `runtime_nodes` row under the account; refuses a different key for a machine already enrolled unless a later `runtimenode.added` for that id is on the chain (T5.4) |
| Trade | the service, through its credential provider | the refresh token, with a DPoP proof under the same key | the refresh token | a short-lived PASETO v4.public access token and a new refresh token of the same family, the presented one marked spent; a spent refresh token presented again revokes the whole family (T5.4) |
| Sign-out | `sidekicks sign-out` | the signed-in machine's tokens | none | revokes the refresh-token family; the refresh token has no expiry of its own and lasts until sign-out or revocation (T5.4) |
| `account.delete` | `sidekicks delete-account` | the signed-in account | none | revokes every refresh-token family of the account, hard-deletes the account's rows through [Spec-020 §Erasure Paths](../../specs/020-data-retention-export-and-deletion.md#erasure-paths) Path 2, and returns; a second call returns the same result and deletes nothing more; the command line then signs this machine out (T5.5) |
| `account.export` | the data export ([Plan-019](../../plans/019-data-retention-export-and-deletion.md)) | the signed-in account | none | `{account: {userId, createdAt, displayName, metadata}, devices}`: the account record and its device list, each device as its card on the Devices page carries it, written as `hosted-account.json`; changes nothing (T5.5) |
