# Hosted Account Deletion Runbook

## Purpose

A break-glass procedure for the relay's owner: delete a hosted account by hand, in the relay's own SQLite database, only when the authenticated path is genuinely impossible (for example, the owner has no passkey left to verify a sign-in). The relay is the person's own, the Workers relay in their Cloudflare account or the Compose relay on their server ([ADR-019 §The Two Deployment Options](../decisions/019-v1-deployment-model-and-oss-license.md#the-two-deployment-options)), so the person who runs it is the account's owner, entitled by holding that Cloudflare account or server; both relays keep the account in SQLite inside the relay, the Workers relay in its Durable Object's own storage and the Compose relay in a SQLite file on the server ([deployment-topology §Account Storage](../architecture/deployment-topology.md#account-storage)). It is never a second way to delete an account. The one way is `sidekicks delete-account`, over the control plane's `account.delete`: an owner who has lost every machine installs the command-line tool on another computer, runs `sidekicks sign-in`, signs in with a passkey of the account's on the relay's sign-in page in the browser, and runs `sidekicks delete-account`. The procedure does on the control plane what `account.delete` does ([Spec-020 §Erasure Paths](../specs/020-data-retention-export-and-deletion.md#erasure-paths) Path 2): it revokes every refresh-token family the account holds, then hard-deletes the account's rows across the `REFERENCES users(id)` inbound-FK closure in one transaction, anonymizing the rows that keep an independent retention basis.

It erases no machine. A machine's own data is erased only on that machine, with `Erase all data` or `sidekicks erase-data` ([Spec-020 §Erasure Paths](../specs/020-data-retention-export-and-deletion.md#erasure-paths) Path 1), and nothing in this procedure reaches it.

## Symptoms

Run this procedure when **all** of the following hold:

- The relay's owner wants the hosted account deleted, holds the Cloudflare account the Workers relay is deployed in or the server the Compose relay runs on, and knows the account's `user_id`.
- The owner cannot run `sidekicks delete-account`: no machine they hold is signed in to the account, and they cannot sign in from another computer, because no passkey of the account's is left to sign in with on the relay's sign-in page. If they can still sign in anywhere, they run `sidekicks delete-account` there instead, and this procedure is not used.

## Detection

Establish **scope** before changing anything — separate identification from remediation:

1. **Resolve the `user_id`.** Confirm the UUID against the control-plane `users` row: `SELECT id, display_name, identity_ref FROM users WHERE id = :pid;`.
2. **Enumerate the closure** from [hosted-account-schema.md](../architecture/schemas/hosted-account-schema.md), not from memory. The closure is every table carrying a `REFERENCES users(id)` column, counted once per table however many such columns it bears: `devices`, `runtime_nodes`, `trust_statements`, `webauthn_credentials`, `webauthn_challenges`, `refresh_token_families`, `revoked_token_families`, `authorization_requests` (through `approved_user_id`), and the anonymize-class `revoked_jtis`. The control plane keeps no session record. **Deployment scope:** before each statement, guard existence (`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '<table>';`) and skip an absent table: a table that does not exist holds no rows to delete.
3. **Read the account's device list**, as `account.export` returns it, so the request's owner can be told which devices lose their sign-in.

## Preconditions

- **Copy what is wanted first.** Deletion removes the account record and its device list, everything `account.export` returns; with no sign-in left, a `SELECT` of those rows before Recovery Steps is the copy. A machine's own sessions and files are not on the control plane and are not in it.
- **Access.** The account's SQLite database and the control plane's refresh-family revocation, the same one a device revoke or a sign-out uses. On the Compose relay the database is the relay's SQLite file, which the relay's one process alone writes, so the relay is stopped after the revocation step and started again once the delete step has committed; the statements run in a SQLite session opened on that file with `PRAGMA foreign_keys = ON;` first, since SQLite leaves foreign keys off on each new connection and the `ON DELETE SET NULL` and `ON DELETE CASCADE` this procedure relies on fire only with them on. On the Workers relay the database is the account's Durable Object's own SQLite storage, which only that object's code reaches.
- **Understand denylist survival.** `revoked_jtis` rows survive deletion by design: `user_id` is nulled, and the `jti` key persists until its natural `expires_at + 24h` reap, a margin past the access token's lifetime, so a revoked token stays refused until it would have expired. This is **not** a precondition failure. `revoked_token_families` rows have no expiry, because a refresh token has none: they stay for the account's life and are deleted with it.
- **Nothing on a machine is touched.** Every machine keeps its own sessions, artifacts and terminal leases; the procedure reaches only the control plane's rows.

## Recovery Steps

Revoke first, then delete in one transaction. The order is load-bearing: revoking before the rows go writes every family to the denylist, so every device is refused at its next refresh before the account's rows go, and once they are gone, the account and the machine keys its tokens are bound to with them, none of its tokens can be traded ([Spec-020 §Ordering And Atomicity](../specs/020-data-retention-export-and-deletion.md#ordering-and-atomicity)). Both steps are idempotent, so a failed run is re-executed from the top.

### Revoke the account's refresh families

1. Revoke every refresh-token family the account holds through the control plane's revocation, as a device revoke or a sign-out does. Each family is written to `revoked_token_families`, which goes with the account in the next step. Every device still holding a refresh token for the account is refused at its next refresh.

_Idempotency:_ a family already revoked stays revoked.

### Delete the account's rows (control plane)

Run as a **single SQLite transaction**: the whole step succeeds, or it rolls back and nothing is deleted.

1. Hard-DELETE the account's rows from the no-retention-basis tables present in your deployment:
   - **`devices`, `runtime_nodes` and `trust_statements`** — the account's linked devices and its machines' registrations, each with its public key, and its chain of signed trust statements ([hosted-account-schema.md §Devices, Machines And The Statement Chain](../architecture/schemas/hosted-account-schema.md#devices-machines-and-the-statement-chain-plan-025)); `DELETE FROM <table> WHERE user_id = :pid;` (safe at live-verification semantics: every machine verifies the chain it keeps itself).
   - **Plain `user_id` tables** — `webauthn_credentials` and `webauthn_challenges` (enrolled passkeys and in-flight ceremony challenges, likewise safe), `refresh_token_families` (the account's live sign-ins; step 1's revocations have already removed them, so this finds none), `revoked_token_families` (the account's revoked families, kept for the account's life): `DELETE FROM <table> WHERE user_id = :pid;`.
   - **`authorization_requests`** — a pending sign-in the account approved and whose authorization code has not yet been redeemed: `DELETE FROM authorization_requests WHERE approved_user_id = :pid;`. A request no account has approved carries no user link and goes at its expiry.
2. Hard-DELETE the anchor: `DELETE FROM users WHERE id = :pid;`. This fires `ON DELETE SET NULL` on the one anonymize-class FK, `revoked_jtis.user_id` ([Spec-020 §Erasure Paths](../specs/020-data-retention-export-and-deletion.md#erasure-paths) FK-safety; Plan-019 D-019-3).
3. If any statement fails (a foreign-key constraint or a storage failure), roll back and do not retry piecemeal. An FK violation on the `users` DELETE means a `NOT NULL NO ACTION` reference survived step 1 — a table in the closure was skipped or its predicate missed a row. Re-check Detection step 2 against the schema, then re-run this step.

_Idempotency:_ a DELETE of an already-deleted row affects zero rows.

## Validation

The deletion is complete when **all** of the following hold:

- `SELECT count(*) FROM users WHERE id = :pid;` returns `0`.
- Each hard-DELETE table from Recovery Steps returns `0` rows for `:pid` (`devices`, `runtime_nodes`, `trust_statements`, `webauthn_credentials`, `webauthn_challenges`, `refresh_token_families`, `revoked_token_families`), and `authorization_requests` returns `0` rows for `approved_user_id = :pid`.
- Every `revoked_jtis` row of the account not yet reaped is present with `user_id IS NULL` and its key intact.
- A refresh presented with any of the account's former refresh tokens is refused.

## Escalation

- **Transaction failure.** The delete step rolled back and nothing was deleted; the revocations from the first step stand. Re-run from the top — both steps are idempotent. Do not hand-patch a partial state.
- **FK-closure drift.** If the `users` DELETE meets a `REFERENCES users(id)` table not listed here, find it in [hosted-account-schema.md](../architecture/schemas/hosted-account-schema.md), extend the procedure to cover the table, confirm its predicate against the schema, and flag the gap for a runbook update.
- **A machine turns up.** This procedure never reaches a machine's data. A machine the owner recovers is already signed out; they erase it there with `Erase all data` or `sidekicks erase-data`.

## Related Architecture Docs

- [Hosted Account Schema](../architecture/schemas/hosted-account-schema.md) — the `REFERENCES users(id)` inbound-FK closure (where Recovery Steps read the closure).

## Related Specs

- [Spec-020 — Data Retention, Export And Deletion](../specs/020-data-retention-export-and-deletion.md) — §Erasure Paths (Path 2), §PII Data Map, §Ordering And Atomicity.
- [Spec-016 — Hosted Account and Identity](../specs/016-hosted-account-and-identity.md) — the hosted account, its devices and its sign-ins.

## Related Plans

- [Plan-015 — Hosted Account and Identity](../plans/015-hosted-account-and-identity.md) — `account.delete`, which this procedure performs by hand, and the token denylist.
- [Plan-019 — Data Retention, Export And Deletion](../plans/019-data-retention-export-and-deletion.md) — the Path-2 closure `account.delete` covers (CP-019-3) and the `ON DELETE SET NULL` severance (D-019-3).

## Who Runs It And Where To Report

A request to delete a hosted account routes first to `sidekicks delete-account`: an owner who can still sign in, from a machine they hold or from any computer with `sidekicks sign-in` and a passkey of the account's, deletes the account there. Only an owner who can no longer sign in at all runs this break-glass procedure, as the person who runs their own relay, which holds the account's SQLite database and the revocation it uses.
