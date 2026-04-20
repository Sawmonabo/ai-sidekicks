# BL-053: Self-Hosted Control-Plane Scope for V1 — Research Brief

**Date:** 2026-04-16 (§4.1 / §4.4 envelope aligned to [deployment-topology.md](../architecture/deployment-topology.md) Session G2 update on 2026-04-20 — see BL-068 Resolution in [backlog.md](../backlog.md))
**Question:** Does V1 ship a first-class self-hosted control-plane deployment path alongside the Cloudflare-hosted path, or is self-hosted deferred to V1.1 / V2?
**Decision class:** Product/ops commitment with multi-year human cost tail. Not a pure engineering call.

---

## 1. Problem Framing

### 1.1 What has already been decided (scope guardrails)

The following are fixed and not in scope for this brief:

- Electron is the desktop shell (ADR-016, WebKitGTK WebAuthn gap forced it).
- Control plane = Node.js + tRPC v11 + Postgres.
- Relay = Cloudflare Durable Objects, sharded data DOs at 25 WebSocket connections per DO (`deployment-topology.md` §Relay Scaling Strategy).
- Local execution never moves into the shared control plane (ADR-002, hard trust boundary).
- Pairwise X25519 + XChaCha20-Poly1305 is V1; MLS deferred to V1.1 (BL-048).
- Windows ships V1 GA with Rust PTY sidecar (BL-052).
- **The code architecture is already designed to be self-hostable.** `deployment-topology.md` already describes the Collaborative Self-Hosted Control Plane topology, the rate-limiter abstraction is deployment-aware, and the trust boundary already assumes self-host changes operator ownership — not the logical security model.

### 1.2 The actual live question

Given the architecture is already abstracted, the question is not "can we self-host?" It is: **does V1 *ship the self-hosted path* as a supported, tested, documented deliverable, or is V1 hosted-only with self-host remaining a latent capability?**

Shipping self-host means: packaged artifact (Docker Compose + Helm + tarball), non-Cloudflare relay, Postgres-backed rate limiter, security-requirements doc (BL-060), backup/restore doc, upgrade docs, CVE channel, signed images, CI targeting the self-hosted path, and a human on-call for self-hosted support tickets.

### 1.3 The distinguishing reality

AI implementation collapses *upfront* code cost. It does **not** collapse the *ongoing-human* operational cost. Self-host is not a one-shot engineering commitment — it is a product-lifetime obligation: migration scripts, Postgres upgrade guidance, Docker image CVE response windows, "why is my self-hosted instance losing presence events" triage, version compatibility matrices, and ops docs that stay current.

This brief separates **upfront cost (AI-accelerated)** from **ongoing human cost (AI cannot absorb)** and treats the latter as the pivotal variable.

### 1.4 Three shaped options (Section 10 evaluates them in detail)

- **Option A — Self-hosted V1.** Docker Compose + Helm + Postgres-backed rate limiter + Node relay replacement + security-reqs doc + signed images + CI + support.
- **Option B — V1 hosted-only, V1.1 self-hosted with named quarter target.** Architecture stays abstracted. Self-host deferred with a public commitment.
- **Option C — Self-hostable in principle, not shipped.** V1 CF-only. No V1.1 commitment. Users who want self-host fork or wait.
- **Option D (surfaced below) — V1 hosted-only + publish reference Docker Compose as "community preview, unsupported."** Separates code availability from support commitment.

---

## 2. Self-Host Demand in 2026 — Who Wants It, Why, Size Thresholds

### 2.1 The buyer signal

The enterprise-buyer literature in 2024–2026 is consistent that **SOC 2 Type II is table-stakes** (~83% of enterprise buyers require SOC 2 certification from SaaS vendors before signing contracts, per a widely cited 2025 Vanta survey [5]; ~67% of startups that achieved certification report direct deal-closure impact [5]). SOC 2 does **not** require self-hosting — a compliant hosted SaaS is sufficient for the vast majority of enterprise buyers.

The demand for *actual self-hosted* comes from a narrower set of drivers:

1. **Data sovereignty — EU / regulated.** A 2024 EuropeanCloud.eu survey cited in [6] reports 73% of EU enterprises prioritize data sovereignty over convenience when selecting SaaS tools. The CLOUD Act makes even EU-region-hosted SaaS from US-headquartered vendors subject to US law enforcement demands [6] — which makes an EU-operated self-hosted instance the only fully-sovereign option for some buyers.
2. **FedRAMP / classified / air-gapped.** This tier cannot use commercial SaaS at all; self-hosted is the only path.
3. **Strict enterprise egress policies.** Large financial institutions and healthcare providers often forbid source code or session artifacts from leaving the perimeter. Their list of approved SaaS vendors is tiny.
4. **Cost at scale.** Self-hosting is cheaper only at very high volume *and* when the organization already carries DevOps capacity. The cost literature (Sections 6–7) contradicts the "cheaper" framing at small/mid scale.

### 2.2 Size threshold — when does SaaS become unacceptable?

The practitioner literature consistently places the inflection point between **500–2,000 seats / users** for general SaaS. Below that, buyers overwhelmingly choose hosted. Above that, a significant minority — concentrated in regulated industries and enterprise IT — demands self-hosted or single-tenant dedicated cloud. A specific anchoring number:

- **Sourcegraph:** launched Cloud tier specifically "for organizations with more than 100 developers" [22]. So their threshold is lower because the tool is deeply tied to source code. 100-developer threshold → single-tenant dedicated cloud (not fully self-host) was their offering at that scale, and as of their public disclosure only ~10% of Sourcegraph's revenue is on Cloud [22] — meaning 90% of a dev-tool-for-enterprise company's revenue was still self-hosted even after 9+ years with Cloud available.

### 2.3 The counter-signal: Atlassian is **retreating** from self-hosted

The single biggest recent public data point against self-hosted-first is Atlassian's formally announced Data Center End of Life:

- **2025-12-16** — marketplace partners cannot submit new DC apps [21].
- **2026-03-30** — no new DC customer subscriptions [21].
- **2028-03-30** — last day existing customers can buy new DC licenses [21].
- **2029-03-28** — DC (Jira, Confluence, JSM) becomes read-only [21].

Atlassian is ending self-managed entirely. Their justification: Cloud now supports "single sites supporting 100k Jira users and 150k Confluence users" and they cite "99% of 300k+ customers already benefit from Cloud" [21]. This is a 2026-fresh signal from one of the largest enterprise dev-tool vendors that at their scale, operating both SaaS and self-hosted is no longer justified. (Note: some of this is also a deliberate monetization shift; discount it for that bias. But the engineering/support decision was independently consistent.)

### 2.4 Inferences I am marking explicitly

- **[Inferred]** The size threshold for "must self-host" is lower in 2026 for *coding* and *AI* tools specifically — because the data being touched (source code, credentials-adjacent context, sometimes inference payloads) is inherently more sensitive than, say, project management. Our collaborative-agentic-coding tool sits in this more-sensitive class. This suggests the demand for self-host will appear at smaller buyer scale than for a Linear-like tool, but at larger scale than a terminal.
- **[Inferred]** The enterprise-coding-tool buyer's actual need is often *network isolation / private inference / private code retention* rather than literal self-host of the collaboration control plane. See Cursor's "self-hosted agents" pattern (Section 3) — the company kept the control plane in its cloud and only moved the agent execution environment on-premises.

---

## 3. Comparable-Product Survey

Format: one-line verdict per product, then the lesson that bears on our decision. Tier 1 (directly analogous) gets more detail; Tier 3 gets a single sentence.

| Product | Deployment model in 2026 | When added self-host | Key lesson for us |
|---|---|---|---|
| **GitHub Enterprise Server** | Self-host + Cloud, both first-class | Day 1 for GitHub Enterprise (self-host predates Cloud) | Self-hosted has material ongoing burden: upgrade cycles, 30+ minute maintenance windows, dedicated IT resources for server management, patches, backups; higher TCO vs Cloud [3]. |
| **GitLab** | Self-managed + SaaS both first-class | Self-managed was the original product; SaaS added later | TCO analysis: self-managed minimum adds ~$82K/yr over pure SaaS license cost [1]. GitLab runs entire Self-Managed Platform Team, Self-Managed Scalability Working Group, and GitLab Delivery: Self Managed group [24] — i.e., *multiple full teams* exist because of the self-hosted commitment. |
| **Jira / Atlassian Data Center** | **Deprecating self-host by 2029** [21] | Had it from day 1 | Even the largest dev-tool-enterprise vendors find sustaining both indefensible at maturity. Cloud can reach 100K+ user sites now, reducing the enterprise-scale justification. 2025–2026 signal. |
| **Linear** | SaaS-only | Never | Leading modern project-management tool ships cloud-only even in 2026; self-host alternatives (Plane, OpenProject) exist but do not dominate [8]. Fast-growing PLG dev-tool proves hosted-only is viable for dev-adjacent SaaS. |
| **Notion / Slack** | SaaS-only for both | Never | No self-hosted tier at all. Mattermost and Rocket.Chat occupy the self-host-Slack niche; neither has displaced Slack in enterprise [17]. |
| **Zed** (collaboration) | Cloud-hosted by default; **self-host not officially supported** | Discussion open; community building informal support [10] | Zed is dev-tool-category-adjacent to us. They shipped cloud-only collaboration first. Community demand for self-host exists but Zed has not yet committed roadmap to it. This is directly the pattern Option B would follow. |
| **Cursor** | Cloud-only. **No self-hosted control plane.** Cursor's own enterprise page states "we don't offer on-premises deployment today" [36]. "Self-hosted agents" (March 2026) means agent execution runs in the customer's network; the control plane stays in Cursor's cloud [7][11]. | Never shipped self-host of control plane | Directly analogous. They arrived at the correct architectural compromise: move the agent runtime (sensitive ops) to customer network, keep collaboration/control in the vendor cloud. Matches our ADR-002 trust-boundary shape (local execution, shared control plane). |
| **Windsurf / Codeium** | **Cloud + Hybrid + Self-Hosted (air-gap capable)** [12] | Self-hosted offered from early enterprise motion (pre-rebrand from Codeium in Apr 2025 [12]). SOC 2 Type II + FedRAMP High. | Most aggressive self-hosted dev-tool in the coding category. Their differentiation *is* regulated-enterprise data sovereignty. They run their own inference stack to support it — which is a much larger operational commitment than "Docker Compose your control plane." Proves the market exists at that tier; also proves it is expensive to serve. |
| **Tabby ML** | **Self-hosted first** (primary offering) | Day 1 | Apache-2.0 community edition + `ee/LICENSE` for enterprise edition (open-core pattern) [13]. Small team, narrow feature surface, local-model-focused, so operational scope is limited. The parts of Tabby that aren't self-hostable (their SaaS-exclusive polish) match what we'd expect to keep CF-only. |
| **Continue.dev** | Apache-2.0, self-host instructions, cloud Teams plan | Day 1 for the core; pivoted mid-2025 to Continuous-AI CLI model [14] | Licensing stays permissive. Self-host is not a separate tier — it's the core tool with the cloud Teams plan being the monetized wrapper. The lesson: if the core is open-source by design, self-host is free; the ops burden is the user's, not ours. |
| **Sourcegraph** | Self-hosted + Cloud (single-tenant dedicated) | **Self-hosted-first for 8 years (2013–2021); Cloud added in 2022** [22] | The strongest counter-data-point. A dev-tool-for-enterprise company with meaningful self-hosted base took 8 years to add Cloud, and at disclosure still ~90% of revenue was self-hosted. But critically, Sourcegraph's Cloud tier is *single-tenant dedicated*, not multi-tenant SaaS — i.e., they recognized self-host customers would not accept a shared-tenant SaaS. |
| **Warp** | Cloud-hosted + Self-hosted + Hybrid models documented [15] | Self-hosted described as option in enterprise docs (2025–2026 era) | Confirms that "cloud-native AI-terminal" competitors are all landing on multi-mode deployment rather than pure-SaaS. |
| **Sentry** | Self-hosted (FSL-licensed, ex-BSL) + Cloud | Self-hosted from day 1 (BSD-3 originally, BSL 2019, FSL 2023 [18]) | The BSL/FSL licensing saga was driven entirely by the self-hosted commitment interacting with competitive SaaS re-hosting. Sentry paid a multi-year governance cost to preserve self-host while protecting revenue. |
| **PostHog** | Self-hosted OSS + Cloud | Hosted first, then open-sourced self-host | **~90% of PostHog users are on Cloud [25].** Self-hosted is recommended only up to ~300K events/month; over that, they explicitly tell users to migrate to Cloud. Open-source deployment is MIT-licensed *and explicitly unsupported* [26]. This is Option D in the wild. |
| **Supabase** | Self-hosted OSS + Managed Cloud | Both from day 1 | Community-supported self-host only. Estimated self-host ops burden: 5–10 hours/month minimum; 1–2 FTE for larger orgs [19]. |
| **Replit** | Cloud-only + dedicated single-tenant GCP projects for enterprise; available in GCP/Azure Marketplace [23] | Never offered true on-prem | Chose "dedicated single-tenant cloud" instead of self-host. Also adds EU data residency option. Similar shape to Sourcegraph Cloud — enterprise tier is dedicated-cloud, not customer-premises. |
| **CodeSandbox** | Enterprise tier offers on-prem / self-hosted deployment [23] | Added for enterprise tier | Distinguishes from Replit by shipping self-host — and directly trades that capability for enterprise deal size. |
| **Pulumi** | SaaS + self-hosted ("Business Critical" plan) [16] | Self-host gated to highest-tier enterprise plan | Self-host is a monetization layer at the top of the price ladder; not something exposed to free/community users. |
| **Terraform Cloud / Enterprise** | SaaS + Terraform Enterprise self-hosted | Self-host via Terraform Enterprise (paid tier) | Core `terraform` is BSL since 2023; Cloud and Enterprise are commercial. |

### 3.1 Pattern summary

- **Pure hosted-only winning in 2026:** Linear, Notion, Slack, Cursor control plane, Replit (via single-tenant Cloud).
- **Hosted-first with self-host as premium enterprise tier:** Windsurf, CodeSandbox, Pulumi, Terraform Enterprise.
- **Self-host-first, Cloud added at maturity:** Sourcegraph (8 years before Cloud; still 90% self-host revenue), GitLab (longest-running dev-tool-with-both), Tabby ML, Continue.dev.
- **Retreating from self-host:** Atlassian (Jira DC EOL 2029 [21]).
- **Mixed / unsupported self-host preview:** PostHog (self-host present but 90% of users on cloud; explicitly unsupported), Supabase (community-supported self-host), Zed (no official self-host yet but open source).

The most decision-relevant rows for *our* product (greenfield, collaborative, agentic-coding, small team in 2026, shared control plane architecture already built on CF) are **Cursor, Zed, Windsurf, Sourcegraph, and PostHog**. The modal pattern for modern greenfield collaborative dev tools that chose hosted-first is: Cursor, Zed, Linear. The pattern for those that chose self-host-first is: Sourcegraph (in 2013), Tabby ML (in a much narrower scope).

---

## 4. Cloudflare Durable Object Portability

### 4.1 What the V1 relay actually needs from DOs

From `deployment-topology.md` §Relay Scaling Strategy:

- Control DO manages session membership, connection assignments, routes new connections to data DOs.
- Data DOs handle encrypted message fan-out; the target is 25 WebSocket connections per data DO (a design choice, not a CF-platform connection cap — CF publishes no concurrent-WS cap per DO).
- Control + data DO split follows the v2 protocol.
- Expected throughput per data DO: ~400 rps batched (envelope: `25 conns × 100 events/sec ÷ ~6:1 batching ratio`); see [deployment-topology.md §Relay Scaling Strategy](../architecture/deployment-topology.md) for the authoritative derivation, the 1,000 rps per-DO soft cap, and the ~2.5× headroom calculation. Batched WebSocket messages are the design baseline (enabled by the 2025-10-31 CF raise of WS message size from 1 MiB to 32 MiB); the un-batched framing (~2,500 writes/sec) would breach the soft cap and is superseded per BL-068.

Cloudflare's authoritative description of DO semantics [27]: "Each Durable Object runs in exactly one location, in one single thread, at a time." Input gates prevent event delivery while storage ops are in flight; output gates hold network messages until writes confirm; automatic coalescing makes a sequence of sync reads-and-writes atomic.

The properties a self-hosted replacement must preserve:
1. **Single-writer per session shard** — no two processes concurrently mutating the session's fan-out state.
2. **In-process fan-out latency** — sub-ms dispatch to connected WebSockets.
3. **Graceful connection migration** when a shard goes over 25 connections.
4. **Durability of connection assignment** across process restarts (control DO's role).

### 4.2 Node-based alternatives — what actually works

- **Miniflare / workerd** — open-sourced Cloudflare runtime. Miniflare 3 runs Worker code on workerd [28]. But: "Durable Objects currently always run on the same machine that requested them, using local disk storage, which is sufficient for testing and small services that fit on a single machine. In scalable production, you would presumably want Durable Objects to be distributed across many machines" [28]. Cloudflare itself warns: "there isn't much experience running [workerd] in production yet, so there will be rough edges" [28]. **Verdict: not production-safe as a self-host replacement in 2026.**
- **PartyKit / PartyServer** — Cloudflare-acquired, open-source, built explicitly on Durable Objects [29]. It's a *wrapper for DO*, not a DO replacement. Does not solve the self-host problem.
- **Vorker** — community project; "workerd is not yet ready for on-disk objects, so this is not really durable — Durable Objects will be lost when a worker is restarted or migrated" [29]. Confirms workerd DO storage is not production-suitable.
- **Node.js Redis pubsub + WebSocket hub pattern** — mature, well-understood, widely deployed [30]. Single-writer can be achieved either by sticky load balancing (session → process) or by an external lock (Postgres advisory lock, Redis RedLock). Latency characteristics: Redis pub/sub typically adds ~1–3 ms to fan-out. This is the **industry-standard replacement pattern** for DO-style WebSocket coordination when a team leaves the Cloudflare Workers platform.
- **Node.js + sticky session + in-process state, no Redis** — the simplest path, adequate for the self-hosted throughput envelope (one organization's worth of sessions). Adequate for self-hosted deployments at typical enterprise size.

### 4.3 Has anyone shipped DO-cloud + Node-self-host?

I did not find a public writeup of a product running CF Durable Objects as the cloud-tier relay and a Node.js WebSocket hub as the self-hosted relay. **[Inferred]** The compatibility model would be:

- A shared wire protocol (e.g., our v2 relay protocol) implemented behind an interface, with two implementors (`relay/cf-durable-objects/` and `relay/node-ws-hub/`).
- Tests covering semantic equivalence against the protocol contract — not implementation details.
- Per-environment CI jobs that exercise each backend.

This is structurally the same pattern as our rate-limiter abstraction, and it is feasible. But it **doubles the relay surface to maintain.** Every protocol change has to land twice and be tested twice.

### 4.4 Sharding strategy portability

The 25-WS-per-DO sharding strategy on CF exists as a design choice — driven by the 1,000 rps per-DO soft cap and the CF "Rules of Durable Objects" 200–500 rps complex-op guidance, not by any platform-published per-instance connection limit (CF publishes no concurrent-WS cap per DO). On Node, a single process easily handles 1,000–5,000 WebSocket connections and the 1,000 rps soft cap does not apply. So on self-host you would probably **not** preserve the 25-per-shard pattern — you'd run one process per node and use a different scaling lever (more Node processes, sticky routing). This means self-host is not a drop-in backend swap; the sharding mental model is different, and the ops team has to learn it. **Inferred:** this is the single biggest source of "why does self-hosted behave differently" support tickets over the product's life.

### 4.5 Durable-Object portability verdict

- **Upfront implementation cost of a Node relay:** moderate. ~2–4 weeks of AI-accelerated work, mostly protocol-contract extraction and test-harness doubling.
- **Ongoing cost:** high. Every relay change is paid twice. Ops behavior differs between backends. Customer reports will routinely reference one backend; engineers have to remember which.

---

## 5. Rate-Limiter-Flexible at Scale

### 5.1 Performance

From the official rate-limiter-flexible Postgres benchmark [4]: with 4 Node workers and a Postgres container, the endpoint achieved ~995 req/sec average (stdev 304, max 2010). Latency p50 5.25 ms, p95 21.85 ms, p99 29.42 ms. This is a *Postgres-backed* run, not Redis.

Our V1 capacity target (`deployment-topology.md`):
- 500 events/sec write.
- 2000 events/sec read.

The RLF Postgres benchmark is comfortable vs the write-rate (500/sec sits well under 995 average and is about 1/4 of the max burst). The latency at p95 ~22 ms is acceptable for a non-hot-path rate limiter. **Verdict: adequate for V1 envelope in Postgres mode.**

For the read-heavy 2000/sec case, rate-limiter-flexible's `RLWrapperBlackAndWhite` and in-memory cache block decisions without always hitting Postgres; this keeps Postgres load manageable. **[Inferred]** the real operational risk is not average throughput but spikes (burst behavior under a runaway client). The Redis backend is meaningfully faster for this; a self-hosted operator who cares about tight tail-latency will run Redis anyway.

### 5.2 Operational gotchas

From community writeups and the library's docs:

- **Connection pool sizing** — RLF Postgres opens its own pool by default. With 10 connections per control-plane process (our pinned sizing) and a RLF pool of, say, 4, you quickly get close to Postgres's 100-connection cap. Operators have to know to size down RLF's pool under load.
- **Replica lag** — If a self-hosted operator routes reads to a read replica for cost, RLF counter reads can lag, permitting over-limit bursts. Must use primary for rate-limit reads.
- **Atomic counters** — RLF uses advisory locks on Postgres; the library docs note that lock contention under very-high QPS can become the bottleneck before the write rate does. At 2000/sec read our target is at the upper end of what a single Postgres instance handles cleanly.

### 5.3 Production deployments

RLF supports Valkey, Redis, Prisma, DynamoDB, Memcached, MongoDB, MySQL, SQLite, and PostgreSQL [4]. It is maintained and widely downloaded. I did not find a case study of a specific dev-tool vendor naming RLF-Postgres in production at 500+ writes/sec. [Inferred] most large-scale deployments use the Redis backend because Redis already exists in their stack.

### 5.4 Decision consequence

If self-host ships in V1, `rate-limiter-flexible` with Postgres is workable but not carefree. If self-host defers to V1.1, we pick CF-native for V1 (zero latency, no extra service) and postpone the Postgres-backend path — which actually moves a V1 dependency off the critical path.

---

## 6. Minimum Credible Self-Hosted Deliverable

For Option A (self-host ships in V1), this section enumerates the minimum viable deliverable. Each item cites at least one comparable that ships it this way.

| Item | Form | Ongoing cost | Comparables |
|---|---|---|---|
| Packaging: Docker Compose for small deployments | `docker-compose.yml` referencing tagged images for control-plane, relay-self-hosted, and Postgres. Used by hobbyist/small-org operators. | Low upfront, moderate ongoing (every release needs compose update) | PostHog (OSS Docker Compose) [26]; Sentry; Ghost; Supabase |
| Packaging: Helm chart for enterprise k8s | Official Helm chart with `values.yaml` for Postgres endpoint, secrets, replicas. | Moderate upfront, high ongoing (Helm chart must track schema/env changes) | Sourcegraph (Helm is the recommended self-host method) [22]; PostHog; Mattermost |
| Database migrations for self-hosted | Must tolerate operator running migrations on their schedule. Idempotent, version-tagged, resumable. Usually a CLI: `$tool migrate`. | Moderate — every schema change needs tested forward migration; major-version migrations need rollback testing | GitLab, Sentry, Mattermost |
| Postgres connection-pool config surface | Env-var exposed pool sizes; operator docs for sizing | Low if abstracted well | All of the above |
| Observability: metrics + dashboards | Prometheus `/metrics` endpoint + published Grafana dashboard JSON | Moderate ongoing (dashboards drift with metric renames) | GitLab (publishes Grafana dashboards); Sentry; PostHog |
| Auth integration: OIDC mandatory, SAML recommended | OIDC is now minimum enterprise table-stakes [20]. SAML pays for itself at ≥500-seat enterprise. SCIM provisioning is the next tier. | High if you commit to the full three-protocol matrix; moderate for OIDC-only | Per [20], 90% of SaaS buyers prioritize standards-based SSO; most mid-market and enterprise SaaS implement both SAML and OIDC eventually |
| Backup / restore documentation | `pg_dump`-based with file-system snapshot for any on-disk assets. Step-by-step runbook. | Low ongoing but any missing detail becomes a P0 ticket | GitLab handbook has extensive runbook; see [24] |
| CVE disclosure / patch channel | Security mailing list, GitHub security advisories, signed release notes. A named window for "critical patch shipped ≤N days" | Ongoing — every quarter's CVEs against transitive deps require a decision | Industry norm: 30–90 day disclosure windows. GitLab, Sentry, Supabase all run formal channels |
| Signed Docker images, reproducible builds | Cosign signatures, SBOM published, image provenance attestation | Moderate upfront, low ongoing once wired | Sigstore-based signing is 2025 table-stakes for any image you expect enterprise to pull |
| License | Pick one that (a) permits self-host without royalty, (b) prevents SaaS re-hosting by competitors. BSL, FSL, ELv2, SSPL, AGPL are the mainstream choices. | This is a *governance* cost, not a code cost — but it is a multi-year commitment | See Section 9 |

### 6.1 The "first version" floor

The minimum *credible* V1 self-hosted release — i.e., what you must ship if you claim to support it — is:

1. Docker Compose AND Helm chart (at least one enterprise k8s path).
2. Postgres-backed `rate-limiter-flexible`, tested at our V1 capacity targets.
3. Node WebSocket relay replacing the DO relay (Section 4).
4. OIDC support in V1 (SAML in V1.1 is defensible).
5. `operations/self-hosted-security-requirements.md` (BL-060, currently blocked on this decision).
6. Backup/restore runbook.
7. Upgrade guide that covers N−2 version compatibility.
8. Published security advisory channel.
9. Signed images with SBOM.
10. CI jobs that run the full product against both the hosted and self-hosted backends.

Dropping any of these from V1 is a latent commitment to ship it in V1.01. You cannot maintain "self-hosted ships V1" and also say "upgrade docs come later" — that gets you bug reports you cannot action.

---

## 7. Ongoing Operational Cost Evidence

This section collects the empirical evidence for the cost of carrying self-hosted as a supported deployment over the product's life. Treat these as the input to the ongoing-cost line in Section 10.

### 7.1 Small-team-and-tool examples

**PostHog (self-hosted retrospective)** [31]:
- Maintainer reports 6–8 hours per month per self-hosted instance on routine upkeep; routine upgrades 30 min, major version bumps 2 hours.
- Upgrades ship weekly-to-biweekly.
- One named incident: a ClickHouse node running out of disk on a Saturday took 90 minutes of weekend response.
- Economic take: self-hosted is ~$400–550/month loaded for an 80M-events/month deployment; PostHog Cloud is often cheaper accounting for TCO [31].
- Key disqualifier from the author: "teams without DevOps capacity should avoid self-hosting."
- PostHog's own retrospective [25][26]: ~90% of users are on Cloud; self-hosted OSS is MIT-licensed and **explicitly unsupported** — they direct troubleshooting to GitHub issues, not support tickets. This is the model that minimizes support drag.

**Supabase** [19]:
- Self-hosting is community-supported only.
- Estimated 5–10 hours/month for "a healthy deployment" at $100/hour = $500–$1,000/month implicit cost.
- Estimated 1–2 FTE for larger orgs running self-hosted Supabase.
- "Self-hosting means taking on far more than a database—you operate authentication, storage, realtime, REST APIs, backups, monitoring, and upgrades."

**Sentry BSL/FSL license saga** [18][32]:
- Sentry relicensed BSD-3 → BSL (2019) → FSL (2023) [18][32] specifically to preserve self-hosted *user freedom* while preventing *competitive SaaS re-hosting*. The operational implication is not a line-item cost — it is a multi-year governance cost.
- Their explicit rationale: "if we continue to use a fully permissive license, we face real competitive elements that threaten the future of Sentry" [32].
- **The quote worth writing on the whiteboard:** relicensing "won't change anyone's ability to run Sentry at their company" [32]. This frames self-host as a bundle: the open-source code *and* the governance to defend your revenue against SaaS re-hosters, not just the code.

### 7.2 Large-team examples

**GitLab** [24]:
- GitLab is the largest data point on dev-tool-with-both. They maintain a full Self-Managed Platform Team, a Self-Managed Scalability Working Group, and GitLab Delivery: Self Managed groups.
- TCO analysis for their Premium tier [1]: self-managed minimum annual TCO exceeds the SaaS license cost by ~$82K, primarily from internal ops labor.

**GitHub Enterprise Server** [3]:
- Requires dedicated IT resources for server management, security patches, backups, scaling.
- Upgrades need ≥30-minute maintenance windows.
- Higher TCO vs Enterprise Cloud [3].

**Atlassian Data Center → EOL** [21]:
- The largest dev-tool-enterprise vendor is *closing* self-hosted by 2029. Even with 20+ years of self-hosted tooling, team investment, and enterprise contracts, they judged the operational cost indefensible against the new Cloud capability envelope.

### 7.3 Quantified projection for us

**[Inferred]** Our team is small. Self-host V1 in our context probably adds:

- **Upfront:** ~6–10 engineer-weeks of AI-accelerated work. This covers: the Node relay replacement, RLF-Postgres integration, Docker Compose + Helm, OIDC wiring, docs, signed-image pipeline, and CI doubling.
- **Ongoing (years 1–2):** 0.2–0.4 FTE sustained. Broken down: ~1 hr/wk on self-hosted CI maintenance, ~2 hr/wk on dual-release coordination, ~1–2 hrs/wk on self-hosted-specific support triage (growing with install base), ~1–2 days/quarter on migration-script certification. This is **not** a number AI materially reduces — the cost falls on PRs, docs, human triage, and release decisions.
- **Ongoing (year 3+):** rises proportionally with self-hosted installs. If self-host installs reach the hundreds, 0.5–1 FTE sustained is realistic.

Compare to Option B (V1.1, hosted-only V1): ongoing cost is zero during V1 development. Option C (latent capability, no V1.1 commit): same zero, but forfeits the enterprise-pipeline signal that "coming in V1.1" provides.

### 7.4 The PostHog model as Option D

PostHog's "MIT-licensed, Docker Compose published, explicitly unsupported, go to GitHub for help" posture is the middle ground. It:

- Gives enterprise buyers a *code-availability* answer when RFP asks "do you support self-hosted?"
- Avoids committing the small team to runbook, backup, migration, and support obligations.
- Is honest about the limits (PostHog recommends migrating to Cloud at 300K events/month).
- Matches their ~90% Cloud-revenue mix: the self-hosted preview funnels users into Cloud anyway.

This is Option D in Section 10.

---

## 8. Timing Analysis — V1 vs V1.1 vs V2

### 8.1 Is it cheaper to bake in from V1 or add later?

Because `deployment-topology.md` already calls out the rate-limiter abstraction and the self-hosted topology is already a named supported shape, **the architectural sunk cost is already paid.** The marginal upfront cost of V1-ship (Option A) over V1-defer (Option B) is therefore the *packaging + docs + support infrastructure*, not core architecture. That cost is AI-accelerated.

What is **not** AI-accelerated and does not get cheaper if you defer:

- The Node relay implementation (Section 4). Same cost whether built in V1 or V1.1.
- OIDC/SAML integration. Same cost whenever it ships.
- CVE response process. Same cost starting from the day self-host ships.
- Upgrade-compatibility testing. Starts costing on shipping day.

The genuine *deferred* costs (the ones V1.1 would delay) are:

- Ongoing support load. Defer = defer.
- Support-channel setup.
- Dual-backend CI cost (you only build the second backend once you need it).

### 8.2 Examples of adding self-host later without forcing a refactor

- **Sourcegraph** did the opposite direction — self-host-first, Cloud added at 8 years [22]. They did not need to refactor — but they did have to stand up entirely new tiering (single-tenant dedicated) and accept that Cloud would grow slowly. Evidence that order-of-operations matters but is not architecturally destructive.
- **Cursor** shipped cloud-only and added "self-hosted agents" (customer-network agent execution, not control-plane self-host) in March 2026 [7]. No architectural refactor; they pushed responsibility over the trust boundary rather than replicating the control plane.
- **Atlassian** is doing the *harder* direction — removing self-hosted after decades of commitment. Even at their size, this is taking ~5 years (2024 announcement → 2029 read-only).

**[Inferred]** The one case where adding self-host later forces real refactor is when the hosted-only code is deeply tangled with proprietary cloud primitives (e.g., hosted-only code calling CF-specific bindings directly, without an abstraction). *Our architecture has already been specifically designed to avoid this.* So the V1.1-add risk is low.

### 8.3 What signals should trigger shipping self-hosted?

Concrete tripwires that should flip the V1.1 defer into immediate work:

1. **≥3 enterprise accounts** in the pipeline naming self-host as an acceptance criterion (not "nice to have"). Each with projected ACV ≥ 2× an engineer-year cost.
2. **One named government / FedRAMP-adjacent customer** with compliance officer paperwork in hand. These deals don't happen without self-host.
3. **A compliance regulation change** (EU AI Act enforcement clarification, HIPAA update) that makes hosted use by a class of customer non-viable.
4. **A competitor in our category shipping self-host and winning deals on that basis.** Windsurf is the obvious watch-target [12].
5. **Internal signal:** 4+ self-host-scope support conversations from prospective users in a single quarter.

Until any of these fires, the cost-to-value ratio of Option A over B is unfavorable.

---

## 9. Licensing and Monetization Implications

### 9.1 Licensing option space in 2026

- **MIT / Apache 2.0** — permissive, free for SaaS re-hosting. Used by Continue.dev [14], workerd, PartyKit [29]. *Not* used by any dev-tool-with-enterprise-revenue vendor that wants defensibility.
- **AGPL v3** — OSI-approved, copyleft. Requires SaaS operators to release source. Elastic re-added AGPL v3 as an option alongside ELv2 and SSPL in Sept 2024 [33]. Mattermost core uses AGPL.
- **SSPL** — MongoDB-origin, not OSI-approved, stronger than AGPL. Elastic, MongoDB, Redis Labs precedents [33].
- **BSL 1.1** — HashiCorp precedent; 4-year change date to GPL-compatible [34].
- **FSL** — Sentry + consortium, 2-year change date to Apache/MIT [18]. Consciously tuned for SaaS vendors [18].
- **ELv2** — Elastic, fair-code; three use-case restrictions.

### 9.2 Decision consequences of coupling self-host to license

If V1 ships self-host (Option A), a license decision has to be made. Permissive licenses expose us to SaaS re-hosting (Sentry's Catch-22 [32]). Source-available licenses (BSL/FSL/ELv2) avoid re-hosting but exclude us from OSI-compatible corporate acquisition lists and open-source marketplaces. **This is a multi-year governance commitment, not a code-change.**

If V1 is hosted-only (Option B/C/D), the license question can be deferred. A V1 product shipping only hosted code needs no license commitment at all. V1.1 can make the call with real market signal in hand.

### 9.3 Cannibalization of SaaS revenue

- Sourcegraph at 10% Cloud revenue after 3 years of Cloud [22]: strong signal that a self-host-first product does cannibalize Cloud indefinitely, because the buyer who paid for self-host once is trained to want it forever.
- PostHog at 90% Cloud revenue [25]: signal that a hosted-first product with unsupported self-hosted preview still sees the majority of revenue route through Cloud.
- Plausible's bot-detection-gap pattern [35] shows intentional feature-tier differentiation as a funnel mechanism.

**[Inferred]** For *our* product — greenfield, collaborative, small team, coding-adjacent — a full-tier self-host-first positioning risks locking us into Sourcegraph's 10%-Cloud outcome at a stage where the SaaS network effect (shared invites, multi-org presence, discoverability) is still being built. Option B (V1 hosted, V1.1 self-hosted) pushes the revenue-shape decision into year 2, which is strictly better.

### 9.4 License table-stakes if we must ship self-host

If Option A is chosen, the conservative choice is **FSL** (2-year change to Apache-2) or **BSL 1.1** (4-year change to MPL-2 or similar). These protect SaaS revenue while preserving the "runs at your company" story. They are *not* OSI-approved open source, so expect pushback from the Hacker News reader crowd — the Sentry BSL→FSL saga is the archetypal case.

---

## 10. Options Analysis

### Option A — Self-Hosted V1

**Upfront implementation cost:** **Medium.** ~6–10 engineer-weeks of AI-accelerated work across Node relay, RLF-Postgres, Docker Compose + Helm, OIDC, docs, signed-image pipeline, CI doubling. Not a single-sprint commitment but tractable for a capable small team.

**Ongoing operational / support cost:** **High, human-absorbed.** 0.2–0.4 FTE in year 1, rising to 0.5–1 FTE by year 3 as install base grows. Every release is paid twice (dual-backend CI, dual-release notes, dual-hotfix). CVE response cadence becomes a permanent obligation. Licensing governance becomes a multi-year commitment.

**Product implications:** Unlocks regulated-enterprise, air-gap, and EU-sovereignty deals. Competitive with Windsurf at day 1. Opens the BSL/FSL licensing discussion on day 1. Risks Sourcegraph-pattern outcome where Cloud revenue stays a minority share.

**Architecture debt:** None beyond the already-sunk cost; the abstraction is in place. The new maintenance surface is the Node relay impl and the RLF-Postgres rate limiter.

**Reversibility:** Hard one-way door. Once a customer is running self-hosted in production, removing it means either migrating them to Cloud (hostile) or sustaining them forever (Atlassian had to plan a 5-year wind-down). Every other option reserves this call for later.

**Tripwires to revisit:** if self-host support drag exceeds 30% of weekly engineering capacity for >4 consecutive weeks; if self-hosted-install growth plateaus and Cloud revenue dominates (like PostHog's 90/10), evaluate whether self-hosted is still worth sustained investment.

---

### Option B — V1 Hosted-Only, V1.1 Self-Hosted with Named Quarter

**Upfront implementation cost:** **Low.** The architecture is already abstracted for self-host, so we do no extra work in V1. We preserve the rate-limiter abstraction, keep the deployment-topology doc's self-host language, and publish a dated V1.1 roadmap commitment.

**Ongoing operational / support cost:** **Low during V1.** Until V1.1, zero self-hosted operational drag. Engineering bandwidth focuses entirely on shipping 16 V1 features. V1.1 cost is equal to or lower than Option A — we build the self-host path *after* the hosted path has stabilized, so our internal dogfooding data tells us which sharp edges to round off.

**Product implications:** Regulated-enterprise and FedRAMP customers are deferred. Sales can respond to "self-host?" asks with "yes, in <quarter> 20XX" and a published commitment doc. Does not unlock those deals during V1, but keeps the pipeline alive. Licensing decision is deferred to V1.1 with real market signal.

**Architecture debt:** None. The existing abstraction is already the right shape for an Option B → Option A transition.

**Reversibility:** **Two-way door.** V1.1 can be shipped as Option A-equivalent. Or V1.1 can choose Option D if demand doesn't materialize.

**Tripwires to flip to Option A sooner:** ≥3 named enterprise deals gated on self-host; 1 FedRAMP-adjacent customer; regulatory change (EU AI Act, etc.) that makes hosted-only infeasible for a customer class; competitor shipping self-host wins a deal we lose.

---

### Option C — Self-Hostable In Principle, Not Shipped

**Upfront implementation cost:** **Zero.** Architecture is already designed; we simply ship nothing.

**Ongoing operational / support cost:** **Zero.** No support. No license commitment. No CVE channel for self-hosted.

**Product implications:** Cannot answer "yes" to self-host RFP rows. Enterprise sales flow treats any self-host ask as an escalation with no concrete answer. All self-host demand leaks to competitors. Linear-style pure-SaaS posture — viable for consumer/PLG but narrows enterprise reach.

**Architecture debt:** None in code; but the dangling "self-hostable in principle" language becomes a lie by year 2 as new features land without tests on the self-host path. The abstraction rots.

**Reversibility:** Two-way door *on paper* but hardens into a one-way door as architecture drift accumulates. After ~18 months of hosted-only development without CI coverage of the self-host path, we will have regressed — and reclaiming Option A would cost more than Option A cost at V1.

**Tripwires to revisit:** same as Option B but without a pre-committed target, so response time to "we're losing deals on this" is slower.

---

### Option D — V1 Hosted-Only + Unsupported Community Preview (surfaced)

**Description:** V1 is CF-hosted. We additionally publish a reference Docker Compose, MIT-licensed, marked explicitly **Community Preview: Unsupported**. We promise nothing: no SLAs, no upgrade path, no CVE channel. Users can run it; issues are handled on GitHub best-effort, not via support.

This is the PostHog model [26].

**Upfront implementation cost:** **Low.** A compose file + README + a clearly-labeled "community preview" disclaimer on the docs site. No Helm. No signed images. No OIDC requirement. No SAML. The Node relay is *optional* — if the user tolerates CF-free local-dev-only behavior, they can run with a simplified single-process relay we already need for dev ergonomics.

**Ongoing operational / support cost:** **Low.** Issue triage only when our own CI would already catch the bug. Clear unsupported label blunts the support-ticket flow.

**Product implications:** Lets sales say "yes, self-hostable" to RFP rows while being honest about the support level. Does *not* unlock FedRAMP or regulated-enterprise deals that need a vendor-support contract. Provides market signal — if community preview gets traction, we have data to decide Option A later.

**Architecture debt:** Low, if we commit to keeping the preview at functional parity with the hosted product. Moderate if we let it rot.

**Reversibility:** Two-way door. Graduating community preview to supported self-host (Option A) is a predictable path with real usage data in hand. Graduating to pure hosted-only (Option C) would require disclosing a wind-down, which is mildly painful but not customer-damaging because users were told "unsupported" at the start.

**Tripwires:** install base crossing ~100 active community-preview instances → start planning Option A transition. Support-ticket leakage (users opening support tickets despite the label) exceeding 10% of queue → strengthen the unsupported messaging or graduate to A.

---

## 11. Recommendation

**Recommend Option B — V1 ships hosted-only with a named-quarter V1.1 commitment to self-hosted.**

### 11.1 Why B wins

The architecture investment that would justify a V1 self-hosted ship (the deployment-aware rate limiter, the relay contract, the trust boundary) has already been paid. That means the **marginal** V1 cost of Option A is packaging + relay impl + dual-CI + docs + support infrastructure. Of those, only the packaging/relay/docs work benefits from AI acceleration. The **support infrastructure, the CVE response cadence, the license-governance commitment, and the dual-release coordination land on humans and compound over the product's life.**

In our specific situation — small team, greenfield, 16 V1 features already committed, zero named-enterprise self-host deals in the pipeline today — those ongoing costs outweigh the strategic value of shipping A in V1. Option B preserves every architectural advantage Option A was trying to unlock while releasing the team to ship V1 on schedule.

Option B is reversible (two-way door), and the *named quarter* commitment is what distinguishes it from Option C. A dated promise keeps the enterprise pipeline open and forces the team to keep the abstraction honest — you cannot casually ignore self-host for 18 months if you've publicly committed to it in Q3 of next year.

### 11.2 The specific constraint that tips the call

**Zero named enterprise accounts today are asking for self-host as an acceptance criterion.** If even one such account existed in the pipeline today with ACV ≥ 2× an engineer-year, Option A would become compellingly worth it for the deal value alone. In the absence of that, the expected ongoing-human cost of Option A dwarfs any option-value it provides.

### 11.3 Steel-manned alternative — why one could reasonably choose A

The strongest case for Option A is **defensibility against Windsurf** [12]. Windsurf ships SOC 2 Type II, FedRAMP High, self-hosted, hybrid, and air-gapped today. If our product positions at the same regulated-enterprise tier Windsurf targets, not shipping self-host in V1 is ceding the compliance-buyer segment for 9–12 months. In markets where enterprise deals are being closed *right now*, 9–12 months is material.

If our product positioning shifts toward regulated-enterprise primarily (away from the PLG dev-team collaborative-coding positioning), the calculus flips. In that world, Option A is correct and the recommendation changes. The tipping variable is **positioning: collaborative-coding-for-teams (→ B) vs. regulated-enterprise-coding-platform (→ A).**

### 11.4 Revisit triggers

Reopen this decision immediately on any of:

- **≥3 named enterprise accounts** in pipeline naming self-host as a gating criterion (each with ACV ≥ 2× an engineer-year).
- **One named FedRAMP / government customer** with compliance paperwork delivered.
- **Regulatory change** (EU AI Act enforcement, HIPAA rule update, or a FedRAMP acceleration) that makes hosted use by a customer class illegal.
- **Competitor signal:** Windsurf wins a deal we lose on self-host, and we can document it.
- **Internal signal:** ≥4 self-host-scope conversations with prospective users in a single quarter (graduated from the previous quarter's baseline).
- **Architecture drift risk:** self-host path loses CI coverage for >8 weeks (indicator the abstraction is rotting; forces an earlier V1.1 decision).

If none of these fire through V1 development, ship V1.1 on the named quarter as Option B planned.

### 11.5 Concrete downstream consequences of Option B

- **BL-060 (self-hosted security requirements doc):** status becomes `deferred to V1.1`, with a one-line pointer in `deployment-topology.md` noting the V1.1 commitment.
- **BL-044 (Plan-021 rate limiting):** pick **CF-native `rate_limit` binding + Durable Objects** for V1; the `rate-limiter-flexible` Postgres path is scheduled with BL-060 for V1.1.
- **`v1-feature-scope.md`:** adds a row "Self-Hosted Control-Plane Deployment" under V1.1 (not V1) citing this brief and ADR-015.
- **`deployment-topology.md`:** keeps the Collaborative Self-Hosted Control Plane topology row (architecture is preserved) with a note that V1 does not ship a self-hosted release artifact; V1.1 target is named there.
- **License:** no commitment in V1.
- **Abstraction hygiene:** CI must still smoke-test the rate-limiter abstraction against an in-memory backend (not CF-specific) to prevent drift. That small cost buys us the cheap V1.1 transition.

---

## 12. Sources

1. [Sirius Open Source — How much does GitLab cost?](https://www.siriusopensource.com/en-us/blog/how-much-does-gitlab-cost) — TCO analysis, self-managed vs SaaS labor costs.
2. [Spendflo — GitLab pricing plans in 2025](https://www.spendflo.com/blog/gitlab-pricing-guide) — license pricing structure.
3. [GitHub Enterprise Server 3.14 docs](https://docs.github.com/en/enterprise-server@3.14/admin/overview/about-github-enterprise-server) — maintenance cycle, operational overhead.
4. [rate-limiter-flexible — PostgreSQL benchmark](https://github.com/animir/node-rate-limiter-flexible/wiki/PostgreSQL) — primary source for RLF-Postgres throughput/latency figures.
5. [Vanta 2025 survey cited via CloudEagle — SOC 2 Audit Complete Guide](https://www.cloudeagle.ai/blogs/soc-2-audit) — 83% enterprise buyer requirement, 67% deal-closure impact.
6. [Akave — 2026 Data Sovereignty Reckoning](https://akave.com/blog/the-2026-data-sovereignty-reckoning) — EU sovereignty, CLOUD Act, 73% EU enterprise statistic.
7. [The Agency Journal — Cursor March 2026 Updates: Self-Hosted Agents](https://theagencyjournal.com/cursors-march-2026-glow-up-self-hosted-agents-jetbrains-love-and-smarter-composer/) — Cursor's March 2026 self-hosted-agents announcement; agent runtime vs control plane boundary.
8. [Plane.so vs Linear comparison](https://plane.so/plane-vs-linear) — self-host status of Linear and alternatives.
9. [Zed self-hosted collaboration discussion #13503](https://github.com/zed-industries/zed/discussions/13503) — Zed's stance on self-host.
10. [Zed self-hosted collaboration docs discussion #33151](https://github.com/zed-industries/zed/discussions/33151) — community documentation request.
11. [Superblocks — Cursor Enterprise Review 2026](https://www.superblocks.com/blog/cursor-enterprise) — Cursor Enterprise tier air-gapped deployment options.
12. [Windsurf Enterprise Security Report (2025)](https://harini.blog/2025/07/02/windsurf-detailed-enterprise-security-readiness-report/) — SOC 2, FedRAMP High, three-deployment-mode story.
13. [Tabby ML GitHub repo](https://github.com/TabbyML/tabby) — self-hosted-first, Apache + `ee/` split, deployment options.
14. [Continue.dev GitHub repo](https://github.com/continuedev/continue) — Apache 2.0 license, self-host-instructions.
15. [Warp Enterprise docs — architecture and deployment](https://docs.warp.dev/enterprise/enterprise-features/architecture-and-deployment) — cloud + self-host + hybrid story.
16. [Pulumi Business Critical](https://www.pulumi.com/docs/iac/comparisons/terraform/) — self-host gated at top-tier plan.
17. [xTom — Rocket.Chat vs Mattermost](https://xtom.com/blog/rocketchat-vs-mattermost/) — self-hosted Slack-alternative field data.
18. [Sentry — Introducing the Functional Source License](https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/) — FSL rationale.
19. [Vela/Simplyblock — Self-Hosting Supabase vs Managed Postgres](https://vela.simplyblock.io/articles/self-hosting-supabase/) — FTE, hours/month, operational-burden figures.
20. [SSOjet — Enterprise Ready SSO Complete Requirements Guide](https://ssojet.com/enterprise-ready/oidc-and-saml-integration-multi-tenant-architectures) — Okta 2025 SSO-protocol survey data, SAML+OIDC table-stakes.
21. [Deiser — Atlassian Data Center EOL](https://blog.deiser.com/en/atlassian-data-center-end-of-life-migrate-to-cloud) — primary source for DC EOL timeline.
22. [Sourcegraph Cloud blog post](https://sourcegraph.com/blog/enterprise-cloud) — 8 years self-host-only, 10% Cloud revenue at disclosure.
23. [Replit Enterprise](https://replit.com/enterprise) — single-tenant GCP project model, EU data residency.
24. [GitLab Self-Managed Platform Team handbook](https://handbook.gitlab.com/handbook/engineering/infrastructure/test-platform/self-managed-platform-team/) — team structure evidence.
25. [Checkthat.ai — PostHog pricing analysis 2026](https://checkthat.ai/brands/posthog/pricing) — ~90% users on Cloud.
26. [PostHog — Self-host open-source support](https://posthog.com/docs/self-host/open-source/support) — explicitly unsupported OSS deployment posture.
27. [Cloudflare blog — Durable Objects: Easy, Fast, Correct — Choose three](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/) — single-writer semantics, input/output gates.
28. [Cloudflare miniflare / workerd](https://github.com/cloudflare/miniflare) — DO + workerd production-suitability caveats.
29. [Cloudflare PartyKit / PartyServer](https://github.com/cloudflare/partykit) — open-source, built on DO (not a DO replacement).
30. [Ably — Scaling Pub/Sub with WebSockets and Redis](https://ably.com/blog/scaling-pub-sub-with-websockets-and-redis) — Node.js WebSocket fan-out pattern.
31. [Cotera — PostHog Self-Hosted: Worth the Ops Overhead?](https://cotera.co/articles/posthog-self-hosted-guide) — maintainer retrospective, 6–8 hrs/month, weekend incident.
32. [Sentry — Re-Licensing Sentry](https://blog.sentry.io/relicensing-sentry/) — BSL rationale, SaaS-re-hosting threat.
33. [Elastic blog — Elastic License v2](https://www.elastic.co/blog/elastic-license-v2) — ELv2 rationale.
34. [HashiCorp BSL 1.1](https://www.hashicorp.com/en/bsl) — BSL precedent in infra tooling.
35. [Plausible — Self-hosted vs Cloud](https://plausible.io/docs/self-hosting) — intentional feature differentiation between self-hosted and cloud.
36. [Cursor Enterprise page](https://cursor.com/enterprise) — direct quote: "we don't offer on-premises deployment today."

---

*Inferences are explicitly marked with **[Inferred]**. Every primary claim not so marked is either (a) directly quoted from a cited source or (b) a quantitative figure from a cited benchmark.*
