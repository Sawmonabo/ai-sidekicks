# ADR-020: V1 Deployment Model (OSS Self-Host + Hosted SaaS) and OSS License

| Field         | Value                                      |
| ------------- | ------------------------------------------ |
| **Status**    | `accepted`                                 |
| **Type**      | `Type 2 (one-way door)`                    |
| **Domain**    | `Deployment / Licensing / Product Posture` |
| **Date**      | `2026-04-17`                               |
| **Author(s)** | `Claude (AI-assisted)`                     |
| **Reviewers** | `Accepted 2026-04-17`                      |

## Context

The product ships a local-first collaborative agent runtime. Execution is always local (per ADR-002 `local-execution-shared-control-plane`); what varies by deployment is where the coordination control plane and relay run. `docs/architecture/deployment-topology.md` names four supported topologies: `Single-Participant Local`, `Collaborative Hosted Control Plane`, `Collaborative Self-Hosted Control Plane`, and `Relay-Assisted Remote Access`. The V1 scope decision (ADR-015) is about which features ship; this ADR is about how those features reach users.

Two product postures have been considered during V1 planning:

1. **Enterprise commercial-SaaS posture** — V1 ships as a hosted-only product, commercial support contracts, optional future self-host for paying enterprise customers. The pre-decision research evaluated this posture under an enterprise-commercial-SaaS cost model and recommended **Option B (V1 hosted-only, defer self-host to V1.1)** on vendor-support-cost grounds; the analytic content of that evaluation is preserved below in §Alternatives Option B (steel-man + rejection rationale) and the underlying primary sources are catalogued in §Research Conducted.

2. **OSS developer-tool posture** — V1 ships as an open-source project that any developer can `git clone`, install, and use either alone or with invited collaborators. The project optionally operates a hosted SaaS for users who prefer a managed experience. The research brief's recommendation was superseded after product framing clarified that (1) this is a developer-category OSS product, not an enterprise commercial platform; (2) the vendor-support-cost framing in the brief assumed an enterprise model that does not apply; (3) the competitive and category-positioning arguments for OSS are strong — Supabase, PostHog, Sentry, tmate, Mattermost, and GitLab have all built successful developer-category products on the one-codebase-two-deployment-options pattern.

This ADR formalizes the OSS developer-tool posture as the V1 deployment model.

Related architectural choices already in place:

- `deployment-topology.md` §Rate Limiting By Deployment already names an abstraction swap between Cloudflare-native `rate_limit` binding (hosted) and `rate-limiter-flexible` Postgres-backed (self-host).
- `deployment-topology.md` §Relay Scaling Strategy describes the Cloudflare Workers + Durable Objects sharded architecture for the project-operated relay.
- ADR-004 commits to SQLite for local state and Postgres for the shared control plane — both needed in both deployment options.

## Problem Statement

How is V1 delivered to users: hosted-only SaaS, OSS self-host-only, or both? Under what license? What is the first-run user experience for the choice?

### Trigger

- Pre-implementation architecture audit (2026-04-16) flagged deployment-option ambiguity as a P0 scope question blocking BL-044 (rate-limiter plan), BL-060 (self-host secure defaults), and downstream first-run UX work.
- Product framing clarified on 2026-04-17 that this is an OSS developer tool, not an enterprise commercial platform, which inverts the cost-benefit of the research brief's Option B recommendation.
- License-file commitment (`LICENSE` at repo root) and relay-infrastructure choice must land before public code push or community contribution can begin.

## Decision

V1 ships with **two deployment options** over a **single codebase** under a **permissive OSS license**.

### The Two Deployment Options

1. **Free self-hosted (OSS).** Users obtain the product via `git clone`, `npm install`, Homebrew formula, or direct release-binary download. The daemon defaults to a **project-operated free public relay** at a published URL so first-run collaboration is zero-configuration. Users can override via config (`RELAY_URL=…` or `--relay-url=…`) to point at their own self-hosted relay. Community-supported via GitHub Issues and Security Advisories; no SLA.
2. **Hosted SaaS.** The project operates the same codebase as a managed service at a separate URL. Users sign up, receive a scoped token, and their daemons point at the hosted control plane. Vendor-supported for paying customers.

The two options share one codebase and one 17-feature V1 surface (no feature-gating between free and hosted in V1).

### License

**MIT or Apache-2.0** at repo root from day one (final choice tracked in BL-083 Decision Log). Revisit only on concrete competitive re-hosting signal; the Sentry BSL→FSL precedent governs the reversal path if ever triggered.

### First-Run UX

On first invite (or explicit activation), the daemon presents a one-time **three-way choice**:

1. **Free public relay** (default) — use the project-operated free relay at a published URL.
2. **Self-host your own** — prompt for relay URL, admin token, CA bundle fingerprint for trust-on-first-use.
3. **Sign up for hosted** — open browser to sign-up flow, return scoped token via deep-link or local-loopback callback, store in OS keystore.

Choice persists in daemon config; never re-prompts unless explicitly reset via CLI. Full spec tracked in BL-081 (Spec-026 first-run onboarding).

### Relay Infrastructure

- **Project-operated free relay:** Cloudflare Workers + Durable Objects using the sharded control-DO + data-DOs architecture from `deployment-topology.md` §Relay Scaling Strategy.
- **Self-hostable relay:** Node.js WebSocket implementation of the same v2 relay protocol, shipped alongside the daemon in the same repo with a `docker-compose.yml` for single-command self-host. Tracked in BL-079 (Spec-025) and BL-080 (Plan-025).

Both backends implement the v2 relay protocol behind one shared contract so protocol-level changes land once and ship to both.

### Rate-Limiter Backends (Ships Both in V1)

- Hosted and project-operated relay: Cloudflare-native `rate_limit` binding.
- Self-hostable relay: `rate-limiter-flexible` with Postgres backend.

Both ship in V1 under the deployment-aware abstraction already named in `deployment-topology.md` §Rate Limiting By Deployment.

### Thesis — Why This Option

The product's natural market is developers building with agents, for themselves and for their collaborators. That audience's category expectation is OSS-first. Developer tools that succeed in this category (VS Code, Neovim, tmux, tmate, Supabase, PostHog, Sentry pre-BSL) ship as OSS with an optional hosted tier; tools that ship hosted-only into this category lose mindshare to OSS alternatives within 12–18 months. The one-codebase-two-deployment pattern is a proven precedent for how to do both at once without fragmenting engineering effort: the same binary runs in either mode; the difference is where the daemon points for collaboration.

Shipping a default project-operated relay makes the OSS self-host experience zero-config for the common case (git clone, invite a friend, it works). That preserves the developer-tool ergonomic bar. Users who want to own the whole stack can point at their own relay in one config flag. Users who want managed can sign up for hosted. Three paths, one codebase, one feature set.

MIT or Apache-2.0 as the starting license matches the category-norm for developer tools and signals open contribution. Reserving source-available relicensing (FSL, BSL, ELv2) for the competitive-re-host scenario follows the Sentry precedent; that scenario is a future contingency, not a V1 commitment.

### Antithesis — The Strongest Case Against

A staff engineer looking at V1 with both OSS self-host and hosted SaaS on the roadmap has legitimate concern: doing two things halfway is worse than doing one thing well. The research brief's Option B (V1 hosted-only) has a real argument: launching both tracks simultaneously doubles the QA matrix (two relay implementations, two rate-limiter backends, two first-run flows, two support channels), and community support drag alone can burn 20–30% of a small team's weekly capacity once the project has any traction. The managed-SaaS-first posture is how most successful commercial dev tools launched: Linear, Notion, Figma, Cursor, Warp — all hosted-only at V1, some opened self-host later, many never. Launching OSS with a hosted sidecar invites a distinct operational question (running infrastructure for users who did not pay) that commercial-SaaS-first avoids entirely.

### Synthesis — Why It Still Holds

The antithesis is the correct posture for a commercial-SaaS company whose value lies in being the sole provider of the managed experience. It is the wrong posture for a developer-category OSS product whose value lies in being the tool itself. Linear / Notion / Figma / Warp are not counter-examples — they are hosted-only products whose value is the hosted surface (sync, collaboration UX, account-side features). This product's value is the collaborative agent runtime, which works identically whether the relay runs on our infrastructure or the user's. Shipping OSS self-host alongside hosted SaaS costs some QA-matrix work (bounded, covered by the rate-limiter abstraction and the shared protocol contract) in exchange for category positioning that is hard to buy back later. The community-support drag is real but is actively managed via the Tripwires below — specifically, if drag exceeds 30% of weekly engineering capacity sustained, the free default relay itself becomes a candidate for deprecation.

The QA-matrix cost is structurally limited by the decision to put both relay backends behind one protocol contract. The implementation of the Node.js self-hostable relay is mostly "here is the WebSocket server loop and here is the Postgres rate-limiter wiring" — one codebase, not two.

## Alternatives Considered

### Option A: OSS Self-Host + Hosted SaaS, Single Codebase, Permissive License (Chosen)

- **What:** Decision above.
- **Steel man:** Matches developer-category norm; single codebase contains the full product; zero-config self-host via default relay preserves the git-clone-and-invite-a-friend ergonomic; hosted SaaS serves users who prefer managed; same V1 feature set in both; license open; revisit gates named.
- **Weaknesses:** QA matrix for two relay backends + two rate-limiter implementations (bounded by shared protocol contract); community-support drag if adoption is uneven; running a free relay is an operational cost the project bears; license commitment reduces future monetization flexibility.

### Option B: V1 Hosted-Only, Self-Host Deferred to V1.1 (Rejected — was the research brief's recommendation)

- **What:** Ship V1 as a hosted-only SaaS. Defer self-host to V1.1 or later. Research brief recommended this under an enterprise-commercial-SaaS cost model.
- **Steel man:** Smallest V1 surface; QA matrix is single-backend; no free-relay operational cost; matches how most successful commercial dev tools (Linear, Notion, Figma, Warp) launched; concentrates engineering effort on the one path users pay for.
- **Why rejected:** The cost-benefit in the brief was computed under an enterprise-commercial-SaaS posture where vendor-support cost is load-bearing. That posture does not apply here — this is an OSS developer tool, not an enterprise commercial product. Under the OSS posture, (1) there is no vendor-support commitment to monetize; (2) the product's value is the tool itself, which anyone-can-git-clone delivers without a hosted-SaaS wrapper; (3) OSS-first is the category norm in the developer-tools market, and launching hosted-only loses mindshare to whichever OSS alternative ships first in the same space. The Linear / Notion / Figma / Warp precedents do not transfer: those products' value is their hosted surface, not the underlying code.

### Option C: Full Enterprise Self-Hosted (Helm + OIDC + SAML + CVE contracts + vendor support) (Rejected)

- **What:** Ship V1 with enterprise-grade self-hosted deployment: Helm charts, OIDC/SAML compatibility matrix, WAF recommendations, HSM for operator signing keys, SOC 2 / compliance-framework mapping, vendor-support contracts with SLA, offline-root signing infrastructure.
- **Steel man:** Lets the project target enterprise buyers directly; opens commercial revenue; compliance features are hard to add later under community-support models.
- **Why rejected:** No named enterprise pipeline today justifies the 0.2–1 FTE sustained cost of maintaining enterprise compliance artifacts against an OSS developer-tool V1. Enterprise deployment is a future-optional path after V1 ships and pipeline signal materializes; at V1, it is speculation with a material cost. BL-060 explicitly lists enterprise-compliance items (SOC 2, OIDC/SAML, HSM, offline-root signing) as V1.1+ scope for this reason.

### Option D: No Default Relay (Users Must Bring Their Own Relay URL) (Rejected)

- **What:** OSS self-host with no project-operated free relay. Every user must run their own relay (or point at someone else's) before invites work.
- **Steel man:** Minimizes project operational cost; no community-support drag from free-tier users; cleanest license-commitment story (no "we run infrastructure for free users" question).
- **Why rejected:** Breaks the "git clone and invite a friend immediately" UX. First-run friction for this product is the ability to share a session with one click; requiring the user to first provision a relay before the first invite works is the same as asking them to set up a Postgres instance before sending an email. The free default relay is the operational cost that buys the category-positioning ergonomic.

### Option E: Pure P2P with STUN/TURN (No Relay at All) (Rejected)

- **What:** Every collaboration session is peer-to-peer over WebRTC, using STUN/TURN for NAT traversal.
- **Steel man:** No relay infrastructure to operate at all; lowest-possible project cost; strong privacy story (no intermediary).
- **Why rejected:** Approximately 30% of collaboration attempts over public networks are blocked by NAT configurations that STUN cannot punch and that require TURN fallback. TURN servers are relays by another name; the architecture still ends up operating a coordination endpoint. Pure-P2P also complicates the session-join handshake, participant-discovery flow, and offline-presence model that `deployment-topology.md` and Spec-008 already depend on. The relay is load-bearing; removing it does not remove the problem it solves.

## Assumptions Audit

| #   | Assumption                                                                                                                                             | Evidence                                                                                                                                                                                                                                                           | What Breaks If Wrong                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 1   | Target audience is developers who expect OSS-first tooling.                                                                                            | Vision's Product Goal section names "Codex and Claude support first" and targets software engineers building with agents; the developer-category norm for this audience is OSS tools with optional hosted tier (VS Code, Neovim, tmate, Supabase, Sentry pre-BSL). | Hosted-only posture (Option B) becomes more defensible; re-evaluate if audience signal skews enterprise-first. |
| 2   | One codebase can serve both deployment options without fragmenting engineering.                                                                        | Shared protocol contract + deployment-aware rate-limiter abstraction; precedents at Supabase, PostHog, Sentry, Mattermost, GitLab.                                                                                                                                 | QA matrix doubles; consider deprecating one path or moving to separate codebases.                              |
| 3   | A project-operated free relay is a manageable operational cost.                                                                                        | Cloudflare Workers + DO pricing is zero-cost at low usage and scales with traffic; sharded architecture keeps per-user cost bounded; per `deployment-topology.md` §Relay Scaling Strategy the expected throughput envelope fits free-tier / low-paid-tier budgets. | Free-relay cost outpaces budget; Tripwire 2 fires to deprecate the free default or scope it.                   |
| 4   | Community-support drag is bounded by decisions we control (scope of support, GitHub Issues triage cadence, deprecation of the free default if needed). | Sentry, PostHog, Supabase have managed this drag; explicit scope-of-support policies limit it.                                                                                                                                                                     | Community drag exceeds sustainable capacity; Tripwire 2 fires.                                                 |
| 5   | Permissive license (MIT or Apache-2.0) does not preclude future relicensing to FSL/BSL/ELv2 for the competitive-re-host case.                          | Sentry BSL→FSL precedent shows the path works; new code under new license, old code stays permissive, new-deployment enforcement via CLI bundling.                                                                                                                 | If enforcement proves impossible, revisit license pre-emptively.                                               |

## Failure Mode Analysis

| Scenario                                                                     | Likelihood | Impact | Detection                                                                    | Mitigation                                                                                                                                 |
| ---------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Competitor re-hosts codebase as competing managed service                    | Low–Med    | High   | Market monitoring; ToS audit of new hosted alternatives                      | Relicense new code to FSL/BSL/ELv2 per Sentry precedent; cease updating the permissive-licensed branch                                     |
| Free default relay becomes a meaningful cost drag                            | Low–Med    | Med    | Infrastructure cost tracking; Cloudflare usage dashboards                    | Tighten free-tier limits; introduce per-account rate quotas; as last resort, deprecate free default and require self-host-or-hosted-signup |
| Community-support drag exceeds capacity                                      | Med        | Med    | Weekly engineering-capacity-on-support metric; GitHub Issues triage-time SLA | Scope-of-support policy; paid-tier-only support escalation; issue-triage bot                                                               |
| Self-host deployment breaks in a production community environment            | Med        | High   | GitHub Issues; security-advisory monitoring                                  | Rapid security-advisory response; pinned-version LTS branch for conservative users                                                         |
| Hosted SaaS and OSS feature-parity drifts over time                          | Med        | Med    | Feature-parity test matrix in CI                                             | Policy: no hosted-only features in V1; feature-parity PR-gate                                                                              |
| Permissive license causes contributor-attribution or patent-litigation issue | Low        | High   | Legal review; dependency patent-risk scanner                                 | Apache-2.0 fallback (patent-grant protection); explicit CLA if needed                                                                      |

## Reversibility Assessment

- **Reversal cost:** License reversal is the highest-cost axis. Switching from MIT/Apache-2.0 to a source-available license (FSL/BSL/ELv2) requires dual-licensing new vs old code, contributor re-agreement under the new license, and market communication. Deployment-model reversal (dropping self-host, dropping hosted, dropping the free default relay) is medium cost — one code path deprecates, users migrate, documentation rewrites, but no user-data migration is required across the architectural axis.
- **Blast radius:** `LICENSE`, `README`, all source-file headers if license changes; `packages/relay-node/` or equivalent if self-host is dropped; free-relay infrastructure if the default is deprecated; first-run UX if the three-way choice changes.
- **Migration path:** License change follows the Sentry BSL→FSL precedent — new code under new license from a specific commit; old code remains under the permissive license forever. Deployment-model changes go through deprecation windows with CLI warnings, documented migration guides, and a published end-of-support timeline.
- **Point of no return:** First public code push under the chosen license locks the permissive grant for all code shipped under it. After that, only new code can be relicensed; the existing permissive-licensed code remains permissively licensed in perpetuity.

## Consequences

### Positive

- Category-positioning matches developer-tool norm; OSS-first signal to the target audience from day one.
- Any user can `git clone` and invite a collaborator with zero configuration (the default free relay delivers this).
- Hosted SaaS serves users who prefer managed, using the same codebase so engineering effort is not fragmented.
- Single 17-feature surface in both options; no feature-gating complexity.
- Shared protocol contract between Cloudflare-DO and Node-relay backends contains the QA-matrix cost.
- License choice (permissive) signals open contribution and matches the category norm.

### Negative (accepted trade-offs)

- Project operates a free default relay, which is an ongoing infrastructure cost (bounded by Cloudflare scaling pricing and by Tripwire 2 deprecation option).
- QA matrix has two relay backends and two rate-limiter backends (bounded by shared protocol contract and deployment-aware abstraction).
- Community-support channel (GitHub Issues / Security Advisories) is a public-facing support surface with no SLA commitment, which still attracts drag on engineering capacity.
- Permissive license reduces future monetization flexibility (reversible via Sentry-precedent relicensing if triggered).

### Unknowns

- Hosted-SaaS monthly-active-user trajectory 6 months post-launch — sets the Tripwire 3 signal level.
- Actual community-support drag rate — sets the Tripwire 2 signal level.
- Whether Apache-2.0 or MIT is the final license (BL-083 resolves).

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan (audience signal tracked post-launch; cost/drag tracked via metrics; feature-parity via CI)
- [x] At least one alternative was seriously considered and steel-manned (Options B–E all steel-manned)
- [x] Antithesis was reviewed (Thesis/Antithesis/Synthesis triad in the Decision section)
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified

### Success Criteria

| Metric                                         | Target                                                                                                   | Measurement Method        | Check Date   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------- | ------------ |
| OSS self-host zero-config first-run flow works | 100% of new-user smoke tests pass `git clone → docker compose up → invite peer → collaboration succeeds` | CI smoke-test job         | `2026-09-01` |
| Hosted-SaaS monthly active users               | Above named floor (to be set in V1 launch plan)                                                          | Hosted-SaaS telemetry     | `2027-01-01` |
| Community-support drag                         | ≤ 30% of weekly engineering capacity, rolling 4-week average                                             | Engineering-time tracking | `2027-01-01` |
| Feature-parity between hosted and self-host    | 100% of V1 features work identically                                                                     | Feature-parity CI suite   | `2026-09-01` |

### Tripwires (Revisit Triggers)

1. **Competitor materially re-hosts our code as a competing managed service with measurable revenue impact.** — Relicense new code to FSL, BSL, or ELv2 per the Sentry precedent; the existing permissive-licensed commits remain permissive.
2. **Community-support drag exceeds 30% of weekly engineering capacity for 4+ consecutive weeks.** — Tighten OSS scope of support; scope-of-support policy published; paid-tier-only escalation; as last resort, deprecate the free default relay in favor of self-host-only (users still run self-host freely; the project simply stops operating the free default).
3. **Hosted-SaaS monthly active users stays below a named threshold 6 months post-launch.** — Reconsider monetization shape before V1.1 planning; options include (a) keep OSS self-host, drop hosted SaaS; (b) reshape hosted-SaaS pricing or feature gating; (c) pursue enterprise-self-host paid tier.

## References

### Research Conducted

| Source                                                       | Type                 | Key Finding                                                                                                                                                                                                  | URL/Location                                                                                                      |
| ------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Supabase self-host                                           | Precedent            | OSS core + hosted SaaS on one codebase; Apache-2.0 license                                                                                                                                                   | <https://supabase.com/docs/guides/self-hosting>                                                                   |
| PostHog self-host                                            | Precedent            | OSS core + hosted SaaS; MIT with later re-license                                                                                                                                                            | <https://posthog.com/docs/self-host>                                                                              |
| Sentry OSS → BSL → FSL                                       | Precedent            | Source-available relicensing path when competitive re-hosting materializes                                                                                                                                   | <https://sentry.io/_/open-source/>                                                                                |
| tmate                                                        | Precedent            | OSS terminal-sharing with free default relay + self-host option                                                                                                                                              | <https://tmate.io/>                                                                                               |
| Mattermost                                                   | Precedent            | OSS + paid-tier two-deployment model                                                                                                                                                                         | <https://mattermost.com/>                                                                                         |
| Cloudflare Workers + Durable Objects                         | Documentation        | Sharded relay architecture used for project-operated free relay                                                                                                                                              | <https://developers.cloudflare.com/durable-objects/>                                                              |
| `rate-limiter-flexible`                                      | Documentation        | Postgres/Redis backends for self-host rate limiting                                                                                                                                                          | <https://github.com/animir/node-rate-limiter-flexible>                                                            |
| Cursor Enterprise page                                       | Vendor announcement  | Direct quote: "we don't offer on-premises deployment today." Anchors the Antithesis/Synthesis claim that the modal greenfield collaborative dev tool ships hosted-only at V1                                 | <https://cursor.com/enterprise>                                                                                   |
| The Agency Journal — Cursor March 2026 self-hosted agents    | Vendor announcement  | Cursor March 2026: agent runtime moves to customer network; control plane stays in Cursor cloud — matches our ADR-002 trust-boundary shape (local execution, shared control plane)                           | <https://theagencyjournal.com/cursors-march-2026-glow-up-self-hosted-agents-jetbrains-love-and-smarter-composer/> |
| Superblocks — Cursor Enterprise Review 2026                  | Engineering blog     | Cursor Enterprise tier offers air-gapped agent-runtime deployment, not control-plane self-host; supports the "control plane stays hosted" pattern                                                            | <https://www.superblocks.com/blog/cursor-enterprise>                                                              |
| Windsurf Enterprise Security Report (2025)                   | Engineering blog     | Windsurf ships SOC 2 Type II + FedRAMP High + cloud + hybrid + self-hosted (air-gap); Antithesis competitor signal in the regulated-enterprise-coding tier                                                   | <https://harini.blog/2025/07/02/windsurf-detailed-enterprise-security-readiness-report/>                          |
| Sourcegraph Cloud blog post                                  | Counter-data point   | Sourcegraph: 8 years self-host-only (2013–2021); ~10% of revenue on Cloud at disclosure (90% remained self-host). Counter-evidence for the cannibalization-pattern argument                                  | <https://sourcegraph.com/blog/enterprise-cloud>                                                                   |
| Deiser — Atlassian Data Center End of Life                   | Vendor announcement  | Atlassian DC EOL timeline (2025-12-16 → 2029-03-28): even the largest dev-tool-enterprise vendor judges sustained self-host indefensible at maturity                                                         | <https://blog.deiser.com/en/atlassian-data-center-end-of-life-migrate-to-cloud>                                   |
| Plane.so vs Linear comparison                                | Engineering blog     | Linear ships SaaS-only in 2026; self-host alternatives (Plane, OpenProject) exist but do not dominate. Anchors the Antithesis Linear-as-SaaS-only example                                                    | <https://plane.so/plane-vs-linear>                                                                                |
| Zed self-hosted collaboration discussion #13503              | GitHub Issue         | Zed cloud-only collaboration first; community demand for self-host exists, no roadmap commitment. Directly the pattern Option B was modeled on                                                               | <https://github.com/zed-industries/zed/discussions/13503>                                                         |
| Tabby ML GitHub repo                                         | Precedent            | Tabby ML self-hosted-first; Apache-2.0 + `ee/` LICENSE split (open-core pattern). Precedent for OSS developer-tool self-host with narrow operational scope                                                   | <https://github.com/TabbyML/tabby>                                                                                |
| Continue.dev GitHub repo                                     | Precedent            | Continue.dev: Apache 2.0 self-host instructions; cloud Teams plan as monetized wrapper. Permissive-OSS-with-hosted-tier precedent                                                                            | <https://github.com/continuedev/continue>                                                                         |
| Warp Enterprise docs                                         | Documentation        | Warp documents cloud + self-hosted + hybrid models in enterprise tier; supports the multi-mode-deployment pattern for AI-terminal competitors                                                                | <https://docs.warp.dev/enterprise/enterprise-features/architecture-and-deployment>                                |
| Pulumi — IaC comparisons (Business Critical plan)            | Documentation        | Pulumi self-host gated to top-tier "Business Critical" enterprise plan; precedent for monetization-via-tier rather than license-segmentation                                                                 | <https://www.pulumi.com/docs/iac/comparisons/terraform/>                                                          |
| Replit Enterprise                                            | Vendor announcement  | Replit: dedicated single-tenant GCP project model + EU data residency (no true on-prem) — alternative to self-host that some enterprise buyers accept                                                        | <https://replit.com/enterprise>                                                                                   |
| Sirius Open Source — How much does GitLab cost?              | Engineering blog     | GitLab self-managed minimum annual TCO exceeds SaaS license cost by ~$82K from internal ops labor; supports the §Antithesis ongoing-cost framing                                                             | <https://www.siriusopensource.com/en-us/blog/how-much-does-gitlab-cost>                                           |
| GitLab Self-managed Scalability Working Group handbook       | Primary source       | GitLab's self-managed scalability work spans support, quality, development, product, and technical-writing roles; structural evidence for the "self-host is multi-team commitment" claim                     | <https://handbook.gitlab.com/handbook/company/working-groups/self-managed-scalability/>                           |
| GitHub Enterprise Server 3.14 docs                           | Documentation        | GitHub Enterprise Server requires dedicated IT, ≥30-min maintenance windows; higher TCO vs Cloud — supports the Antithesis ongoing-cost argument                                                             | <https://docs.github.com/en/enterprise-server@3.14/admin/overview/about-github-enterprise-server>                 |
| Cotera — PostHog Self-Hosted: Worth the Ops Overhead?        | Engineering blog     | PostHog self-host retrospective: 6–8 hrs/month maintenance; weekend incident response; concrete ongoing-cost figure underlying the §Antithesis 20–30% capacity claim                                         | <https://cotera.co/articles/posthog-self-hosted-guide>                                                            |
| Vela/Simplyblock — Self-Hosting Supabase vs Managed Postgres | Engineering blog     | Self-hosting Supabase: 5–10 hrs/month; 1–2 FTE for larger orgs; full ops surface beyond DB; supports §Antithesis ongoing-cost claim                                                                          | <https://vela.simplyblock.io/articles/self-hosting-supabase/>                                                     |
| Checkthat.ai — PostHog pricing analysis 2026                 | Engineering blog     | ~90% of PostHog users are on Cloud despite OSS self-host availability — quantitative anchor for the hosted-revenue-still-dominates pattern in §Synthesis                                                     | <https://checkthat.ai/brands/posthog/pricing>                                                                     |
| PostHog — Self-host open-source support                      | Documentation        | PostHog OSS self-host is MIT-licensed and explicitly unsupported (community via GitHub Issues, not support tickets); supplements the generic PostHog precedent row with the explicit-unsupported posture URL | <https://posthog.com/docs/self-host/open-source/support>                                                          |
| Vanta 2025 survey via CloudEagle — SOC 2 Audit Guide         | Primary research     | 83% of enterprise buyers require SOC 2 cert; 67% of certified startups report direct deal-closure impact — anchors the enterprise-buyer-baseline framing in §Antithesis                                      | <https://www.cloudeagle.ai/blogs/soc-2-audit>                                                                     |
| Akave — 2026 Data Sovereignty Reckoning                      | Engineering blog     | 73% of EU enterprises prioritize data sovereignty over convenience; CLOUD Act exposes US-HQ SaaS — anchors the EU-sovereignty driver behind self-host demand                                                 | <https://akave.com/blog/the-2026-data-sovereignty-reckoning>                                                      |
| SSOjet — Enterprise Ready SSO Complete Requirements Guide    | Documentation        | OIDC + SAML are 2025–2026 enterprise SSO table-stakes; 90% of SaaS buyers prioritize standards-based SSO — anchors Option C OIDC/SAML rejection rationale                                                    | <https://ssojet.com/enterprise-ready/oidc-and-saml-integration-multi-tenant-architectures>                        |
| Sentry — Introducing the Functional Source License           | Vendor announcement  | Sentry's FSL rationale: "freedom without free-riding"; 2-year change to Apache/MIT — anchors the Tripwire 1 BSL/FSL relicensing reversal path                                                                | <https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/>                   |
| Sentry — Re-Licensing Sentry                                 | Vendor announcement  | Sentry BSL rationale: "competitive elements that threaten the future of Sentry"; relicensing preserves user freedom — anchors Sentry-precedent claim in §License + Tripwire 1 + Decision Log                 | <https://blog.sentry.io/relicensing-sentry/>                                                                      |
| Elastic blog — Elastic License v2                            | OSS license analysis | ELv2 rationale; Elastic re-added AGPL v3 in Sept 2024 alongside ELv2 and SSPL — supports the source-available license option-space named in §Decision                                                        | <https://www.elastic.co/blog/elastic-license-v2>                                                                  |
| HashiCorp BSL 1.1                                            | OSS license analysis | HashiCorp BSL precedent; 4-year change date to GPL-compatible — supports BSL option named in §Reversibility + §License                                                                                       | <https://www.hashicorp.com/en/bsl>                                                                                |
| Cloudflare blog — Durable Objects: Easy, Fast, Correct       | Documentation        | DO single-writer semantics: "exactly one location, one single thread, at a time"; input/output gates — supplements the generic CF DO row with the semantic-properties URL                                    | <https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/>                                     |
| Cloudflare miniflare / workerd                               | GitHub Issue         | workerd DO storage caveat: not production-suitable in 2026; DOs always run on the same machine as requested — anchors why a CF-DO-as-self-host shortcut is not viable                                        | <https://github.com/cloudflare/miniflare>                                                                         |
| Cloudflare PartyKit / PartyServer                            | GitHub Issue         | PartyKit is open-source DO wrapper, NOT a DO replacement — anchors why a self-hostable PartyKit shortcut does not apply                                                                                      | <https://github.com/cloudflare/partykit>                                                                          |
| Ably — Scaling Pub/Sub with WebSockets and Redis             | Engineering blog     | Industry-standard Node.js + Redis pubsub + WebSocket hub pattern for self-hosted DO replacement — anchors the chosen Node-relay self-host implementation pattern                                             | <https://ably.com/blog/scaling-pub-sub-with-websockets-and-redis>                                                 |
| `rate-limiter-flexible` — PostgreSQL backend wiki            | Documentation        | RLF Postgres benchmark: ~995 req/sec average, p95 21.85ms — adequate for V1 500/sec write target; deepens the generic RLF row with the specific Postgres-backend benchmark URL                               | <https://github.com/animir/node-rate-limiter-flexible/wiki/PostgreSQL>                                            |

### Related ADRs

- [ADR-002: Local Execution, Shared Control Plane](./002-local-execution-shared-control-plane.md) — trust-boundary framing that makes the self-host + hosted split coherent.
- [ADR-004: SQLite Local State, Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md) — persistence layer shared across both deployment options.
- [ADR-015: V1 Feature Scope Definition](./015-v1-feature-scope-definition.md) — the 17-feature V1 surface that both deployment options ship.

### Related Docs

- [Deployment Topology](../architecture/deployment-topology.md) — `Collaborative Hosted Control Plane` and `Collaborative Self-Hosted Control Plane` topology rows cross-link to this ADR per BL-053 Exit Criteria.
- [V1 Feature Scope](../architecture/v1-feature-scope.md) — Deployment Options section cites this ADR per BL-053 Exit Criteria.
- [Spec-008: Control Plane Relay and Session Join](../specs/008-control-plane-relay-and-session-join.md) — v2 relay protocol that both relay backends implement.
- [Spec-021: Rate Limiting Policy](../specs/021-rate-limiting-policy.md) — deployment-aware rate-limiter abstraction.
- [Spec-027: Self-Host Secure Defaults](../specs/027-self-host-secure-defaults.md) — normative secure-defaults posture for the `Collaborative Self-Hosted Control Plane` topology committed to by this ADR; operator-facing companion at [Operations › Self-Host Secure Defaults](../operations/self-host-secure-defaults.md) (Spec-027 Acceptance Criterion).
- [BL-044](../archive/backlog-archive.md) — Plan-021 Rate Limiting (ships both backends in V1).
- [BL-060](../archive/backlog-archive.md) — secure-by-default behaviors for self-host deployment.
- [BL-079 / BL-080](../archive/backlog-archive.md) — Spec-025 + Plan-025 self-hostable Node relay (this ADR's self-host implementation).
- [BL-081 / BL-082](../archive/backlog-archive.md) — Spec-026 + Plan-026 first-run three-way-choice onboarding (this ADR's UX implementation).
- [BL-083](../archive/backlog-archive.md) — commit OSS `LICENSE` at repo root (this ADR's license deliverable).

## Decision Log

| Date       | Event                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-16 | Research conducted        | Comparable-product survey, ongoing-cost evidence, Cloudflare Durable Object portability analysis, license option-space evaluation, and timing analysis (V1 vs V1.1) recommended Option B (V1 hosted-only) under an enterprise-commercial-SaaS cost model. The analysis is preserved in [§Alternatives Option B](#option-b-v1-hosted-only-self-host-deferred-to-v11-rejected-was-the-research-briefs-recommendation) above (steel-man + rejection rationale) and the supporting primary sources are catalogued in [§Research Conducted](#research-conducted) above                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-04-17 | Product framing clarified | OSS developer-tool posture; not enterprise-commercial-SaaS; research brief Option B recommendation superseded on this basis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-04-17 | Proposed                  | Drafted against BL-053 exit criteria                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-04-17 | Accepted                  | ADR accepted as V1 deployment model + OSS license commitment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-04-17 | LICENSE committed         | Apache-2.0 chosen per BL-083. Rationale: (a) explicit patent grant (§3) protects contributors and users from patent litigation by other contributors — a concrete advantage MIT does not provide; (b) §5 codifies inbound-is-outbound contribution semantics, reducing the need for a separate CLA for casual contributors; (c) dominant choice in modern developer-tool OSS (Kubernetes, Supabase, Terraform-pre-BSL-era); (d) SPDX identifier `Apache-2.0` recognized by all major dependency scanners. MIT considered as the alternative and rejected — the patent-grant protection matters more than MIT's marginally-cleaner GPL-compatibility story for this contributor-rich developer-tool category. `LICENSE` file at repo root contains the verbatim canonical Apache-2.0 text (appendix instantiated with `Copyright 2026 AI Sidekicks contributors`); root `package.json` `license` field set to `Apache-2.0`; `README.md` §License links to `./LICENSE` and this ADR |
