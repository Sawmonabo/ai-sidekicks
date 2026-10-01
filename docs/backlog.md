# Backlog

Work that is waiting on something outside this repository. Everything else is either done, in flight on a branch, or a phase in [`docs/architecture/cross-plan-dependencies.md`](./architecture/cross-plan-dependencies.md).

Each item names what it is waiting for and what would close it. Delete an item when it closes; closed items live in [Backlog Archive](./archive/backlog-archive.md).

## BL-108: Plan-022 Windows + macOS signing procurement evidence

- Status: `blocked` (external-world wait — SignPath Foundation's acceptance, and an Apple Developer Program membership)
- Priority: `P2`
- Owner: `unassigned`
- References: [Plan-022](./plans/022-rust-pty-sidecar.md) §Preconditions and Phase 4, [ADR-019](./decisions/019-windows-v1-tier-and-pty-sidecar.md) §Decision items 7 and 8, [ADR-023](./decisions/023-v1-ci-cd-and-release-automation.md) §Axis 5, [Spec-021](./specs/021-desktop-app-and-renderer.md) §macOS
- Summary: Three records from outside this repository gate the release workflow's signing steps: (a) SignPath Foundation accepting the project into its free open-source program ([signpath.org/terms](https://signpath.org/terms)); (b) the first release whose Windows binaries — the Electron app, the PTY sidecar and the service's Windows half — name SignPath Foundation as publisher; (c) the Apple Developer ID Application certificate, from an Apple Developer Program membership (its thumbprint, the team ID and the enrollment confirmation), the same certificate the desktop app and the sidecar sign with. If SignPath Foundation finds the project ineligible, the choice goes back to the person and the distribution plan does not change on its own.
- V1 Release Impact: Does not block the release. Until these land, Windows builds publish unsigned and macOS builds carry the project's self-signed code-signing identity, whose first launch asks the person to open the app from Finder's menu; the Phase 4 cross-compile work ships to GitHub Releases meanwhile.
- Named gate: SignPath Foundation's acceptance of the project, and an Apple Developer Program membership (a paid yearly membership). Nothing in this repository blocks.
- Exit Criteria: all three records attached to this entry, and Plan-022 Phase 4's signing preconditions checked.

## BL-124: npm Trusted Publisher bootstrap for the terminal helper's packages

- Status: `blocked` (the registration ceremony must run in an interactive 2FA session the maintainer performs; it cannot run from CI)
- Priority: `P2`
- Owner: `unassigned`
- References: [ADR-023 §Axis 3](./decisions/023-v1-ci-cd-and-release-automation.md#axis-3--release-automation) (Surface 3, the sidecar's npm platform packages under npm Trusted Publishing), [ADR-023 §F-6](./decisions/023-v1-ci-cd-and-release-automation.md#failure-mode-analysis) (per-package Trusted Publisher registration risk + npm-bootstrap chicken-and-egg ceremony), [ADR-023 §Consequences](./decisions/023-v1-ci-cd-and-release-automation.md#consequences) (a per-package 2FA registration ceremony), [Plan-022](./plans/022-rust-pty-sidecar.md) Phase 5 (the publish, T-022-5-1), [BL-108](#bl-108-plan-022-windows--macos-signing-procurement-evidence) (binary code-signing certificates — distinct procurement track).
- Summary: The terminal helper's npm platform packages (`@ai-sidekicks/pty-sidecar-{win32-x64,win32-arm64,darwin-arm64,darwin-x64,linux-x64,linux-arm64}` and the umbrella `@ai-sidekicks/pty-sidecar`) publish under npm Trusted Publishing, which gives them npm's own provenance. ADR-023 §F-6 documents the bootstrap as a one-time chicken-and-egg ceremony: each package must publish once under a granular access token before npmjs.com will accept its Trusted Publisher registration. Nothing else is published to npm: `@ai-sidekicks/contracts`, `@ai-sidekicks/client-sdk` and `@ai-sidekicks/crypto-paseto` stay inside the workspace. BL-108 covers the binary installer code-signing certificates (Apple Developer ID + Windows track).
- V1 Release Impact: Plan-022 Phase 5's publish of the platform packages under Trusted Publishing waits on this entry.
- Exit Criteria: (a) npm organization claimed + 2FA enforced on every maintainer with publish rights per [npm 2FA docs](https://docs.npmjs.com/configuring-two-factor-authentication); (b) §F-6 bootstrap step — each package published once under a granular access token to seed the npmjs.com package record that Trusted Publisher registration requires; the packages are created by Plan-022 Phase 5; (c) per-package Trusted Publisher entry registered **from the CLI** — `npm trust github <package> --file <workflow>.yml --repository <owner>/ai-sidekicks --allow-publish` (the subcommand needs npm 11.15.0 or later, and `npm trust list` / `npm trust revoke` cover inspection and rollback) — pinned to this repo + the publishing workflow file per [npm Trusted Publishers docs](https://docs.npmjs.com/trusted-publishers/), which bind each registration to a specific workflow **filename**; (d) first end-to-end release publishes the packages with npm's provenance statement, against which `npm audit signatures` passes on a downstream install; (e) [ADR-023](./decisions/023-v1-ci-cd-and-release-automation.md) records the procurement date, the npm organization name, and the registered Trusted Publisher entries. Before (d), **dry-run the publish**: pnpm's reliability as an OIDC carrier is contested upstream, and the escalation path if it fails is to pin npm and publish the packed tarball instead.
- Tracked-by: ADR-023 §Axis 3 (Surface 3).
- Revisit Trigger: **This is the one procurement item with a closing window.** Per the [GitHub changelog of 2026-07-31](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/), bypass-2FA granular access tokens already cannot change package access, maintainers, or trusted-publishing configuration, and around **January 2027**, verbatim, "2FA-bypass tokens will also lose direct publish. Their publishing surface will reduce to reading private packages and staging a publish, which a maintainer approves with 2FA" — the recommendation being to "move automated publishing to trusted publishing (OIDC) or staged publishing." The §F-6 bootstrap is materially easier before that date than after, which is why this entry is `P2`. The ceremony itself must run in an interactive 2FA session and cannot be automated from CI. Other trigger: maintainer capacity aligns with the §F-6 bootstrap ceremony window.

## BL-155: The remote channel's hybrid post-quantum Noise profile

- Status: `blocked` (external-world wait — the hybrid profile's specification is an open working draft with no formal analysis)
- Priority: `P2`
- Owner: `unassigned`
- References: [ADR-010](./decisions/010-tokens-passkeys-and-the-remote-channel.md) (per-connection encryption on the Noise Protocol Framework), [Spec-028 §The encryption envelope](./specs/028-remote-control.md#the-encryption-envelope), [Plan-028 §Phase 3 — The relay and the channel](./plans/028-remote-control.md#phase-3--the-relay-and-the-channel), [libp2p/specs#727](https://github.com/libp2p/specs/pull/727) (the hybrid Noise draft)
- Summary: A channel between a device and a machine runs `Noise_KK_25519_ChaChaPoly_SHA256`. Its X25519 exchange is not post-quantum: someone who records a channel's traffic today could open it once a large enough quantum computer exists. The hybrid profile in progress, `Noise_XXhfs_25519+MLKEM768_ChaChaPoly_SHA256`, is an open working draft with no formal analysis, and the channel ships no unreviewed draft and no second, TLS-based connection to get there sooner. The move needs nothing new in the channel: the hybrid `KK` profile joins as a second profile in the connection's first frame, offered ahead of today's, on the same certified channel keys and frames (its extra tokens are ephemeral KEM keys), and a machine stops accepting the classical profile once every device linked to it offers the hybrid one.
- Named gate: the hybrid Noise profile's specification being finalized and reviewed for production use. Nothing in-tree blocks.
- Exit Criteria: (a) a finalized hybrid `KK` Noise profile with published analysis; (b) the profile added to the channel's profile list on the machine and every client, ahead of `Noise_KK_25519_ChaChaPoly_SHA256`; (c) a machine refusing the classical profile once every linked device offers the hybrid one; (d) ADR-010 and Spec-028 §The encryption envelope name the hybrid profile.

## BL-156: An app-owned no-reply co-author address

- Status: `blocked` (external-world wait — the project owns no mail domain)
- Priority: `P3`
- Owner: `unassigned`
- References: [Spec-009 §Required Behavior](./specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) (`Agent-Run` as the authoritative attribution)
- Summary: An agent's commits carry the daemon's `Agent-Run` trailer, which is the authoritative attribution. A co-author trailer appears only where the provider itself emits or documents one. A co-author trailer the app writes itself would need a no-reply address on a mail domain the project owns, and it has none, so the app relies on `Agent-Run` until one exists.
- Named gate: an owned mail domain.
- Exit Criteria: (a) a mail domain owned by the project, with a no-reply address on it; (b) Spec-009 states when the daemon adds its own co-author trailer and with which address; (c) the trailer hook writes it.

## BL-157: Sending the email digest without a mail password

- Status: `blocked` (external-world wait — no sending domain or mail-service account, and no registered, verified Google or Microsoft app)
- Priority: `P3`
- Owner: `unassigned`
- References: [Spec-017](./specs/017-notifications-and-attention-model.md) (the email digest), [BL-156](#bl-156-an-app-owned-no-reply-co-author-address) (the same mail-domain block)
- Summary: The email digest is sent by the service on the person's machine through the person's own mail account, with a password or an app password, which works for Gmail, iCloud, Yahoo and most mail hosts. Two ways to send without a password are blocked outside this repository. A mail service the product runs, through the control plane and a transactional mail API, needs a sending domain with its records and a mail-service account the project does not have. Signing in with Google or Microsoft instead of a password needs an OAuth client registered and verified with each: Google classes full mail access as a restricted scope needing app verification and a security assessment, and sending alone as a sensitive scope ([Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)). Microsoft 365 turns password sending off by default on existing work accounts at the end of December 2026, so a work Microsoft 365 mailbox is the one account the digest cannot reach until this closes; the web address reaches a phone meanwhile.
- Named gate: an owned sending domain and mail-service account, or registered and verified Google and Microsoft OAuth apps.
- Exit Criteria: either (a) a product-run mail service on the project's domain, with the digest able to send through it, or (b) Google and Microsoft OAuth sign-in for the digest's mail account, with registered and verified apps; and Spec-017 and the Notifications settings page describe the added path.

## BL-158: The Apple Developer Program membership for the iPhone app

- Status: `blocked` (external-world wait — a paid, yearly membership in the person's own Apple account)
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-029](./specs/029-ios-remote-client.md), [Plan-028 §Phase 7 — Frontend](./plans/028-remote-control.md#phase-7--frontend), [BL-108](#bl-108-plan-022-windows--macos-signing-procurement-evidence) (the same membership signs the macOS app)
- Summary: The iPhone app is the one front end in a Capacitor shell, native only for the enclave key, the push extension, the cover, the scan, the port view, bundle staging, the link open (`sidekicks://session/<id>`) and the Back swipe's one marked dismissal, for iOS 26 and later, built and signed under the person's own Apple account. Building it to a phone needs that account's Apple Developer Program membership: it gives the signing certificate, the registered-device profile and the APNs key the relay signs the person's pushes with. Every other Remote Control unit builds without it. Once installed, the app takes each linked machine's console from that machine over the end-to-end channel, staged for its next start; only the app's own native code and its platform bridge come with a new build.
- Named gate: the person's Apple Developer Program membership.
- Exit Criteria: (a) the membership active in the person's Apple account; (b) the iPhone app built, signed and installed on a registered device; (c) a push delivered through the account's APNs key.

## BL-159: The Firebase project for Android push

- Status: `blocked` (external-world wait — a Firebase project in the person's own Google account)
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-028](./specs/028-remote-control.md), [Plan-028 §Phase 7 — Frontend](./plans/028-remote-control.md#phase-7--frontend), [BL-158](#bl-158-the-apple-developer-program-membership-for-the-iphone-app) (the iPhone app's counterpart)
- Summary: The Android app's push goes through FCM, sent from a Firebase project in the person's own Google account; the relay adds that project's credentials to a push the machine has already sealed. Push to the Android app waits on it. Everything else in the Android app builds and installs without it, and every other Remote Control unit builds without it.
- Named gate: a Firebase project in the person's Google account.
- Exit Criteria: (a) the Firebase project exists in the person's Google account; (b) its FCM credentials held by the person's relay; (c) a push delivered through FCM to the Android app.
