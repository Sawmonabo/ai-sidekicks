# ADR-019: V1 Deployment Model and OSS License

| Field         | Value                                      |
| ------------- | ------------------------------------------ |
| **Status**    | `accepted`                                 |
| **Type**      | `Type 2 (one-way door)`                    |
| **Domain**    | `Deployment / Licensing / Product Posture` |
| **Date**      | `2026-04-17`                               |
| **Author(s)** | `Claude (AI-assisted)`                     |
| **Reviewers** | `Accepted 2026-04-17`                      |

## Context

The product ships an agentic coding runtime for one user and their agents. Execution is always local (per ADR-002 `local-execution-shared-control-plane`); what varies by deployment is where the coordination control plane and relay run. `docs/architecture/deployment-topology.md` names four supported topologies: `Single-Device Local`, `Workers Relay`, `Compose Relay`, and `Relay-Assisted Remote Access`. The V1 scope decision (ADR-014) is about which features ship; this ADR is about how those features reach users.

Two product postures are possible:

1. **Enterprise commercial-SaaS posture** — V1 ships as a hosted-only product, commercial support contracts, optional future self-host for paying enterprise customers. Under an enterprise-commercial-SaaS cost model this posture favors **Option B (V1 hosted-only)** on vendor-support-cost grounds; that case is in §Alternatives Option B (steel-man + rejection rationale), and its primary sources are in §Research Conducted.

2. **OSS developer-tool posture** — V1 ships as an open-source project that any developer can install and use from any of their linked devices, with a relay they deploy for themself. The product framing settles it: (1) this is a developer-category OSS product for one user, not an enterprise commercial platform; (2) the vendor-support-cost framing assumes an enterprise model that does not apply; (3) the competitive and category-positioning arguments for OSS are strong — Supabase, PostHog, Sentry, tmate, Mattermost, and GitLab have all built successful developer-category products that people run on their own infrastructure.

This record takes the OSS developer-tool posture as the V1 deployment model.

Related architectural choices already in place:

- `deployment-topology.md` §Rate Limiting By Deployment names where each relay counts its sign-in routes: the per-identity Durable Object on the Workers relay, memory on the Compose relay.
- `deployment-topology.md` §Relay Scaling Strategy describes how the Workers relay uses Cloudflare Workers + Durable Objects for one person: one Durable Object for the account.
- ADR-004 commits to SQLite for local state and Postgres for the control plane on the Compose relay.

## Problem Statement

How is V1 delivered: where does the person's relay run, under what license, and how does a machine first reach its relay?

### Trigger

- Deployment-option ambiguity blocks the rate-limiter plan, the self-host secure-defaults work, and downstream first-run UX.
- The product is an OSS developer tool for one user, not an enterprise commercial platform, which inverts the cost-benefit behind Option B under the enterprise cost model.
- License-file commitment (`LICENSE` at repo root) and relay-infrastructure choice must land before public code push or community contribution can begin.

## Decision

V1 ships as a **single codebase** under a **permissive OSS license**, and its relay is **the person's own**: they deploy it for themself in one of **two ways**.

### The Two Deployment Options

1. **The Workers relay, in the person's own Cloudflare account.** Cloudflare Workers + Durable Objects, deployed by the person for themself: nothing to keep running at home, and no open port.
2. **The Compose relay, on the person's own server.** Node, Caddy and Postgres from one `docker-compose.yml`: everything on hardware the person holds.

The person picks per setup, and can switch a machine between them. The daemon points at its relay through config (`RELAY_URL=…` or `--relay-url=…`). Both relays run one protocol from one codebase and serve the same feature set, with one difference the person sees: shared ports in the web client exist only on the Compose relay, and on the Workers relay the web client says so. Community-supported via GitHub Issues and Security Advisories; no SLA.

A relay serving other people — a project-operated public relay, or a hosted service for paying customers — is out of scope for one user, and so are billing, bans, per-person credentials and third-party witnessing of the audit log.

### License

**Apache-2.0** at repo root from day one. MIT was the alternative and was rejected: Apache-2.0's explicit patent grant (§3) protects contributors and users from patent litigation by other contributors, §5 codifies inbound-is-outbound contribution semantics so a separate CLA is not needed for casual contributors, it is the dominant choice in modern developer-tool OSS, and the SPDX identifier `Apache-2.0` is recognized by every major dependency scanner — all of which outweigh MIT's marginally cleaner GPL-compatibility story for a contributor-rich developer-tool category. The `LICENSE` file at the repo root carries the verbatim canonical Apache-2.0 text, the root `package.json` `license` field is `Apache-2.0`, and [README.md §License](../../README.md) links to both. Revisit only on concrete competitive re-hosting signal; the Sentry BSL→FSL precedent governs the reversal path if ever triggered.

Runtime and bundled dependencies stay inside the MIT / Apache-2.0 / BSD / ISC norm this commitment assumes. Three waivers stand. The first: `axe-core` (MPL-2.0) is admitted as a **never-distributed devDependency** of `apps/desktop` for the console's accessibility test tier ([Desktop App Implementation Notes §Console Test Tiers](../architecture/desktop-implementation-notes.md#console-test-tiers)), because it ships in no release artifact and is linked into no distributed bundle, so no MPL file-level copyleft obligation attaches to anything a user receives. A runtime or bundled use of an MPL-2.0 package is not covered by that waiver. The second: `@ibm/plex-sans-variable` 0.2.0 and `@ibm/plex-mono-variable` 1.0.0, both SIL Open Font License 1.1, supply the two faces the console self-hosts ([Desktop App Implementation Notes §Console Libraries](../architecture/desktop-implementation-notes.md#console-libraries)); the font bytes ship, so this is a bundled outside-norm use and takes its own entry. The waiver holds because OFL-1.1's obligations are met by construction: the faces ship **unmodified** (at these pins the SHA-256 of all four emitted faces matches the package sources byte for byte), so the Reserved Font Name clause is not engaged; each package carries its own `LICENSE.txt` and declares `"license": "OFL-1.1"`; the packages are `devDependencies` so their `@ibm/telemetry-js` runtime dependency never enters the artifact; and **the packaged application reproduces the license text**, an obligation on the packaging configuration. The third: the ELK layout engine compiled into `@mermanjs/web-render` 0.8.0 (`merman-elk-layered`, a Rust translation of Eclipse ELK, EPL-2.0; merman's notices also list elkjs, EPL-2.0, as the reference its ELK adapter is compared against) and the KaTeX math fonts bundled with it (OFL-1.1), which draw a reply's diagrams ([ADR-042](./042-diagrams-drawn-by-merman.md)); the package itself is MIT OR Apache-2.0. The waiver holds because both stay separate, unmodified modules, so nothing of ours becomes a derivative work under EPL-2.0, and their obligations are met by the packaged application's third-party notices: merman's own `THIRD_PARTY_NOTICES.md` and the license texts in its `THIRD_PARTY_LICENSES/` folder reproduced in full, and, as EPL-2.0 §3.1 requires of a program distributed other than as source, a statement that the compiled ELK ships under EPL-2.0, not under this repository's Apache-2.0, with its source available at merman's release the app ships.

### First-Run UX

The machine signs in to the person's relay from the command line: `sidekicks sign-in` runs the device-code flow. It prints a code and an address, opens the address in the browser where one exists, and waits. Sign-in is refused while the service holds the data folder, naming `sidekicks daemon stop` or Runtime's `Stop`.

The daemon pins the relay's TLS key only when the relay's certificate does not chain to a root the operating system trusts (a self-signed relay, or one on a private certificate authority), because Caddy makes a new key at every renewal. A relay with a publicly trusted certificate is checked by the platform's own certificate validation and its host name, so a renewal never trips a refusal. When a pinned relay presents a different key, the daemon refuses the connection and records `relay.pin_refused {relayHost, pinnedSpkiPrefix, presentedSpkiPrefix}` on its sentinel session, each prefix the first 8 bytes of its hash, never a token; the error code is `relay.spki_mismatch` (412). `sidekicks daemon status` prints `refused: the relay's key does not match the one pinned when it was linked`, and the recovery is `sidekicks relay repin --force` with the new hash pasted. This pin is the transport's; the machine-key pin of the encrypted channel ([Spec-027](../specs/027-remote-control.md)) holds on both relays whatever their certificate.

### Relay Infrastructure

- **Workers relay:** Cloudflare Workers + Durable Objects, one Durable Object for the account as `deployment-topology.md` §Relay Scaling Strategy lays out, deployed into the person's own Cloudflare account.
- **Compose relay:** Node.js WebSocket implementation of the same v2 relay protocol, shipped alongside the daemon in the same repo with a `docker-compose.yml` (Node, Caddy, Postgres) for single-command deployment on the person's own server. Its Caddy takes `ACME_PROFILE`, empty by default, which leaves Caddy's own profile; `shortlived` requests Let's Encrypt's 160-hour certificates.

Both backends implement the v2 relay protocol behind one shared contract so protocol-level changes land once and ship to both.

Both relays hold the same admission rules:

- The relay counts requests on its sign-in routes (sign-in, token refresh, device linking) only, and answers one past the limit with 429 and a retry time. On the Workers relay they count in the per-identity Durable Object, one global counter that rotating edge locations does not reset; on the one-process Compose relay they count in memory. A counter error fails that one request like any backend error.
- On the WebSocket the relay sees only encrypted frames and counts none of them. The machine reads each method inside the sealed connection and keeps the last `presence.heartbeat` per device.
- The relay forwards each device's frames as fast as the machine drains them; backpressure on the channel bounds frames and bytes in both directions.

### Rate-Limiter Backends (Ships Both in V1)

- Workers relay: the per-identity Durable Object for the sign-in routes.
- Compose relay: `InMemoryRateLimiter`, a sliding window per source address in the one relay process, for the same routes. No library: `rate-limiter-flexible`'s memory limiter counts a fixed window, and both relays answer one sliding-window `RateLimiter` contract whose retry time is when the oldest counted request ages out.

Both ship in V1 under the deployment-aware abstraction already named in `deployment-topology.md` §Rate Limiting By Deployment.

### Thesis — Why This Option

The product's natural market is developers building with agents. That audience's category expectation is OSS-first. Developer tools that succeed in this category (VS Code, Neovim, tmux, tmate, Supabase, PostHog, Sentry pre-BSL) ship as OSS that people run on their own machines; tools that ship hosted-only into this category lose mindshare to OSS alternatives within 12–18 months. The same binary runs against either relay; the only difference is where the daemon points for remote access.

A relay the person deploys for themself keeps their traffic on infrastructure they hold. The Workers relay asks for a Cloudflare account and nothing kept running at home; the Compose relay keeps everything on the person's own hardware. Two relays, one codebase, one protocol, one feature set.

A permissive license matches the category-norm for developer tools and signals open contribution. Reserving source-available relicensing (FSL, BSL, ELv2) for the competitive-re-host scenario follows the Sentry precedent; that scenario is a future contingency, not a V1 commitment.

### Antithesis — The Strongest Case Against

Asking the person to deploy a relay before a phone can reach their machine is friction a project-operated default relay would remove: the category's zero-config expectation (install, link a phone, it works) points at running a public relay for everyone. Two relay implementations also double part of the QA matrix (two relay backends, two rate-limiter backends), and community support drag alone can burn 20–30% of a small team's weekly capacity once the project has any traction. The managed-SaaS-first posture is how most successful commercial dev tools launched: Linear, Notion, Figma, Cursor, Warp — all hosted-only at V1, some opened self-host later, many never.

### Synthesis — Why It Still Holds

A public relay serves other people, and serving other people brings billing, bans, per-person credentials and witnessing that one user does not need. Linear / Notion / Figma / Warp are not counter-examples — they are hosted-only products whose value is the hosted surface (sync, collaboration UX, account-side features). This product's value is the agent runtime itself, which works identically on either relay. The Workers relay deploys into the person's own Cloudflare account with nothing to keep running, which keeps the setup cost to one deployment. Two relays cost some QA-matrix work (bounded, covered by the rate-limiter abstraction and the shared protocol contract). The community-support drag is real and is managed via the Tripwires below.

The QA-matrix cost is structurally limited by the decision to put both relay backends behind one protocol contract. The implementation of the Node.js self-hostable relay is mostly "here is the WebSocket server loop and here is the in-memory sign-in counter" — one codebase, not two.

## Alternatives Considered

### Option A: The Person's Own Relay (Workers or Compose), Single Codebase, Permissive License (Chosen)

- **What:** Decision above.
- **Steel man:** Matches developer-category norm; single codebase contains the full product; the person's traffic stays on infrastructure they hold; the Workers relay needs no server of their own; same V1 feature set on both relays; license open; revisit gates named.
- **Weaknesses:** QA matrix for two relay backends + two rate-limiter implementations (bounded by shared protocol contract); community-support drag if adoption is uneven; the person deploys a relay before a second device can reach the machine; license commitment reduces future monetization flexibility.

### Option B: V1 Hosted-Only (Rejected)

- **What:** Ship V1 as a hosted-only service the project runs for its users. An enterprise-commercial-SaaS cost model favors this.
- **Steel man:** Smallest V1 surface; QA matrix is single-backend; nothing for the person to deploy; matches how most successful commercial dev tools (Linear, Notion, Figma, Warp) launched; concentrates engineering effort on one path.
- **Why rejected:** A hosted service serves other people, which is out of scope for one user, and the enterprise-commercial-SaaS posture its cost model assumed does not apply to an OSS developer tool: (1) there is no vendor-support commitment to monetize; (2) the product's value is the tool itself, which the person runs without a hosted wrapper; (3) OSS-first is the category norm in the developer-tools market, and launching hosted-only loses mindshare to whichever OSS alternative ships first in the same space. The Linear / Notion / Figma / Warp precedents do not transfer: those products' value is their hosted surface, not the underlying code.

### Option C: Full Enterprise Self-Hosted (Helm + OIDC + SAML + CVE contracts + vendor support) (Rejected)

- **What:** Ship V1 with enterprise-grade self-hosted deployment: Helm charts, OIDC/SAML compatibility matrix, WAF recommendations, HSM for the person's signing keys, SOC 2 / compliance-framework mapping, vendor-support contracts with SLA, offline-root signing infrastructure.
- **Steel man:** Lets the project target enterprise buyers directly; opens commercial revenue; compliance features are hard to add later under community-support models.
- **Why rejected:** Enterprise deployment serves an organization's many users, and the product has one. Enterprise sign-on (OIDC/SAML), compliance mapping (SOC 2), HSM custody, WAF recommendations, Helm charts, an SLA and offline-root signing infrastructure are out of scope for one user.

### Option D: A Project-Operated Public Relay as the Default (Rejected)

- **What:** The project runs a free public relay at a published address, and every install points at it by default.
- **Steel man:** Zero-configuration first run: install, link a phone, it works, with no Cloudflare account or server of the person's own.
- **Why rejected:** A public relay serves other people, which is out of scope for one user. It brings the bans, per-person credentials, abuse handling and billing pressure the product does not carry, and it puts the person's traffic on infrastructure they do not hold. The Workers relay keeps the first run to one deployment into the person's own Cloudflare account.

### Option E: Pure P2P with STUN/TURN (No Relay at All) (Rejected)

- **What:** Every device-to-machine session is peer-to-peer over WebRTC, using STUN/TURN for NAT traversal.
- **Steel man:** No relay infrastructure to operate at all; lowest-possible project cost; strong privacy story (no intermediary).
- **Why rejected:** Approximately 30% of connection attempts over public networks are blocked by NAT configurations that STUN cannot punch and that require TURN fallback. TURN servers are relays by another name; the architecture still ends up operating a coordination endpoint. Pure-P2P also complicates the device-link handshake, the relay-endpoint negotiation, and the device-liveness model that `deployment-topology.md` and [Spec-027](../specs/027-remote-control.md) already depend on. The relay is load-bearing; removing it does not remove the problem it solves.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Target audience is developers who expect OSS-first tooling. | Vision's Product Goal section names "Codex and Claude support first" and targets software engineers building with agents; the developer-category norm for this audience is OSS tools with optional hosted tier (VS Code, Neovim, tmate, Supabase, Sentry pre-BSL). | Hosted-only posture (Option B) becomes more defensible; re-evaluate if audience signal skews enterprise-first. |
| 2 | One codebase can serve both relays without fragmenting engineering. | Shared protocol contract + deployment-aware rate-limiter abstraction; precedents at Supabase, PostHog, Sentry, Mattermost, GitLab. | QA matrix doubles; consider dropping one relay. |
| 3 | One person's traffic fits a Cloudflare account's low-usage pricing. | Cloudflare Workers + DO pricing is zero-cost at low usage and scales with traffic; per `deployment-topology.md` §Relay Scaling Strategy the expected throughput envelope fits free-tier / low-paid-tier budgets. | The Workers relay costs the person more than a small server; the Compose relay is the cheaper path. |
| 4 | Community-support drag is bounded by decisions we control (scope of support, GitHub Issues triage cadence). | Sentry, PostHog, Supabase have managed this drag; explicit scope-of-support policies limit it. | Community drag exceeds sustainable capacity; Tripwire 2 fires. |
| 5 | A permissive license does not preclude future relicensing to FSL/BSL/ELv2 for the competitive-re-host case. | Sentry BSL→FSL precedent shows the path works; new code under new license, old code stays permissive, new-deployment enforcement via CLI bundling. | If enforcement proves impossible, revisit license pre-emptively. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Competitor re-hosts codebase as competing managed service | Low–Med | High | Market monitoring; ToS audit of new hosted alternatives | Relicense new code to FSL/BSL/ELv2 per Sentry precedent; cease updating the permissive-licensed branch |
| Community-support drag exceeds capacity | Med | Med | Weekly engineering-capacity-on-support metric; GitHub Issues triage-time target | Scope-of-support policy; issue-triage bot |
| Self-host deployment breaks in a production community environment | Med | High | GitHub Issues; security-advisory monitoring | Rapid security-advisory response; pinned-version LTS branch for conservative users |
| The Workers and Compose relays drift apart | Med | Med | The relay protocol test matrix in CI, run against both relays | One shared protocol contract; a relay-only feature is named on screen where the other relay lacks it |
| Permissive license causes contributor-attribution or patent-litigation issue | Low | High | Legal review; dependency patent-risk scanner | Apache-2.0's patent grant is the protection; explicit CLA if needed |

## Reversibility Assessment

- **Reversal cost:** License reversal is the highest-cost axis. Switching from Apache-2.0 to a source-available license (FSL/BSL/ELv2) requires dual-licensing new vs old code, contributor re-agreement under the new license, and market communication. Deployment-model reversal (dropping one of the two relays) is medium cost — one code path goes, the person moves their machine to the other relay, documentation rewrites, but no user-data migration is required across the architectural axis.
- **Blast radius:** `LICENSE`, `README`, all source-file headers if license changes; the dropped relay's package and deployment files if one relay goes.
- **Migration path:** License change follows the Sentry BSL→FSL precedent — new code under new license from a specific commit; old code remains under the permissive license forever. Deployment-model changes go through deprecation windows with CLI warnings, documented migration guides, and a published end-of-support timeline.
- **Point of no return:** First public code push under the chosen license locks the permissive grant for all code shipped under it. After that, only new code can be relicensed; the existing permissive-licensed code remains permissively licensed in perpetuity.

## Consequences

### Positive

- Category-positioning matches developer-tool norm; OSS-first signal to the target audience from day one.
- The person's traffic runs through a relay they deployed, on their own Cloudflare account or their own server.
- One feature set on both relays; the one relay-specific feature, shared ports in the web client, is named where it is missing.
- Shared protocol contract between Cloudflare-DO and Node-relay backends contains the QA-matrix cost.
- License choice (permissive) signals open contribution and matches the category norm.

### Negative (accepted trade-offs)

- The person deploys a relay before a second device can reach the machine: one deployment into their own Cloudflare account, or a Compose stack on their own server.
- QA matrix has two relay backends and two rate-limiter backends (bounded by shared protocol contract and deployment-aware abstraction).
- Community-support channel (GitHub Issues / Security Advisories) is a public-facing support surface with no SLA commitment, which still attracts drag on engineering capacity.
- Permissive license reduces future monetization flexibility (reversible via Sentry-precedent relicensing if triggered).

### Unknowns

- Actual community-support drag rate — sets the Tripwire 2 signal level.

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| The Compose relay's first run works | 100% of smoke tests pass `docker compose up → sidekicks sign-in → link a device → remote control succeeds` | CI smoke-test job | Before the first release carrying Remote Control |
| Community-support drag | ≤ 30% of weekly engineering capacity, rolling 4-week average | Engineering-time tracking | `2027-01-01` |
| Feature parity between the Workers and Compose relays | 100% of V1 features work identically, apart from shared ports in the web client | Relay protocol CI suite run against both relays | Before the first release carrying Remote Control |

### Tripwires (Revisit Triggers)

1. **Competitor materially re-hosts our code as a competing managed service with measurable revenue impact.** — Relicense new code to FSL, BSL, or ELv2 per the Sentry precedent; the existing permissive-licensed commits remain permissive.
2. **Community-support drag exceeds 30% of weekly engineering capacity for 4+ consecutive weeks.** — Tighten OSS scope of support and publish the scope-of-support policy.

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Supabase self-host | Precedent | OSS core + hosted SaaS on one codebase; Apache-2.0 license | <https://supabase.com/docs/guides/self-hosting> |
| PostHog self-host | Precedent | OSS core + hosted SaaS; MIT with later re-license | <https://posthog.com/docs/self-host> |
| Sentry OSS → BSL → FSL | Precedent | Source-available relicensing path when competitive re-hosting materializes | <https://sentry.io/_/open-source/> |
| tmate | Precedent | OSS terminal-sharing with free default relay + self-host option | <https://github.com/tmate-io/tmate> |
| Mattermost | Precedent | OSS + paid-tier two-deployment model | <https://mattermost.com/> |
| Cloudflare Workers + Durable Objects | Documentation | The platform the Workers relay runs on: one Durable Object for the account | <https://developers.cloudflare.com/durable-objects/> |
| Cursor Enterprise page | Vendor announcement | Direct quote: "we don't offer on-premises deployment today." Anchors the Antithesis/Synthesis claim that the modal greenfield collaborative dev tool ships hosted-only at V1 | <https://cursor.com/enterprise> |
| The Agency Journal — Cursor March 2026 self-hosted agents | Vendor announcement | Cursor March 2026: agent runtime moves to customer network; control plane stays in Cursor cloud — matches our ADR-002 trust-boundary shape (local execution, shared control plane) | <https://theagencyjournal.com/cursors-march-2026-glow-up-self-hosted-agents-jetbrains-love-and-smarter-composer/> |
| Superblocks — Cursor Enterprise Review 2026 | Engineering blog | Cursor Enterprise tier offers air-gapped agent-runtime deployment, not control-plane self-host; supports the "control plane stays hosted" pattern | <https://www.superblocks.com/blog/cursor-enterprise> |
| Windsurf Enterprise Security Report (2025) | Engineering blog | Windsurf ships SOC 2 Type II + FedRAMP High + cloud + hybrid + self-hosted (air-gap); Antithesis competitor signal in the regulated-enterprise-coding tier | <https://harini.blog/2025/07/02/windsurf-detailed-enterprise-security-readiness-report/> |
| Sourcegraph Cloud blog post | Counter-data point | Sourcegraph: 8 years self-host-only (2013–2021); ~10% of revenue on Cloud at disclosure (90% remained self-host). Counter-evidence for the cannibalization-pattern argument | <https://sourcegraph.com/blog/enterprise-cloud> |
| Deiser — Atlassian Data Center End of Life | Vendor announcement | Atlassian DC EOL timeline (2025-12-16 → 2029-03-28): even the largest dev-tool-enterprise vendor judges sustained self-host indefensible at maturity | <https://blog.deiser.com/en/atlassian-data-center-end-of-life-migrate-to-cloud> |
| Plane.so vs Linear comparison | Engineering blog | Linear ships SaaS-only in 2026; self-host alternatives (Plane, OpenProject) exist but do not dominate. Anchors the Antithesis Linear-as-SaaS-only example | <https://plane.so/plane-vs-linear> |
| Zed self-hosted collaboration discussion #13503 | GitHub Issue | Zed cloud-only collaboration first; community demand for self-host exists, no roadmap commitment. Directly the pattern Option B was modeled on | <https://github.com/zed-industries/zed/discussions/13503> |
| Tabby ML GitHub repo | Precedent | Tabby ML self-hosted-first; Apache-2.0 + `ee/` LICENSE split (open-core pattern). Precedent for OSS developer-tool self-host with narrow operational scope | <https://github.com/TabbyML/tabby> |
| Continue.dev GitHub repo | Precedent | Continue.dev: Apache 2.0 self-host instructions; cloud Teams plan as monetized wrapper. Permissive-OSS-with-hosted-tier precedent | <https://github.com/continuedev/continue> |
| Warp Enterprise docs | Documentation | Warp documents cloud + self-hosted + hybrid models in enterprise tier; supports the multi-mode-deployment pattern for AI-terminal competitors | <https://docs.warp.dev/enterprise/enterprise-features/architecture-and-deployment> |
| Pulumi — IaC comparisons (Business Critical plan) | Documentation | Pulumi self-host gated to top-tier "Business Critical" enterprise plan; precedent for monetization-via-tier rather than license-segmentation | <https://www.pulumi.com/docs/iac/comparisons/terraform/> |
| Replit Enterprise | Vendor announcement | Replit: dedicated single-tenant GCP project model + EU data residency (no true on-prem) — alternative to self-host that some enterprise buyers accept | <https://replit.com/enterprise> |
| Sirius Open Source — How much does GitLab cost? | Engineering blog | GitLab self-managed minimum annual TCO exceeds SaaS license cost by ~$82K from internal ops labor; supports the §Antithesis ongoing-cost framing | <https://www.siriusopensource.com/en-us/blog/how-much-does-gitlab-cost> |
| GitLab Self-managed Scalability Working Group handbook | Primary source | GitLab's self-managed scalability work spans support, quality, development, product, and technical-writing roles; structural evidence for the "self-host is multi-team commitment" claim | <https://handbook.gitlab.com/handbook/company/working-groups/self-managed-scalability/> |
| GitHub Enterprise Server 3.14 docs | Documentation | GitHub Enterprise Server requires dedicated IT, ≥30-min maintenance windows; higher TCO vs Cloud — supports the Antithesis ongoing-cost argument | <https://docs.github.com/en/enterprise-server@3.14/admin/overview/about-github-enterprise-server> |
| Cotera — PostHog Self-Hosted: Worth the Ops Overhead? | Engineering blog | PostHog self-host retrospective: 6–8 hrs/month maintenance; weekend incident response; concrete ongoing-cost figure underlying the §Antithesis 20–30% capacity claim | <https://cotera.co/articles/posthog-self-hosted-guide> |
| Vela/Simplyblock — Self-Hosting Supabase vs Managed Postgres | Engineering blog | Self-hosting Supabase: 5–10 hrs/month; 1–2 FTE for larger orgs; full ops surface beyond DB; supports §Antithesis ongoing-cost claim | <https://vela.simplyblock.io/articles/self-hosting-supabase/> |
| Checkthat.ai — PostHog pricing analysis 2026 | Engineering blog | ~90% of PostHog users are on Cloud despite OSS self-host availability — quantitative anchor for the hosted-revenue-still-dominates pattern in §Synthesis | <https://checkthat.ai/brands/posthog/pricing> |
| PostHog — Self-host open-source support | Documentation | PostHog OSS self-host is MIT-licensed and explicitly unsupported (community via GitHub Issues, not support tickets); supplements the generic PostHog precedent row with the explicit-unsupported posture URL | <https://posthog.com/docs/self-host/open-source/support> |
| Vanta 2025 survey via CloudEagle — SOC 2 Audit Guide | Primary research | 83% of enterprise buyers require SOC 2 cert; 67% of certified startups report direct deal-closure impact — anchors the enterprise-buyer-baseline framing in §Antithesis | <https://www.cloudeagle.ai/blogs/soc-2-audit> |
| Akave — 2026 Data Sovereignty Reckoning | Engineering blog | 73% of EU enterprises prioritize data sovereignty over convenience; CLOUD Act exposes US-HQ SaaS — anchors the EU-sovereignty driver behind self-host demand | <https://akave.com/blog/the-2026-data-sovereignty-reckoning> |
| SSOjet — Enterprise Ready SSO Complete Requirements Guide | Documentation | OIDC + SAML are 2025–2026 enterprise SSO table-stakes; 90% of SaaS buyers prioritize standards-based SSO — anchors Option C OIDC/SAML rejection rationale | <https://ssojet.com/enterprise-ready/oidc-and-saml-integration-multi-tenant-architectures> |
| Sentry — Introducing the Functional Source License | Vendor announcement | Sentry's FSL rationale: "freedom without free-riding"; 2-year change to Apache/MIT — anchors the Tripwire 1 BSL/FSL relicensing reversal path | <https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/> |
| Sentry — Re-Licensing Sentry | Vendor announcement | Sentry BSL rationale: "competitive elements that threaten the future of Sentry"; relicensing preserves user freedom — anchors the Sentry-precedent claim in §License and Tripwire 1 | <https://blog.sentry.io/relicensing-sentry/> |
| Elastic blog — Elastic License v2 | OSS license analysis | ELv2 rationale; Elastic re-added AGPL v3 in Sept 2024 alongside ELv2 and SSPL — supports the source-available license option-space named in §Decision | <https://www.elastic.co/blog/elastic-license-v2> |
| HashiCorp BSL 1.1 | OSS license analysis | HashiCorp BSL precedent; 4-year change date to GPL-compatible — supports BSL option named in §Reversibility + §License | <https://www.hashicorp.com/en/bsl> |
| Cloudflare blog — Durable Objects: Easy, Fast, Correct | Documentation | DO single-writer semantics: "exactly one location, one single thread, at a time"; input/output gates — supplements the generic CF DO row with the semantic-properties URL | <https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/> |
| Cloudflare miniflare / workerd | GitHub Issue | workerd DO storage caveat: not production-suitable in 2026; DOs always run on the same machine as requested — anchors why a CF-DO-as-self-host shortcut is not viable | <https://github.com/cloudflare/miniflare> |
| Cloudflare PartyKit / PartyServer | GitHub Issue | PartyKit is open-source DO wrapper, NOT a DO replacement — anchors why a self-hostable PartyKit shortcut does not apply | <https://github.com/cloudflare/partykit> |
| Ably — Scaling Pub/Sub with WebSockets and Redis | Engineering blog | Industry-standard Node.js + Redis pubsub + WebSocket hub pattern for self-hosted DO replacement — anchors the chosen Node-relay self-host implementation pattern | <https://ably.com/blog/scaling-pub-sub-with-websockets-and-redis> |

### Related ADRs

- [ADR-002: Local Execution, Shared Control Plane](./002-local-execution-shared-control-plane.md) — trust-boundary framing: execution stays on the person's machines, and only coordination crosses their relay.
- [ADR-004: SQLite Local State, Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md) — SQLite on the machine, Postgres behind the Compose relay.
- [ADR-014: V1 Feature Scope Definition](./014-v1-feature-scope-definition.md) — the V1 surface both relays serve.

### Related Docs

- [Deployment Topology](../architecture/deployment-topology.md) — the `Workers Relay` and `Compose Relay` topology rows cross-link to this ADR.
- [V1 Feature Scope](../architecture/v1-feature-scope.md) — the Deployment Options section cites this ADR.
- [Spec-019: Rate Limiting Policy](../specs/019-rate-limiting-policy.md) — deployment-aware rate-limiter abstraction.
- [Spec-023: Self-Host Secure Defaults](../specs/023-self-host-secure-defaults.md) — normative secure-defaults posture for the `Compose Relay` topology committed to by this ADR; the person's step-by-step companion at [Operations › Self-Host Secure Defaults](../operations/self-host-secure-defaults.md) (Spec-023 Acceptance Criterion).
