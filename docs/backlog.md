# Backlog

Work that is waiting on something outside this repository. Everything else is either done, in flight on a branch, or a phase in [`docs/architecture/cross-plan-dependencies.md`](./architecture/cross-plan-dependencies.md).

Each item names what it is waiting for and what would close it. Delete an item when it closes; closed items live in [Backlog Archive](./archive/backlog-archive.md).

## BL-108: Windows + macOS signing procurement evidence

- Status: `blocked` (external-world wait — SignPath Foundation's acceptance, and an Apple Developer Program membership)
- Priority: `P2`
- Owner: `unassigned`
- References: [Plan-021](./plans/021-rust-pty-sidecar.md) §Preconditions and Phase 4 (the Windows signing), [Plan-020](./plans/020-desktop-app-and-renderer.md) T-020r-6-2 (the macOS signing), [ADR-018](./decisions/018-windows-v1-tier-and-pty-sidecar.md) §Decision items 7 and 8, [ADR-022](./decisions/022-v1-ci-cd-and-release-automation.md) §Axis 5, [Spec-021](./specs/021-desktop-app-and-renderer.md) §macOS
- Summary: Three records from outside this repository gate the release workflow's signing steps: (a) SignPath Foundation accepting the project into its free open-source program ([signpath.org/terms](https://signpath.org/terms)); (b) the first release whose Windows binaries — the Electron app, the PTY sidecar and the service's Windows half — name SignPath Foundation as publisher; (c) the Apple Developer ID Application certificate, from an Apple Developer Program membership (its thumbprint, the team ID and the enrollment confirmation), which the desktop app's macOS builds sign with; the sidecar ships no macOS binary. If SignPath Foundation finds the project ineligible, the choice goes back to the person and the distribution plan does not change on its own.
- V1 Release Impact: Windows signing through SignPath Foundation gates the Windows release; if the project is not eligible, that goes back to the person and the distribution plan does not change silently. macOS builds carry the project's self-signed code-signing identity, whose first launch asks the person to open the app from Finder's menu. Until SignPath Foundation signs, Plan-021's Phase 4 Windows binaries publish only to a pre-release npm tag, and no Windows release ships unsigned.
- Named gate: SignPath Foundation's acceptance of the project, and an Apple Developer Program membership (a paid yearly membership). Nothing in this repository blocks.
- Exit Criteria: all three records attached to this entry, and Plan-021 Phase 4's signing preconditions checked.

## BL-124: npm Trusted Publisher bootstrap for the terminal helper's packages

- Status: `blocked` (the registration ceremony must run in an interactive 2FA session the maintainer performs; it cannot run from CI)
- Priority: `P2`
- Owner: `unassigned`
- References: [ADR-022 §Axis 3](./decisions/022-v1-ci-cd-and-release-automation.md#axis-3--release-automation) (Surface 2, the sidecar's npm platform packages under npm Trusted Publishing), [ADR-022 §F-5](./decisions/022-v1-ci-cd-and-release-automation.md#failure-mode-analysis) (per-package Trusted Publisher registration risk + npm-bootstrap chicken-and-egg ceremony), [ADR-022 §Consequences](./decisions/022-v1-ci-cd-and-release-automation.md#consequences) (a per-package 2FA registration ceremony), [Plan-021](./plans/021-rust-pty-sidecar.md) Phase 5 (the publish, T-021-5-1), [BL-108](#bl-108-windows--macos-signing-procurement-evidence) (binary code-signing certificates — distinct procurement track).
- Summary: The terminal helper's npm platform packages (`@ai-sidekicks/pty-sidecar-win32-x64` and `@ai-sidekicks/pty-sidecar-win32-arm64`, since the helper ships for Windows only, and the umbrella `@ai-sidekicks/pty-sidecar`) publish under npm Trusted Publishing, which gives them npm's own provenance. ADR-022 §F-5 documents the bootstrap as a one-time chicken-and-egg ceremony: each package must publish once under a granular access token before npmjs.com will accept its Trusted Publisher registration. Nothing else is published to npm: `@ai-sidekicks/contracts`, `@ai-sidekicks/client-sdk` and `@ai-sidekicks/crypto-paseto` stay inside the workspace. BL-108 covers the binary installer code-signing certificates (Apple Developer ID + Windows track).
- V1 Release Impact: Plan-021 Phase 5's publish of the platform packages under Trusted Publishing waits on this entry.
- Exit Criteria: (a) npm organization claimed + 2FA enforced on every maintainer with publish rights per [npm 2FA docs](https://docs.npmjs.com/configuring-two-factor-authentication); (b) §F-5 bootstrap step — each package published once under a granular access token to seed the npmjs.com package record that Trusted Publisher registration requires; the packages are created by Plan-021 Phase 5; (c) per-package Trusted Publisher entry registered **from the CLI** — `npm trust github <package> --file <workflow>.yml --repository <owner>/ai-sidekicks --allow-publish` (the subcommand needs npm 11.15.0 or later, and `npm trust list` / `npm trust revoke` cover inspection and rollback) — pinned to this repo + the publishing workflow file per [npm Trusted Publishers docs](https://docs.npmjs.com/trusted-publishers/), which bind each registration to a specific workflow **filename**; (d) first end-to-end release publishes the packages with npm's provenance statement, against which `npm audit signatures` passes on a downstream install; (e) [ADR-022](./decisions/022-v1-ci-cd-and-release-automation.md) records the procurement date, the npm organization name, and the registered Trusted Publisher entries. Before (d), **dry-run the publish**: pnpm's reliability as an OIDC carrier is contested upstream, and the escalation path if it fails is to pin npm and publish the packed tarball instead.
- Tracked-by: ADR-022 §Axis 3 (Surface 2).
- Revisit Trigger: **This is the one procurement item with a closing window.** Per the [GitHub changelog of 2026-07-31](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/), bypass-2FA granular access tokens already cannot change package access, maintainers, or trusted-publishing configuration, and around **January 2027**, verbatim, "2FA-bypass tokens will also lose direct publish. Their publishing surface will reduce to reading private packages and staging a publish, which a maintainer approves with 2FA" — the recommendation being to "move automated publishing to trusted publishing (OIDC) or staged publishing." The §F-5 bootstrap is materially easier before that date than after, which is why this entry is `P2`. The ceremony itself must run in an interactive 2FA session and cannot be automated from CI. Other trigger: maintainer capacity aligns with the §F-5 bootstrap ceremony window.

## BL-155: The remote channel's hybrid post-quantum Noise profile

- Status: `blocked` (external-world wait — the hybrid profile's specification is an open working draft with no formal analysis)
- Priority: `P2`
- Owner: `unassigned`
- References: [ADR-010](./decisions/010-tokens-passkeys-and-the-remote-channel.md) (per-connection encryption on the Noise Protocol Framework), [Spec-027 §The encryption envelope](./specs/027-remote-control.md#the-encryption-envelope), [Plan-025 §Phase 3 — The relay and the channel](./plans/025-remote-control.md#phase-3--the-relay-and-the-channel), [libp2p/specs#727](https://github.com/libp2p/specs/pull/727) (the hybrid Noise draft)
- Summary: A channel between a device and a machine runs `Noise_KK_25519_ChaChaPoly_SHA256`. Its X25519 exchange is not post-quantum: someone who records a channel's traffic today could open it once a large enough quantum computer exists. The hybrid profile in progress, `Noise_XXhfs_25519+MLKEM768_ChaChaPoly_SHA256`, is an open working draft with no formal analysis, and the channel ships no unreviewed draft and no second, TLS-based connection to get there sooner. The move needs nothing new in the channel: the hybrid `KK` profile joins as a second profile in the connection's first frame, offered ahead of today's, on the same certified channel keys and frames (its extra tokens are ephemeral KEM keys), and a machine stops accepting the classical profile once every device linked to it offers the hybrid one.
- Named gate: the hybrid Noise profile's specification being finalized and reviewed for production use. Nothing in-tree blocks.
- Exit Criteria: (a) a finalized hybrid `KK` Noise profile with published analysis; (b) the profile added to the channel's profile list on the machine and every client, ahead of `Noise_KK_25519_ChaChaPoly_SHA256`; (c) a machine refusing the classical profile once every linked device offers the hybrid one; (d) ADR-010 and Spec-027 §The encryption envelope name the hybrid profile.

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
- References: [Spec-028](./specs/028-connect-an-ios-app-and-drive-control.md), [Plan-025 §Phase 7 — Frontend](./plans/025-remote-control.md#phase-7--frontend), [BL-108](#bl-108-windows--macos-signing-procurement-evidence) (the same membership signs the macOS app)
- Summary: The iPhone app is the one front end in a Capacitor shell, native only for the enclave key, the push extension, the cover, the scan, the port view, bundle staging, the link open (`sidekicks://session/<id>`) and the Back swipe's one marked dismissal, for iOS 26 and later, built and signed under the person's own Apple account. Building it to a phone needs that account's Apple Developer Program membership: it gives the signing certificate, the registered-device profile and the APNs key the relay signs the person's pushes with. Every other Remote Control unit builds without it. Once installed, the app takes each linked machine's console from that machine over the end-to-end channel, staged for its next start; only the app's own native code and its platform bridge come with a new build.
- Named gate: the person's Apple Developer Program membership.
- Exit Criteria: (a) the membership active in the person's Apple account; (b) the iPhone app built, signed and installed on a registered device; (c) a push delivered through the account's APNs key.

## BL-159: The Firebase project for Android push

- Status: `blocked` (external-world wait — a Firebase project in the person's own Google account)
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-027](./specs/027-remote-control.md), [Plan-025 §Phase 7 — Frontend](./plans/025-remote-control.md#phase-7--frontend), [BL-158](#bl-158-the-apple-developer-program-membership-for-the-iphone-app) (the iPhone app's counterpart)
- Summary: The Android app's push goes through FCM, sent from a Firebase project in the person's own Google account; the relay adds that project's credentials to a push the machine has already sealed. Push to the Android app waits on it. Everything else in the Android app builds and installs without it, and every other Remote Control unit builds without it.
- Named gate: a Firebase project in the person's Google account.
- Exit Criteria: (a) the Firebase project exists in the person's Google account; (b) its FCM credentials held by the person's relay; (c) a push delivered through FCM to the Android app.

## BL-160: signalsmith-stretch reading a request added in pieces

- Status: `blocked` (external-world wait — a `signalsmith-stretch` release carrying [Signalsmith-Audio/signalsmith-stretch#30](https://github.com/Signalsmith-Audio/signalsmith-stretch/pull/30))
- Priority: `P3`
- Owner: `unassigned`
- References: [Desktop App Implementation Notes §Console Libraries](architecture/desktop-implementation-notes.md#console-libraries) (the Voice call playback row), [Signalsmith-Audio/signalsmith-stretch#30](https://github.com/Signalsmith-Audio/signalsmith-stretch/pull/30) (the fix), [Signalsmith-Audio/signalsmith-stretch#22](https://github.com/Signalsmith-Audio/signalsmith-stretch/issues/22) (the issue it fixes)
- Summary: A Codex hold's request plays into a voice call through `signalsmith-stretch` 1.3.2 in the window, streamed in a second at a time with `addBuffers`. In 1.3.2 the package's read loop loses its place at the first joint between pieces (upstream issue #22). The fix is posted upstream as pull request #30 and no release carries it, so the desktop carries it as a `pnpm patch` to the read loop, held in `patches/` and named in `patchedDependencies` in `pnpm-workspace.yaml`.
- Named gate: a `signalsmith-stretch` release that carries the fix. Nothing in-tree blocks.
- Exit Criteria: (a) the desktop on that release; (b) the patch and its `patchedDependencies` entry deleted; (c) until then, each newest-release pass checks the pull request's state with `gh pr view 30 -R Signalsmith-Audio/signalsmith-stretch`.

## BL-161: Bun building a package that sets `"gypfile": false`

- Status: `blocked` (external-world wait — a Bun release fixing [oven-sh/bun#43903](https://github.com/oven-sh/bun/issues/43903))
- Priority: `P3`
- Owner: `unassigned`
- References: [Workflow Graph Model §Node-Kind Taxonomy](domain/workflow-graph-model.md#node-kind-taxonomy) (a run installs from the lock and never resolves again), [oven-sh/bun#43903](https://github.com/oven-sh/bun/issues/43903)
- Summary: A workflow's code step installs its packages with `bun install --frozen-lockfile` in that version's code folder. Bun runs the `node-gyp` build even for a package that sets `"gypfile": false`, such as `better-sqlite3`, and that build fetches the Node headers. So the install runs with `npm_config_devdir` and `TMPDIR` pointed into the daemon's folder, and the headers land under the daemon's cache rather than the person's own.
- Named gate: a Bun release that carries the fix. Nothing in-tree blocks.
- Exit Criteria: (a) the daemon's `bun` on that release; (b) `npm_config_devdir` and `TMPDIR` kept on the install only if the cache placement still needs them; (c) until then, each newest-release pass checks the issue's state with `gh issue view 43903 -R oven-sh/bun`.

## BL-162: Codex sending no command item for a command its sandbox refuses early

- Status: `blocked` (external-world wait — a Codex release fixing [openai/codex#47433](https://github.com/openai/codex/issues/47433))
- Priority: `P3`
- Owner: `unassigned`
- References: [Spec-004 §Per-Driver Capability Matrix](./specs/004-provider-driver-contract-and-capabilities.md#per-driver-capability-matrix) (Codex's hooks and their trust), [Codex wire reference §Hooks passed at the service's start, and their trust](./reference/provider-wire/codex.md#hooks-passed-at-the-services-start-and-their-trust), [openai/codex#47433](https://github.com/openai/codex/issues/47433)
- Summary: When Codex's sandbox refuses a command on its early exit path, Codex sends no `commandExecution` item for it, while the model still gets the refusal with exit code 1: a sandbox-refused `touch .git/config` run twice in one thread with approvals never has no item the second time. The pre-tool and post-tool hooks still fire for that call, since a refused command still counts as a success. So a command Codex refused before sending its command item gets its row from the daemon's hook pair: a command a hook reports with no item by the end of its turn is one the sandbox refused before sending its item, and its row carries no exit code, since the post payload carries none.
- Named gate: a Codex release that sends the command item on the early refusal path. Nothing in-tree blocks.
- Exit Criteria: (a) a refused command's row drawn from Codex's own item; (b) the hook-drawn row path deleted, the hooks keeping their other work (reporting a command and holding a call while the session is paused); (c) until then, each newest-release pass checks the issue's state with `gh issue view 47433 -R openai/codex`.

## BL-163: The compaction point no provider request reports

- Status: `blocked` (external-world wait — a Claude Code release answering [anthropics/claude-code#97568](https://github.com/anthropics/claude-code/issues/97568), and a Codex release answering [openai/codex#48616](https://github.com/openai/codex/issues/48616))
- Priority: `P3`
- Owner: `unassigned`
- References: [Spec-011 §Context Window and Compaction](./specs/011-transcript-and-reasoning.md#context-window-and-compaction), [Claude wire reference §What the daemon sends to a process it starts, and what it reads back](./reference/provider-wire/claude.md#what-the-daemon-sends-to-a-process-it-starts-and-what-it-reads-back), [Codex wire reference §Conversation settings a client sets per conversation](./reference/provider-wire/codex.md#conversation-settings-a-client-sets-per-conversation), [Plan-010 §Phase 3 — Child-Run Expansion And Reasoning Surfaces](./plans/010-transcript-and-reasoning.md#phase-3--child-run-expansion-and-reasoning-surfaces) (T3.7, T3.8), [anthropics/claude-code#97568](https://github.com/anthropics/claude-code/issues/97568), [openai/codex#48616](https://github.com/openai/codex/issues/48616)
- Summary: Each provider's compaction point is set by its own knob, and for some bounds no request reports the point the bound resolves to, so the daemon calibrates it. On Claude Code the window key's point is read back from `get_context_usage`, but below 67,000 tokens only the percentage key reaches, and no request reports that key's point: the daemon computes it from the reply reserve and the constant, read with two `get_context_usage` reads in the short control-only process it runs at session creation, with `apply_flag_settings {env}` between them setting the window key and then a `CLAUDE_CODE_MAX_OUTPUT_TOKENS` value, once per model. Request #97568 asks `get_context_usage` to report the percentage key's point. On Codex the resolved limit for `model_auto_compact_token_limit` appears only in the `post sampling token usage` trace line (`auto_compact_scope_limit`), about 330 KB of trace a turn: a short calibration service on a throwaway home, against a local stand-in endpoint that spends no tokens, reads it once per model and window the picker offers, stored by the Codex version, the model and the window, and run again when the installed Codex version or the model catalog changes. Request #48616 asks Codex to report the resolved limit in `thread/tokenUsage/updated` or `model/list`.
- Named gate: a Claude Code release that reports the percentage key's point, and a Codex release that reports the resolved limit; each half closes on its own provider's release. Nothing in-tree blocks.
- Exit Criteria: (a) on a Claude Code release that reports it, the two context reads that calibrate the percentage key's point deleted and the provider's figure read, the creation-time process keeping its other reads; (b) on a Codex release that reports it, the calibration service deleted and the provider's figure read; (c) until both close, each newest-release pass checks each issue's state with `gh issue view 97568 -R anthropics/claude-code` and `gh issue view 48616 -R openai/codex`.

## BL-164: MCP Tasks on Codex

- Status: `blocked` (external-world wait — a Codex release carrying MCP Tasks, [openai/codex#48617](https://github.com/openai/codex/issues/48617))
- Priority: `P3`
- Owner: `unassigned`
- References: [ADR-038 §Context](./decisions/038-mcp-credential-custody.md#context), [ADR-038 §Option E](./decisions/038-mcp-credential-custody.md#option-e-wait-for-the-providers-filed-in-parallel-not-chosen-alone), [Spec-024 §Long tool calls and the fronted route](./specs/024-mcp-server-configuration-and-governance.md#long-tool-calls-and-the-fronted-route), [openai/codex#48617](https://github.com/openai/codex/issues/48617)
- Summary: Codex has no MCP Tasks and cannot move a long call to the background. So the daemon fronts every tool server a Codex session reaches, on its own route, with its own MCP client holding the real connection: past 120 s the route answers Codex's pending call with a task handle, the call keeps running in the daemon's client, which makes it task-augmented wherever the tool allows one, and the result is delivered into the conversation when the call ends. A fronted server behind a sign-in is reached on the daemon's own sign-in. The request asks Codex to make a task-augmented call when a tool allows one, poll `tasks/get` and keep the task across a thread resume.
- Named gate: a Codex release that makes task-augmented calls itself. Nothing in-tree blocks.
- Exit Criteria: (a) a Codex session's task-augmented calls handed to Codex; (b) the daemon's fronting narrowed, the single sign-in for both providers keeping its own value; (c) until then, each newest-release pass checks the issue's state with `gh issue view 48617 -R openai/codex`.

## BL-165: MCP prompts on Codex

- Status: `blocked` (external-world wait — a Codex release with prompt calls on its app-server, [openai/codex#5059](https://github.com/openai/codex/issues/5059))
- Priority: `P3`
- Owner: `unassigned`
- References: [ADR-038 §Context](./decisions/038-mcp-credential-custody.md#context), [ADR-038 §Option E](./decisions/038-mcp-credential-custody.md#option-e-wait-for-the-providers-filed-in-parallel-not-chosen-alone), [openai/codex#5059](https://github.com/openai/codex/issues/5059) (the project's comment proposes the calls)
- Summary: Codex never asks a server for its prompts: its app-server has no prompt verb, and its MCP client methods are `mcpServerStatus/list`, `mcpServer/oauth/login`, `config/mcpServer/reload`, `mcpServer/resource/read`, `mcpServer/tool/call` and an event stream that serves only hosted apps. So on a Codex session the daemon lists and reads a server's prompts through its own MCP client, which needs a credential for a server behind a sign-in. The comment on #5059 asks for `mcpServer/prompt/list` and `mcpServer/prompt/get` beside `mcpServer/resource/read`, on the connection Codex already holds.
- Named gate: a Codex release with prompt calls on its app-server. Nothing in-tree blocks.
- Exit Criteria: (a) a Codex session's prompts listed and read through Codex's own prompt calls, in place of the daemon's own MCP client; (b) until then, each newest-release pass checks the issue's state with `gh issue view 5059 -R openai/codex`.

## BL-166: Live tear-off on Wayland waits on an Electron API

- Status: `blocked` (external-world wait — Electron accepting and releasing a call that attaches a window to a pointer drag)
- Priority: `P3`
- Owner: `unassigned`
- References: [ADR-040](./decisions/040-drag-is-our-own-on-pointer-events.md) (Linux on Wayland), [Plan-027](./plans/027-windows-and-linux.md) T27.2.15, [Electron issue #54650](https://github.com/electron/electron/issues/54650)
- Summary: On native Wayland a session view torn out of its window cannot follow the pointer, because Electron offers no call for `xdg_toplevel_drag_v1`; the view's window opens where the compositor places it. Feature request #54650 asks Electron for that call, a thin API over Chromium's `views::Widget::PrepareForMoveLoop` and `RunMoveLoop`.
- V1 Release Impact: none for macOS. The Linux leg ships the native drag ADR-040 describes; the live follow on Wayland arrives with the Electron release that carries the call.
- Named gate: an Electron release with the call.
- Exit Criteria: when the Linux work starts, where #54650 stands is checked, and the held socket-intercepting add-on ADR-040 records is looked at again if no release carries the call; the release is taken, T27.2.15's Wayland drag moves onto the call, and this entry is deleted.
