# Cedar Policy Signing And Rotation

## Purpose

Publish, verify, rotate and retire the signed approval-rules bundles the service evaluates with Cedar. One bundle form carries the built-in approval rules and every later one: the set built into the service is the first bundle, a later one arrives on the update feed, and each passes the same verifier — an Ed25519 and an ML-DSA-65 signature both required against the two key pairs pinned in the service build ([ADR-012 §Signing Algorithm](../decisions/012-cedar-approval-policy-engine.md#signing-algorithm)), a required Sigstore keyless record verified offline, and a strictly rising version with no expiry ([ADR-012 §Policy Chain of Custody](../decisions/012-cedar-approval-policy-engine.md#policy-chain-of-custody)). Covers four procedures: publishing a new bundle, reading a refused bundle or a service that will not start, rotating a signing key, and retiring a key early after a suspected compromise.

## Symptoms

- The service records `policy_bundle.rejected {version, reason}`, with `reason` one of `signature`, `key_retired`, `record`, `not_newer`, `malformed` or `cedar`. The service keeps evaluating with the bundle it already runs, so approvals go on under the last verified rules.
- `sidekicks daemon status` still prints an older `Approval rules: bundle <n> · built <date>` after a newer bundle was published.
- The service will not start, and `sidekicks daemon status` and Settings › Runtime's service line read `Stopped: its approval rules did not pass their signature check. Reinstall the app to restore them.` No bundle verified, not even the one built into the service.
- The project's transparency-log watch alerts on an entry under the release workflow's identity that the project did not make.
- A signing key, or the release workflow's protected environment that holds the keys, is suspected to be exposed.
- Scope:
  - A refused candidate changes nothing on the machine that refused it; the machine waits on a verifiable newer bundle.
  - The start refusal stops one machine's service until the app is reinstalled or updated.
  - A suspected key compromise concerns every machine whose build pins that key.

## Detection

- Run `sidekicks daemon status` on the machine: `Approval rules: bundle <n> · built <date>` names the bundle it runs (`built in` for the first). `sidekicks daemon status --json` carries the same as `approvalRules {version, builtAt, source}`, where `source` is `built_in` or `update`.
- Read the machine's `policy_bundle.rejected` events for the version refused and the reason, and match the reason against Scenario B's table.
- Compare the running version with the newest bundle published on the update feed.
- For a log-watch alert: open the transparency-log entry, read the certificate's workflow identity, the ref and the repository ids, and match them against the release workflow's own runs. An entry no run of the project made is Scenario D.
- For a suspected compromise: establish whether the key material alone or the release workflow and its protected environment are suspected. The second widens the response (Scenario D, step 2).

## Preconditions

- The project owner's approval as required reviewer of the release workflow's protected environment, which holds the signing keys as environment secrets readable only by the tag-triggered release workflow.
- Both pinned pairs, `current` and `next`, present in that environment; each pair is one Ed25519 key and one ML-DSA-65 key.
- Access to the update feed the service fetches from.
- For a retirement: the pinned pair other than the one being retired is not suspected.
- For reading a machine's state: a shell on the machine to run `sidekicks daemon status`.

## Recovery Steps

### Scenario A — Publish a new approval-rules bundle

1. Change the YAML policy sources under `packages/runtime-daemon/policies/`, merge the change, and tag the release (`v<major>.<minor>.<patch>`); the release workflow runs on the tag, and only a run on a release tag produces a record the service accepts.
2. Approve the workflow's use of the protected environment as the required reviewer.
3. The workflow compiles the policies and builds `approval-rules-<version>.bundle`, with a `version` higher than any published and a current `builtAt`, and the service's Cedar version as `cedarVersion`.
4. The workflow signs the canonical manifest with the `current` pair's Ed25519 and ML-DSA-65 keys, then signs the bundle keyless through Sigstore, which puts an entry in the transparency log, and writes the Sigstore record beside the bundle.
5. The workflow runs the service's own verifier over the bundle against the release pins before publishing; a bundle it refuses is not published.
6. Publish the bundle and its Sigstore record on the update feed.
7. On a machine, after its next update check, confirm that `sidekicks daemon status` prints `Approval rules: bundle <version> · built <date>`.

Building and signing are the release workflow's own scripts; there is no `sidekicks` verb for them, because the person never handles a bundle.

### Scenario B — A bundle was refused, or the service will not start

A refused bundle changes nothing on the machine: it keeps evaluating with the bundle it runs until a verifiable newer one arrives, so the fix is always a newer bundle, never an action on the machine.

| `reason` | Meaning | Action |
| --- | --- | --- |
| `signature` | An Ed25519 or ML-DSA-65 signature is missing or does not verify against the pinned pairs. | Confirm the release workflow signed with the pinned `current` or `next` pair, then publish a newer bundle signed correctly. A dev or test build pins test material and refuses release bundles by design. |
| `key_retired` | The bundle was signed by a key the machine has recorded as retired. | Sign with the other pair and publish a newer bundle; a retired key never signs again. |
| `record` | The Sigstore record is missing, has no transparency-log entry, or names a signer outside the pinned issuer, identity pattern or repository and owner ids. | Confirm the bundle came from the project's release workflow on its own repository at a release tag, and republish from such a run. A record naming any other identity is not the project's: go to Scenario D. |
| `not_newer` | The version is not higher, or `builtAt` is earlier, than the running bundle's. | Expected when an older bundle is replayed. Publish a bundle with a higher version and a current `builtAt`. |
| `malformed` | The manifest does not parse, or a content hash does not match the bundle's contents. | Rebuild and republish; if the published file is intact, the fetch was damaged and the next update check fetches it again. |
| `cedar` | The manifest's `cedarVersion` is not the service's, or the policy set does not parse. | Rebuild the bundle for the service's Cedar version, or ship it with the service update that moves the Cedar pin. |

**The service will not start.** When no bundle verifies, not even the built-in one, the install is damaged or was built with other pins. Reinstall or update the app from the project's own release, which restores a built-in bundle that verifies; the service then starts on it and fetches the newest bundle at its next update check.

### Scenario C — Rotate a signing key (no compromise)

Each service build pins two pairs, `current` and `next`, so rotation needs no coordinated upgrade.

1. Generate a new pair — one Ed25519 key and one ML-DSA-65 key — in the protected environment.
2. Sign the next bundles with the `next` pair; every machine already verifies it.
3. Ship the following service build pinning the old `next` as its `current` and the new pair as its `next`.
4. Remove the old `current` pair from the protected environment once no release signs with it. If it must stop verifying on machines that still pin it, retire it with a statement (Scenario D, steps 3 and 4).

### Scenario D — Retire a key early (suspected compromise, or a log entry the project did not make)

Treat as a Severity 1 incident.

1. Remove the suspected key's pair from the protected environment. Preserve the workflow run history, the environment's access record and the transparency-log entries.
2. If the release workflow or its protected environment is suspected, not only the key material, lock the environment and review its required reviewers and secrets before any further signing.
3. With the other pinned pair, sign a retirement statement naming the retired key ids, and re-sign the newest bundle with that pair at a version higher than any published.
4. Publish the retirement statement together with the re-signed bundle on the update feed, never the statement alone, so no machine is left without verifiable rules. Each machine records the retired ids for good, refuses anything they signed, and swaps to the re-signed bundle.
5. Generate a new pair to become `next`, and ship the service build that pins it.

A copied key alone ships nothing the service accepts: every bundle also needs a Sigstore record that only the project's own release workflow on its own repository can make, and any such attempt shows in the public log the project watches.

## Validation

- `sidekicks daemon status` prints `Approval rules: bundle <version> · built <date>` for the published version, and `--json` reads `approvalRules.source` as `update`.
- The machine recorded `policy_bundle.loaded {version, builtAt}` for that version and no `policy_bundle.rejected` for it.
- After a start refusal: the service starts, and the status line names a bundle again.
- After a rotation: the newest bundle, signed with the pair that was `next`, is the one running.
- After a retirement: the re-signed bundle is the one running, and the transparency-log watch shows no entry the project did not make.

## Escalation

- Escalate when both pinned pairs are suspected: no retirement statement can then be signed by an uncompromised pair, and only a service update pinning new pairs recovers. Until it lands, the required Sigstore record still keeps bundles made outside the project's own release workflow from being accepted.
- Escalate when a transparency-log entry verifies under the project's release identity but no one on the project ran that release: the workflow or its repository is compromised, not only a key.
- Escalate when the service still refuses to start after a reinstall from the project's own release.
- Escalate when a machine's stored highest `version` is higher than any bundle the project has published (possible damage to the service's database; see [Local Persistence Repair And Restore](./local-persistence-repair-and-restore.md)).

## Related Architecture Docs

- [Security Architecture](../architecture/security-architecture.md)
- [Daemon Architecture](../architecture/daemon.md)

## Related Specs

- [Approvals Permissions And Trust Boundaries](../specs/010-approvals-permissions-and-trust-boundaries.md)

## Related Plans

- [Approvals Permissions And Trust Boundaries](../plans/010-approvals-permissions-and-trust-boundaries.md)
