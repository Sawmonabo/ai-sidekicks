# ADR-021: V1 Toolchain Selection

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 2 (one-way door)` |
| **Domain**    | `Build / Tooling`       |
| **Date**      | `2026-04-26`            |
| **Author(s)** | `Claude (AI-assisted)`  |
| **Reviewers** | `Accepted 2026-04-26`   |

## Context

[Container Architecture §Implementation Topology](../architecture/container-architecture.md#implementation-topology) gives the workspace shape: the Rust crates under `crates/` (`sidekicks-daemon`, `sidekicks-cli`, `sidekicks-contracts`, `sidekicks-client`, `sidekicks-control-plane`, `sidekicks-search`, `sidekicks-terminal`, `sidekicks-compression` and `sidekicks-platforms`), and the TypeScript that stays, `apps/desktop/` and the `packages/` that are each the TypeScript face of a crate (`contracts`, `client-sdk`, `compression`, `search-ranking`) plus `markdown-parser`. [Plan-001](../plans/001-session-core.md) is the first plan built on the toolchain and owns the one schema of each database, the daemon's and the control plane's, to which Plans 004, 015, 019 and 025 add their tables and columns.

Constraints from accepted ADRs:

- [ADR-015](./015-electron-desktop-app.md) — Electron 44.x, whose bundled Node (24.21) runs the app's main process and renderer; the daemon client runs there as the Rust client's Node-API addon.
- [ADR-004](./004-sqlite-local-state-and-postgres-control-plane.md) — SQLite for local execution (`session_events`, `session_snapshots`), Postgres for shared state.
- [ADR-013](./013-control-plane-api.md) — `axum` on `worker` for the Control Plane.
- [ADR-009](./009-json-rpc-ipc-wire-format.md) — JSON-RPC 2.0 in the frame codec for daemon IPC.
- [ADR-017](./017-cross-version-compatibility.md) — semver `MAJOR.MINOR` versions, with the app and the service agreeing a version range at the handshake; the toolchain pin and the `engines` declarations set the toolchain floors.

The implementer is Claude Opus 4.7 (AI-implementation economics outweigh human-DX arguments). Multi-year maintenance horizon. Reversal cost is high once Plan-001 ships and later plans bind to the toolchain.

## Problem Statement

What toolchain, workspace, quality and database-driver primitives should V1 use, for the Rust crates and for the TypeScript that stays, so Plan-001 implementation can begin against a decided toolchain — and so downstream plans (003/006/018/022 in particular) inherit a coherent build surface?

### Trigger

Plan-001 builds on the toolchain, so the toolchain is chosen first, each primitive against primary sources.

---

## Decision

We will adopt the following V1 toolchain. Every choice is forward-declared as the V1 default; section [Re-evaluation Triggers](#re-evaluation-triggers) names the criteria that would reopen each.

| Primitive | Choice | Version |
| --- | --- | --- |
| Rust toolchain | **One exact stable release**, pinned in the root `rust-toolchain.toml` (profile `minimal`, components `rustfmt` and `clippy`, target `wasm32-unknown-unknown` for `sidekicks-compression` and the WebAssembly builds), with `rust-version` naming the same release. CI runs `rustup toolchain install` with no arguments once, before any Turbo or Cargo step, so it installs what the file names, and sets `RUSTUP_AUTO_INSTALL=0`, so parallel Cargo runs never race to install it. Each new stable moves the pin in its own PR, which fixes every lint it brings | 1.99.0 |
| Cargo workspace | **A virtual workspace**, `members = ["crates/*"]`, `resolver = "3"`; edition 2024, `rust-version`, license and `publish = false` in `[workspace.package]`; every dependency version once in `[workspace.dependencies]`, internal crates by path; lints once in `[workspace.lints]`, each crate writing `[lints] workspace = true`; `[profile.wasm-release]` (`panic = "abort"`, LTO, one codegen unit, `strip`) for the WebAssembly builds | edition 2024, resolver 3 |
| Build orchestrator | **Turborepo**, driving Cargo through its Cargo support beside the pnpm packages: no `package.json` in any crate, no folder both a crate and a pnpm package, the root `Cargo.toml` naming the workspace `sidekicks-crates` in `[workspace.metadata]`, `$TURBO_DEFAULT$` in the shared `build` and `lint` inputs, `CARGO_BUILD_WARNINGS` in `globalEnv`, `"cache": false` on `sidekicks-crates#test`, and a crate a pnpm package compiles to WebAssembly carrying `"command": null`. A remote cache backed by the GitHub Actions cache (`rharkor/caching-for-turbo`), signed artifacts, telemetry disabled. The cache is GitHub-hosted rather than self-hosted: what self-hosting bought was independence from a vendor who could relicense the service, and a GitHub Actions cache artifact is subject to no such relicensing, so the property is preserved by a different mechanism | 2.11.7 exact |
| Package manager | **pnpm** for the TypeScript that stays, with `nodeLinker: isolated`, workspace catalogs, `allowBuilds` allowlist, and `minimumReleaseAge: 1440` as the supply-chain guard — a resolution-time filter over a package's published-at, so it refuses a freshly published version whether the spec is exact or a range. Crates take the same one-day hold: every crate in the lock through Cargo's `registry.global-min-publish-age`, from the toolchain whose Cargo supports it, and a direct bump through Renovate's `minimumReleaseAge` | pnpm 10.33+ |
| Formatters | **rustfmt** with `edition` and `style_edition = "2024"` and nothing else (100 columns, 4 spaces; imports in three groups by hand); `pnpm format` also runs `cargo fmt --all`. **Tombi** for TOML, `line-width = 100` | rustfmt from the pin; Tombi 1.8+ |
| Rust lints | **Clippy** `pedantic` on, with `must_use_candidate`, `missing_errors_doc`, `missing_panics_doc`, `too_many_lines` and `similar_names` allowed, plus restriction lints matched to `AGENTS.md`'s rules (`wildcard_enum_match_arm`, `unwrap_used`, `allow_attributes_without_reason`, `mod_module_files`, `missing_docs_in_private_items` scoped to `pub(crate)` items, and the rest); `expect_used`, `indexing_slicing` and `module_name_repetitions` off on purpose. rustc: `unsafe_code` denied; `missing_docs`, `unreachable_pub` and `dead_code_pub_in_binary` warn. A suppression is `#[expect(lint, reason = "…")]`. CI sets `CARGO_BUILD_WARNINGS=deny` and runs each Cargo command with `--keep-going` | Clippy from the pin |
| Errors and logs | **`thiserror`** in library code, **`anyhow`** only in a program's `main`; **`tracing`**, with the daemon's service log written by flexi_logger's `FileLogWriter` under one `tracing-subscriber` fmt layer that also writes to standard error | flexi_logger 0.31.10 |
| Rust tests | **cargo-nextest** (no retries; a `ci` profile, and an `endurance` profile for the one endurance binary) plus `cargo test --doc`, which nextest does not run; unit tests in `#[cfg(test)] mod tests`, one integration binary per crate (`tests/it/main.rs`), `rstest` where cases share a body or a fixture, cross-crate helpers behind a `test-support` feature, `proptest` for parsers, wire decoding and crypto, `insta` only where the snapshot is the behavior, and `cargo mutants --in-diff` on a pull request | nextest 0.9.148+, rstest 0.27.0, cargo-mutants 27.1.0 |
| Unused code, advisories, spelling | **rustc's `dead_code` lints plus `cargo-shear`** (unused and misplaced dependencies and source files no module links); **`cargo-deny`** running only `advisories`, `bans` and `sources`; **`typos`** on code, Rust and TypeScript, with `locale = "en-us"`, documents excluded | cargo-shear 1.14+, cargo-deny 0.20+, typos-cli 1.51+ |
| SQLite binding | **`rusqlite`** with `bundled`, which builds SQLite from `libsqlite3-sys`, WAL at boot, prepared-statement caching for hot paths | 0.40.2 exact (SQLite 3.53.2) |
| Postgres client | On the Worker, **`tokio-postgres`** with `default-features = false, features = ["js"]`, queries only through typed statements (`query_typed`, `execute_typed`, `query_typed_one`, `query_typed_opt`, `batch_execute`) through Hyperdrive, and the schema apply on a second, direct client; on the Compose relay's native program, **`deadpool-postgres`** | tokio-postgres 0.7.18 |
| TypeScript compilation | **`tsc -b`** per package, emitting each package's `.js` and `.d.ts` together; `isolatedModules: true` and `isolatedDeclarations: true` per package | TypeScript 7.0+ |
| TypeScript test runner | **Vitest** with `projects` configuration; **happy-dom + `@testing-library/react`** for renderer component tests (Browser Mode is reserved for assertions that need a real layout engine; Playwright stays the E2E vehicle through Electron's `_electron` harness); the Worker's Durable Object and alarm tests under `@cloudflare/vitest-plugin` | 4.x |
| TypeScript linter + formatter | **ESLint 10 flat-config + typescript-eslint + Prettier 3** | ESLint 10, TS-ESLint 8.71+, Prettier 3 |
| Node target | Node 24.21 or later for the TypeScript that stays, and each package's `engines.node` floor is `>=24.21.0`: the Electron app runs the Node its Electron pin bundles, 24.21 on Electron 44, and the floor is that same release so the app and the packages share one Node. The daemon and the CLI are native programs and need no Node | 24.21+ |
| TS settings | strict, ESM-first (`"type": "module"`), `module: nodenext`, `moduleResolution: nodenext`, `verbatimModuleSyntax: true`; `target: es2024` (Node 24) | TypeScript 7 for the typecheck; 6 for the tools that import it |

Each package's `engines.node: ">=24.21.0"` states the Node floor, and the root's `packageManager` pin, `.nvmrc`, `rust-toolchain.toml` and CI say which versions the repository runs on; the root carries no `engines` install gate.

The CI jobs for `crates/`: `cargo fmt --all -- --check`; `CARGO_BUILD_WARNINGS=deny cargo clippy --workspace --all-targets --all-features --locked --keep-going`; `cargo nextest run --workspace --locked --profile ci` and `cargo test --workspace --doc --locked`; `cargo doc --workspace --no-deps --locked`; `cargo deny check advisories bans sources`; `cargo shear --deny-warnings`; `typos`; `tombi format --check`; `cargo mutants --test-tool=nextest --in-diff` on a pull request; and the regeneration of the TypeScript contracts followed by `git diff --exit-code` after Prettier. Each native leg builds `sidekicks-daemon` with `--locked` for its target, with that target's C toolchain for the crates that compile C or assembly (`aws-lc-sys`, `ring`, `blake3`, `libsqlite3-sys`, `psm`, `rquickjs-sys` and, on macOS and Linux, `libmimalloc-sys`).

### Thesis — Why This Combination

Four integration constraints make these choices reinforce each other rather than stand alone:

1. **One toolchain, read from one file.** An exact pin makes local and CI runs identical: CI installs what `rust-toolchain.toml` names and nothing else, `rust-version` and Clippy's `msrv` follow it, and new lints arrive only in the PR that moves the pin, which fixes them. The `wasm32-unknown-unknown` target sits in the same file, so the WebAssembly builds need no extra step.
2. **One task graph for two languages.** Turbo's Cargo support puts the crates in the same graph as the pnpm packages: a pnpm package that ships a crate's WebAssembly build depends on that crate's `build`, a binary's build and every lint replay from Turbo's cache, and `turbo run build lint test` covers both languages with no `package.json` in any crate.
3. **Checks that are `AGENTS.md`'s rules.** Each repository rule has a standard tool behind it: `wildcard_enum_match_arm` makes a closed set name every arm, `missing_docs` and `missing_docs_in_private_items` hold the docstring rule, `#[expect]` with a reason fails once it stops firing, `cargo-shear` is knip's counterpart down to files no module links, and `typos` with `locale = "en-us"` holds American spelling in code. `CARGO_BUILD_WARNINGS=deny` fails CI on any warning, rustdoc's included, without discarding the build cache.
4. **Tests that stay cheap.** nextest runs each test in its own process, so tests never coordinate global state, and runs with no retries, so a flaky test shows; one integration binary per crate links once instead of once per file, and `cargo test --doc` runs the doctests nextest skips.

The TypeScript that stays keeps its toolchain as the root `package.json` names it. Vitest 4.x with `projects` is the one runner that handles Node-class packages, type-only packages, _and_ the React renderer in one toolchain — the renderer project running under a DOM shim (happy-dom), with Browser Mode (Playwright provider, stable since 4.0 / 2025-10-22) available in the same runner for any assertion that later needs a real layout engine. Vitest runs on Vite 8, whose own Oxc transform strips each file's types, so every project's tests run from source with no build step and no separate TypeScript loader.

The pnpm + Turborepo combination is the empirical default among comparable TypeScript monorepos: vercel/turborepo itself runs `pnpm@10.28.0` + Turbo, trpc/trpc runs `pnpm@10.33.1` + Turbo with `engines.node: "^24.0.0"`, vercel/next.js runs pnpm + Turbo throughout (raw `package.json` reads, 2026-04-26). Among Rust workspaces, ruff, uv and oxc pin their toolchain to an exact release in `rust-toolchain.toml`. Adoption is corroborating evidence, not the primary justification, but it materially de-risks the integration paths we'll need (pnpm v10 lockfile parsing, `workspace:` protocol semantics, Turbo cache-key derivation).

### Antithesis — The Strongest Case Against

A skeptical staff engineer would argue:

- **Bun monorepo collapses the TypeScript toolchain.** Bun 1.3 ships a runtime, package manager, test runner, transpiler, and bundler in one binary; workspace install times beat pnpm in vendor benchmarks. For the TypeScript that stays, the simplest possible stack is Bun for everything, and we are over-architecting by stitching together pnpm + Turbo + Vitest.
- **Oxlint + tsgolint is the modern lint story.** tsgolint covers 59 of 61 typescript-eslint type-aware rules (`oxc.rs/docs/guide/usage/linter/type-aware.html`) at 50–100× ESLint speed. Oxfmt is at Prettier-100% conformance (beta). Choosing ESLint+Prettier in 2026 is the defensive call, not the principal-engineer call.
- **Cargo needs no task runner.** Turbo's Cargo support is marked experimental, and its docs say it "can change at any time"; Cargo already builds the crates in dependency order, so running it directly keeps a moving dependency out of every build.
- **The `stable` channel needs no bump PRs.** Pinning an exact release means a PR every six weeks; the `stable` channel takes each release as it ships.

### Synthesis — Why It Still Holds

- **Bun rejected; re-evaluated on a named trigger.** Bun's official `bun.com/docs/pm/workspaces` page does not surface isolated installs as a primary workspace primitive — independent reporting places isolated-install support in 1.2.x as a CLI flag, but the absence from canonical docs is itself a maturity signal. Turborepo's first-class lockfile support targets pnpm v10/v11 (turbo canary 2.9.7 added pnpm v11 multi-document lockfile parsing) before equivalent Bun lockfile work. Multi-year ecosystem-bet risk on the first-class primitive is the wrong allocation. Re-evaluate when [Re-evaluation Triggers](#re-evaluation-triggers) item 3 fires. Bun as the runtime and package tool of a workflow Code step is a separate choice this does not touch.
- **Oxlint+tsgolint rejected, named criterion documented.** tsgolint is alpha (`oxlint-tsgolint` 0.21.1, 2026-04-22). Oxfmt is beta. ESLint 10 flat-config (GA 2026-02-06) is mature and meets perf bar via `--cache` plus running type-aware rules in CI only (`typescript-eslint.io/troubleshooting/typed-linting/performance`). Migration trigger: when tsgolint reaches 1.0 stable AND Oxfmt reaches 1.0 stable, evaluate migration with `@oxlint/migrate`.
- **Turbo drives Cargo, pinned exactly.** A probe on this repository with turbo 2.11.7 put the crates in one graph beside the pnpm packages, ran a pnpm package's build after a crate's build, and replayed a binary's build and every lint from cache (library builds never cache, by design). Without it the WebAssembly packages would need a second runner to order their builds after the crates'. The experimental label is answered by pinning `turbo` exactly and bumping it in its own PR; if a release breaks the support, CI runs Cargo outside Turbo and the crates need no change.
- **An exact pin, moved every release.** The `stable` channel lets a new release's lints land in an unrelated PR, on CI before anyone's machine; the pin makes each bump one PR that fixes what it brings. Cargo's one-day release-age hold for every crate comes with the toolchain whose Cargo supports it, taken by that bump.
- **One compiler builds every TypeScript package.** Each package builds with `tsc -b` on TypeScript 7, which emits its `.js` and `.d.ts` together, so what the typecheck passes is what ships. `isolatedModules: true` and `isolatedDeclarations: true` stay on, constraining TS source to constructs a per-file emitter handles. The root `package.json` installs TypeScript 7 under the alias `@typescript/native` (`npm:typescript@^7.0.2`), whose `tsc` the builds and typechecks run, and keeps the name `typescript` on TypeScript 6 (`npm:@typescript/typescript6@^6.0.2`), which typescript-eslint and the other tools that import the compiler load.

---

## Alternatives Considered

### Option A: Rust 1.99.0 + Cargo workspace + Turbo + nextest + Clippy + `cargo-shear` + `rusqlite` + `tokio-postgres`; pnpm + Vitest + ESLint+Prettier for the TypeScript (Chosen)

- **What:** Per [Decision](#decision) table.
- **Steel man:** Reinforcing constraints (one pinned toolchain, one task graph across Cargo and pnpm, a standard tool behind each repository rule, cheap tests) all push to the same combination. Adoption-validated by the largest comparable monorepos.
- **Weaknesses:** Two languages' toolchains to maintain; Turbo's Cargo support is experimental; a bump PR every Rust release; ESLint slower than Oxlint.

### Option B: Bun monorepo for the TypeScript (Rejected)

- **What:** Bun 1.3 as runtime + package manager + test runner + bundler + transpiler for the TypeScript that stays.
- **Steel man:** Single binary collapses 5 primitives into 1. Faster install, faster transpile, growing community. Vendor benchmarks beat pnpm cold install.
- **Why rejected:** (a) Bun's isolated-install primitive is not a documented workspace setting on `bun.com/docs/pm/workspaces`; (b) Turborepo's canonical lockfile support targets pnpm v10/v11 ahead of Bun (turbo 2.9.7 multi-doc lockfile support is pnpm-only); (c) Bun has no documented `catalog:` equivalent for workspace dependency unification; (d) Bun's transpiler doesn't emit `.d.ts`, so we'd still need tsc anyway. Multi-year ecosystem-bet risk too high for V1.

### Option C: Nx in place of Turborepo (Rejected)

- **What:** Nx 22.7 as build orchestrator (plugin ecosystem, generators, project-references auto-sync via `@nx/js`).
- **Steel man:** Nx Cloud free Hobby tier (50k credits/mo, 50 contributors) + self-hosted remote caching is **explicitly free** per the official Nx Powerpack announcement (`nx.dev/blog/introducing-nx-powerpack`). Plugin ecosystem auto-syncs `references` arrays in tsconfig.json. Best built-in dependency graph viz.
- **Why rejected:** Nx is heavier (100+ runtime deps vs Turbo's smaller surface) and pulls in opinionated scaffolders we don't need in a greenfield repo. The plugin advantage is real but maps to features (generators, schematics) our workflow doesn't consume. Turbo's smaller surface area + MIT license + open self-host posture, and its Cargo support probed on this repository, are a better fit for a project where AI-implementation economics dominate.

### Option D: Oxlint + Oxfmt + tsgolint as the TypeScript default (Rejected)

- **What:** Replace ESLint+Prettier with the OXC/VoidZero Rust toolchain.
- **Steel man:** 50–100× ESLint speed; tsgolint covers 59/61 typescript-eslint type-aware rules; Oxfmt at 100% Prettier conformance. Single-binary deployment. AI-implementation economics favor the speed.
- **Why rejected:** tsgolint is alpha (`oxlint-tsgolint` 0.21.1 / 2026-04-22); Oxfmt is beta (2026-02-24). A first-class dev-loop primitive on alpha + beta is the wrong risk allocation when ESLint+Prettier are mature and meet the perf bar via `--cache` and CI-only type-aware rules. Re-evaluated per [Re-evaluation Triggers](#re-evaluation-triggers) item 1.

### Option E: Biome 2.4 as combined TypeScript linter+formatter (Rejected)

- **What:** Single Rust binary linter + formatter, monorepo-aware, fast.
- **Steel man:** Single tool replaces ESLint + typescript-eslint + Prettier. Subsecond performance on 10k files. GritQL plugins. v2.x ships type-aware rules.
- **Why rejected:** Type-aware coverage is ~10 rules vs typescript-eslint's 61; flagship `noFloatingPromises` rule "detects ~75% of cases" (Biome's own claim). For a strict-mode TypeScript codebase doing TDD, accepting a 25% miss rate on the single best-supported type-aware rule is too steep. Biome 2026 roadmap (`biomejs.dev/blog/roadmap-2026/`) prioritizes embedded languages, HTML, SCSS, IDE LSP polish — not aggressive type-aware expansion. Plugin system is GritQL-pattern-match-only (no autofix). `useExhaustiveDependencies` rule has documented divergence from `react-hooks/exhaustive-deps` (`biomejs/biome#2149`), which the renderer needs.

### Option F: `cargo-machete` or `cargo-udeps` in place of `cargo-shear` (Rejected)

- **What:** Another unused-dependency finder for the crates.
- **Steel man:** `cargo-machete` is fast; `cargo-udeps` checks through compilation.
- **Why rejected:** `cargo-machete` works "in a fast (yet imprecise) way", and `cargo-udeps` "needs Rust nightly to actually run". Neither reports source files no module links, which `cargo-shear` does, the counterpart of knip's unused-files report.

### Option G: `cargo-audit` for advisories (Rejected)

- **What:** RustSec advisories through `cargo-audit`.
- **Steel man:** The RustSec project's own tool.
- **Why rejected:** `cargo-deny`'s `advisories` check reads the same database, and `cargo-deny` already runs for `bans` and `sources`; two tools for one check is a defect.

### Option H: Taplo for TOML (Rejected)

- **What:** Taplo as the TOML formatter.
- **Steel man:** The longest-used TOML formatter in Rust projects.
- **Why rejected:** Its author wrote in `tamasfe/taplo#715` that he cannot see himself returning to the project; Tombi is active, ships on npm, and has `tombi format --check` for CI.

### Option I: `log`, or `tracing-appender` for the service log (Rejected)

- **What:** The `log` facade in place of `tracing`, or `tracing-appender` writing the service log file.
- **Steel man:** `log` is smaller; `tracing-appender` is the `tracing` project's own file writer.
- **Why rejected:** `tracing` records spans with typed fields, which the service log and its diagnostics read. `tracing-appender` rotates by period only and prunes by count, with no size cap, where flexi_logger's `FileLogWriter` caps each file by size.

---

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Turbo's Cargo support keeps the crates and the pnpm packages in one task graph | Probed on this repository with turbo 2.11.7: one graph, a pnpm package's build after a crate's build, binary builds and lints replayed from cache; three settings required (`$TURBO_DEFAULT$` in the shared `build` and `lint` inputs, `CARGO_BUILD_WARNINGS` in `globalEnv`, `"cache": false` on `sidekicks-crates#test`), without which a crate's hash misses its own `Cargo.toml`, warnings pass, or tests replay | CI and local builds run Cargo outside Turbo; the WebAssembly packages order their builds by script; the crates need no change |
| 2 | Turborepo's MIT license + open remote-cache HTTP API are durable | `github.com/vercel/turborepo/blob/main/LICENSE` (MIT, verified live 2026-04-26); HTTP API spec documented at `turborepo.dev/docs/core-concepts/remote-caching`; multiple self-host implementations exist (`ducktors/turborepo-remote-cache`, `brunojppb/turbo-cache-server`, `Tapico/tapico-turborepo-remote-cache`) | Vercel relicenses or closes the API. Because the cache is not self-hosted, the live exposure is the GitHub Actions cache backend — `rharkor/caching-for-turbo` going unmaintained, or Turborepo retiring the HTTP cache API the action implements. Either is answered by dropping back to local-only caching (a wall-clock loss, not a correctness one) or by standing up one of the self-host implementations named here. |
| 3 | Vitest 4.x's `projects` config covers Node + browser packages in one toolchain | Vitest 4.0 release notes 2025-10-22 (Browser Mode stabilized); `vitest.dev/guide/projects` (replaced workspaces in 3.2 / June 2025); Browser Mode supports Playwright/WebDriverIO/preview providers. **Holds in the tree:** the `renderer` project runs happy-dom + `@testing-library/react` and the `main-unit` project runs Node, in one config | The `projects` mechanism itself regresses (the assumption's real subject) — split into per-package runner configs. A DOM-shim shortfall is NOT this failure: it escalates to Browser Mode in the same runner, no toolchain change |
| 4 | `rusqlite`'s bundled SQLite builds on every V1 target with that target's C toolchain | `rusqlite` 0.40.2 with `bundled` builds SQLite 3.53.2 from `libsqlite3-sys` 0.38.2 through `cc`; each native CI leg builds `sidekicks-daemon` with `--locked` for its target | A leg without a C toolchain cannot build the daemon; that leg takes its target's toolchain (MSVC on Windows, clang-cl on Windows on ARM) |
| 5 | Node 24 receives security patches through 2028-04-30 | `endoflife.date/nodejs`: Node 24 Active LTS through 2026-10, then Maintenance through 2028-04-30 (the Node.js release schedule row under Research Conducted) | Node 24 EOL accelerates; move the Electron pin to a release that bundles a supported Node, and the packages' floor with it |
| 6 | `isolatedDeclarations: true` with `tsc -b` on TypeScript 7 emits each package's declarations correctly | TS 5.5 `isolatedDeclarations` proposal `microsoft/TypeScript#47947`; tsgo readme at `github.com/microsoft/typescript-go` documents `isolatedDeclarations`-friendly emit | a package's emitted declarations fail a consumer's typecheck; `pnpm typecheck` stops the change before it merges |
| 7 | `require(esm)` is stable on Node 22.12+ | Joyee Cheung's primary-source post 2025-12-30 (Node TSC member); unflagged in Node 22.12.0 / 20.19.0 late 2025; formally Stable in Node 25.4.0 | Top-level-await ESM modules can't be `require()`'d (still true and acceptable — our code has no TLA) |
| 8 | typescript-eslint 8.71+ type-aware rules meet our perf bar via `--cache` and CI-only execution under ESLint 10 | `typescript-eslint.io/troubleshooting/typed-linting/performance` (canonical perf guide); ESLint `--cache` cuts repeat runs to a fraction; type-aware rules can be config-gated to CI; `typescript-eslint.io/users/dependency-versions` confirms `^10.0.0` officially supported by typescript-eslint 8.x | Lint runtime exceeds tolerable CI minutes on a 50k-LOC monorepo; migrate to Oxlint+tsgolint ahead of Re-evaluation Trigger 1 |
| 9 | `CARGO_BUILD_WARNINGS=deny` fails CI on any warning without discarding the build cache | Stabilized in Cargo 1.97; Clippy prefers it to `-D warnings` because it "has the benefit of not invalidating build caches"; it covers `cargo doc`, so an unresolved doc link fails it, even replayed from cache | Warnings pass CI; CI sets `-D warnings` through `RUSTFLAGS` and accepts the cache loss |
| 10 | `tokio-postgres` with its `js` feature reaches Postgres from the Worker through Hyperdrive | Measured in the full Worker: typed (unnamed) statements through Hyperdrive with caching off for authentication reads; the schema apply on a second, direct client keeping `pg_advisory_xact_lock`, since Hyperdrive lists advisory locks unsupported | Named statements or a custom column type would make the driver prepare statements Hyperdrive supports only for other drivers; the queries stay on typed statements and built-in column types |

---

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A Turbo release changes or breaks its Cargo support | Med | Medium | `turbo run` fails, or a crate's hash misses its own `Cargo.toml` | `turbo` pinned exactly and bumped in its own PR; CI falls back to running Cargo outside Turbo |
| A new Rust stable brings lints the workspace fails | High | Low | The bump PR's CI | The pin moves in its own PR, which fixes every lint it brings |
| Parallel Cargo runs race to install the toolchain | Med | Low | Interleaved rustup installs in CI | `rustup toolchain install` runs once before any Cargo step, with `RUSTUP_AUTO_INSTALL=0` so a missing toolchain fails at once |
| A crate that compiles C or assembly fails on one native leg | Med | Medium | That leg's `sidekicks-daemon` build | Each leg carries its target's C toolchain: MSVC and NASM (or `aws-lc-rs`' prebuilt NASM objects) on Windows, clang-cl on ARM64 |
| A RustSec advisory lands on a crate the lock holds | Med | Medium–High | `cargo deny check advisories` in CI | Take the fixed release; a yanked crate is denied |
| Turborepo retires the open remote-cache HTTP API | Low | Medium | Vercel announcement; `turbo.json` schema breaks; the `rharkor/caching-for-turbo` proxy stops serving | Fall back to local-only caching, or stand up `ducktors/turborepo-remote-cache`, or migrate to Nx self-host (also free per Powerpack announcement). |
| Vitest 4.x renderer environment regresses (happy-dom shim or, where used, Browser Mode) | Med | Medium | Renderer test suite fails after a Vitest or happy-dom update | Pin Vitest and happy-dom minors; escalate the `renderer` project to Browser Mode (Playwright provider, already supported by the same runner) — or fall back to Playwright Component Testing if the `projects` mechanism itself is at fault |
| typescript-eslint perf becomes intolerable | Med | Low–Medium | CI lint stage > 5 min; developer-feedback friction | Earlier migration to Oxlint + tsgolint (Re-evaluation Trigger 1); reduce type-aware rule set in interim |
| Node 24 EOL accelerates ahead of 2028-04 | Low | High | nodejs/Release schedule update | Move the Electron pin to a release that bundles the next supported LTS line, and the packages' floor with it |
| ESM `require()` regresses on Node 24 | Very Low | High | `require(esm)` calls throw at runtime | Restore explicit dynamic `import()` pattern; bisect Node release |

---

## Reversibility Assessment

- **Reversal cost:** Medium-to-high. Per-primitive switching cost varies: a Rust toolchain bump is one file and the lints it brings; build-orchestrator swap (≈ 1 day, `turbo.json` → `nx.json`, or Cargo run outside Turbo); test-runner swap for the TypeScript (≈ 2–3 days, test-API rewrites); linter swap (≈ 1 day with migration tooling); package-manager swap (≈ 1–2 days, lockfile + CI rewrite); SQLite or Postgres driver swap (the queries move with it, behind the daemon's and the control plane's own modules).
- **Blast radius:** Every crate and package, every CI pipeline, all dev environments, all release artifacts.
- **Migration path:** Adopt the new primitive in a feature branch; rebuild the lockfile; swap CI. For the package manager and the test runners specifically, the migration is invasive: every package's lockfile entries, scripts or tests move with it.
- **Point of no return:** After Plan-001 lands and Plans 004, 015, 019 and 025 build on the one schema and the drivers. This ADR sets the floor before that boundary is crossed.

---

## Consequences

### Positive

- One pinned toolchain, read by every machine and every CI job from one file, with each new release's lints fixed in one PR.
- One task graph across Cargo and pnpm, so the WebAssembly packages build after their crates and lints replay from cache.
- A standard tool behind each repository rule: Clippy for closed sets and docstrings, `cargo-shear` for unused code, `typos` for American spelling, `cargo-deny` for advisories and sources.
- Empirical adoption-validated stack (pnpm + Turbo) confirmed in vercel/turborepo's own repo, trpc/trpc, vercel/next.js (raw `package.json` reads, 2026-04-26).
- Strong type-aware lint coverage for the TypeScript from day one (typescript-eslint full 61-rule set vs Biome's ~10).
- `rusqlite` builds SQLite from source into the daemon, so every platform runs the same SQLite release with no prebuilt binding to match to a runtime.
- `isolatedDeclarations: true` keeps every TypeScript package's declarations emittable file by file, which is what lets TypeScript 7 emit them in parallel.

### Negative (accepted trade-offs)

- Two languages' toolchains to maintain, and a Rust bump PR every release.
- Turbo's Cargo support is experimental; the exact pin and a fallback to plain Cargo bound the exposure.
- Every native CI leg needs its target's C toolchain for the crates that compile C or assembly.
- ESLint runtime cost vs Oxlint speed (~45 s vs ~0.5 s on 10k files per pkgpulse 2026 benchmark; pinning ESLint 10 inherits the same general perf profile as ESLint 9). Mitigation: `--cache` for repeat runs; type-aware rules in CI only; the named migration trigger (Re-evaluation Trigger 1).
- pnpm symlink layout learning curve (`node_modules/.pnpm/<pkg>/`). Acceptable in an AI-implementer-led project where the model has high familiarity with isolated layouts.
- Turbo telemetry-on-by-default requires explicit `TURBO_TELEMETRY_DISABLED=1` plumbing in CI and dev-env docs.
- Apache-2.0 OSS posture (per [ADR-019](./019-v1-deployment-model-and-oss-license.md)) is compatible with all primitive licenses (MIT for pnpm/Turbo/Vitest/ESLint/Prettier; MIT or Apache-2.0 for the Rust toolchain and the Cargo tools; MIT for `rusqlite` and `tokio-postgres`).

### Unknowns

- When Oxlint + tsgolint reach 1.0 stable. The migration path is then `@oxlint/migrate` plus tsgolint config; until then the TypeScript lints with ESLint.
- When typescript-eslint and the other tools that import the compiler run on TypeScript 7, so the TypeScript 6 install they use can go (Re-evaluation Trigger 2).
- Whether Bun closes the workspace-protocol and Turborepo lockfile parity gap. Bun's ecosystem velocity is high, and closing that gap would make it the right re-evaluation candidate.
- When Turbo's Cargo support leaves its experimental label (Re-evaluation Trigger 6).

---

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| A plan builds without integration friction across all primitives | Every acceptance criterion of the plan passes with the ADR-021 toolchain unchanged | Each task's acceptance in the plan | When each plan's last phase lands |
| Hot-build under target (single-package or single-crate change) | < 30 seconds from save to test result | Local `turbo watch` + Vitest watch, or `cargo nextest run` on the changed crate | At each toolchain version change |
| `sidekicks-daemon` builds on every V1 platform | On macOS x64/arm64, Linux x64/arm64 (glibc and musl) and Windows x64/arm64, `sidekicks-daemon` builds with `--locked`, the bundled SQLite and its `.recover` shell included, and repairs the damaged-database fixture through its `sqlite-shell` mode | CI native-leg matrix | Each CI run |

---

## Re-evaluation Triggers

Each of the following events triggers a re-evaluation of the named primitive:

1. **Oxlint+tsgolint stabilization** — when tsgolint reaches 1.0 stable AND Oxfmt reaches 1.0 stable, evaluate ESLint+Prettier → Oxlint+Oxfmt+tsgolint migration with `@oxlint/migrate`.
2. **TypeScript 7 for the tools** — when typescript-eslint and the other tools that import the compiler run on TypeScript 7, evaluate dropping the TypeScript 6 install they use, so one compiler serves the typecheck, the build and the tools.
3. **Bun workspace + Turborepo lockfile parity** — when Bun publishes documented isolated-install workspace primitive AND Turborepo gains first-class Bun lockfile support (parity with current pnpm v10/v11 multi-document parsing), evaluate pnpm → Bun migration.
4. **pnpm 11.0 stable with `minimumReleaseAge` default** — upgrade from pnpm 10 to pnpm 11 as soon as the supply-chain default flips.
5. **A Rust release whose Cargo holds every crate a day** — Rust 1.100.0's Cargo is the first with `registry.global-min-publish-age`; the pin's bump to it turns the hold on for every crate in the lock.
6. **Turbo's Cargo support leaves experimental, or breaks** — when Turborepo marks it stable, the exact `turbo` pin may loosen; when a release breaks it, evaluate running Cargo outside Turbo.
7. **Node 26 ships under new release cadence** — Node 27 onwards (April 2027) every release becomes LTS-eligible per `nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule`. Re-evaluate the TypeScript packages' Node floor under the new cadence.
8. **Electron drops Chromium-based renderer or `contextBridge`** — separately re-evaluates ADR-015, but cascades to ADR-021 by changing the Node the desktop and the TypeScript packages run on.

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| pnpm settings reference | Documentation | `nodeLinker: isolated` (v10 default), `allowBuilds` allowlist (v10.26+) replaces deprecated `onlyBuiltDependencies`, `minimumReleaseAge` (v10.16+; default in v11 RC) | <https://pnpm.io/settings> |
| pnpm catalogs | Documentation | `catalog:` protocol since v9.5; `catalogMode` v10.12; `cleanupUnusedCatalogs` v10.15 — workspace-wide dependency version unification | <https://pnpm.io/catalogs> |
| pnpm releases | Documentation | pnpm 10.33.2 stable (verified 2026-04-26 via npm registry); pnpm 11.0.0-rc.5 (2026-04-21) defaults `minimumReleaseAge` and adds `blockExoticSubdeps` | <https://github.com/pnpm/pnpm/releases> |
| Turborepo MIT license | Primary source | License confirmed MIT, read 2026-04-26 (not MPL); self-host posture is durable | <https://github.com/vercel/turborepo/blob/main/LICENSE> |
| Turborepo remote caching | Documentation | Open HTTP API; `TURBO_REMOTE_CACHE_SIGNATURE_KEY` for HMAC-SHA256 signed artifacts | <https://turborepo.dev/docs/core-concepts/remote-caching> |
| Turborepo telemetry | Documentation | On by default; opt-out via `TURBO_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` | <https://turborepo.dev/docs/telemetry> |
| `ducktors/turborepo-remote-cache` | Self-host implementation | Open-source S3-backed Turbo cache server; the fallback if the GitHub Actions cache backend is ever unavailable | <https://github.com/ducktors/turborepo-remote-cache> |
| Nx Powerpack announcement | Vendor announcement | Confirms Nx self-hosted caching is explicitly free; Nx Cloud paid features are distributed-execution + AI-CI, not core caching | <https://nx.dev/blog/introducing-nx-powerpack> |
| TypeScript project references | Documentation | `composite: true` + `tsc -b` for incremental builds; canonical types-emit path | <https://www.typescriptlang.org/docs/handbook/project-references.html> |
| `microsoft/typescript-go` repo | Repository status | Emit and project references "done"; watch mode still "prototype" with no incremental rechecking | <https://github.com/microsoft/typescript-go> |
| esbuild content-types | Documentation | Confirms esbuild does NOT emit `.d.ts` files; tsc remains the type-emit tool | <https://esbuild.github.io/content-types/> |
| `microsoft/TypeScript#47947` | Proposal | `isolatedDeclarations` flag (TS 5.5+) constrains exports to type-checker-independent shapes — prep for swc/esbuild/tsgo native `.d.ts` emit | <https://github.com/microsoft/TypeScript/issues/47947> |
| TypeScript 5.5 release notes | Documentation | `isolatedDeclarations` reports an error on a file whose exports are not annotated enough to emit declarations without the type checker | <https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-5.html#isolated-declarations> |
| Vitest 4.0 announcement | Vendor announcement | Browser Mode stabilized 2025-10-22 (Playwright/WebDriverIO providers); v8 coverage with Istanbul-grade accuracy | <https://vitest.dev/blog/vitest-4> |
| Vitest projects guide | Documentation | `projects` configuration (replaced `workspace` in 3.2) — single Vitest invocation across multi-package monorepo with merged coverage | <https://vitest.dev/guide/projects> |
| Jest 30 release | Vendor announcement | 37% faster, 77% lower memory in one large TS app; JSDOM 26; native `.mts`/`.cts`; minimum TS 5.4 | <https://jestjs.io/blog/2025/06/04/jest-30/> |
| Node.js test runner reference | Documentation | `node:test` Stability 2 since Node 20; **`--watch` Stability 1 (experimental)**; `--experimental-test-coverage` requires flag; `mock.module()` requires `--experimental-test-module-mocks` | <https://nodejs.org/docs/latest-v24.x/api/test.html> |
| Biome v2 announcement | Vendor announcement | First JS/TS linter with type-aware rules without invoking `tsc`; flagship `noFloatingPromises` covers ~75% of typescript-eslint cases | <https://biomejs.dev/blog/biome-v2/> |
| Biome 2026 roadmap | Vendor announcement | Prioritizes embedded languages, HTML, SCSS, IDE LSP polish — not aggressive type-aware expansion | <https://biomejs.dev/blog/roadmap-2026/> |
| Oxlint 1.0 announcement | Vendor announcement | 50–100× ESLint speed; 500+ ESLint-compatible rules at GA; 720+ rules by 2026-03 | <https://voidzero.dev/posts/announcing-oxlint-1-stable> |
| Oxlint type-aware via tsgolint | Documentation | tsgolint covers **59 of 61** typescript-eslint type-aware rules; runs in <10s where ESLint takes ~1 min | <https://oxc.rs/docs/guide/usage/linter/type-aware.html> |
| Oxfmt beta | Vendor announcement | 100% Prettier conformance at >30× speed; beta announced 2026-02-24 | <https://oxc.rs/blog/2026-02-24-oxfmt-beta> |
| ESLint flat-config evolution | Documentation | `defineConfig()` (March 2025) flattens nested args; flat config default since ESLint 9.0 (April 2024) | <https://eslint.org/blog/2025/03/flat-config-extends-define-config-global-ignores/> |
| ESLint v10.0.0 release announcement | Vendor announcement | GA 2026-02-06 (Nicholas C. Zakas, ESLint TSC); breaking changes: drops Node <20.19.0/21/23 support; `eslintrc` config system fully removed; flat-config-only — strictly aligns with §Decision row 5's flat-config posture | <https://eslint.org/blog/2026/02/eslint-v10.0.0-released/> |
| typescript-eslint dependency-versions matrix | Documentation | typescript-eslint v8.x officially supports ESLint `^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0` — confirms ESLint 10 / TS-ESLint 8.71+ pairing pinned in the workspace `package.json` is supported | <https://typescript-eslint.io/users/dependency-versions> |
| typescript-eslint perf guide | Documentation | `--cache` plus type-aware rules in CI only is the canonical perf strategy for large TS monorepos | <https://typescript-eslint.io/troubleshooting/typed-linting/performance> |
| SQLCipher project | Documentation | Whole-database single-master-key encryption; not used, since nothing in the daemon's database is encrypted by the app | <https://www.zetetic.net/sqlcipher/> |
| Node.js release schedule | Documentation | Node 22 Maintenance LTS through 2027-04-30; Node 24 Active LTS through 2026-10 then Maintenance through 2028-04-30 | <https://endoflife.date/nodejs> |
| Evolving the Node.js Release Schedule | Vendor announcement | Node 26 ships April 2026 (last under legacy odd/even); from Node 27 (April 2027) every release is LTS-eligible | <https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule> |
| `require(esm)` stability (Joyee Cheung) | Primary source (Node TSC member) | Unflagged in Node 22.12.0 / 20.19.0 late 2025; formally Stable in Node 25.4.0; top-level-await ESM still requires dynamic `import()` | <https://joyeecheung.github.io/blog/2025/12/30/require-esm-in-node-js-from-experiment-to-stability/> |
| Microsoft TypeScript Node-Target-Mapping wiki | Primary source | `target: ES2023, lib: ES2023, module: nodenext` for Node 22; `target: ES2024, lib: ES2024, module: nodenext` for Node 24 | <https://github.com/microsoft/TypeScript/wiki/Node-Target-Mapping> |
| TypeScript 5.7 announcement | Vendor announcement | ES2024 target supported; Node 22 compile-cache awareness | <https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/> |
| Adoption-evidence: vercel/turborepo `package.json` | Primary source | `"packageManager": "pnpm@10.28.0"` + Turborepo as task runner | <https://raw.githubusercontent.com/vercel/turborepo/main/package.json> |
| Adoption-evidence: trpc/trpc `package.json` | Primary source | `"packageManager": "pnpm@10.33.1"`, Turborepo, `"engines": { "node": "^24.0.0", "pnpm": "^10.33.1" }` | <https://raw.githubusercontent.com/trpc/trpc/main/package.json> |
| Adoption-evidence: vercel/next.js `package.json` | Primary source | `pnpm` referenced throughout scripts; Turborepo as task runner | <https://raw.githubusercontent.com/vercel/next.js/canary/package.json> |
| Rust 1.99.0 announcement | Vendor announcement | 1.99.0 is the stable release the toolchain pins | <https://blog.rust-lang.org/2026/10/01/Rust-1.99.0/> |
| rustup overrides and profiles | Documentation | `rust-toolchain.toml` names the channel, profile, components and targets; the `minimal` profile installs rustc, rust-std and cargo | <https://rust-lang.github.io/rustup/overrides.html>, <https://rust-lang.github.io/rustup/concepts/profiles.html> |
| Rust release notes | Changelog | Cargo 1.97 stabilizes `build.warnings`, "useful for enforcing a warning-free build in CI, replacing `-Dwarnings`" | <https://raw.githubusercontent.com/rust-lang/rust/master/RELEASES.md> |
| Cargo configuration | Documentation | `build.warnings` = `deny` "emit[s] an error for a crate that has lint warnings", set through `CARGO_BUILD_WARNINGS` | <https://doc.rust-lang.org/cargo/reference/config.html> |
| Cargo workspaces and resolver | Documentation | `[workspace.package]`, `[workspace.dependencies]` and `[workspace.lints]` inherited by members; resolver 3 is edition 2024's default and prefers versions whose `rust-version` the toolchain meets | <https://doc.rust-lang.org/cargo/reference/workspaces.html>, <https://doc.rust-lang.org/cargo/reference/resolver.html> |
| rustfmt style editions | Documentation | `style_edition = "2024"`; `group_imports`, `imports_granularity` and `wrap_comments` are nightly-only | <https://doc.rust-lang.org/edition-guide/rust-2024/rustfmt-style-edition.html>, <https://raw.githubusercontent.com/rust-lang/rustfmt/main/Configurations.md> |
| Clippy README | Documentation | `pedantic` is "rather strict or [has] occasional false positives"; restriction lints are picked one by one, never as a group; `CARGO_BUILD_WARNINGS` "has the benefit of not invalidating build caches" | <https://raw.githubusercontent.com/rust-lang/rust-clippy/master/README.md> |
| Clippy lint list and configuration | Documentation | The restriction lints the workspace turns on; `missing-docs-in-crate-items = true` checks only items visible within the crate, such as `pub(crate)` items | <https://rust-lang.github.io/rust-clippy/stable/index.html>, <https://doc.rust-lang.org/clippy/lint_configuration.html> |
| Turborepo's Rust guide | Documentation | Cargo support is "experimental and can change at any time"; `[workspace.metadata].name` gives the workspace its identity in the graph; library builds default to `cache: false`, and only `bin`, `cdylib` and `staticlib` outputs cache | <https://turborepo.dev/docs/guides/tools/rust> |
| `vercel/turborepo#13283` | Pull request | Turborepo builds its own repository with its Cargo support | <https://github.com/vercel/turborepo/pull/13283> |
| cargo-nextest | Documentation | Runs each test in its own process; configuration profiles; doctests are not run | <https://nexte.st/docs/design/why-process-per-test/>, <https://nexte.st/docs/configuration/> |
| cargo-mutants | Documentation | `--in-diff` mutates only the lines a diff changes | <https://mutants.rs/in-diff.html> |
| cargo-shear README | Repository | Finds unused and misplaced dependencies and source files no module links | <https://raw.githubusercontent.com/Boshen/cargo-shear/main/README.md> |
| cargo-machete README | Repository | Works "in a fast (yet imprecise) way" | <https://raw.githubusercontent.com/bnjbvr/cargo-machete/main/README.md> |
| cargo-udeps README | Repository | Needs Rust nightly to run | <https://raw.githubusercontent.com/est31/cargo-udeps/master/README.md> |
| cargo-deny checks | Documentation | `advisories` reads the RustSec database; `bans` reports duplicate versions and wildcards; `sources` limits where crates come from | <https://embarkstudios.github.io/cargo-deny/cli/check.html> |
| cargo-audit README | Repository | The RustSec project's advisory checker, reading the same database as cargo-deny's `advisories` | <https://raw.githubusercontent.com/rustsec/rustsec/main/cargo-audit/README.md> |
| typos reference | Documentation | `locale = "en-us"` refuses British spellings | <https://raw.githubusercontent.com/crate-ci/typos/master/docs/reference.md> |
| Tombi README | Repository | TOML formatter and linter with `tombi format --check` | <https://raw.githubusercontent.com/tombi-toml/tombi/main/README.md> |
| `tamasfe/taplo#715` | Issue tracker | Taplo's author writes that he cannot see himself returning to the project | <https://github.com/tamasfe/taplo/issues/715> |
| `rusqlite` 0.40.2 | Repository | The `bundled` feature compiles SQLite 3.53.2 from `libsqlite3-sys` | <https://raw.githubusercontent.com/rusqlite/rusqlite/v0.40.2/src/lib.rs> |
| Hyperdrive with `tokio-postgres` | Documentation | `tokio-postgres` with the `js` feature connects from a Rust Worker through Hyperdrive | <https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/rust-postgres/> |
| Hyperdrive supported features | Documentation | Advisory locks are listed as unsupported through the pooler | <https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/> |
| thiserror, anyhow, tracing | Repository | `thiserror` derives library error types; `anyhow` carries errors in applications; `tracing` records spans with typed fields | <https://github.com/dtolnay/thiserror>, <https://github.com/dtolnay/anyhow>, <https://docs.rs/tracing/latest/tracing/> |
| flexi_logger 0.31.10 | Repository | `FileLogWriter` rotates by size and by age | <https://static.crates.io/crates/flexi_logger/flexi_logger-0.31.10.crate> |
| Adoption-evidence: ruff, uv and oxc toolchain files | Primary source | Each pins `channel = "1.99.0"` in `rust-toolchain.toml` | <https://raw.githubusercontent.com/astral-sh/ruff/main/rust-toolchain.toml>, <https://raw.githubusercontent.com/astral-sh/uv/main/rust-toolchain.toml>, <https://raw.githubusercontent.com/oxc-project/oxc/main/rust-toolchain.toml> |
| Electron releases feed | Registry | Electron 44.7.0, the exact pinned release, bundles Node 24.21.0 | <https://releases.electronjs.org/releases.json> |

### Related ADRs

- [ADR-015: Electron Desktop App](./015-electron-desktop-app.md) — sets the Electron pin whose bundled Node the app runs: V1 runs on Electron 44.x, whose bundled Node is 24.21. The packages' `engines.node` floor is `>=24.21.0`, that same bundled Node, which also meets the memory gate's `process.availableMemory()` reading (24.16 or later).
- [ADR-004: SQLite Local State and Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md) — sets the SQLite + Postgres engine pair this ADR selects bindings for.
- [ADR-013: Control Plane API](./013-control-plane-api.md) — the control plane's `axum` on `worker` stack, built by this toolchain's Cargo workspace.
- [ADR-009: JSON-RPC IPC Wire Format](./009-json-rpc-ipc-wire-format.md) — the daemon wire format whose contracts crate and generated TypeScript the toolchain builds.
- [ADR-017: Cross-Version Compatibility](./017-cross-version-compatibility.md) — the version-floor enforcement model this ADR's `engines.*` declarations and toolchain pin participate in.
- [ADR-019: V1 Deployment Model and OSS License](./019-v1-deployment-model-and-oss-license.md) — Apache-2.0 posture that constrains primitive license compatibility (all selected primitives are MIT, Apache-2.0, ISC or BSD-2 compatible).

### Related Plans

- [Plan-001: Session Core](../plans/001-session-core.md) — first consumer of this toolchain; owns the one schema of each database, the daemon's and the control plane's.

### Related Architecture

- [Container Architecture](../architecture/container-architecture.md) — the workspace topology (the `crates/`, `packages/` and `apps/` trees).
