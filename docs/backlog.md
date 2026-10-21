# Backlog

Work that is waiting on something outside this repository. Everything else is either done, in flight on a branch, or a phase in [`docs/architecture/cross-plan-dependencies.md`](./architecture/cross-plan-dependencies.md).

Each item names what it is waiting for and what would close it. Delete an item when it closes; closed items live in [Backlog Archive](./archive/backlog-archive.md).

## BL-108: SignPath Foundation's acceptance for Windows signing

- Status: `blocked` (external-world wait — SignPath Foundation's acceptance)
- Priority: `P2`
- Owner: `unassigned`
- References: the release workflow's Windows signing of the `sidekicks-daemon` program, [Plan-020](./plans/020-desktop-app-and-renderer.md) T-020r-6-2 (the Windows signing), [ADR-018](./decisions/018-windows-v1-tier-and-pty-in-the-daemon.md) §Decision items 5 and 6, [ADR-022](./decisions/022-v1-ci-cd-and-release-automation.md) §Axis 5
- Summary: One answer from outside this repository gates the release workflow's Windows signing: SignPath Foundation accepting the project into its free open-source program ([signpath.org/terms](https://signpath.org/terms)), which the release workflow applies for once a release exists, as the program's terms ask. Once accepted, the workflow signs every Windows binary — the Electron app, `sidekicks-daemon`, `sidekicks`, the client's `.node` and `libpdfium` — with SignPath Foundation as publisher. If SignPath Foundation finds the project ineligible, the choice goes back to the person and the distribution plan does not change on its own.
- V1 Release Impact: Until SignPath Foundation signs, Windows builds publish unsigned: SmartScreen's prompt is cleared once with `Run anyway`, and a Windows machine with Smart App Control on cannot run them, a gap until then. If the project is not eligible, that goes back to the person and the distribution plan does not change silently.
- Named gate: SignPath Foundation's acceptance of the project. Nothing in this repository blocks.
- Exit Criteria: SignPath Foundation's acceptance attached to this entry, and the release workflow's Windows signing checked on the first release it signs.

## BL-155: The remote channel's hybrid post-quantum Noise profile

- Status: `blocked` (external-world wait — the hybrid profile's specification is an open working draft with no formal analysis)
- Priority: `P2`
- Owner: `unassigned`
- References: [ADR-010](./decisions/010-tokens-passkeys-and-the-remote-channel.md) (per-connection encryption on the Noise Protocol Framework), [Spec-027 §The encryption envelope](./specs/027-remote-control.md#the-encryption-envelope), [Plan-025 §Phase 3 — The relay and the channel](./plans/025-remote-control.md#phase-3--the-relay-and-the-channel), [libp2p/specs#727](https://github.com/libp2p/specs/pull/727) (the hybrid Noise draft)
- Summary: A channel between a device and a machine runs one of two profiles, `Noise_KK_25519_AESGCM_SHA256`, offered first, or `Noise_KK_25519_ChaChaPoly_SHA256`. Its X25519 exchange is not post-quantum: someone who records a channel's traffic today could open it once a large enough quantum computer exists. The hybrid profile in progress, `Noise_XXhfs_25519+MLKEM768_ChaChaPoly_SHA256`, is an open working draft with no formal analysis, and the channel ships no unreviewed draft and no second, TLS-based connection to get there sooner. The move needs nothing new in the channel: the hybrid `KK` profile joins as a further profile in the connection's first frame, offered ahead of the classical ones, on the same certified channel keys and frames (its extra tokens are ephemeral KEM keys), and a machine stops accepting the classical profiles once every device linked to it offers the hybrid one.
- Named gate: the hybrid Noise profile's specification being finalized and reviewed for production use. Nothing in-tree blocks.
- Exit Criteria: (a) a finalized hybrid `KK` Noise profile with published analysis; (b) the profile added to the channel's profile list on the machine and every client, ahead of `Noise_KK_25519_AESGCM_SHA256` and `Noise_KK_25519_ChaChaPoly_SHA256`; (c) a machine refusing the classical profiles once every linked device offers the hybrid one; (d) ADR-010 and Spec-027 §The encryption envelope name the hybrid profile.

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
- References: [Spec-028](./specs/028-connect-an-ios-app-and-drive-control.md), [Plan-025 §Phase 7 — Frontend](./plans/025-remote-control.md#phase-7--frontend)
- Summary: The iPhone app is the one front end in a Capacitor shell, native only for the enclave key, the push extension, the cover, the scan, the port view, bundle staging, the link open (`sidekicks://session/<id>`), the Back swipe's one marked dismissal and the share sheet for a file a page in Preview saved, for iOS 26 and later, built and signed under the person's own Apple account. Building it to a phone needs that account's Apple Developer Program membership: it gives the signing certificate, the registered-device profile and the APNs key the relay signs the person's pushes with. Every other Remote Control unit builds without it. Once installed, the app takes each linked machine's console from that machine over the end-to-end channel, staged for its next start; only the app's own native code and its platform bridge come with a new build.
- Named gate: the person's Apple Developer Program membership.
- Exit Criteria: (a) the membership active in the person's Apple account; (b) the iPhone app built, signed and installed on a registered device; (c) a push delivered through the account's APNs key.

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
- References: [Spec-004 §Per-Driver Capability Matrix](./specs/004-provider-driver-contract-and-capabilities.md#per-driver-capability-matrix) (Codex's hooks and their trust), [Codex wire reference §Hooks and their trust](./reference/provider-wire/codex.md#hooks-and-their-trust), [openai/codex#47433](https://github.com/openai/codex/issues/47433)
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
- Exit Criteria: (a) a Codex session's task-augmented calls handed to Codex; (b) the daemon's fronting narrowed, the one sign-in every provider's sessions share keeping its own value; (c) until then, each newest-release pass checks the issue's state with `gh issue view 48617 -R openai/codex`.

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

## BL-168: A backup restored on a second computer

- Status: `blocked` (external-world wait — a second computer to restore on)
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-013 §Backup Policy](./specs/013-persistence-and-recovery.md#backup-policy) (a restore on another computer reads the backup directly), [Plan-005](./plans/005-local-ipc-and-daemon-control.md) T-005r-1-13 and T-005r-3-20
- Summary: A backup holds no credential and no key, so it is meant to restore on any computer, after which the person signs in to providers and links devices again. That has been designed and not measured: no run has restored a backup taken on one machine onto another.
- V1 Release Impact: none for a restore on the machine that wrote the backup; a restore on another computer ships designed but unmeasured until this closes.
- Named gate: a second computer in the build loop.
- Exit Criteria: a backup taken on one machine is restored on a second with `sidekicks data restore`, the sessions read back whole, the providers ask to sign in and the devices to link, and the figures are recorded in Plan-005; this entry is deleted.

## BL-170: Sätteri parsing seven markdown cases as CommonMark and GFM do

- Status: `blocked` (external-world wait — a Sätteri release carrying the parser fix)
- Priority: `P3`
- Owner: `unassigned`
- References: [Desktop App Implementation Notes §Console Libraries](./architecture/desktop-implementation-notes.md#console-libraries) (the Streaming markdown row), [bruits/satteri#326](https://github.com/bruits/satteri/issues/326) (the seven cases), [bruits/satteri#327](https://github.com/bruits/satteri/pull/327) (the fix)
- Summary: The app parses replies with Sätteri 0.10.5, built from the release's source with one fix of the app's own ([BL-174](#bl-174-sätteri-keeping-an-indented-code-block-whole-after-the-line-that-closed-a-list)). Seven cases parse differently from CommonMark and remark-gfm: emphasis flanking, task lists, footnotes and autolinks. A reply holding one of them can draw differently from how another CommonMark renderer draws it. The app carries no change for them; it waits for a release.
- V1 Release Impact: the seven cases draw as Sätteri 0.10.5 reads them until a release carries the fix.
- Named gate: a Sätteri release carrying bruits/satteri#327.
- Exit Criteria: that release is taken by the app's package and, in the same release bump, by the service's Sätteri parser; the seven cases of bruits/satteri#326 parse as CommonMark and remark-gfm do; this entry is deleted.

## BL-171: Sätteri's browser loader taking an already compiled parser

- Status: `blocked` (external-world wait — a Sätteri release carrying the loader change)
- Priority: `P3`
- Owner: `unassigned`
- References: [Desktop App Implementation Notes §Console Libraries](./architecture/desktop-implementation-notes.md#console-libraries) (the Streaming markdown row), [bruits/satteri#329](https://github.com/bruits/satteri/pull/329) (the change)
- Summary: `patches/@bruits__satteri-wasm32-wasi@0.10.5.patch` makes the WebAssembly build's browser loader use the parser module the first markdown worker compiled, read from the global `satteriWasmModule`, instead of fetching and compiling its own. Each later worker is handed that module, and the page sets the same global to the module the worker posts to it before it loads its own parser ([ADR-043](./decisions/043-long-replies-parsed-on-screen-and-held-packed.md)). bruits/satteri#329 adds the same thing upstream under the global `__SATTERI_WASM_MODULE__`. The same patch makes the Node loader, which the renderer's unit tests run, take its module from that global too; that half carries the app's own parser build ([BL-174](#bl-174-sätteri-keeping-an-indented-code-block-whole-after-the-line-that-closed-a-list)), which bruits/satteri#329 does not touch.
- V1 Release Impact: none; the patch carries the behavior until a release does.
- Named gate: a Sätteri release carrying bruits/satteri#329.
- Exit Criteria: that release is taken; the browser loader's half of the patch is deleted, and the patch and its `patchedDependencies` entry with it once BL-174 has closed; `apps/desktop/src/renderer/src/components/Markdown/worker/entry.ts` and the page's parser loader, `apps/desktop/src/renderer/src/components/Markdown/parse/page-parser.ts`, hand the module under `__SATTERI_WASM_MODULE__` in place of `satteriWasmModule`, and `apps/desktop/tests/e2e/webassembly-worker-policy.test.ts` waits for it under that name; this entry is deleted.

## BL-172: Sätteri exporting its tree reader, materializer and walk on their own

- Status: `blocked` (external-world wait — a Sätteri release carrying the exports)
- Priority: `P3`
- Owner: `unassigned`
- References: [Desktop App Implementation Notes §Console Libraries](./architecture/desktop-implementation-notes.md#console-libraries) (the Streaming markdown row), [bruits/satteri#330](https://github.com/bruits/satteri/pull/330) (the change)
- Summary: `patches/satteri@0.10.5.patch` exports the `satteri/mdast-reader` and `satteri/mdast-materializer` subpaths, which the page reads the worker's binary trees with: the streaming tail, a long table's pieces, and a block too long for the page to parse. The page also runs its own parser, loaded on its own lazy chunk at idle; through the subpaths, reading a worker's tree needs neither that chunk nor the parser, so it works before the page's parser is ready ([ADR-043](./decisions/043-long-replies-parsed-on-screen-and-held-packed.md)). The patch also exports `walkMdastHandle` from the package's main entry, which the parser's cut reads each top-level block's position with, on the page or in the markdown worker, without copying the whole tree out. bruits/satteri#330 adds the subpath exports and the `walkMdastHandle` export upstream.
- V1 Release Impact: none; the patch carries the exports until a release does.
- Named gate: a Sätteri release carrying bruits/satteri#330.
- Exit Criteria: that release is taken; the patch and its `patchedDependencies` entry are deleted; this entry is deleted.

## BL-173: xterm.js drawing block, box and Powerline glyphs in its DOM renderer

- Status: `blocked` (external-world wait — an `@xterm/xterm` release whose DOM renderer draws block elements, box drawing and the Powerline symbols)
- Priority: `P3`
- Owner: `unassigned`
- References: [Desktop App Implementation Notes §Console Libraries](./architecture/desktop-implementation-notes.md#console-libraries) (the Terminal row), [xtermjs/xterm.js#6224](https://github.com/xtermjs/xterm.js/issues/6224) (the issue)
- Summary: `patches/@xterm__xterm@6.0.0.patch` makes the DOM renderer draw block elements, box drawing and the Powerline symbols (U+E0A0–E0A2 and U+E0B0–E0BF) in each cell's text color, from the WebGL addon's shape tables, where 6.0.0 takes them from the font: a block glyph leaves a seam between rows, and the app's mono faces carry no Powerline symbols. `customGlyphs` reaches only the WebGL renderer. xtermjs/xterm.js#6224 asks upstream for block elements and box drawing only, so a release fixing it alone leaves the Powerline symbols to the patch.
- V1 Release Impact: none; the patch carries the behavior until a release does.
- Named gate: an `@xterm/xterm` release whose DOM renderer draws block elements, box drawing and the Powerline symbols itself.
- Exit Criteria: that release is taken; the patch and its `patchedDependencies` entry are deleted; `apps/desktop/tests/browser/terminal-pane/grid.test.ts` still passes drawn by the DOM renderer, and a Powerline prompt drawn by it shows no missing-glyph box; this entry is deleted.

## BL-174: Sätteri keeping an indented code block whole after the line that closed a list

- Status: `blocked` (external-world wait — a Sätteri release carrying the fix)
- Priority: `P3`
- Owner: `unassigned`
- References: [Desktop App Implementation Notes §Console Libraries](./architecture/desktop-implementation-notes.md#console-libraries) (the Streaming markdown row)
- Summary: Sätteri 0.10.5 ends an indented code block after its first line when an earlier line closed a list item or a blockquote and held another block, so `- a\n\n\n***\n    code\n\n    more\n` parses as two code blocks where CommonMark reads one. `packages/markdown-parser` builds the parser's WebAssembly module from the archive of one commit on the user's fork that adds the fix to the release, checked against a pinned SHA-256, and the Cargo workspace's `[patch.crates-io]` reads `satteri-pulldown-cmark` from the same commit; and the markdown worker compiles that module in place of the npm package's. `patches/@bruits__satteri-wasm32-wasi@0.10.5.patch` makes the Node loader read the same module from `satteriWasmModule`, and the renderer's unit tier forces that loader over the native build, so no test parses with the release's module. The fix is not sent upstream.
- V1 Release Impact: none; the package carries the fix until a release does.
- Named gate: a Sätteri release carrying the fix.
- Exit Criteria: that release is taken, and every reference to `packages/markdown-parser` and to `apps/desktop/tests/helpers/markdown-parser-module.ts`, the setup file that sets the global `satteriWasmModule` for the renderer's unit tier, is gone: the package and its lockfile entries; the desktop's dependency on it, and `apps/desktop/src/renderer/src/components/Markdown/worker/entry.ts` compiles the npm package's module again; the package's entry in `apps/desktop/build/third-party-notices.ts`; `inThreadParserModule()` in `apps/desktop/src/renderer/src/components/Markdown/worker/connection.test-support.ts` stops reading that global; the setup file, its `setupFiles` line and `NAPI_RS_FORCE_WASI` in `apps/desktop/vitest/tier-projects.ts`, and its include in `apps/desktop/tsconfig.electron-test.json`; the Node loader's half of the Sätteri patch; the package's `knip.json` workspace and its lines in `.prettierignore` and `eslint.config.mjs`; the `satteri-pulldown-cmark` lines of the root `Cargo.toml`'s `[patch.crates-io]` and the fork's `allow-git` entry in `deny.toml`; the `markdown-parser` scope in `commitlint.config.mjs` and `CONTRIBUTING.md`; its mentions in `AGENTS.md` and `packages/AGENTS.md`; the `ci.yml` step that installs its Rust and the anchor every desktop job repeats it through, and the markdown parser in the comment on the `tools/wasm-dist.ts` path filter; the renderer tests in the `pnpm-workspace.yaml` comment on the `wasm32` architecture; the Streaming markdown row's sentence on the package in `docs/architecture/desktop-implementation-notes.md`; the `tools/wasm-dist.ts` options only this package uses (`isCrateThirdParty`, `builtModulePath`, `linkedPackageDirectories`), and its fetching of license files from a crate's repository unless another build needs it; this entry is deleted.

## BL-175: `worker-build` building the control plane in debug mode

- Status: `blocked` (external-world wait — a `workers-rs` release carrying the fix for [cloudflare/workers-rs#1086](https://github.com/cloudflare/workers-rs/issues/1086))
- Priority: `P3`
- Owner: `unassigned`
- References: [ADR-013](./decisions/013-control-plane-api.md) (the control plane on `axum` and `worker`), [cloudflare/workers-rs#1086](https://github.com/cloudflare/workers-rs/issues/1086) (the report)
- Summary: The control plane's Worker is built by `worker-build`'s release profile, local runs included. A `--dev` build panics in `worker::Delay` from compatibility date 2026-08-04, because `setTimeout` there returns a Node `Timeout` object; release builds and production are unaffected.
- Named gate: a `workers-rs` release that fixes the debug build. Nothing in-tree blocks.
- Exit Criteria: (a) the control plane on that release; (b) the release-only build removed, so a local run may use a debug build; (c) until then, each newest-release pass checks cloudflare/workers-rs#1086's state.

## BL-176: `worker-build` reading an npm manifest in the crate root

- Status: `blocked` (external-world wait — a `workers-rs` release carrying the fix for [cloudflare/workers-rs#1087](https://github.com/cloudflare/workers-rs/issues/1087))
- Priority: `P3`
- Owner: `unassigned`
- References: [ADR-013](./decisions/013-control-plane-api.md) (the control plane on `axum` and `worker`), [cloudflare/workers-rs#1087](https://github.com/cloudflare/workers-rs/issues/1087) (the report)
- Summary: The control plane's Worker needs an npm manifest for its passkey module, and `worker-build` fails when the crate folder holds a `package.json` with dependencies (`invalid type: map, expected a string`), because it reads the manifest wasm-bindgen copies as a flat map of names to versions. The control plane keeps its npm manifest outside the crate root.
- Named gate: a `workers-rs` release that reads such a manifest. Nothing in-tree blocks.
- Exit Criteria: (a) the control plane on that release; (b) the workaround removed, so the npm manifest may sit in the crate root; (c) until then, each newest-release pass checks cloudflare/workers-rs#1087's state.

## BL-177: mimalloc on Windows

- Status: `blocked` (external-world wait — a `libmimalloc-sys` release bundling mimalloc 3.4.0 or newer, which [purpleprotocol/mimalloc_rust#169](https://github.com/purpleprotocol/mimalloc_rust/pull/169) carries)
- Priority: `P3`
- Owner: `unassigned`
- References: [purpleprotocol/mimalloc_rust#169](https://github.com/purpleprotocol/mimalloc_rust/pull/169) (the bump to mimalloc 3.4.0)
- Summary: The service and its modes run on mimalloc on macOS and Linux and on the system allocator on Windows, because the mimalloc 3.3.2 that `libmimalloc-sys` bundles crashes on x64 processors without the POPCNT instruction, which Chrome's SSE3 floor still admits. The allocator choice lives in `sidekicks-platforms`.
- Named gate: a `libmimalloc-sys` release that bundles mimalloc 3.4.0 or newer. Nothing in-tree blocks.
- Exit Criteria: (a) the service on that release; (b) mimalloc running on Windows, the system-allocator branch removed; (c) until then, each newest-release pass checks the pull request's state with `gh pr view 169 -R purpleprotocol/mimalloc_rust`.
