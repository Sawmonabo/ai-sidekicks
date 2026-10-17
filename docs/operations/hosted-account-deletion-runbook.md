# Hosted Account Deletion Runbook

## Purpose

A break-glass procedure for the relay's owner: delete the hosted account by editing the relay's database by hand, only when the authenticated path, `sidekicks account delete`, is genuinely impossible (for example, the owner has no passkey left to verify a sign-in). The relay is the person's own, the Workers relay in their Cloudflare account or the Compose relay on their server ([ADR-019 §The Two Deployment Options](../decisions/019-v1-deployment-model-and-oss-license.md#the-two-deployment-options)), so the person who runs it is the account's owner, entitled by holding that Cloudflare account or server; both relays keep the account in SQLite inside the relay, the Workers relay in its Durable Object's own storage and the Compose relay in a SQLite file on the server ([deployment-topology §Account Storage](../architecture/deployment-topology.md#account-storage)). The one deletion path is `sidekicks account delete`, over the control plane's `account.delete` ([Plan-015 §Phase 5](../plans/015-hosted-account-and-identity.md#phase-5--daemon-credential-seam--account), [Plan-019](../plans/019-data-retention-export-and-deletion.md) CP-019-3), which the control plane serves only to the signed-in account: an owner who has lost every machine installs the command-line tool on another computer, runs `sidekicks account login`, signs in with a passkey of the account's on the relay's sign-in page in the browser, and runs `sidekicks account delete`. This procedure is for the owner who cannot sign in at all. It makes the change `account.delete` makes, in the same order, as [Spec-020 §Erasure Paths](../specs/020-data-retention-export-and-deletion.md#erasure-paths) Path 2 gives it: revoke every refresh-token family the account holds, then hard-delete the account's rows across the `REFERENCES users(id)` inbound-FK closure, anonymizing the rows that keep an independent retention basis.

It erases no machine. A machine's own data is erased only on that machine, with `Erase all data` or `sidekicks data erase` ([Spec-020 §Erasure Paths](../specs/020-data-retention-export-and-deletion.md#erasure-paths) Path 1), and nothing in this procedure reaches it.

## Symptoms

Run this procedure when **all** of the following hold:

- The relay's owner wants the hosted account deleted and holds the Cloudflare account the Workers relay is deployed in or the server the Compose relay runs on.
- The owner cannot run `sidekicks account delete`: no machine they hold is signed in to the account, and they cannot sign in from another computer, because no passkey of the account's is left to sign in with on the relay's sign-in page. If they can still sign in anywhere, they run `sidekicks account delete` there instead, and this procedure is not used.

## Detection

Establish **scope** before changing anything — separate identification from remediation:

1. **Confirm the account exists.** A deployment holds one account, so the relay's sign-in page offers `Sign in with a passkey` while it exists and `Create an account` only while none does.
2. **Read the closure** `account.delete` covers from [hosted-account-schema.md](../architecture/schemas/hosted-account-schema.md), not from memory: every table carrying a `REFERENCES users(id)` column, counted once per table however many such columns it bears — `devices`, `runtime_nodes`, `trust_statements`, `webauthn_credentials`, `webauthn_challenges`, `refresh_token_families`, `revoked_token_families`, `authorization_requests` (through `approved_user_id`), and the anonymize-class `revoked_jtis`. The control plane keeps no session record.

## Preconditions

- **Nothing can be copied first.** Deletion removes the account record and its device list, everything `account.export` returns, and `account.export` needs a sign-in, which this procedure's owner no longer has. A machine's own sessions and files are not on the control plane and are not in it.
- **Access on the Workers relay.** Cloudflare's [Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/) reads and edits a Durable Object's SQLite from the dashboard, for someone with at least `Editor` access to the Worker: on the **Durable Objects** page, select the relay's namespace, select **Data Studio**, and give it the account object's name. Each statement it runs is sent as its own request to the object, and a Durable Object's SQL cannot run `BEGIN TRANSACTION` ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)), so the steps cannot be grouped: they run in an order where a stop between any two leaves a state the next run finishes, and each is safe to run again. Its queries are billed as the object's own requests and written to the Cloudflare account's audit log.
- **Access on the Compose relay.** Stop the relay, so nothing else writes the file, and open its SQLite file in the `sqlite3` shell. Run `PRAGMA foreign_keys = ON;` and `BEGIN IMMEDIATE;` first and `COMMIT;` last, so the steps land whole or not at all, then start the relay again.
- **Copies taken before.** The rows stay in the relay's own earlier copies until those go: the Workers relay's object keeps 30 days of point-in-time recovery ([deployment-topology §Account Storage](../architecture/deployment-topology.md#account-storage)), and each Compose relay backup taken before the deletion keeps the account for as long as it is kept.
- **Understand denylist survival.** `revoked_jtis` rows survive deletion by design: `user_id` is nulled, and the `jti` key persists until its natural `expires_at + 24h` reap, a margin past the access token's lifetime, so a revoked token stays refused until it would have expired. This is **not** a precondition failure. `revoked_token_families` rows have no expiry, because a refresh token has none: they stay for the account's life and are deleted with it.
- **Nothing on a machine is touched.** Every machine keeps its own sessions, artifacts and terminal leases; the procedure reaches only the control plane's rows.

## Recovery Steps

The order is load-bearing, as in `account.delete`: revoking before the rows go writes every family to the denylist, so every device is refused at its next refresh before the account's rows go, and once they are gone, the account and the machine keys its tokens are bound to with them, none of its tokens can be traded ([Spec-020 §Ordering And Atomicity](../specs/020-data-retention-export-and-deletion.md#ordering-and-atomicity)). Every statement is idempotent, so a run that stops partway is run again from the top. Children go before the `users` row, and `revoked_jtis` is severed by its own statement, so the steps hold whether or not the database enforces `REFERENCES`.

### Find the account

1. `SELECT id FROM users;` returns the deployment's one account. Each statement below names it as `:id`; put its value in place of `:id` before running the statement.

### Revoke the account's refresh families

1. `INSERT OR IGNORE INTO revoked_token_families (family_id, user_id, reason) SELECT family_id, user_id, 'account_deleted' FROM refresh_token_families WHERE user_id = :id;` writes each live family to the denylist.
2. `DELETE FROM refresh_token_families WHERE user_id = :id;` ends the live sign-ins. Every device still holding a refresh token for the account is refused at its next refresh.

### Delete the account's rows

1. Hard-delete the rows from the no-retention-basis tables, one statement each: `DELETE FROM devices WHERE user_id = :id;`, then the same for `runtime_nodes`, `trust_statements`, `webauthn_credentials`, `webauthn_challenges` and `revoked_token_families`, and `DELETE FROM authorization_requests WHERE approved_user_id = :id;`. These are the account's linked devices and its machines' registrations, each with its public key, and its chain of signed trust statements ([hosted-account-schema.md §Devices, Machines And The Statement Chain](../architecture/schemas/hosted-account-schema.md#devices-machines-and-the-statement-chain-plan-025); safe at live-verification semantics, since every machine verifies the chain it keeps itself), its enrolled passkeys and in-flight ceremony challenges, its revoked families (kept for the account's life), and every sign-in request it approved. A request no account has approved carries no user link and goes at its expiry.
2. `UPDATE revoked_jtis SET user_id = NULL WHERE user_id = :id;` severs the one anonymize-class reference, as `ON DELETE SET NULL` does ([Spec-020 §Erasure Paths](../specs/020-data-retention-export-and-deletion.md#erasure-paths) FK-safety; Plan-019 D-019-3).
3. `DELETE FROM users WHERE id = :id;` deletes the anchor.

## Validation

The deletion is complete when **all** of the following hold:

- Every statement ran without an error, and on the Compose relay `COMMIT;` returned.
- `SELECT count(*) FROM users;` returns 0.
- The relay's sign-in page offers `Create an account`, which it offers only while the deployment holds no account.
- A refresh presented with any of the account's former refresh tokens is refused.

## Escalation

- **A statement fails.** On the Compose relay the transaction rolls back and nothing changes; on the Workers relay the statements before it stand. Either way, run the steps again from the top: each is idempotent.
- **FK-closure drift.** A foreign-key failure on the `users` delete means a `REFERENCES users(id)` table is missing from these steps: find it in [hosted-account-schema.md](../architecture/schemas/hosted-account-schema.md) and bring this runbook's closure in line with the schema, and `account.delete`'s fan-out with it.
- **A machine turns up.** This procedure never reaches a machine's data. A machine the owner recovers is already signed out; they erase it there with `Erase all data` or `sidekicks data erase`.

## Related Architecture Docs

- [Hosted Account Schema](../architecture/schemas/hosted-account-schema.md) — the `REFERENCES users(id)` inbound-FK closure (where Recovery Steps read the closure).
- [Deployment Topology §Account Storage](../architecture/deployment-topology.md#account-storage) — where each relay keeps the account.

## Related Specs

- [Spec-020 — Data Retention, Export And Deletion](../specs/020-data-retention-export-and-deletion.md) — §Erasure Paths (Path 2), §PII Data Map, §Ordering And Atomicity.
- [Spec-016 — Hosted Account and Identity](../specs/016-hosted-account-and-identity.md) — the hosted account, its devices and its sign-ins.

## Related Plans

- [Plan-015 — Hosted Account and Identity](../plans/015-hosted-account-and-identity.md) — `account.delete`, whose change this procedure makes by hand, and the token denylist.
- [Plan-019 — Data Retention, Export And Deletion](../plans/019-data-retention-export-and-deletion.md) — the Path-2 closure `account.delete` covers (CP-019-3) and the `ON DELETE SET NULL` severance (D-019-3).

## Who Runs It And Where To Report

A request to delete a hosted account routes first to `sidekicks account delete`: an owner who can still sign in, from a machine they hold or from any computer with `sidekicks account login` and a passkey of the account's, deletes the account there. Only an owner who can no longer sign in at all runs this break-glass procedure, as the person who runs their own relay and holds its Cloudflare account or server.
