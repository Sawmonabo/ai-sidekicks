# ADR-022: V1 Toolchain Selection

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 2 (one-way door)` |
| **Domain**    | `Build / Tooling`       |
| **Date**      | `2026-04-26`            |
| **Author(s)** | `Claude (AI-assisted)`  |
| **Reviewers** | `Accepted 2026-04-26`   |

## Context

V1 begins with no checked-in code. The repo holds a stub `package.json` (Apache-2.0 licensed) and the docs corpus; [Container Architecture](../architecture/container-architecture.md) §Canonical Implementation Topology is authoritative for the workspace shape (`packages/contracts/`, `packages/client-sdk/`, `packages/runtime-daemon/`, `packages/control-plane/`, `apps/desktop/`, `apps/cli/`). [Plan-001](../plans/001-shared-session-core.md) is the next code-execution gate and owns `0001-initial.sql`, whose column shape is forward-declared into Plan-003/006/018/022.

Constraints already locked by accepted ADRs:

- [ADR-016](./016-electron-desktop-shell.md) — Electron stable branches 39/40/41 → Node 22.x in the renderer + main process.
- [ADR-004](./004-sqlite-local-state-and-postgres-control-plane.md) — SQLite for local execution (`session_events`, `session_snapshots`), Postgres for shared state.
- [ADR-014](./014-trpc-control-plane-api.md) — tRPC v11 for the Collaboration Control Plane.
- [ADR-009](./009-json-rpc-ipc-wire-format.md) — JSON-RPC 2.0 with LSP-style framing for daemon IPC.
- [ADR-018](./018-cross-version-compatibility.md) — semver `MAJOR.MINOR` floor enforced via `sessions.min_client_version` and `engines` declarations.

The implementer is Claude Opus 4.7 (AI-implementation economics outweigh human-DX arguments per project memory). Multi-year maintenance horizon. Greenfield repo means low reversibility cost _today_ but high cost once Plan-001 ships and subsequent plans bind to the toolchain.

## Problem Statement

What workspace, quality, and runtime-driver primitives should V1 lock so Plan-001 implementation can begin against a stable, decided toolchain — and so downstream plans (003/006/018/022 in particular) inherit a coherent build surface?

### Trigger

Plan-001 is approved with `Preconditions` checked. Per [memory `feedback_doc_first_before_coding.md`], code execution requires every governing doc complete; per [memory `feedback_websearch_before_recommendation.md`], primitive choices count as architectural decisions and need primary-source-cited research before being presented. This ADR is the doc-first artifact that closes the gate.

---

## Decision

We will adopt the following V1 toolchain. Every choice is forward-declared as the V1 default; section [Re-evaluation Triggers](#re-evaluation-triggers) names the criteria that would reopen each.

| Primitive | Choice | Version (2026-04-26) |
| --- | --- | --- |
| Package manager | **pnpm** with `nodeLinker: isolated`, workspace catalogs, `allowBuilds` allowlist | 10.33+ |
| Build orchestrator | **Turborepo** with self-hosted remote cache (`ducktors/turborepo-remote-cache` or equivalent), signed artifacts, telemetry disabled | 2.9+ |
| TypeScript compilation | **Hybrid**: `tsc -b --emitDeclarationOnly` for `.d.ts` + **esbuild** for `.js` emit; `isolatedModules: true` and `isolatedDeclarations: true` per package | tsc 5.8+, esbuild 0.28+ |
| Test runner | **Vitest** with `projects` configuration; Browser Mode (Playwright provider) for renderer tests | 4.x |
| Linter + formatter | **ESLint 10 flat-config + typescript-eslint + Prettier 3** for V1 (bumped from ESLint 9 → 10 at PR-time per [Decision Log](#decision-log) 2026-04-26) | ESLint 10, TS-ESLint 8.59+, Prettier 3 |
| SQLite binding | **better-sqlite3** with WAL at boot, prepared-statement caching for hot paths | 12.9+ |
| Postgres client | **pg** (`node-postgres`); `pg-listen` wrapper for LISTEN/NOTIFY | 8.20+ |
| Node target | **Two-tier**: Node 22 Maintenance LTS for daemon + Electron renderer (forced by ADR-016); Node 24 Active LTS for control plane + CLI | 22.12+ / 24.x |
| TS settings | strict, ESM-first (`"type": "module"`), `module: nodenext`, `moduleResolution: nodenext`, `verbatimModuleSyntax: true`; `target: es2023` (Node 22 tier) / `es2024` (Node 24 tier) | TypeScript 5.8+ |

`engines.node` declarations enforce the per-tier floor. `engines.pnpm: "^10.33.0"` enforces the manager floor.

### Thesis — Why This Combination

Three integration constraints make these choices reinforce each other rather than stand alone:

1. **Two-ABI native bindings.** The renderer (Electron 41 main + preload via `electron-v123` ABI) and the daemon (Node 22 native ABI) share `better-sqlite3` source but require different compiled binaries. pnpm's isolated linker is the only manager primitive that keeps each workspace's `node_modules` resolution-scoped, allowing `pnpm rebuild --filter=@ai-sidekicks/desktop better-sqlite3` against Electron headers without disturbing the daemon's Node 22 build (`pnpm/pnpm#9073`, `WiseLibs/better-sqlite3#1393`). Hoisted layouts (npm, Bun default, Yarn `node-modules`) put a single `better-sqlite3` at `node_modules/better-sqlite3` and break one runtime or the other.
2. **Hash-chain BLOB ergonomics.** Spec-006's integrity protocol (`prev_hash`, `row_hash`, `daemon_signature`, `participant_signature`) operates on Buffers — BLAKE3, Ed25519, RFC 8785 JCS canonicalization all consume Node `Buffer`. better-sqlite3 returns BLOBs as `Buffer`; node:sqlite returns `Uint8Array`, requiring an extra `Buffer.from(view)` per read. Across event replay (read-heavy) this is allocation noise we eliminate by binding choice.
3. **Single-toolchain renderer + Node coverage.** Vitest 4.x with `projects` is the only stable runner that handles Node-class packages, type-only packages, _and_ the React renderer in one toolchain via Browser Mode (Playwright provider, stable since 4.0 / 2025-10-22). Pairing Vitest with the existing esbuild dependency from the JS-emit toolchain produces zero-config TS execution everywhere.

The pnpm + Turborepo combination is the empirical default among comparable TypeScript monorepos: vercel/turborepo itself runs `pnpm@10.28.0` + Turbo, trpc/trpc runs `pnpm@10.33.1` + Turbo with `engines.node: "^24.0.0"`, vercel/next.js runs pnpm + Turbo throughout (raw `package.json` reads, 2026-04-26). Adoption is corroborating evidence, not the primary justification, but it materially de-risks the integration paths we'll need (pnpm v10 lockfile parsing, `workspace:` protocol semantics, Turbo cache-key derivation).

### Antithesis — The Strongest Case Against

A skeptical staff engineer would argue:

- **Bun monorepo collapses the toolchain.** Bun 1.3 ships a runtime, package manager, test runner, transpiler, and bundler in one binary. Two-ABI bindings are addressable via `bun install --trust` allowlists; workspace install times beat pnpm in vendor benchmarks. For a greenfield project the simplest possible stack is Bun for everything, and we are over-architecting by stitching together pnpm + Turbo + Vitest + esbuild.
- **Oxlint + tsgolint is the modern lint story.** As of 2026-03, tsgolint covers 59 of 61 typescript-eslint type-aware rules (`oxc.rs/docs/guide/usage/linter/type-aware.html`) at 50–100× ESLint speed. Oxfmt is at Prettier-100% conformance (beta). Choosing ESLint+Prettier in 2026 is the defensive call, not the principal-engineer call.
- **Single Node target everywhere.** Two-tier targeting (Node 22 + Node 24) creates split CI matrices, split Docker images, split `tsconfig.json` ladder. Pin everything to Node 22 — it's still in security support through 2027-04, and the cognitive simplicity is worth the foregone 18 months.
- **`tsc` only, no esbuild.** `tsc -b` with `composite: true` is the simplest TypeScript story. esbuild's lack of `.d.ts` emit means we run two tools per package and risk version drift between what tsc validates and what esbuild emits. One tool is better than two.

### Synthesis — Why It Still Holds

- **Bun rejected for V1, retained as V1.1 candidate.** Bun's official `bun.com/docs/pm/workspaces` page (verified live 2026-04-26) does not surface isolated installs as a primary workspace primitive — independent reporting places isolated-install support in 1.2.x as a CLI flag, but the absence from canonical docs is itself a maturity signal. Turborepo's first-class lockfile support targets pnpm v10/v11 (turbo canary 2.9.7 added pnpm v11 multi-document lockfile parsing) before equivalent Bun lockfile work. Multi-year ecosystem-bet risk on the Tier-1 primitive is the wrong allocation. Re-evaluate at V1.1.
- **Oxlint+tsgolint deferred to V1.1, named criterion documented.** tsgolint is alpha (`oxlint-tsgolint` 0.21.1 as of 2026-04-22). Oxfmt is beta. ESLint 10 flat-config (GA 2026-02-06; bumped from the originally-pinned 9.x at PR-time per [Decision Log](#decision-log)) is mature and meets perf bar via `--cache` plus running type-aware rules in CI only (`typescript-eslint.io/troubleshooting/typed-linting/performance`). Migration trigger: when tsgolint reaches 1.0 stable AND Oxfmt reaches 1.0 stable, evaluate migration with `@oxlint/migrate`.
- **Two-tier Node targeting is free.** Both tiers run `module: nodenext` and `verbatimModuleSyntax: true`; the difference is `target: es2023` vs `es2024` and which `lib` array is imported. Cognitive simplicity argument fails because the _runtime_ split is forced by Electron (we cannot pick Node 24 for the renderer). Given that, picking Node 24 Active LTS for the cloud-side tier captures EOL 2028-04 vs Node 22's EOL 2027-04 — 18 months of upstream security at zero compatibility cost.
- **`tsc` only fails the hot-build budget.** At the scale of an Electron renderer + 5 packages + a daemon, `tsc -b` rebuild cycles are tens of seconds. esbuild emits the same TS-stripped JS in hundreds of milliseconds. The two-tool risk (tsc and esbuild disagreeing on a TypeScript edge case) is bounded by `isolatedModules: true` (mandatory) and `isolatedDeclarations: true` (recommended), which constrain TS source to constructs both tools agree on. Adopting `isolatedDeclarations` now is also the maximally-smooth preparation for tsgo / TypeScript 7 native compiler when it stabilizes.

---

## Alternatives Considered

### Option A: pnpm + Turbo + Vitest + ESLint+Prettier + better-sqlite3 + pg + two-tier Node (Chosen)

- **What:** Per [Decision](#decision) table.
- **Steel man:** Reinforcing constraints (two-ABI bindings, hash-chain BLOB Buffer, single-runner browser+Node coverage) all push to the same combination. Adoption-validated by largest comparable TypeScript monorepos.
- **Weaknesses:** Eight primitive choices to maintain; Turbo telemetry-on-by-default requires explicit opt-out plumbing; ESLint slower than Oxlint; tsc + esbuild dual-tool risk bounded but non-zero.

### Option B: Bun monorepo (Rejected)

- **What:** Bun 1.3 as runtime + package manager + test runner + bundler + transpiler. better-sqlite3 still as binding (Bun-native `bun:sqlite` rejected per research brief).
- **Steel man:** Single binary collapses 5 primitives into 1. Faster install, faster transpile, growing community. Vendor benchmarks beat pnpm cold install.
- **Why rejected:** (a) Bun's isolated-install primitive is not a documented workspace setting on `bun.com/docs/pm/workspaces` as of 2026-04-26, raising integration risk for two-ABI native bindings; (b) Turborepo's canonical lockfile support targets pnpm v10/v11 ahead of Bun (turbo 2.9.7 multi-doc lockfile support is pnpm-only); (c) Bun has no documented `catalog:` equivalent for workspace dependency unification; (d) Bun's transpiler doesn't emit `.d.ts`, so we'd still need tsc anyway. Multi-year ecosystem-bet risk too high for V1.

### Option C: Nx + ESLint + Vitest + better-sqlite3 + pg + Node 22 only (Rejected)

- **What:** Nx 22.7 as build orchestrator (plugin ecosystem, generators, project-references auto-sync via `@nx/js`).
- **Steel man:** Nx Cloud free Hobby tier (50k credits/mo, 50 contributors) + self-hosted remote caching is **explicitly free** per the official Nx Powerpack announcement (`nx.dev/blog/introducing-nx-powerpack`). Plugin ecosystem auto-syncs `references` arrays in tsconfig.json. Best built-in dependency graph viz.
- **Why rejected:** Nx is heavier (100+ runtime deps vs Turbo's smaller surface) and pulls in opinionated scaffolders we don't need in a greenfield repo. The plugin advantage is real but maps to features (generators, schematics) our workflow doesn't consume. Turbo's smaller surface area + MIT license + open self-host posture are a better fit for a project where AI-implementation economics dominate.

### Option D: Oxlint + Oxfmt + tsgolint as V1 default (Rejected — V1.1 candidate)

- **What:** Replace ESLint+Prettier with the OXC/VoidZero Rust toolchain.
- **Steel man:** 50–100× ESLint speed; tsgolint covers 59/61 typescript-eslint type-aware rules; Oxfmt at 100% Prettier conformance. Single-binary deployment. AI-implementation economics favor the speed.
- **Why rejected for V1:** tsgolint is alpha (`oxlint-tsgolint` 0.21.1 / 2026-04-22); Oxfmt is beta (2026-02-24). Tier-1 dev-loop primitive on alpha + beta is the wrong risk allocation when ESLint+Prettier are mature and meet the perf bar via `--cache` and CI-only type-aware rules. Named V1.1 candidate per [Re-evaluation Triggers](#re-evaluation-triggers).

### Option E: Biome 2.4 as combined linter+formatter (Rejected)

- **What:** Single Rust binary linter + formatter, monorepo-aware, fast.
- **Steel man:** Single tool replaces ESLint + typescript-eslint + Prettier. Subsecond performance on 10k files. GritQL plugins. v2.x ships type-aware rules.
- **Why rejected:** Type-aware coverage is ~10 rules vs typescript-eslint's 61; flagship `noFloatingPromises` rule "detects ~75% of cases" (Biome's own claim). For a strict-mode TypeScript codebase doing TDD, accepting a 25% miss rate on the single best-supported type-aware rule is too steep. Biome 2026 roadmap (`biomejs.dev/blog/roadmap-2026/`) prioritizes embedded languages, HTML, SCSS, IDE LSP polish — not aggressive type-aware expansion. Plugin system is GritQL-pattern-match-only (no autofix). `useExhaustiveDependencies` rule has documented divergence from `react-hooks/exhaustive-deps` (`biomejs/biome#2149`), which the renderer needs.

### Option F: node:sqlite instead of better-sqlite3 (Rejected)

- **What:** Use the Node.js built-in `node:sqlite` module (added 22.5.0, RC in Node 25.7.0).
- **Steel man:** Zero native binding to manage. No `electron-rebuild` step. Maintained by the Node.js core team. API parity with better-sqlite3 (synchronous, `prepare`, `function`, `aggregate`, `loadExtension`, sessions). Node 25.x adds `SQLTagStore` LRU.
- **Why rejected:** (a) Stability label is still "experimental" on Node 22 LTS — the Node project has not granted RC stability on the LTS line we run on, and V1's daemon + renderer are pinned to Node 22 by ADR-016; (b) BLOB return type is `Uint8Array`, not Node-canonical `Buffer` — every hash-chain read requires an extra wrap; (c) Electron 41 still requires `--experimental-sqlite` flag (`electron/electron#45532`) to use it from the renderer; (d) the SQG benchmark (2026-01-19, Node 22) shows better-sqlite3 ahead by 1.11×–1.67× across `getUserById`, `insertUser`, `updatePostViews`. Re-evaluate when node:sqlite reaches Stability 2 on a Node LTS line we actually run.

### Option G: postgres.js (porsager) instead of pg (Rejected)

- **What:** `porsager/postgres` 3.4.9 with tagged-template SQL, automatic prepared-statement LRU, native LISTEN/NOTIFY auto-reconnect, built-in logical-replication subscribe.
- **Steel man:** Tighter API. First-class TypeScript types. LISTEN/NOTIFY auto-reconnect solves the operational fragility that bites `pg` in production.
- **Why rejected:** The performance argument is stale (porsager's benchmarks ran on Node 12.20.1; the 2026 dev.to benchmark on Node 22 shows pg slightly ahead with sub-µs gaps dominated by Postgres RTT — not a deciding axis). The deciding axes are maturity, ecosystem (BullMQ, pgBoss, Drizzle, Kysely, OpenTelemetry instrumentation all default to pg), and explicit prepared-statement control (postgres.js auto-caches every query, which is convenient until you need cache invalidation). LISTEN/NOTIFY operational concern addressed via `pg-listen` wrapper (`andywer/pg-listen`) — one extra dep is cheaper than rebuilding against a different driver.

### Option H: Single Node 22 LTS target everywhere (Rejected)

- **What:** Pin every workspace to Node 22 Maintenance LTS for cognitive simplicity.
- **Steel man:** One `engines.node` floor; one Docker base image; one `tsconfig.json` ladder; no split CI matrix.
- **Why rejected:** The Electron 41 floor _forces_ Node 22 only for daemon + renderer. Control plane + CLI run in our own infrastructure with no such constraint. Picking Node 24 Active LTS for those tiers captures security support through 2028-04 vs Node 22's 2027-04 — 18 months at zero compatibility cost. `module: nodenext` and `verbatimModuleSyntax: true` are identical across both tiers; the only difference is `target: es2023` vs `es2024` and `lib`. The "split" is a tsconfig two-line difference, not a Docker / CI / runtime split.

---

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | pnpm 10's isolated linker handles two-ABI native bindings (Electron + Node) cleanly via per-workspace rebuild | `pnpm/pnpm#9073` (better-sqlite3 + native bindings interaction); `WiseLibs/better-sqlite3#1393` (NODE_MODULE_VERSION mismatch under Electron); pnpm.io/settings `nodeLinker: isolated` is the v10 default | Daemon and Electron both load incompatible native binaries; rebuilds break across tiers; we'd fall back to manual `node-gyp` rebuild scripts per tier |
| 2 | Turborepo's MIT license + open remote-cache HTTP API are durable | `github.com/vercel/turborepo/blob/main/LICENSE` (MIT, verified live 2026-04-26); HTTP API spec documented at `turborepo.dev/docs/core-concepts/remote-caching`; multiple self-host implementations exist (`ducktors/turborepo-remote-cache`, `brunojppb/turbo-cache-server`, `Tapico/tapico-turborepo-remote-cache`) | Vercel relicenses or closes the API; fork the cache server or migrate to nx self-host |
| 3 | Vitest 4.x's `projects` config covers Node + browser packages in one toolchain | Vitest 4.0 release notes 2025-10-22 (Browser Mode stabilized); `vitest.dev/guide/projects` (replaced workspaces in 3.2 / June 2025); Browser Mode supports Playwright/WebDriverIO/preview providers | Browser Mode regresses on renderer; fall back to separate Playwright Component Testing (named V1.1 fallback) |
| 4 | better-sqlite3 12.9.0 ships Electron 41 prebuilds for all V1 platforms | GitHub releases-API enumeration on 2026-04-26: 141 prebuild artifacts including `electron-v123-darwin-arm64`, `electron-v123-linux-x64`, `electron-v123-win32-x64`, plus arm64 / musl variants | One platform falls out of prebuilt coverage; `electron-rebuild` step required at install time on that platform |
| 5 | Node 22 Maintenance LTS receives security patches through 2027-04-30 | `endoflife.date/nodejs` (verified live 2026-04-26); Node 22 entered Active LTS 2024-10-29, transitioned to Maintenance 2025-10-21, EOL scheduled 2027-04-30 | Node 22 EOL accelerates; migrate daemon + renderer to next Electron LTS that bundles a supported Node line |
| 6 | `isolatedDeclarations: true` plus `tsc --emitDeclarationOnly` produces correct types and prepares the codebase for tsgo / TypeScript 7 migration | TS 5.5 `isolatedDeclarations` proposal `microsoft/TypeScript#47947`; tsgo readme at `github.com/microsoft/typescript-go` documents `isolatedDeclarations`-friendly emit | tsgo emits incompatible declarations; we keep tsc indefinitely (acceptable degradation, not a hard failure) |
| 7 | `require(esm)` is stable on Node 22.12+ | Joyee Cheung's primary-source post 2025-12-30 (Node TSC member); unflagged in Node 22.12.0 / 20.19.0 late 2025; formally Stable in Node 25.4.0 | Top-level-await ESM modules can't be `require()`'d (still true and acceptable — our code has no TLA) |
| 8 | typescript-eslint 8.59+ type-aware rules meet our perf bar via `--cache` and CI-only execution under ESLint 10 (bumped from ESLint 9 → 10 at PR-time per [Decision Log](#decision-log)) | `typescript-eslint.io/troubleshooting/typed-linting/performance` (canonical perf guide); ESLint `--cache` cuts repeat runs to a fraction; type-aware rules can be config-gated to CI; `typescript-eslint.io/users/dependency-versions` confirms `^10.0.0` officially supported by typescript-eslint 8.x | Lint runtime exceeds tolerable CI minutes on a 50k-LOC monorepo; migrate to Oxlint+tsgolint earlier (named V1.1 candidate) |

---

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| pnpm regresses two-ABI native bindings on a release | Low | High | `pnpm rebuild --filter=@ai-sidekicks/desktop better-sqlite3` fails in CI | Pin pnpm minor version in `engines.pnpm`; downgrade if a rebuild test breaks |
| Turborepo deprecates self-hostable remote cache | Low | Medium | Vercel announcement; `turbo.json` schema breaks | Fork `ducktors/turborepo-remote-cache`; or migrate to Nx self-host (also free per Powerpack announcement) |
| Vitest 4.x Browser Mode regression breaks renderer tests | Med | Medium | Renderer test suite fails after Vitest update | Pin Vitest minor; fall back to Playwright Component Testing for renderer-only |
| typescript-eslint perf becomes intolerable | Med | Low–Medium | CI lint stage > 5 min; developer-feedback friction | Earlier migration to Oxlint + tsgolint (already V1.1 plan); reduce type-aware rule set in interim |
| Node 22 EOL accelerates ahead of 2027-04 | Low | High | nodejs/Release schedule update | Migrate daemon + renderer to next Electron stable that bundles a supported Node line |
| better-sqlite3 maintenance lapses | Low | High | Issue tracker stale; release cadence drops | Switch to `node:sqlite` once it reaches Stability 2 on Node LTS we run; accept Uint8Array→Buffer wrap cost |
| ESM `require()` regresses on Node 22 | Very Low | High | `require(esm)` calls throw at runtime | Restore explicit dynamic `import()` pattern; bisect Node release |
| pg LISTEN/NOTIFY drops in production | Med | Medium | Notification handler stops firing | `pg-listen` wrapper handles backoff + re-subscription; alert on subscription gaps |

---

## Reversibility Assessment

- **Reversal cost:** Medium-to-high. Per-primitive switching cost varies: package-manager swap (≈ 1–2 days, lockfile + CI rewrite + binding rebuild), build-orchestrator swap (≈ 1 day, `turbo.json` → `nx.json`), test-runner swap (≈ 2–3 days, test-API rewrites), linter swap (≈ 1 day with migration tooling), SQLite binding swap (≈ 0.5 day for sync API → sync API; medium for sync → async), Postgres client swap (≈ 1–2 days, query-construction rewrites). Two-tier Node target is per-package `tsconfig` toggle (≈ minutes).
- **Blast radius:** Every package, every CI pipeline, all dev environments, all `electron-rebuild` workflows, all release artifacts.
- **Migration path:** Adopt new primitive in a feature branch; rebuild lockfile; rebuild bindings; swap CI. For the package manager and test runner specifically, the migration is invasive enough that we should treat the swap as a Type 2 ADR in its own right.
- **Point of no return:** After Plan-001 lands and Plans 003/006/018/022 build on the migration shape and binding ABI. As of 2026-04-26 we are pre-PoNR; this ADR sets the floor before that boundary is crossed.

---

## Consequences

### Positive

- Reinforcing primitive choices: pnpm enables Turbo's first-class lockfile support enables better-sqlite3's two-ABI rebuilds enables Vitest's single-runner Node + browser coverage.
- Empirical adoption-validated stack (pnpm + Turbo) confirmed in vercel/turborepo's own repo, trpc/trpc, vercel/next.js (raw `package.json` reads, 2026-04-26).
- Strong type-aware lint coverage from day one (typescript-eslint full 61-rule set vs Biome's ~10).
- Hash-chain BLOB ergonomics: `Buffer` end-to-end across BLAKE3 / Ed25519 / RFC 8785 JCS without per-read wrapping.
- 18 months of additional upstream Node security support on control plane + CLI tier (Node 24 EOL 2028-04 vs Node 22 EOL 2027-04) at zero compatibility cost.
- `isolatedDeclarations: true` adopted now is the maximally-smooth preparation for tsgo / TypeScript 7 migration.

### Negative (accepted trade-offs)

- ESLint runtime cost vs Oxlint speed (~45 s vs ~0.5 s on 10k files per pkgpulse 2026 benchmark; pinning ESLint 10 inherits the same general perf profile as ESLint 9). Mitigation: `--cache` for repeat runs; type-aware rules in CI only; named V1.1 migration trigger.
- pnpm symlink layout learning curve (`node_modules/.pnpm/<pkg>/`). Acceptable in an AI-implementer-led project where the model has high familiarity with isolated layouts.
- tsc + esbuild dual-tool complexity (vs single-tool tsc only). Bounded by `isolatedModules: true` (mandatory) and `isolatedDeclarations: true` (recommended).
- Turbo telemetry-on-by-default requires explicit `TURBO_TELEMETRY_DISABLED=1` plumbing in CI and dev-env docs.
- Two-tier Node targeting splits `tsconfig` `target` / `lib` per-package. Mitigation: shared root `tsconfig.base.json` + `tsconfig.node22.json` / `tsconfig.node24.json` extension presets.
- Apache-2.0 OSS posture (per [ADR-020](./020-v1-deployment-model-and-oss-license.md)) is compatible with all primitive licenses (MIT for pnpm/Turbo/Vitest/ESLint/Prettier/better-sqlite3/pg; ISC for npm; BSD-2 for Yarn — none are problematic).

### Unknowns

- Whether Oxlint + tsgolint stabilize on a horizon that beats our V1.1 cycle. If they ship 1.0 stable in 2026, the migration path is `@oxlint/migrate` plus tsgolint config. If they slip to 2027, V1.1 may ship on ESLint as well.
- Whether tsgo / TypeScript 7 native compiler reaches stable for V1.1+. The repo status page (`github.com/microsoft/typescript-go`) lists emit and project references "done" but watch mode still "prototype" and JSDoc-source `.d.ts` emit "in progress."
- Whether Bun closes the workspace-protocol and Turborepo lockfile parity gap by V1.1. Bun's ecosystem velocity is high; another year of maturity may make it the right re-evaluation candidate.

---

## Decision Validation

### Pre-Implementation Checklist

- [x] All assumptions cite primary sources (8 entries, all linked)
- [x] At least one alternative was seriously considered and steel-manned (8 alternatives steel-manned across the primitives)
- [x] Antithesis was considered (single skeptical-engineer rebuttal across 4 axes, then synthesized)
- [x] Failure modes have detection mechanisms (8 scenarios, 8 detection signals)
- [x] Point of no return is identified (post-Plan-001 + downstream-plan binding)

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Plan-001 implementation completes without integration friction across all primitives | All Plan-001 acceptance criteria pass with ADR-022 toolchain unchanged | Plan-001 Done Checklist | `2026-05-15` |
| CI cold-build under target | < 10 minutes from `pnpm install` to all-package build green | CI pipeline timing | `2026-05-15` |
| Hot-build under target (single-package change) | < 30 seconds from save to test result | Local `turbo watch` + Vitest watch latency | `2026-05-15` |
| Two-ABI native binding rebuild succeeds on all V1 platforms | `pnpm rebuild --filter=@ai-sidekicks/desktop better-sqlite3` succeeds on macOS x64/arm64, Linux x64/arm64, Windows x64 | CI matrix run | `2026-05-15` |

---

## Re-evaluation Triggers

The toolchain is locked for V1 but not frozen forever. Each of the following events SHOULD trigger an explicit re-evaluation of the named primitive:

1. **Oxlint+tsgolint stabilization** — when tsgolint reaches 1.0 stable AND Oxfmt reaches 1.0 stable, evaluate ESLint+Prettier → Oxlint+Oxfmt+tsgolint migration with `@oxlint/migrate`.
2. **tsgo / TypeScript 7 native compiler stabilization** — when watch-mode incremental rechecking lands and `--build` reaches feature parity with `tsc -b`, evaluate tsc+esbuild → tsgo migration.
3. **Bun workspace + Turborepo lockfile parity** — when Bun publishes documented isolated-install workspace primitive AND Turborepo gains first-class Bun lockfile support (parity with current pnpm v10/v11 multi-document parsing), evaluate pnpm → Bun migration at the V1.1 boundary.
4. **node:sqlite Stability 2 on Node LTS we run** — when `node:sqlite` reaches Stability 2 on Node 22 (or whichever LTS the daemon then targets), evaluate better-sqlite3 → node:sqlite migration. Hash-chain BLOB ergonomics may still favor better-sqlite3, but the dependency-removal benefit becomes load-bearing.
5. **pnpm 11.0 stable with `minimumReleaseAge` default** — upgrade from pnpm 10 to pnpm 11 as soon as the supply-chain default flips.
6. **Node 26 ships under new release cadence** — Node 27 onwards (April 2027) every release becomes LTS-eligible per `nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule`. Re-evaluate two-tier targeting under the new cadence.
7. **Electron drops Chromium-based renderer or `contextBridge`** — separately re-evaluates ADR-016, but cascades to ADR-022 by changing the daemon-renderer ABI relationship and possibly Node target.

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| pnpm settings reference | Documentation | `nodeLinker: isolated` (v10 default), `allowBuilds` allowlist (v10.26+) replaces deprecated `onlyBuiltDependencies`, `minimumReleaseAge` (v10.16+; default in v11 RC) | <https://pnpm.io/settings> |
| pnpm catalogs | Documentation | `catalog:` protocol since v9.5; `catalogMode` v10.12; `cleanupUnusedCatalogs` v10.15 — workspace-wide dependency version unification | <https://pnpm.io/catalogs> |
| pnpm releases | Documentation | pnpm 10.33.2 stable (verified 2026-04-26 via npm registry); pnpm 11.0.0-rc.5 (2026-04-21) defaults `minimumReleaseAge` and adds `blockExoticSubdeps` | <https://github.com/pnpm/pnpm/releases> |
| `pnpm/pnpm#9073` | Issue tracker | Documented better-sqlite3 + Electron + pnpm pattern — isolated linker enables clean two-ABI rebuilds | <https://github.com/pnpm/pnpm/issues/9073> |
| `WiseLibs/better-sqlite3#1393` | Issue tracker | `NODE_MODULE_VERSION` mismatch under Electron — confirms two-ABI binding constraint | <https://github.com/WiseLibs/better-sqlite3/issues/1393> |
| Turborepo MIT license | Primary source | License confirmed MIT as of 2026-04-26 (not MPL); self-host posture is durable | <https://github.com/vercel/turborepo/blob/main/LICENSE> |
| Turborepo remote caching | Documentation | Open HTTP API; `TURBO_REMOTE_CACHE_SIGNATURE_KEY` for HMAC-SHA256 signed artifacts | <https://turborepo.dev/docs/core-concepts/remote-caching> |
| Turborepo telemetry | Documentation | On by default; opt-out via `TURBO_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` | <https://turborepo.dev/docs/telemetry> |
| `ducktors/turborepo-remote-cache` | Self-host implementation | Open-source S3-backed Turbo cache server | <https://github.com/ducktors/turborepo-remote-cache> |
| Nx Powerpack announcement | Vendor announcement | Confirms Nx self-hosted caching is explicitly free; Nx Cloud paid features are distributed-execution + AI-CI, not core caching | <https://nx.dev/blog/introducing-nx-powerpack> |
| TypeScript project references | Documentation | `composite: true` + `tsc -b` for incremental builds; canonical types-emit path | <https://www.typescriptlang.org/docs/handbook/project-references.html> |
| TypeScript native preview announcement | Vendor announcement | tsgo `@typescript/native-preview` is preview, not stable; targeted across 2026 | <https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/> |
| `microsoft/typescript-go` repo | Repository status | Emit and project references "done"; watch mode still "prototype" with no incremental rechecking | <https://github.com/microsoft/typescript-go> |
| esbuild content-types | Documentation | Confirms esbuild does NOT emit `.d.ts` files; tsc remains the type-emit tool | <https://esbuild.github.io/content-types/> |
| `microsoft/TypeScript#47947` | Proposal | `isolatedDeclarations` flag (TS 5.5+) constrains exports to type-checker-independent shapes — prep for swc/esbuild/tsgo native `.d.ts` emit | <https://github.com/microsoft/TypeScript/issues/47947> |
| Vitest 4.0 announcement | Vendor announcement | Browser Mode stabilized 2025-10-22 (Playwright/WebDriverIO providers); v8 coverage with Istanbul-grade accuracy | <https://vitest.dev/blog/vitest-4> |
| Vitest projects guide | Documentation | `projects` configuration (replaced `workspace` in 3.2) — single Vitest invocation across multi-package monorepo with merged coverage | <https://vitest.dev/guide/projects> |
| Jest 30 release | Vendor announcement | 37% faster, 77% lower memory in one large TS app; JSDOM 26; native `.mts`/`.cts`; minimum TS 5.4 | <https://jestjs.io/blog/2025/06/04/jest-30/> |
| Node.js test runner reference | Documentation | `node:test` Stability 2 since Node 20; **`--watch` Stability 1 (experimental)**; `--experimental-test-coverage` requires flag; `mock.module()` requires `--experimental-test-module-mocks` | <https://nodejs.org/api/test.html> |
| Biome v2 announcement | Vendor announcement | First JS/TS linter with type-aware rules without invoking `tsc`; flagship `noFloatingPromises` covers ~75% of typescript-eslint cases | <https://biomejs.dev/blog/biome-v2/> |
| Biome 2026 roadmap | Vendor announcement | Prioritizes embedded languages, HTML, SCSS, IDE LSP polish — not aggressive type-aware expansion | <https://biomejs.dev/blog/roadmap-2026/> |
| Oxlint 1.0 announcement | Vendor announcement | 50–100× ESLint speed; 500+ ESLint-compatible rules at GA; 720+ rules as of 2026-03 | <https://voidzero.dev/posts/announcing-oxlint-1-stable> |
| Oxlint type-aware via tsgolint | Documentation | tsgolint covers **59 of 61** typescript-eslint type-aware rules; runs in <10s where ESLint takes ~1 min | <https://oxc.rs/docs/guide/usage/linter/type-aware.html> |
| Oxfmt beta | Vendor announcement | 100% Prettier conformance at >30× speed; beta as of 2026-02-24 | <https://oxc.rs/blog/2026-02-24-oxfmt-beta> |
| ESLint flat-config evolution | Documentation | `defineConfig()` (March 2025) flattens nested args; flat config default since ESLint 9.0 (April 2024) | <https://eslint.org/blog/2025/03/flat-config-extends-define-config-global-ignores/> |
| ESLint v10.0.0 release announcement | Vendor announcement | GA 2026-02-06 (Nicholas C. Zakas, ESLint TSC); breaking changes: drops Node <20.19.0/21/23 support; `eslintrc` config system fully removed; flat-config-only — strictly aligns with ADR-022 §Decision row 5 posture and supports the PR-time ESLint 9 → 10 bump per [Decision Log](#decision-log) | <https://eslint.org/blog/2026/02/eslint-v10.0.0-released/> |
| typescript-eslint dependency-versions matrix | Documentation | typescript-eslint v8.x officially supports ESLint `^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0` — confirms ESLint 10 / TS-ESLint 8.59+ pairing pinned in the workspace `package.json` is supported | <https://typescript-eslint.io/users/dependency-versions> |
| typescript-eslint perf guide | Documentation | `--cache` plus type-aware rules in CI only is the canonical perf strategy for large TS monorepos | <https://typescript-eslint.io/troubleshooting/typed-linting/performance> |
| `WiseLibs/better-sqlite3` releases | Repository | v12.9.0 (2026-04-12); 141 prebuild artifacts including `electron-v123` and `node-v137`; embeds SQLite 3.53.0 | <https://github.com/WiseLibs/better-sqlite3/releases> |
| better-sqlite3 worker-thread guidance | Documentation | Each worker opens its own `Database` instance in WAL read-only; never share `Database` across threads | <https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md> |
| Node.js SQLite docs | Documentation | `node:sqlite` Stability 1.2 (RC) on Node 25.7+; **still experimental on Node 22 LTS**; BLOB return type is `Uint8Array` | <https://nodejs.org/api/sqlite.html> |
| `electron/electron#45532` | Issue tracker | Electron 41 still requires `--experimental-sqlite` flag to use `node:sqlite` from the renderer | <https://github.com/electron/electron/issues/45532> |
| SQG SQLite Driver Benchmark 2026-01-19 | Primary benchmark | better-sqlite3 ahead of node:sqlite by 1.11×–1.67× across `getUserById` / `insertUser` / `updatePostViews` on Node 22 | <https://sqg.dev/blog/sqlite-driver-benchmark/> |
| SQLCipher project | Documentation | Whole-database single-master-key encryption — incompatible with Spec-022's per-participant AES-GCM crypto-shred via key-row deletion; rejected | <https://www.zetetic.net/sqlcipher/> |
| `brianc/node-postgres` CHANGELOG | Repository | pg 8.20 (2026-02): `onConnect` pool callback; 8.16 added min pool size; 8.15 native ESM imports; 9.0 breaking-changes discussion open #3598 | <https://github.com/brianc/node-postgres/blob/master/CHANGELOG.md> |
| `andywer/pg-listen` | Repository | Production-grade LISTEN/NOTIFY wrapper with auto-reconnect + backoff — addresses pg's idle-disconnect fragility | <https://github.com/andywer/pg-listen> |
| dev.to Node 22 driver benchmark | Independent benchmark | pg-native > pg > postgres.js with sub-µs gaps on Node 22; performance is config-dominated, not driver-dominated | <https://dev.to/nigrosimone/benchmarking-postgresql-drivers-in-nodejs-node-postgres-vs-postgresjs-17kl> |
| Node.js release schedule | Documentation | Node 22 Maintenance LTS through 2027-04-30; Node 24 Active LTS through 2026-10 then Maintenance through 2028-04-30 | <https://endoflife.date/nodejs> |
| Evolving the Node.js Release Schedule | Vendor announcement | Node 26 ships April 2026 (last under legacy odd/even); from Node 27 (April 2027) every release is LTS-eligible | <https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule> |
| `require(esm)` stability (Joyee Cheung) | Primary source (Node TSC member) | Unflagged in Node 22.12.0 / 20.19.0 late 2025; formally Stable in Node 25.4.0; top-level-await ESM still requires dynamic `import()` | <https://joyeecheung.github.io/blog/2025/12/30/require-esm-in-node-js-from-experiment-to-stability/> |
| Microsoft TypeScript Node-Target-Mapping wiki | Primary source | `target: ES2023, lib: ES2023, module: nodenext` for Node 22; `target: ES2024, lib: ES2024, module: nodenext` for Node 24 | <https://github.com/microsoft/TypeScript/wiki/Node-Target-Mapping> |
| TypeScript 5.7 announcement | Vendor announcement | ES2024 target supported; Node 22 compile-cache awareness | <https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/> |
| Adoption-evidence: vercel/turborepo `package.json` | Primary source | `"packageManager": "pnpm@10.28.0"` + Turborepo as task runner | <https://raw.githubusercontent.com/vercel/turborepo/main/package.json> |
| Adoption-evidence: trpc/trpc `package.json` | Primary source | `"packageManager": "pnpm@10.33.1"`, Turborepo, `"engines": { "node": "^24.0.0", "pnpm": "^10.33.1" }` | <https://raw.githubusercontent.com/trpc/trpc/main/package.json> |
| Adoption-evidence: vercel/next.js `package.json` | Primary source | `pnpm` referenced throughout scripts; Turborepo as task runner | <https://raw.githubusercontent.com/vercel/next.js/canary/package.json> |

### Related ADRs

- [ADR-016: Electron Desktop Shell](./016-electron-desktop-shell.md) — sets Electron 41 → Node 22 floor that forces tier-1 Node target.
- [ADR-004: SQLite Local State and Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md) — sets the SQLite + Postgres engine pair this ADR selects bindings for.
- [ADR-014: tRPC Control Plane API](./014-trpc-control-plane-api.md) — the control plane RPC stack that consumes the package manager + monorepo + TS settings.
- [ADR-009: JSON-RPC IPC Wire Format](./009-json-rpc-ipc-wire-format.md) — the daemon wire format whose contracts package consumes the toolchain.
- [ADR-018: Cross-Version Compatibility](./018-cross-version-compatibility.md) — the version-floor enforcement model this ADR's `engines.*` declarations participate in.
- [ADR-020: V1 Deployment Model and OSS License](./020-v1-deployment-model-and-oss-license.md) — Apache-2.0 posture that constrains primitive license compatibility (all selected primitives are MIT/ISC/BSD-2 compatible).

### Related Plans

- [Plan-001: Shared Session Core](../plans/001-shared-session-core.md) — first consumer of this toolchain; tier-entry plan that owns `0001-initial.sql`.

### Related Architecture

- [Container Architecture](../architecture/container-architecture.md) — authoritative for the workspace topology (`packages/`/`apps/` tree).

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-04-26 | Authored | Authored from three Opus 4.7 research passes (workspace toolchain, quality tooling, runtime drivers); citations consolidated into Research Conducted table per ADR-016/017 surfacing pattern. |
| 2026-04-26 | Accepted | All assumptions citation-backed; failure modes have detection signals; point of no return identified. |
| 2026-04-26 | Amended | §Decision row 5 promoted from "ESLint 9" → "ESLint 10" at PR-001 time. ESLint v10.0.0 reached GA on 2026-02-06 (v10.2.1 patch on 2026-04-17), is flat-config-only (strictly more aligned with our flat-config posture), and is officially supported by typescript-eslint 8.59+ per `typescript-eslint.io/users/dependency-versions`. Bump caught at PR-time after `package.json` shipped `eslint: ^10.2.1` ahead of the ADR text; Synthesis, Assumptions Audit row 8, Negative consequences, and References table updated in lockstep. |
