# Hosted Account Deletion Runbook

## Purpose

A break-glass procedure for the relay's owner: delete the hosted account only when the authenticated path is genuinely impossible (for example, the owner has no passkey left to verify a sign-in). The relay is the person's own, the Workers relay in their Cloudflare account or the Compose relay on their server ([ADR-019 §The Two Deployment Options](../decisions/019-v1-deployment-model-and-oss-license.md#the-two-deployment-options)), so the person who runs it is the account's owner, entitled by holding that Cloudflare account or server; both relays keep the account in SQLite inside the relay, the Workers relay in its Durable Object's own storage and the Compose relay in a SQLite file on the server ([deployment-topology §Account Storage](../architecture/deployment-topology.md#account-storage)). It is never a second way to delete an account: it runs the product's own `account.delete` ([Plan-015 §Phase 5](../plans/015-hosted-account-and-identity.md#phase-5--daemon-credential-seam--account), [Plan-019](../plans/019-data-retention-export-and-deletion.md) CP-019-3), whose fan-out runs in the relay's code in one transaction, on the Workers relay and the Compose relay alike. The everyday way to call it is `sidekicks delete-account`: an owner who has lost every machine installs the command-line tool on another computer, runs `sidekicks sign-in`, signs in with a passkey of the account's on the relay's sign-in page in the browser, and runs `sidekicks delete-account`. `account.delete` does what [Spec-020 §Erasure Paths](../specs/020-data-retention-export-and-deletion.md#erasure-paths) Path 2 gives: it revokes every refresh-token family the account holds, then hard-deletes the account's rows across the `REFERENCES users(id)` inbound-FK closure in one transaction, anonymizing the rows that keep an independent retention basis. No step edits the account's SQLite by hand.

It erases no machine. A machine's own data is erased only on that machine, with `Erase all data` or `sidekicks erase-data` ([Spec-020 §Erasure Paths](../specs/020-data-retention-export-and-deletion.md#erasure-paths) Path 1), and nothing in this procedure reaches it.

## Symptoms

Run this procedure when **all** of the following hold:

- The relay's owner wants the hosted account deleted and holds the Cloudflare account the Workers relay is deployed in or the server the Compose relay runs on.
- The owner cannot run `sidekicks delete-account`: no machine they hold is signed in to the account, and they cannot sign in from another computer, because no passkey of the account's is left to sign in with on the relay's sign-in page. If they can still sign in anywhere, they run `sidekicks delete-account` there instead, and this procedure is not used.

## Detection

Establish **scope** before changing anything — separate identification from remediation:

1. **Confirm the account exists.** A deployment holds one account, so the relay's sign-in page offers `Sign in with a passkey` while it exists and `Create an account` only while none does.
2. **Read the closure** `account.delete` covers from [hosted-account-schema.md](../architecture/schemas/hosted-account-schema.md), not from memory: every table carrying a `REFERENCES users(id)` column, counted once per table however many such columns it bears — `devices`, `runtime_nodes`, `trust_statements`, `webauthn_credentials`, `webauthn_challenges`, `refresh_token_families`, `revoked_token_families`, `authorization_requests` (through `approved_user_id`), and the anonymize-class `revoked_jtis`. The control plane keeps no session record.

## Preconditions

- **Nothing can be copied first.** Deletion removes the account record and its device list, everything `account.export` returns, and `account.export` needs a sign-in, which this procedure's owner no longer has. A machine's own sessions and files are not on the control plane and are not in it.
- **Access.** The relay's own code runs every step, on either relay. On the Workers relay, Cloudflare's [Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/) can read and edit a Durable Object's SQLite from the dashboard; this procedure does not use it. On the Compose relay, no step opens the relay's SQLite file.
- **Understand denylist survival.** `revoked_jtis` rows survive deletion by design: `user_id` is nulled, and the `jti` key persists until its natural `expires_at + 24h` reap, a margin past the access token's lifetime, so a revoked token stays refused until it would have expired. This is **not** a precondition failure. `revoked_token_families` rows have no expiry, because a refresh token has none: they stay for the account's life and are deleted with it.
- **Nothing on a machine is touched.** Every machine keeps its own sessions, artifacts and terminal leases; the procedure reaches only the control plane's rows.

## Recovery Steps

`account.delete` revokes first, then deletes in one transaction. The order is load-bearing: revoking before the rows go writes every family to the denylist, so every device is refused at its next refresh before the account's rows go, and once they are gone, the account and the machine keys its tokens are bound to with them, none of its tokens can be traded ([Spec-020 §Ordering And Atomicity](../specs/020-data-retention-export-and-deletion.md#ordering-and-atomicity)). Both steps are idempotent, so a failed run is run again from the top.

### Revoke the account's refresh families

1. `account.delete` revokes every refresh-token family the account holds, as a device revoke or a sign-out does. Each family is written to `revoked_token_families`, which goes with the account in the next step. Every device still holding a refresh token for the account is refused at its next refresh.

_Idempotency:_ a family already revoked stays revoked.

### Delete the account's rows (control plane)

`account.delete` runs this as **one transaction** in the relay's code: the whole step succeeds, or it rolls back and nothing is deleted.

1. It hard-deletes the account's rows from the no-retention-basis tables: `devices`, `runtime_nodes` and `trust_statements` (the account's linked devices and its machines' registrations, each with its public key, and its chain of signed trust statements, [hosted-account-schema.md §Devices, Machines And The Statement Chain](../architecture/schemas/hosted-account-schema.md#devices-machines-and-the-statement-chain-plan-025); safe at live-verification semantics, since every machine verifies the chain it keeps itself), `webauthn_credentials` and `webauthn_challenges` (enrolled passkeys and in-flight ceremony challenges, likewise safe), `refresh_token_families` (the account's live sign-ins; the revocations have already removed them), `revoked_token_families` (the account's revoked families, kept for the account's life), and every `authorization_requests` row the account approved. A request no account has approved carries no user link and goes at its expiry.
2. It hard-deletes the anchor, the `users` row, which sets `revoked_jtis.user_id`, the one anonymize-class reference, to null ([Spec-020 §Erasure Paths](../specs/020-data-retention-export-and-deletion.md#erasure-paths) FK-safety; Plan-019 D-019-3).
3. When any statement fails (a foreign-key constraint or a storage failure), the transaction rolls back and `account.delete` reports the failure.

_Idempotency:_ a run against an account already deleted deletes nothing more.

## Validation

The deletion is complete when **all** of the following hold:

- `account.delete` returned success.
- The relay's sign-in page offers `Create an account`, which it offers only while the deployment holds no account.
- A refresh presented with any of the account's former refresh tokens is refused.

## Escalation

- **Transaction failure.** The delete step rolled back and nothing was deleted; the revocations from the first step stand. Run it again from the top — both steps are idempotent. Do not patch a partial state by hand.
- **FK-closure drift.** A failure on the `users` delete means a `REFERENCES users(id)` table is missing from `account.delete`'s fan-out: find it in [hosted-account-schema.md](../architecture/schemas/hosted-account-schema.md) and bring `account.delete` and this runbook's closure in line with the schema.
- **A machine turns up.** This procedure never reaches a machine's data. A machine the owner recovers is already signed out; they erase it there with `Erase all data` or `sidekicks erase-data`.

## Related Architecture Docs

- [Hosted Account Schema](../architecture/schemas/hosted-account-schema.md) — the `REFERENCES users(id)` inbound-FK closure (where Recovery Steps read the closure).

## Related Specs

- [Spec-020 — Data Retention, Export And Deletion](../specs/020-data-retention-export-and-deletion.md) — §Erasure Paths (Path 2), §PII Data Map, §Ordering And Atomicity.
- [Spec-016 — Hosted Account and Identity](../specs/016-hosted-account-and-identity.md) — the hosted account, its devices and its sign-ins.

## Related Plans

- [Plan-015 — Hosted Account and Identity](../plans/015-hosted-account-and-identity.md) — `account.delete`, which this procedure runs, and the token denylist.
- [Plan-019 — Data Retention, Export And Deletion](../plans/019-data-retention-export-and-deletion.md) — the Path-2 closure `account.delete` covers (CP-019-3) and the `ON DELETE SET NULL` severance (D-019-3).

## Who Runs It And Where To Report

A request to delete a hosted account routes first to `sidekicks delete-account`: an owner who can still sign in, from a machine they hold or from any computer with `sidekicks sign-in` and a passkey of the account's, deletes the account there. Only an owner who can no longer sign in at all runs this break-glass procedure, as the person who runs their own relay, whose code runs `account.delete`.
