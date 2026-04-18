# Cedar Policy Signing And Rotation

## Purpose

Sign, distribute, verify, and rotate the operator-signed artifacts that underpin Cedar approval policy evaluation: the daemon image (V1) and the runtime Cedar policy bundle (V1.1+). Cover the four operational scenarios: signing a new bundle, diagnosing a daemon that refuses to enforce approvals because of signature failure, rotating the operator signing key, and responding to a suspected compromise of the operator signing key.

## Symptoms

- `RecoveryStatusRead` reports `ApprovalPolicyEngineUnavailable` on one or more daemon nodes.
- Daemon logs show one of: `policy-bundle-signature-invalid`, `policy-bundle-hash-mismatch`, `policy-bundle-version-rollback`, `policy-bundle-timestamp-expired`, `policy-bundle-algorithm-mismatch`, `policy-bundle-pinned-key-unknown`.
- Approval requests stall: new `ApprovalRequestCreate` calls return `ApprovalPolicyEngineUnavailable`; in-flight approvals pause.
- A newly deployed daemon image fails to start and logs `image-signature-verification-failed` against the pinned operator public key.
- An operator security incident ticket indicates suspected exposure of the operator release signing key.
- Scope and blast radius:
  - V1 image-signature failure: one daemon node fails to start; approvals on that node unavailable.
  - V1.1 bundle-signature failure: daemon continues running but suspends approval evaluation; existing authorized sessions on that node continue until they require a new approval decision.
  - Suspected operator-key compromise: fleet-wide; every daemon pinned to the compromised key is in scope.

## Detection

- Read `RecoveryStatusRead` and `FailureDetailRead` for the affected node(s) before taking any action.
- Correlate the specific error code from daemon logs against the failure modes in the Recovery Steps table below.
- Check operator release infrastructure audit logs for unexpected signing events in the 7 days preceding the report.
- For suspected compromise: confirm with operator security whether the private key material or the release infrastructure itself is suspected to be exposed. The two cases have different response scope.

## Preconditions

- Access to the operator release infrastructure (for signing and rotation scenarios).
- Access to the affected daemon node(s) and permission to restart them.
- Access to the most recent known-good signed policy bundle (for bundle-verification failure diagnostics).
- For rotation: scheduled maintenance window coordinated with all daemon operators (hosted + self-hosted) because V1 does not support dual-pinning.
- For compromise response: incident-response authority to publish an emergency daemon image out of the normal release cadence.

## Recovery Steps

### Scenario A — Sign and publish a new policy bundle (V1.1+)

1. Build the policy bundle tarball:
   `sidekicks policy bundle build --out policy-bundle-v{N}.cedar.tar.gz`
   where `{N}` is `last_published_version + 1`.
2. Inspect the manifest in the built tarball to confirm version, algorithm, and Cedar target version are as expected.
3. Sign the bundle with the operator release key:
   `sidekicks policy bundle sign --bundle policy-bundle-v{N}.cedar.tar.gz --key <operator-release-key-ref>`
4. Verify the signature locally before publishing:
   `sidekicks policy bundle verify --bundle policy-bundle-v{N}.cedar.tar.gz --sig policy-bundle-v{N}.cedar.tar.gz.sig --pubkey <operator-public-key>`
5. Publish bundle and signature to the operator distribution endpoint.
6. Monitor daemon fleet telemetry for bundle pickup and successful verification counts.

(CLI flag names are proposed; concrete surface is finalized in [Plan-012](../plans/012-approvals-permissions-and-trust-boundaries.md).)

### Scenario B — Daemon refuses to enforce approvals (bundle verification failed)

| Error code | Meaning | Action |
|---|---|---|
| `policy-bundle-signature-invalid` | Signature does not verify against pinned key. | Confirm correct bundle/signature pair; confirm daemon's pinned key matches the key that signed this bundle; if mismatch, daemon was built against a different operator key and needs rebuild/reinstall. |
| `policy-bundle-hash-mismatch` | Tarball hash does not match manifest hash. | Bundle is truncated or altered; re-fetch from distribution endpoint. |
| `policy-bundle-version-rollback` | Candidate `N` is not greater than `last_verified_bundle_version`. | Expected when replaying an older bundle; publish `N > last_verified_bundle_version` or, if the daemon's persisted version is itself wrong, escalate. |
| `policy-bundle-timestamp-expired` | Manifest timestamp is outside the freshness window. | Publish a newer bundle with a current timestamp. |
| `policy-bundle-algorithm-mismatch` | Bundle signed with an algorithm other than the daemon's pinned algorithm. | Re-sign the bundle with the daemon's expected algorithm or rebuild the daemon with the desired algorithm pinned. |
| `policy-bundle-pinned-key-unknown` | Daemon has no pinned operator public key. | Daemon image is built incorrectly; rebuild with `OPERATOR_PUBLIC_KEY` build arg set. |

After correcting the underlying cause, restart the daemon and confirm `RecoveryStatusRead` moves out of `ApprovalPolicyEngineUnavailable`.

### Scenario C — Rotate the operator signing key (no compromise)

V1 does not support dual-pinning. Rotation is a coordinated fleet upgrade.

1. Generate the new operator signing keypair on the operator release infrastructure.
2. Update the release build configuration to pin the new public key (`OPERATOR_PUBLIC_KEY` build arg) in the next daemon image.
3. Build and sign the next daemon image with the new key. The image itself is signed by the new key from this point forward.
4. (V1.1+) Sign one final policy bundle with the old key that is valid for the freshness window; this keeps not-yet-upgraded daemons operational during the rollout.
5. Publish the new daemon image and announce the rotation to all daemon operators with a target upgrade deadline before the freshness window on the last old-key-signed bundle expires.
6. Self-hosters rebuild their daemon images with the new operator public key on the same schedule.
7. After the deadline, verify fleet telemetry shows all daemons running the new-key image. Decommission the old signing key from the release infrastructure.

### Scenario D — Respond to suspected compromise of the operator signing key

Treat as a Severity 1 incident.

1. Immediately revoke access to the compromised key on the operator release infrastructure. Preserve audit logs.
2. Generate a replacement operator signing keypair on a clean release environment.
3. Build and sign an emergency daemon image pinned to the replacement public key. Mark the release as emergency in the release notes.
4. Publish the emergency image out-of-band and notify all daemon operators (hosted + self-hosted) to upgrade immediately.
5. (V1.1+) Do not publish any further policy bundles signed with the compromised key, even if the freshness window would still accept them.
6. Acknowledge in the incident record the gap period: daemons that have not yet upgraded will continue to accept artifacts signed by the compromised key until they upgrade. V1 has no online revocation channel to close this gap. Track each non-upgraded daemon until it upgrades.
7. If the suspected compromise is of the release infrastructure itself (not just the key material), rebuild the release infrastructure from known-good state before generating the replacement keypair.

## Validation

- `RecoveryStatusRead` moves out of `ApprovalPolicyEngineUnavailable` on affected nodes.
- Daemon logs show successful bundle or image signature verification.
- A test `ApprovalRequestCreate` on the affected node returns a normal approval flow rather than `ApprovalPolicyEngineUnavailable`.
- For rotation: fleet telemetry shows 100% of active daemons running an image pinned to the new operator public key.
- For compromise response: the incident record includes the list of daemons that upgraded to the emergency image and the timestamp each one upgraded.

## Escalation

- Escalate when image signature verification fails against the pinned key with no explainable cause (suggests the pinned key in the deployed image is not the key the release infrastructure actually signed with — either the wrong image was deployed or the release pipeline is misconfigured).
- Escalate when bundle verification continues to fail after re-fetching and the hash matches the distribution endpoint.
- Escalate on any case of suspected compromise of the operator signing key or the release infrastructure that holds it.
- Escalate when the daemon's persisted `last_verified_bundle_version` is higher than any bundle that has actually been published (possible local SQLite state corruption; cross-reference [Local Persistence Repair And Restore](./local-persistence-repair-and-restore.md)).

## Related Architecture Docs

- [Security Architecture](../architecture/security-architecture.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)

## Related Specs

- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)

## Related Plans

- [Approvals Permissions And Trust Boundaries](../plans/012-approvals-permissions-and-trust-boundaries.md)
