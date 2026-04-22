# BL-097 Pass D — Post-V1 Contract-Freeze Regrets

**Date:** 2026-04-22
**Question:** Under AI Sidekicks Option 6 (full workflow engine shipped at V1, public contract effectively frozen until V2), what contract-freeze mistakes have other production workflow engines made — and what specific contract decisions would have prevented those regrets?
**Scope:** Seven systems — Airflow, Temporal, Dagger, n8n, GitHub Actions, CircleCI, Activepieces. For each, we extract (a) the specific API/contract that broke, (b) the root cause of the bad V1 choice, (c) the contract decision that would have avoided the regret, and (d) direct applicability to AI Sidekicks Option 6.

This brief feeds the Option 6 go/no-go and — if Option 6 lands — the list of V1 contract choices that *must be locked down now*, before code execution.

---

## 1. Problem Framing

### 1.1 Why this pass matters under Option 6

Option 6 ships the full workflow engine at V1. That means:

- The DSL / config surface is locked at V1 GA. Users write workflows against it; breaking it later forces a forked runtime or a rewrite-your-workflows migration.
- The execution model (how tasks are isolated, how state is stored, how outputs are passed) is locked at V1 GA. Internals that leak into user-visible semantics become contract.
- The extension surface (what a "step" or "integration" or "node" looks like) is locked. Third-party extension authors will encode assumptions into code we don't control.

Under this choice we get at most one free major version break (V1 → V2) before we look like Airflow-on-the-1.x-tail or CircleCI-on-1.0-after-2.0. The cost of that break is measured in: mass rewrite of user workflows; loss of the extension ecosystem; "pin to 1.x" user cohorts we support forever. We want to **spend that break on things that are genuinely impossible to get right in advance**, not on things the 2020-2026 workflow-engine cohort has already learned the hard way.

### 1.2 The seven-system survey scope

Selected to span the axes that matter for our shape: declarative-YAML (GitHub Actions, CircleCI), imperative-SDK (Temporal, Dagger, Airflow 2+), visual-editor (n8n, Activepieces), determinism-first (Temporal), extension-heavy (Airflow providers, GitHub Actions marketplace, Dagger Modules, n8n/Activepieces "pieces"). Airflow is investigated most deeply (two major version rewrites already shipped — 1→2 and 2→3 — so two data points per freeze pattern).

### 1.3 What this brief does *not* do

- It does not recommend for or against Option 6 itself — that's the parent's Phase-8 job.
- It does not enumerate every breaking change each system ever shipped. It surfaces the breaks that most directly translate to contract-design lessons for us.
- "Freeze-regret" means *a break a shipping system had to ship even though it hurt users*. Cosmetic renames with a migration tool are not freeze regrets; semantic or model changes that invalidate user code are.

---

## 2. Per-System Scar-Tissue Report

### 2.1 Apache Airflow — richest two-major-version case study

Airflow is the densest primary source: they rewrote 1.x → 2.0 (Dec 2020) and 2.x → 3.0 (2025) and published a long changelog plus postmortem blogs for each. Both rewrites broke the same handful of invariants that 1.x and 2.x had baked into the public contract.

#### 2.1.1 What broke — 1.x → 2.x

**a. `airflow.contrib` → provider packages.** Airflow 1.x bundled every integration (AWS, GCP, Snowflake, Postgres, Kubernetes, HTTP, FTP, etc.) into the `airflow.contrib.*` namespace of the core distribution. 2.0 split these into 61 independent `apache-airflow-providers-*` packages, each with its own release cadence and its own SemVer. Old import paths continued to work with `DeprecationWarning`, but all examples, docs, and typing moved to the new namespace.

**b. The XCom pickle default.** 1.x serialized XCom values via `pickle` by default. 2.0 disabled pickling by default and limited the default serializer to JSON. (Ref: apache/airflow#9606 — pickling left open a straightforward remote-code-execution path because XCom values flow through the metadata DB, and anyone with write access to that DB could poison replayed pipelines.)

**c. The scheduler.** 1.x ran a single scheduler process against a single database; "scheduler performance" was the top community-survey complaint (Astronomer, 2020). 2.0 introduced AIP-15 (multi-scheduler HA) and DAG serialization so the web server no longer parsed DAG files from disk at every page load. The web server's own-parse-DAGs behavior in 1.x was an architectural mistake — the UI should have been stateless from the start.

**d. The experimental REST API.** 1.x shipped an `experimental` REST API. 2.0 declared that API "no longer experimental" only after AIP-32 rewrote it with OpenAPI + proper auth + permissions. 1.x's had shipped without a framework for authorization and with narrow coverage — a contract-frozen surface that had to be replaced wholesale.

**e. `SubDAG` → `TaskGroup`.** SubDAG was a 1.x mechanism for grouping tasks visually; it executed with a single-task parallelism constraint that surprised users constantly. 2.0 added `TaskGroup` as the correct answer, left SubDAG working but deprecated, and eventually removed it in 3.0.

#### 2.1.2 What broke — 2.x → 3.x

**a. Task Execution Interface + direct-DB access removed.** Airflow 2.x task code could import `airflow.models` and read/write the metadata DB directly. 3.0 requires all task-side state access to go through the Task Execution API or the Airflow Python Client. Airflow framed this in release docs as "a stronger security model, including secure, scalable execution across multi-cloud, hybrid-cloud, and local data center deployments" — the blog post is explicit that 2.x lacked team isolation ("has often been requested by Airflow enterprise deployments for a better security posture"). This break was forced by the absence of a client-server boundary in V1 — once user code could poke the DB, multi-tenant isolation required removing that capability.

**b. SubDAG removed entirely.** Deprecated in 2.0, removed in 3.0. Migration path: `TaskGroup` + Assets + Data-Aware Scheduling.

**c. Sequential / CeleryKubernetes / LocalKubernetes executors removed.** Baked-in executor enumeration at V1 meant removing executors was breaking even when everyone should have switched to the successor.

**d. SLA → Deadline Alerts.** "SLA" as a concept, with its specific semantics and DB tables, removed entirely.

**e. REST API v1 → v2.** v1, itself a V1-freeze compromise of the 1.x experimental API, was removed and replaced by a FastAPI-based `/api/v2`. This is two API rewrites across two major versions.

**f. Execution-context key removals.** Tomorrow/yesterday/prev/next `_ds`/`_ds_nodash`/`execution_date` context variables are removed — removed because the 2.x task context leaked the scheduler's internal concept of "execution date" into user code, and the whole concept was renamed "logical date" in 3.0.

**g. Datasets → Assets (rename).** Cosmetic, but documented as a top-level 3.0 breaking change with a migration tool and UI copy changes. External references (blog posts, tutorials, conference talks) broken.

**h. `catchup_by_default` and `create_cron_data_intervals` defaults flipped.** A silent default-flip in a scheduler behavior. Users with workflows that depended on the old defaults had their scheduling quietly change.

#### 2.1.3 Root causes

- **Monolithic integration bundling.** 1.x shipped integrations in-core, which meant a bug in the GCP hook waited for a core release. Cloud SDK cadence and workflow-engine cadence don't match; users paid for that mismatch for years.
- **No client-server boundary.** 1.x and 2.x let tasks import core models. Removing that in 3.0 was the largest security-driven break.
- **Scheduler as single-process.** 1.x encoded the assumption in the DB schema and in the operator API. AIP-15 required DB-level coordination code that wasn't designed for it.
- **Insecure defaults (pickle, plain REST auth).** Shipped in 1.x because "dev-first" felt like a reasonable default; forced out in 2.0 after real exploits.
- **Terminology drift.** "Execution date" vs "logical date"; "Datasets" vs "Assets"; "SubDAG" vs "TaskGroup". V1 locked in terms that later research showed were wrong.

#### 2.1.4 What would have prevented them

- Ship integrations as **separately-versioned packages from day one**, with a provider-API contract the core commits to. No `airflow.contrib` inside core.
- Enforce a **task-to-state boundary** at V1 even if the initial implementation is trivial (e.g., tasks always go through a client library, never a direct DB connection).
- Use **safe serialization defaults** (JSON / CBOR, not pickle). No back-door pickle opt-in via config; if pickling is ever supported, it's an explicit named transport, not the default.
- Design the **scheduler for horizontal HA from day one**, even if the V1 default is single-process. The DB schema has to carry the coordination columns.
- Treat the **REST API as a first-class V1 deliverable** with auth, permissions, and OpenAPI. No `experimental` labels on public surface — either it's in or it's gated behind a feature flag.
- Name things once, correctly. **Pick the mature term** — learn from prior art. Don't invent a term you're going to regret.

#### 2.1.5 Applicability to AI Sidekicks Option 6

Extremely high. Every one of Airflow's freeze regrets maps directly:

- Our "integrations" (Codex, Claude, Gemini, MCP tools, channel surfaces) must be **separately-versioned packages**, not core modules. If we ship a V1 where the Codex adapter lives at `ai-sidekicks/src/adapters/codex`, we are writing our own `airflow.contrib`.
- Our "tasks" (whatever we call the workflow-step unit — block, step, cell) must have a **clearly bounded state access API** even at V1. No "the step hook has full DB access because it's convenient."
- Our serialization of step inputs/outputs and any workflow-state snapshots must be **JSON-first, explicitly-typed**. No pickle, no eval-of-YAML.
- Any **scheduling / daemon state** model has to be designed so multi-agent multi-host coordination in V2 is not a schema break. Spec-016 channels already has a multi-machine model; the workflow engine must not re-bake the single-host assumption.
- The **public control plane** (however users poke the daemon from scripts / CI / the desktop app) must have auth, permissions, OpenAPI from V1. No experimental endpoints.
- Terminology: whatever we call the unit (step, action, block), whatever we call outputs (artifacts, results, captures), whatever we call the scheduling concept — we pick once, using current ecosystem terms, and we do not ship a word we're going to want to rename.

### 2.2 Temporal — the determinism-replay contract

Temporal's V1 contract bet the farm on one invariant: **workflow code is deterministic, and the orchestrator replays it against recorded event history on every worker restart**. This is the single most consequential V1 contract decision in the survey — everything else flows from it.

#### 2.2.1 What determinism locks in

Per docs.temporal.io (Go/Java/TypeScript/Python/.NET SDK versioning pages), the set of operations the Worker checks for replay equivalence includes:

- `workflow.ExecuteActivity`
- `workflow.ExecuteChildWorkflow`
- `workflow.NewTimer`
- `workflow.RequestCancelWorkflow`
- `workflow.SideEffect`
- `workflow.SignalExternalWorkflow`
- `workflow.Sleep`

Any change to the sequence, count, or (with some SDK caveats) identity of these calls during replay triggers a non-determinism error and the workflow is effectively bricked until the operator intervenes. Specifically — Temporal itself documents that the runtime check **does not** check activity input-argument values or timer durations, which is a known sharp edge (silent drift is possible on the parts it doesn't check).

#### 2.2.2 Versioning APIs — and their own rewrite

Temporal has had to rewrite its own versioning story:

- **`GetVersion` / Patch APIs** — explicit code-branch markers, like feature flags, recorded in the event history so that future replays take the historical branch. Works, but forces "if GetVersion > N" scar tissue to accumulate in workflow code forever; community threads discuss when it's "safe to remove" old GetVersion calls.
- **Worker Versioning — legacy "Version Sets".** An older API, now deprecated.
- **Worker Versioning — "Build IDs" with Pinned vs Auto-upgrade workflows.** The new approach. Support for the pre-2025 experimental worker versioning was announced to be removed from Temporal Server in March 2026 — i.e., Temporal is itself breaking its own V1 versioning API across versions.

They also document that **Worker Versioning is best suited for short-lived workflows**. Long-running workflows have to either (a) continue running on the old build ID indefinitely or (b) `ContinueAsNew` across upgrade boundaries to adopt a new version. If your V1 contract is "workflows can run forever and you can upgrade code anytime," that is not actually the contract Temporal ended up shipping — they learned long-running workflows need a different upgrade model than short ones, and the API had to be reshaped after the fact.

#### 2.2.3 Root cause

Determinism-plus-replay is a beautiful invariant that, once shipped, **freezes the entire surface on which workflow code is written**. Every timer duration, every activity signature, every conditional branch is implicitly part of the contract. Versioning APIs are not a fix — they're the cost of admitting the contract is too tight to evolve cleanly.

#### 2.2.4 What would have prevented the pain

Not much, given the invariant they chose. The invariant *is* the contract. The lessons are negative:

- If you commit to replay-based execution, **the freeze is much tighter than a normal API freeze** — it includes the structure of conditionals, the count of loops, the ordering of side-effects.
- **Build the versioning API into V1 from day one**, and assume you'll rewrite *that* API at least once. Temporal has rewritten it at least once (Version Sets → Build IDs) already.
- **Distinguish short-lived and long-lived workflows at the contract level** — don't pretend they have the same upgrade model.

#### 2.2.5 Applicability to AI Sidekicks Option 6

Moderate-to-high, depending on whether V1 workflows are:

- Stateless (read the workflow file, run it end-to-end, write the result): Temporal's lesson mostly doesn't bind.
- Replay-able (you can suspend a workflow at a step and pick it up later, possibly after a code change): **Temporal's lesson is the V1 contract**. Every step signature, every branch, every timer is frozen. We'd need `GetVersion`-style patching built into V1.
- Durable across reboots (daemon restart recovers an in-flight workflow): Same as replay — Temporal-class freeze.

If Option 6's workflow engine supports any form of "resume a paused workflow after process restart," we must decide *now* whether we're taking on Temporal's full determinism contract (and therefore need a patching API from V1) or whether we're explicitly opting out (e.g., "workflow resumes only replay the I/O log, not the code"). "We'll figure it out in V1.1" is the one answer that is definitely wrong.

### 2.3 Dagger — the DSL lock-in and the wholesale API rewrite

Dagger is the single clearest "we made the wrong V1 bet on configuration language" case in the entire survey.

#### 2.3.1 The CUE chapter (2020–2022)

Dagger's original V1 was built around **CUE** as the pipeline configuration language. CUE is a powerful typed configuration language (used by Kubernetes ecosystem tooling) but it is, in the Dagger founders' own later words, "a brand new language" for most of their users.

Per Solomon Hykes (Dagger co-founder) on HN (news.ycombinator.com/item?id=46265956) and the official ending-CUE-support blog (dagger.io/blog/ending-cue-support/, Dec 2023):

- "The number one complaint from our users is that they didn't want to learn CUE."
- Remaining CUE-only was described as "suicide."
- "Engineers are tired of building CI/CD pipelines with shell scripts and YAML … but what they really want is to write code in a language they already know."

Dagger shipped a **full multi-SDK rewrite** (Go, Python, Node.js — later TypeScript, PHP, Rust, Elixir, .NET, Java) built on a new GraphQL engine. CUE SDK support was ended on **2023-12-14**, roughly 2.5 years after V1.

#### 2.3.2 The `v0.8` break release (Aug 2023)

`v0.8.0 - BREAKING CHANGES RELEASE` (dagger/dagger#5374) was announced explicitly as a breaking-changes release:

- Container methods `exec` → `withExec`, `fs` → `rootfs`.
- `Directory.workdir`, `File.secret` removed.
- `Host.envVariable` removed entirely — architectural fallout from "moving the GraphQL server to the engine runner." Supporting env-var read meant either blindly forwarding every client env var to the server (security bug) or building a custom session handler — both unacceptable.
- Python SDK: dropped synchronous API (async-only going forward).
- Node.js SDK: `Client` became a named export.

Team admissions: `Container.exitCode` "didn't work correctly when commands failed"; optional string fields couldn't distinguish unset from empty in strongly-typed SDKs.

#### 2.3.3 The Zenith / Modules chapter (Nov 2023 — 2024)

Zenith introduced the **Module** system and **Daggerverse** (searchable registry of community functions). This was a second architectural pivot: from "write a pipeline file" to "call composable functions from a registry." Dagger v0.10 (Jan/Feb 2024) shipped Modules as the headline V1.x feature, and v0.11's old pipeline APIs became no-ops (with removal planned in v0.13).

#### 2.3.4 Compat mode and shadow-API breakage (2025–2026)

dagger/dagger#10713 (2026): engine upgrade v0.18.8 → v0.18.12 broke a user's module tests because error-string formatting changed. The user quote: "error strings are part of the 'shadow API' and are outside of compat mode." Dagger added `engineVersion` in `dagger.json` (v0.12) specifically so modules could declare which engine API they were written against — i.e., Dagger is still, as of 2026, adding compatibility shims for contract surfaces they didn't mean to freeze.

#### 2.3.5 Root causes

- **The DSL lock-in.** Picking a niche configuration language — even a good one — as the primary surface means the entire user experience depends on that language's adoption. CUE adoption in CI/CD was lower than in Kubernetes configs; Dagger paid the cost.
- **Shadow API surface.** "Error strings" turned out to be part of the contract because users wrote tests that matched them. Anything users observe is part of the contract; calling it "not part of the API" only works until users notice.
- **Architectural relocation (v0.8).** Moving the GraphQL server to the engine runner forced a new security model, which cascaded into `Host.envVariable` removal.

#### 2.3.6 What would have prevented them

- **Do not pick a novel DSL as your V1 contract.** The convergent answer across the 2020-2026 cohort is "languages users already know" (Go, Python, TypeScript, plus YAML/shell for simple cases).
- **Define what is and is not part of the contract explicitly**, and put the non-contract surface under a stability labeling system (like Go's experimental packages or Kubernetes's alpha/beta/stable conventions). "Shadow API" means "contract we forgot to declare."
- **Ship the compatibility mechanism with the engine from v1.0**, not as a v0.12 retrofit. `engineVersion` in `dagger.json` is exactly the sort of thing that, if not there at V1, users will ship modules against the current behavior and break when it drifts.

#### 2.3.7 Applicability to AI Sidekicks Option 6

Very high. The DSL question is the single biggest one we'll answer for V1:

- If we invent a novel DSL for workflow definitions, we inherit Dagger's CUE lesson. **Don't do this.**
- If we pick YAML + a typed SDK (like Airflow 2+, GitHub Actions + marketplace, or Temporal's approach), we're aligned with the convergent answer. The SDK should be in a language our users already run.
- The "shadow API" lesson: whatever our workflow output format, error message format, or log format is, users will depend on it. We should either formalize those as part of the contract *now* or put them behind an explicit "not contract" wrapper (e.g., "error messages are human-facing and subject to change; use error codes").
- Compat mode: whatever our workflow-definition format is, it should carry a version marker from day one (`ai-sidekicks-schema: 1.0`), and the engine should be able to read older-marker files in a compat mode — so a V2 engine can still run V1-authored workflows without forcing everyone to rewrite simultaneously.

### 2.4 n8n — the silent-semantics and execution-model freezes

n8n (visual workflow builder) has a documented `BREAKING-CHANGES.md` (github.com/n8n-io/n8n/blob/master/packages/cli/BREAKING-CHANGES.md) covering every release since 0.x. The density is unusual — small breaks every few releases rather than a big-bang rewrite.

#### 2.4.1 What broke

**Execution-mode removal (v1.27.0, 2024).** n8n shipped three execution modes in 0.x/1.x: `own`, `main`, `queue`. The `own` mode (each execution runs in its own process) was deprecated and then removed; `EXECUTIONS_PROCESS=own` configurations fail to start. Users on that mode for workflow isolation had no direct replacement in their deployment — they had to switch deployment topology.

**Silent expression errors → hard failures (v1.0, 2023).** In 0.x, workflow expressions that referenced non-existent nodes or hit runtime errors were silently ignored. In 1.0, the backend throws. Workflows that appeared to work for years suddenly fail in production.

**Webhook deregistration behavior (v1.15.0).** n8n stopped deregistering webhooks at startup/shutdown. `N8N_SKIP_WEBHOOK_DEREGISTRATION_SHUTDOWN` flag removed. Deployment scripts that relied on the old behavior broke silently.

**Database schema becomes irreversible (v0.234.0).** "Database will use strings instead of numeric values to identify workflows and credentials"; execution data moved to a separate table. **Downgrade impossible without full backup restore.** This is an underappreciated freeze regret — a schema change that removes the downgrade path converts an upgrade into a one-way commitment.

**Credential expressions — paired-item matching (v1.24.0).** Credential values in multi-input contexts changed from first-item-only to paired-item. Workflows that depended on the old semantics silently changed behavior.

**Array-output semantics flipped (v1.47.0).** `.last()`, `.first()`, `.all()` without arguments changed from first-node-output to last-node-output. Multi-output nodes (If, Switch) affected.

**Async API migration (v0.135.0).** `this.getCredentials()`, `this.helpers.getBinaryDataBuffer()`, and later `getBinaryStream()` (v1.9.0) all became async. Node authors had to add `await` everywhere.

**Backend migrations (v0.104.0 drops MongoDB; v1.0 + v2.0 drops MySQL/MariaDB; v2.0 drops legacy SQLite driver and in-memory binary data).** Every storage backend that shipped in 0.x has been deprecated or removed across two majors.

**Environment shifts (v1.0 Node 18; v1.98.0 Node 20; v2.0 pnpm-only for runners image).** Runtime dependency minimums keep moving.

**Security-level defaults flipped (v2.0).** Code Node env var access blocked by default. ExecuteCommand and LocalFileTrigger disabled by default. OAuth callback auth now required.

#### 2.4.2 Root causes

- **Execution topology baked in as enum.** Naming three modes (`own`, `main`, `queue`) forced long-term support for all three, and removing one hurts users who picked it.
- **Silent-error defaults.** Permissive behavior feels helpful during development and turns into a contract after a few releases.
- **DB schema without versioning / rollback thinking.** Schema change + no rollback path = one-way upgrade.
- **Sync-to-async migration done in-place.** Node API signature change forces every extension author to update.
- **Backend plurality.** Supporting MongoDB, MySQL, MariaDB, SQLite, and Postgres in V1 meant maintaining five storage adapters; removing any of them is breaking.

#### 2.4.3 What would have prevented them

- **Pick one storage backend for V1 and build the extension point only after there's demand.** n8n's experience is the anti-pattern: five backends at V1, three removed by V2.
- **Execution model as an invariant, not an enum.** One model, one topology, until you understand the production demand well enough to generalize.
- **Loud errors by default.** Silent-success-on-bad-reference is one of the hardest freeze regrets to back out of because users build dependencies on the silence.
- **Schema version + forward-and-backward migration discipline.** Every schema change ships with an explicit migration in both directions, or the rollback path is documented as broken.
- **Async-first API from day one.** Don't promise synchronous callbacks you'll have to make async later.

#### 2.4.4 Applicability to AI Sidekicks Option 6

High. Specific contract choices:

- **One persistence backend at V1** (probably SQLite, per current project direction). Make the extension point formal but don't ship Postgres/MySQL/Mongo adapters at V1.
- **One execution model**. If V1 is "run this workflow on the local daemon," don't enumerate "local / queued / remote" and then have to remove "queued" in V2.
- **Loud errors** for any user-facing workflow semantics — unreferenced node, missing input, typo in expression, unknown integration name. If V1 silently no-ops these, V2 can't tighten without breaking.
- **All extension/adapter APIs async from day one.** Even if the V1 implementation is synchronous inside, the signature is `Promise<T>` / async trait.

### 2.5 GitHub Actions — the HCL→YAML mass rewrite and the slow-release ecosystem burden

GitHub Actions shipped a limited preview in 2018 that used **HCL** (HashiCorp Configuration Language) as the workflow syntax — `.github/main.workflow` files. They ran with that surface for about a year.

#### 2.5.1 What broke — and kept breaking

**HCL → YAML mass rewrite.** On **2019-09-30**, GitHub stopped running HCL workflows. Migration required running GitHub's migration script across every workflow file, in every repo, for every user. GitHub never published a primary-source "why YAML" reasoning in the deprecation changelog — but the practical pattern was that HCL adoption in CI/CD was low, YAML adoption was saturated (GitLab CI, CircleCI, Azure Pipelines, Travis CI all used YAML). This is the exact same lesson as Dagger's CUE, shipped three years earlier by a much-larger company.

**`set-output` / `save-state` deprecation (2022-10-11).** These stdout-based workflow commands (`echo "::set-output name=X::Y"`) let actions communicate with the runner. The problem: untrusted logged data — e.g., the output of a tool run in a step — could inject `::set-output::` lines and cause the runner to execute unintended commands. **Security-driven contract break.** Migration to `GITHUB_OUTPUT` / `GITHUB_STATE` environment files. Planned final removal **2023-05-31**, then postponed indefinitely on **2023-07-24** because usage was still too high. So there are three failure modes: (1) ship insecure-by-default, (2) announce deprecation, (3) fail to execute the deprecation because ecosystem inertia is too strong.

**Node 12 → 16 → 20 forced migration.** GitHub forces action authors to update their Node runtime version as GitHub upgrades the runner:

- Node 12 actions deprecated 2022-09-22; enforcement 2023-06-14; removal 2023-08-14.
- Node 16 deprecated 2023-09-22; transition to Node 20 through Spring 2024.
- Node 20 deprecation announced 2025-09-19.

Every cycle forces every action author in the marketplace to republish. Actions that aren't maintained die. The ecosystem keeps accumulating dead actions.

**Artifact API v3 → v4 (2024-04-16 deprecation → 2025-01-30 removal).** v4 artifacts are **immutable**; v3 artifacts were mutable (multiple jobs could upload to the same artifact). v4 requires unique artifact names across a matrix. This is a semantic break, not just an API rename — matrix workflows that had merged outputs into one artifact have to change their logic.

**Immutable Actions (2024-2026).** Actions becoming GHCR-backed packages required self-hosted runners to allow `ghcr.io` and `*.actions.githubusercontent.com` network traffic. Breaking for locked-down network deployments.

**Composite actions vs reusable workflows.** Not a single break but a years-long Conway's-Law problem: GitHub shipped composite actions at one point, then reusable workflows at another, then kept iterating on which can call which (composite can't call reusable workflows; reusable workflows can call composites; nesting depth 10 for composites, flat for reusable). Users have to pick one, and the rules keep shifting.

#### 2.5.2 Root causes

- **Novel DSL (HCL) without ecosystem traction.** See Dagger 2.3 — same root cause.
- **Stdout-as-control-plane.** `::set-output::` is the archetypal "oh god we should have used a typed channel."
- **Runtime version embedded in the contract** (`runs.using: node12`). Action authors wrote actions against a specific Node version; GitHub can't move Node forward without forcing a mass rewrite.
- **Mutable artifacts.** v3 allowed multiple jobs to write one artifact; the accumulator pattern turned out to be a scaling and consistency liability.

#### 2.5.3 What would have prevented them

- **Pick YAML or a typed SDK. Do not invent a novel DSL.**
- **Never let untrusted stdout be a control channel.** Any "the action tells the runner something" mechanism must be a typed sidechannel (env file, named pipe, explicit API), not a stdout command prefix.
- **Don't encode the runtime version in the user contract.** If actions are Node scripts, either GitHub owns the Node version forever (no) or the action declares its own runtime via a container image (yes).
- **Ship artifacts as immutable from day one.** Mutation-as-accumulator feels helpful, forces a break later.

#### 2.5.4 Applicability to AI Sidekicks Option 6

High. Specific contract choices:

- **DSL: YAML or typed SDK, not a bespoke language.** (Converges with Dagger.)
- **Step-to-runtime control channel: typed, not stdout-based.** If a step outputs "this is the next workflow step's input," it's via a named API call, not by `echo ::something::`.
- **Integration/adapter runtime version: the adapter declares its own runtime** (Docker image, npm package, etc.) so the AI Sidekicks daemon can upgrade its own runtime without invalidating adapters.
- **Workflow outputs (captures, artifacts, run records) are immutable.** If users want an accumulator, they build one on top; we don't let the same workflow-step-output key be written twice.

### 2.6 CircleCI — the 1.0 → 2.0 big-bang rewrite

CircleCI ran 1.0 from ~2011 and announced the 2.0 GA in **2017-07**. They sunset 1.0 on **2018-08-31**.

#### 2.6.1 What broke

**`circle.yml` (root) → `.circleci/config.yml`.** File moved, syntax rewritten. Not a pure rename — the schema is different.

**Ubuntu 12.04 deprecation and image management.** 1.0 ran on a fixed Ubuntu 12.04 image. When Canonical EOL'd it in 2017, CircleCI stopped updating packages and the image became a liability.

**Convention-over-configuration → Docker-first executor flexibility.** 1.0's "we auto-detect your language and Just Work" philosophy forced customization into bolt-ons (custom `circle.yml` hacks to override their auto-detection). 2.0 made Docker images first-class — you pick your own container. The change was advertised as "flexible resource allocation" and "advanced caching strategies" — but the underlying admission is that 1.0's opinionated auto-detection couldn't scale to the range of stacks users actually ran.

**2.1 orbs.** Introduced in late 2018 as reusable parameterized config. Orbs are effectively a package-manager layer on top of the config file — and GitHub Actions ended up reinventing the same thing (composite actions + marketplace).

**Workflow version numbers flipped.** Under 2.0 top-level `version: 2` required a `workflows:` block with its own `version: 2`. In 2.1 the workflow-level version was removed. Silent config-schema drift.

#### 2.6.2 Root causes

- **Convention-over-configuration is a lock-in.** Once users rely on the framework "knowing" their stack, they can't reasonably override it without scaffolding that fights the framework.
- **Pinning one OS image.** Long-term support obligation.
- **Config schema without a migration tool.** CircleCI had to banner-warn users for months to get them off 1.0.

#### 2.6.3 What would have prevented them

- **Explicit over implicit from day one.** Users declare their runtime/image; the framework does not guess.
- **Runtime image as an explicit declaration, not a platform default.**
- **A migration tool that mechanically transforms old configs**, shipped *with* the deprecation announcement, not six months later.

#### 2.6.4 Applicability to AI Sidekicks Option 6

Moderate. Our V1 is unlikely to ship a language-auto-detection layer. But:

- The "runtime image" lesson: if our workflow steps run in containers, **declare the image explicitly** at V1. Don't ship a "we pick one for you" convenience layer that becomes our responsibility to keep in sync with ecosystem versions forever.
- If we change the workflow definition format between V1 and V2, **ship the migration tool with the deprecation notice**, not after.

### 2.7 Activepieces — the young-system pattern

Activepieces is a younger system (primarily 2023-2026). Its breaking-changes page (activepieces.com/docs/install/configuration/breaking-changes) is comparatively short, but the items are instructive because they're all pre-V1-stable:

- **File storage shift.** Files from actions/triggers moved from base64-in-memory strings to DB-or-S3 paths. Paused flows from pre-0.29 "no longer work" — downgrade impossible.
- **Connections API rename.** `name` → `externalId`, `displayName` added. Users of the API have to rewrite calls.
- **All branches converted to routers.** A fundamental control-flow primitive replaced. "Downgrade is not supported."
- **`AP_SANDBOX_RUN_TIME_SECONDS` → `AP_FLOW_TIMEOUT_SECONDS`.** Env var rename for a core runtime setting.
- **`SIGN_UP_ENABLED` removed.** Replaced by platform/project invitations + role model rework.
- **EXTERNAL_CUSTOMER → OPERATOR role rename** in the embedding SDK.
- **SQLite → PGLite migration auto-applied on upgrade.** Embedded-DB family change done inline.
- **UI: Array of Properties + Dynamic Value.** Semantic change forced users to remap values in existing flows.

**Root cause.** Same class as n8n: every time the team learned their original V1 naming or model was wrong, they broke it. The system is small enough that they can ship breaks and iterate. This is not a reassuring model — it means as adoption grows they'll hit the same freeze wall the larger systems hit.

**What would have helped:**
- Stable naming ≠ stable semantics. Getting the names right at V1 (per Airflow lesson) is cheap; changing them later is expensive.
- Avoid fundamental control-flow primitive choices (branches vs routers) at V1 until the execution model is proven.

**Applicability to Option 6:** Moderate. Every single Activepieces break is one of the patterns already enumerated above — naming, role models, env-var keys, semantic rewrites of primitives. The lesson is "even small systems hit these walls; there's no free escape by being 'young enough to break things.'"

---

## 3. Cross-Cutting Freeze-Regret Patterns

Distilled from the seven per-system reports. Each pattern names (a) the pattern, (b) which systems hit it, (c) the AI Sidekicks V1 contract decision that avoids it. If a pattern can't cash out as a concrete contract choice for V1, it's not here.

### Pattern F1 — **Monolithic Integration Bundling**

**Hit by:** Airflow (`airflow.contrib`), GitHub Actions (Node-12/16/20 ecosystem), n8n (storage backends, node API).

**Why it's a V1 freeze regret:** Integrations with external systems (cloud SDKs, APIs, tools) have their own release cadence. Bundling them in-core means a bug in the Codex adapter forces a core release. Removing bundled integrations later is breaking. Keeping them tied to the core's release cycle ages them into CVEs and missing-feature complaints.

**AI Sidekicks V1 contract decision:** Every first-party integration (Codex adapter, Claude Code adapter, MCP tool adapters, channel surface adapters) ships as a **separately-versioned package** with its own release cadence. Core exposes an integration contract (probably a TypeScript interface in `packages/contracts/`); first-party integrations live in `@ai-sidekicks/adapter-*` packages and can be patched independently. No `src/adapters/` folder inside core.

### Pattern F2 — **DSL Lock-In (Novel-Language V1)**

**Hit by:** Dagger (CUE), GitHub Actions (HCL).

**Why it's a V1 freeze regret:** Picking a language your users don't already know makes it the single tallest barrier to adoption. If you later learn adoption is bottlenecked on DSL unfamiliarity, you must rewrite onto a familiar language — a full V1 → V2 rewrite of the user-facing surface. Both Dagger and GitHub Actions paid this cost. The convergent answer across the 2020-2026 cohort: **YAML + typed SDK in a popular language** (Airflow 2+, Temporal, Dagger v0.10+, Activepieces).

**AI Sidekicks V1 contract decision:** Workflow definitions are **YAML or JSON** (choose one, pick YAML — the ecosystem default). Programmatic authoring is via a **typed SDK in TypeScript** (which the daemon is already written in). No bespoke DSL. No CUE, no HCL, no custom expression language beyond what's strictly needed for field templating (and templating should be handlebars-style or Liquid — an existing ecosystem, not our invention).

### Pattern F3 — **State Access Boundary Missing**

**Hit by:** Airflow 2.x → 3.x (direct DB access → Task Execution Interface).

**Why it's a V1 freeze regret:** If workflow-step code can directly poke the engine's metadata store (DB, event log, execution context), multi-tenant isolation, security auditing, and client-server deployments are all impossible without a breaking rewrite. Airflow 3 had to remove a capability users had been depending on for five years.

**AI Sidekicks V1 contract decision:** Workflow step code **never** touches the daemon's internal state directly. All access goes through a formal client API (probably a TypeScript module the step receives as an argument, with narrow methods). Even if V1's implementation is trivially in-process, the *contract* is as if the step runs in a separate process over a client-server boundary.

### Pattern F4 — **Unsafe Serialization Default (Pickle-Class)**

**Hit by:** Airflow (XCom pickle, 1.x default; deprecated 2.0).

**Why it's a V1 freeze regret:** Pickle / eval / Marshal / unpickle-by-default create direct RCE paths the moment untrusted data touches the store. Once shipped, removing them is breaking because users have stored pickle-dependent values in their DBs.

**AI Sidekicks V1 contract decision:** Workflow state, step inputs, step outputs, and captures are **JSON (or a constrained superset like JSON-with-dates-as-ISO-strings)**. No YAML-with-`!!python/object`. No eval-of-user-expression except in a sandboxed scripting context with a clear boundary. No pickle. No `JSON.parse` into classes that have `fromJSON` methods that can side-effect.

### Pattern F5 — **Stdout-as-Control-Plane**

**Hit by:** GitHub Actions (`::set-output::`, `::save-state::`).

**Why it's a V1 freeze regret:** If a step communicates with the runner by emitting specially-formatted stdout lines, untrusted data in logs (CLI tool output, echoed files, environment dumps) can forge control messages. Fixing this later is a security-driven break that invalidates all existing actions.

**AI Sidekicks V1 contract decision:** All step-to-daemon communication is via a **typed channel** — JSON-RPC over stdio (LSP-style framing), named pipes, or an env-file writes-and-reads contract. Never stdout pattern-matching. Step stdout is strictly for human-facing log output; the daemon never parses it for control.

### Pattern F6 — **Silent-Error Defaults**

**Hit by:** n8n (expression errors silently passing in 0.x; hard failures in 1.0).

**Why it's a V1 freeze regret:** Silent no-op on user errors (typos, missing references, invalid values) feels forgiving during development and turns into a contract. Users build workflows that depend on the silence. Switching to loud failures is breaking.

**AI Sidekicks V1 contract decision:** Every user error in workflow definitions — unknown integration name, missing required input, typo in step reference, unresolved expression — is **a loud failure at workflow load time** or at the earliest runtime discovery point. Never a silent no-op. If we want forgiving behavior later (e.g., "skip missing optional steps") it's opt-in via explicit syntax, never default.

### Pattern F7 — **Identifier / Terminology Drift**

**Hit by:** Airflow (Datasets → Assets, SubDAG → TaskGroup, execution_date → logical_date); n8n ("own" execution mode); Activepieces (EXTERNAL_CUSTOMER → OPERATOR); CircleCI (`circle.yml` → `.circleci/config.yml`).

**Why it's a V1 freeze regret:** Names show up in users' workflow files, blog posts, conference talks, training materials, third-party tutorials. Renaming a primitive breaks all that external material even with a migration tool.

**AI Sidekicks V1 contract decision:** Pick terminology once, using **current ecosystem terms**:

- Step vs task vs action: converge on one word. (Industry-current: "step" from GitHub Actions, "task" from Airflow/Temporal. "Step" reads better for our context.)
- Output / artifact / capture: pick one. (Industry-current: "artifact" in CI, "output" in scripting. We're more CI-shaped — "artifact" is likely right.)
- Workflow / pipeline / flow: pick one. (Industry-current: "workflow" for GitHub Actions and Temporal, "pipeline" for CircleCI and Dagger, "flow" for n8n and Activepieces. "Workflow" is the dominant term.)
- Channel vs queue vs topic (Spec-016): pick one and hold it.

Do not invent any new terms the 2020-2026 workflow-engine cohort has converged on.

### Pattern F8 — **Executor / Execution-Model Enumeration**

**Hit by:** Airflow (Sequential / Local / Celery / Kubernetes / CeleryKubernetes / LocalKubernetes → removed several in 3.0); n8n (`own` / `main` / `queue` → removed `own`).

**Why it's a V1 freeze regret:** Naming three execution models at V1 forces supporting all three forever or breaking removal. Users who picked the doomed one are stranded.

**AI Sidekicks V1 contract decision:** **One execution model at V1.** Local daemon runs workflows locally; Spec-016 channels handle cross-machine. Do not ship "local or queued" at V1. If V1.1 needs to add a queued/remote execution mode, add it as a new capability, not an enum flip.

### Pattern F9 — **Output Mutability**

**Hit by:** GitHub Actions (v3 artifacts mutable; v4 immutable).

**Why it's a V1 freeze regret:** Allowing a workflow step's output to be mutated (by a later step, by a retry, by an accumulator pattern) makes retries, caching, and parallel execution all subtly incorrect. Retrofitting immutability invalidates existing accumulator workflows.

**AI Sidekicks V1 contract decision:** Workflow step **outputs are immutable once written**. A step either succeeds-and-writes-once or fails-and-no-output. Accumulator patterns are built on top (e.g., a "collect" step that reads N upstream outputs and emits a new one). Retry means re-running the step and getting a new output identity.

### Pattern F10 — **Runtime Version Embedded in User Contract**

**Hit by:** GitHub Actions (Node 12 / 16 / 20 forced migrations for every action author, every ~18 months).

**Why it's a V1 freeze regret:** If workflow/step authoring specifies a runtime version, the platform owns that runtime forever. When the runtime EOLs, the platform must force-migrate every author or maintain an obsolete runtime forever. Both options are painful.

**AI Sidekicks V1 contract decision:** The daemon's internal runtime (Node/TypeScript version) is **never part of the user contract**. If step code runs in a specific runtime, that runtime is declared by the adapter (e.g., the adapter ships as a container image with its own Node version, or the adapter declares `"runtime": "node>=20"` in its manifest and the daemon orchestrates). The daemon can upgrade its own Node version without asking adapters to republish.

### Pattern F11 — **One-Way Schema Upgrades**

**Hit by:** n8n (v0.234.0 DB schema string-IDs + execution-data table split; "downgrade impossible without backup restore"). Activepieces (SQLite → PGLite inline migration; "downgrade not supported").

**Why it's a V1 freeze regret:** Any schema upgrade that has no reverse migration converts "upgrade to X" into a one-way commitment. Users can't back out if X has a bug. For a daemon users run locally (our case), this compounds — bad release = wedged user who can't roll back.

**AI Sidekicks V1 contract decision:** Every DB schema migration ships with an **explicit reverse migration**, or the release notes document the rollback path (export to JSON, downgrade, import). Bypassing this is the exception, requires explicit version-bump coordination, and is documented as a one-way change in release notes.

### Pattern F12 — **Shadow API (Undeclared Contract Surface)**

**Hit by:** Dagger (error strings; dagger/dagger#10713).

**Why it's a V1 freeze regret:** Anything users observe is part of the contract whether you mean it to be or not. Error-message text, log formats, file-tree layout on disk, env-var names, exit codes — all of these become contract the moment users write tests against them.

**AI Sidekicks V1 contract decision:** Explicitly declare the **not-contract surface** at V1. Error messages are human-facing and can change; use error codes for programmatic checks. Log formats are for humans; use structured-log JSON for programmatic consumers. File-tree layout is documented as internal; external tools must go through the daemon API. Ship the disclaimer with V1, not after the first incident.

### Pattern F13 — **Insufficient Versioning-API Maturity at V1**

**Hit by:** Temporal (Version Sets → Build IDs rewrite; Patch API still accumulating scar tissue).

**Why it's a V1 freeze regret:** If your V1 contract allows workflows to run long enough to outlive code changes, you need a versioning/compatibility mechanism *in the contract from V1*, and you should assume you'll rewrite that mechanism at least once.

**AI Sidekicks V1 contract decision:** Workflow definition files carry an **explicit schema version marker** from V1 (`ai-sidekicks-schema: 1.0` or equivalent). The daemon supports running older-schema workflows via a compat layer. If we ever support suspended/resumed workflows across code updates, the schema version becomes the compat key. This is cheap to add at V1, expensive to retrofit.

### Pattern F14 — **Bundled Authoring + Runtime + Storage**

**Hit by:** Most systems, especially n8n and Airflow pre-3.0.

**Why it's a V1 freeze regret:** When the workflow definition, the execution runtime, and the state store are bundled into one monolith, separating them later (to enable headless execution, CI/CD integration, or multi-machine deployment) is a structural rewrite.

**AI Sidekicks V1 contract decision:** At V1, the seams are *defined* even if the implementation is monolithic: **workflow-file-parser** knows nothing about **step-executor**, which knows nothing about **state-store**. The contracts at these seams are TypeScript interfaces; the V1 implementation wires them together in-process, but V1.x or V2 can move them across process/host boundaries without rewriting user-visible contracts.

---

## 4. Top Freeze-Regret Patterns Ranked by Applicability to Option 6

If Option 6 proceeds, the patterns ranked by how much they'll hurt us if we get them wrong:

1. **F2 DSL lock-in** — the single biggest trap; one wrong language choice forces the entire V1→V2 rewrite. Decide *now*: YAML + typed TS SDK.
2. **F3 state access boundary** — if V1 steps can poke daemon internals, V2 multi-machine (Spec-016 channel dispatch in V1.1 per MEMORY) breaks.
3. **F7 terminology drift** — cheap to get right now, disproportionately expensive later.
4. **F1 integration bundling** — the first-party adapters (Codex, Claude, MCP) *must* be separately-versioned from V1.
5. **F5 stdout-as-control-plane** — GHA paid for this publicly; the answer is typed channels.
6. **F4 unsafe serialization** — JSON-only; no pickle-class transports. Trivial to decide, disastrous if we forget.
7. **F13 versioning API at V1** — if workflows are suspended/resumable, a schema version marker is a cheap V1 add that avoids Temporal-class pain.

Three more that matter but aren't deal-breakers: F6 silent-error defaults, F8 execution-model singular, F12 shadow API disclaimer. All are cheap to decide now, all are locked to the V1 ship, none of them requires heroic engineering.

---

## 5. Sources

All fetched 2026-04-22 unless otherwise noted.

**Airflow:**
- Apache Airflow 2.0 release blog — `https://airflow.apache.org/blog/airflow-two-point-oh-is-here/`
- Astronomer "Introducing Airflow 2.0" — `https://www.astronomer.io/blog/introducing-airflow-2-0/`
- Apache Airflow 3.0 release blog — `https://airflow.apache.org/blog/airflow-three-point-oh-is-here/`
- Airflow 3 upgrade guide — `https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html`
- apache/airflow#9606 (turn off pickling of XCom by default in 2.0) — `https://github.com/apache/airflow/issues/9606`
- Airflow 2.4.0 release notes (XCom backend signature change) — `https://airflow.apache.org/docs/apache-airflow/2.4.0/release_notes.html`
- Airflow providers changelog — `https://airflow.apache.org/docs/apache-airflow-providers-cncf-kubernetes/stable/changelog.html`

**Temporal:**
- Temporal Go SDK versioning — `https://docs.temporal.io/develop/go/versioning`
- Temporal Worker Versioning (new) — `https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning`
- Temporal Worker Versioning legacy (Version Sets, being removed 2026-03) — `https://docs.temporal.io/encyclopedia/worker-versioning-legacy`
- Temporal "Announcing Worker Versioning Public Preview" — `https://temporal.io/blog/announcing-worker-versioning-public-preview-pin-workflows-to-a-single-code`
- temporalio/temporal worker-versioning.md — `https://github.com/temporalio/temporal/blob/main/docs/worker-versioning.md`

**Dagger:**
- Ending Support for Dagger CUE SDK (2023-12-14) — `https://dagger.io/blog/ending-cue-support/`
- dagger/dagger Discussion #4086 (CUE SDK state + potential futures) — `https://github.com/dagger/dagger/discussions/4086`
- dagger/dagger Discussion #5374 (0.8.0 breaking changes) — `https://github.com/dagger/dagger/discussions/5374`
- dagger/dagger Issue #10713 (engine version compat mode, shadow API break) — `https://github.com/dagger/dagger/issues/10713`
- Dagger 2024 highlights — `https://dagger.io/blog/2024-highlights/`
- HN: Solomon Hykes on CUE decision — `https://news.ycombinator.com/item?id=46265956`
- Dagger CHANGELOG — `https://github.com/dagger/dagger/blob/main/CHANGELOG.md`

**n8n:**
- n8n BREAKING-CHANGES.md — `https://github.com/n8n-io/n8n/blob/master/packages/cli/BREAKING-CHANGES.md`
- n8n 1.0 migration checklist — `https://docs.n8n.io/1-0-migration-checklist/`
- n8n 2.0 breaking changes — `https://docs.n8n.io/2-0-breaking-changes/`

**GitHub Actions:**
- HCL workflows deprecation (2019-09-17) — `https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/`
- HCL workflows removed (2019-10-01) — `https://github.blog/changelog/2019-10-01-github-actions-hcl-workflows-are-no-longer-being-run/`
- set-output / save-state deprecation (2022-10-11) — `https://github.blog/changelog/2022-10-11-github-actions-deprecating-save-state-and-set-output-commands/`
- set-output / save-state postponement (2023-07-24) — `https://github.blog/changelog/2023-07-24-github-actions-update-on-save-state-and-set-output-commands/`
- Node 16 migration (2022-09-22) — `https://github.blog/changelog/2022-09-22-github-actions-all-actions-will-begin-running-on-node16-instead-of-node12/`
- Node 20 migration (2023-09-22) — `https://github.blog/changelog/2023-09-22-github-actions-transitioning-from-node-16-to-node-20/`
- Node 20 deprecation (2025-09-19) — `https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/`
- Artifact v3 deprecation (2024-04-16) — `https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/`
- GitHub Actions breaking changes notice (2024-11-05) — `https://github.blog/changelog/2024-11-05-notice-of-breaking-changes-for-github-actions/`
- Immutable Actions / GHCR — `https://github.com/orgs/community/discussions/182046`

**CircleCI:**
- CircleCI 1.0 end-of-life support center — `https://support.circleci.com/hc/en-us/categories/360000531614-CircleCI-1-0-End-of-Life`
- CircleCI 2.0 GA announcement — `https://circleci.com/blog/launching-today-circleci-2-0-reaches-general-availability/`
- CircleCI 2.1 config overview — `https://discuss.circleci.com/t/circleci-2-1-config-overview/26057`
- CircleCI orbs concepts — `https://circleci.com/docs/orb-concepts/`
- Ubuntu 12.04 image EOL warning — `https://discuss.circleci.com/t/ubuntu-12-04-precise-build-image-end-of-life-warning/11668`

**Activepieces:**
- Breaking changes — `https://www.activepieces.com/docs/install/configuration/breaking-changes`
- activepieces releases — `https://github.com/activepieces/activepieces/releases`

*End of brief.*
