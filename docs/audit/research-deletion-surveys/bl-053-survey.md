# T10 Survey: bl-053-self-hosted-scope-research.md

**Date:** 2026-04-25
**Surveyor:** Claude Opus 4.7 (1M context)
**Source brief:** `/home/sabossedgh/dev/ai-sidekicks/docs/research/bl-053-self-hosted-scope-research.md`
**Destination ADR:** `/home/sabossedgh/dev/ai-sidekicks/docs/decisions/020-v1-deployment-model-and-oss-license.md`
**Strategy:** surface-external-citations (T8 lock; analytic content already absorbed into ADR-020 prose in prior sessions)

---

## §1 — Bibliography + Destination Map

The brief's `## 12. Sources` section (lines 487–522) numbers 36 external citations [1]–[36]. ADR-020's existing `### Research Conducted` table (lines 209–218) already contains 8 rows (Supabase, PostHog, Sentry, tmate, Mattermost, Cloudflare DO, rate-limiter-flexible, plus the brief itself). The table below covers ALL 36 brief sources; the `Destination` column distinguishes (a) "already-in-ADR-020-table → no T13 action" from (b) "extend ADR-020 §Research Conducted at line ~218".

**Convention:** "extend ADR-020 §Research Conducted (insert before line 220 closing `### Related ADRs`)" is the canonical destination for new rows.

| # | Source | Type | Key Finding (1-sentence) | URL | Destination |
|---|--------|------|--------------------------|-----|-------------|
| 1 | Sirius Open Source — How much does GitLab cost? | Engineering blog | GitLab self-managed minimum annual TCO exceeds SaaS license cost by ~$82K from internal ops labor. | https://www.siriusopensource.com/en-us/blog/how-much-does-gitlab-cost | extend ADR-020 §Research Conducted |
| 2 | Spendflo — GitLab pricing plans in 2025 | Vendor announcement | GitLab license-pricing structure context for TCO baseline. | https://www.spendflo.com/blog/gitlab-pricing-guide | extend ADR-020 §Research Conducted (low priority — supports [1]) |
| 3 | GitHub Enterprise Server 3.14 docs | Documentation | GitHub Enterprise Server requires dedicated IT, ≥30-min maintenance windows, higher TCO vs Cloud. | https://docs.github.com/en/enterprise-server@3.14/admin/overview/about-github-enterprise-server | extend ADR-020 §Research Conducted |
| 4 | rate-limiter-flexible — PostgreSQL benchmark | Documentation | RLF Postgres benchmark: ~995 req/sec average, p95 21.85ms — adequate for V1 500/sec write target. | https://github.com/animir/node-rate-limiter-flexible/wiki/PostgreSQL | **already in ADR-020** (row 218 covers the library; this benchmark URL deepens it — extend with the wiki URL specifically) |
| 5 | Vanta 2025 survey via CloudEagle — SOC 2 Audit Guide | Primary research | 83% of enterprise buyers require SOC 2 cert; 67% of certified startups report direct deal-closure impact. | https://www.cloudeagle.ai/blogs/soc-2-audit | extend ADR-020 §Research Conducted |
| 6 | Akave — 2026 Data Sovereignty Reckoning | Engineering blog | 73% of EU enterprises prioritize data sovereignty over convenience; CLOUD Act exposes US-HQ SaaS. | https://akave.com/blog/the-2026-data-sovereignty-reckoning | extend ADR-020 §Research Conducted |
| 7 | The Agency Journal — Cursor March 2026 Self-Hosted Agents | Vendor announcement | Cursor March 2026: agent runtime moves to customer network; control plane stays in Cursor cloud. | https://theagencyjournal.com/cursors-march-2026-glow-up-self-hosted-agents-jetbrains-love-and-smarter-composer/ | extend ADR-020 §Research Conducted |
| 8 | Plane.so vs Linear comparison | Engineering blog | Linear ships SaaS-only in 2026; self-host alternatives (Plane, OpenProject) exist but do not dominate. | https://plane.so/plane-vs-linear | extend ADR-020 §Research Conducted (anchors antithesis Linear-as-SaaS-only claim) |
| 9 | Zed self-hosted collaboration discussion #13503 | GitHub Issue | Zed cloud-only collaboration first; community demand for self-host exists, no roadmap commitment. | https://github.com/zed-industries/zed/discussions/13503 | extend ADR-020 §Research Conducted |
| 10 | Zed self-hosted collaboration docs discussion #33151 | GitHub Issue | Community documentation request for Zed self-hosted collaboration. | https://github.com/zed-industries/zed/discussions/33151 | extend ADR-020 §Research Conducted (low priority — duplicate of [9] context) |
| 11 | Superblocks — Cursor Enterprise Review 2026 | Engineering blog | Cursor Enterprise tier: air-gapped deployment options for agent runtime, not control plane. | https://www.superblocks.com/blog/cursor-enterprise | extend ADR-020 §Research Conducted (supports [7] + [36]) |
| 12 | Windsurf Enterprise Security Report (2025) | Engineering blog | Windsurf ships SOC 2 Type II + FedRAMP High + cloud + hybrid + self-hosted (air-gap). | https://harini.blog/2025/07/02/windsurf-detailed-enterprise-security-readiness-report/ | extend ADR-020 §Research Conducted (anchors Antithesis competitor signal) |
| 13 | Tabby ML GitHub repo | GitHub Issue | Tabby ML self-hosted-first; Apache-2.0 + `ee/` LICENSE split (open-core pattern). | https://github.com/TabbyML/tabby | extend ADR-020 §Research Conducted |
| 14 | Continue.dev GitHub repo | GitHub Issue | Continue.dev: Apache 2.0 self-host instructions; cloud Teams plan as monetized wrapper. | https://github.com/continuedev/continue | extend ADR-020 §Research Conducted |
| 15 | Warp Enterprise docs — architecture and deployment | Documentation | Warp documents cloud + self-hosted + hybrid models in enterprise tier. | https://docs.warp.dev/enterprise/enterprise-features/architecture-and-deployment | extend ADR-020 §Research Conducted |
| 16 | Pulumi — IaC comparisons (Business Critical plan) | Documentation | Pulumi self-host gated to top-tier "Business Critical" enterprise plan. | https://www.pulumi.com/docs/iac/comparisons/terraform/ | extend ADR-020 §Research Conducted |
| 17 | xTom — Rocket.Chat vs Mattermost | Engineering blog | Self-hosted Slack-alternatives field data; neither has displaced Slack in enterprise. | https://xtom.com/blog/rocketchat-vs-mattermost/ | extend ADR-020 §Research Conducted (low priority — anchors negative-space claim) |
| 18 | Sentry — Introducing the Functional Source License | Vendor announcement | Sentry's FSL rationale: "freedom without free-riding"; 2-year change to Apache/MIT. | https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/ | extend ADR-020 §Research Conducted (anchors the BSL→FSL precedent the ADR cites in Decision §License + Tripwire 1) |
| 19 | Vela/Simplyblock — Self-Hosting Supabase vs Managed Postgres | Engineering blog | Self-hosting Supabase: 5–10 hrs/month; 1–2 FTE for larger orgs; full ops surface beyond DB. | https://vela.simplyblock.io/articles/self-hosting-supabase/ | extend ADR-020 §Research Conducted |
| 20 | SSOjet — Enterprise Ready SSO Complete Requirements Guide | Documentation | OIDC + SAML are 2025–2026 enterprise SSO table-stakes; 90% of SaaS buyers prioritize standards-based SSO. | https://ssojet.com/enterprise-ready/oidc-and-saml-integration-multi-tenant-architectures | extend ADR-020 §Research Conducted (anchors Option C OIDC/SAML rejection rationale) |
| 21 | Deiser — Atlassian Data Center End of Life | Vendor announcement | Atlassian DC EOL timeline: 2025-12-16 → 2029-03-28; even largest dev-tool vendor judges self-host indefensible at maturity. | https://blog.deiser.com/en/atlassian-data-center-end-of-life-migrate-to-cloud | extend ADR-020 §Research Conducted (highest-priority counter-signal cite) |
| 22 | Sourcegraph Cloud blog post | Engineering blog | Sourcegraph: 8 years self-host-only (2013–2021); ~10% of revenue on Cloud at disclosure (i.e., 90% self-host). | https://sourcegraph.com/blog/enterprise-cloud | extend ADR-020 §Research Conducted (highest-priority counter-data-point) |
| 23 | Replit Enterprise | Vendor announcement | Replit: dedicated single-tenant GCP project model + EU data residency (no true on-prem). | https://replit.com/enterprise | extend ADR-020 §Research Conducted |
| 24 | GitLab Self-Managed Platform Team handbook | Documentation | GitLab maintains full Self-Managed Platform Team + Scalability Working Group + Delivery group. | https://handbook.gitlab.com/handbook/engineering/infrastructure/test-platform/self-managed-platform-team/ | extend ADR-020 §Research Conducted (supports [1] TCO claim) |
| 25 | Checkthat.ai — PostHog pricing analysis 2026 | Engineering blog | ~90% of PostHog users are on Cloud despite OSS self-host availability. | https://checkthat.ai/brands/posthog/pricing | extend ADR-020 §Research Conducted (the PostHog precedent row at line 213 is generic; this URL provides the specific 90% figure) |
| 26 | PostHog — Self-host open-source support | Documentation | PostHog OSS self-host is MIT-licensed and explicitly unsupported (community via GitHub Issues, not support tickets). | https://posthog.com/docs/self-host/open-source/support | extend ADR-020 §Research Conducted (supplements existing PostHog row at line 213 with the explicit-unsupported posture URL) |
| 27 | Cloudflare blog — Durable Objects: Easy, Fast, Correct | Documentation | DO single-writer semantics: "exactly one location, one single thread, at a time"; input/output gates. | https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/ | extend ADR-020 §Research Conducted (supplements existing CF DO row at line 217 with semantic-properties URL) |
| 28 | Cloudflare miniflare / workerd | GitHub Issue | workerd DO storage caveat: not production-suitable in 2026; DOs always run on the same machine as requested. | https://github.com/cloudflare/miniflare | extend ADR-020 §Research Conducted (anchors why a CF-DO-as-self-host shortcut is not viable) |
| 29 | Cloudflare PartyKit / PartyServer | GitHub Issue | PartyKit is open-source DO wrapper, NOT a DO replacement; does not solve self-host problem. | https://github.com/cloudflare/partykit | extend ADR-020 §Research Conducted (anchors why a self-hostable PartyKit shortcut does not apply) |
| 30 | Ably — Scaling Pub/Sub with WebSockets and Redis | Engineering blog | Industry-standard Node.js + Redis pubsub + WebSocket hub pattern for self-hosted DO replacement. | https://ably.com/blog/scaling-pub-sub-with-websockets-and-redis | extend ADR-020 §Research Conducted (anchors the chosen Node-relay self-host implementation pattern) |
| 31 | Cotera — PostHog Self-Hosted: Worth the Ops Overhead? | Engineering blog | PostHog self-host retrospective: 6–8 hrs/month maintenance; weekend incident response example. | https://cotera.co/articles/posthog-self-hosted-guide | extend ADR-020 §Research Conducted (supplements existing PostHog row with concrete-cost retrospective) |
| 32 | Sentry — Re-Licensing Sentry | Vendor announcement | Sentry BSL rationale: "competitive elements that threaten the future of Sentry"; relicensing preserves user freedom. | https://blog.sentry.io/relicensing-sentry/ | extend ADR-020 §Research Conducted (anchors Sentry-precedent claim in Decision §License + Tripwire 1 + Decision Log) |
| 33 | Elastic blog — Elastic License v2 | OSS license analysis | ELv2 rationale; Elastic re-added AGPL v3 in Sept 2024 alongside ELv2 and SSPL. | https://www.elastic.co/blog/elastic-license-v2 | extend ADR-020 §Research Conducted (supports the source-available license option-space named in §Decision) |
| 34 | HashiCorp BSL 1.1 | OSS license analysis | HashiCorp BSL precedent; 4-year change date to GPL-compatible. | https://www.hashicorp.com/en/bsl | extend ADR-020 §Research Conducted (supports BSL option named in §Reversibility + §License) |
| 35 | Plausible — Self-hosted vs Cloud | Documentation | Plausible's intentional feature differentiation between self-hosted and cloud as funnel mechanism. | https://plausible.io/docs/self-hosting | extend ADR-020 §Research Conducted (low priority — anchors revenue-cannibalization framing in §Synthesis) |
| 36 | Cursor Enterprise page | Vendor announcement | Direct quote: "we don't offer on-premises deployment today." | https://cursor.com/enterprise | extend ADR-020 §Research Conducted (highest-priority direct-comparable cite) |

### Mapping summary

- **Already in ADR-020 table (no T13 action):** rows for Supabase, PostHog (generic), Sentry (BSL/FSL precedent generic), tmate, Mattermost, Cloudflare DO (generic), rate-limiter-flexible (generic). The brief's bibliography supplies *deeper* URLs for several of these (especially [25][26][27][31] for PostHog/CF-DO); T13 should ADD those rows rather than overwrite the generic ones — they cite different load-bearing claims.
- **New rows to land in T13:** all 36 sources, with prioritization by load-bearing weight in the ADR's Decision/Antithesis/Synthesis prose:
  - **Highest priority (must land):** [21] Atlassian DC EOL, [22] Sourcegraph Cloud, [36] Cursor Enterprise direct quote, [12] Windsurf, [7] Cursor self-hosted-agents (March 2026), [18][32] Sentry FSL/BSL — these directly anchor named claims.
  - **High priority:** [1][3] GitHub/GitLab TCO, [5][6] SOC 2 + EU sovereignty stats, [13][14] Tabby/Continue, [19][24][25][26][31] PostHog/Supabase/GitLab ops-cost data, [20] OIDC/SAML, [27][28][29][30] CF-DO portability evidence.
  - **Medium priority:** [4] RLF benchmark URL, [8][9][10][11][15][16][23] precedent products, [33][34] license precedents.
  - **Low priority (optional supplements):** [2] GitLab pricing, [17] Rocket.Chat/Mattermost, [35] Plausible.

Total candidate rows for T13: **36** (less ~5 already-cited generically → ~31 fully new + 5 deepening rows).

---

## §2 — Absorption Confirmed

ADR-020 §Decision, §Alternatives Considered, §Reversibility, §Failure Mode Analysis, §Tripwires, and §Decision Log were read in full (lines 1–248). The following absorption confirmations apply:

1. **Self-hosted scope choice (V1 vs V1.1 vs V2).** The brief's central question (does V1 ship self-host?) is fully resolved in ADR-020 §Decision: "V1 ships with **two deployment options** over a **single codebase** under a **permissive OSS license**" — and ADR-020 §Alternatives explicitly supersedes the brief's Option B recommendation (line 18, line 108) on OSS-developer-tool framing.

2. **License selection.** The brief's §9 license option-space (MIT/Apache/AGPL/SSPL/BSL/FSL/ELv2) is fully reflected in ADR-020 §Decision §License (line 52: "MIT or Apache-2.0 at repo root") and §Decision Log entry 2026-04-17 LICENSE (line 247) selecting Apache-2.0 with explicit reasoning. The Sentry BSL→FSL precedent is preserved as the reversal path in Tripwire 1 (line 201) and §Reversibility (line 153).

3. **Deployment-model trade-offs (cost/benefit).** The brief's §7 ongoing-cost evidence (PostHog 6–8 hrs/mo; Supabase 5–10 hrs/mo; GitLab full Self-Managed team) lands as ADR-020 §Antithesis (line 88: "doubles the QA matrix...20–30% of a small team's weekly capacity") and §Tripwires #2 (line 202: "Community-support drag exceeds 30% of weekly engineering capacity for 4+ consecutive weeks"). The brief's §8 timing analysis (V1 vs V1.1) is preserved in ADR-020 §Alternatives Considered Option B steel-man + rejection (lines 104–108).

4. **Comparable-product survey.** The brief's §3 comparable-product table (Linear, Cursor, Windsurf, Sourcegraph, PostHog, Supabase, etc.) is consolidated into ADR-020 §Antithesis (line 88: "Linear, Notion, Figma, Cursor, Warp — all hosted-only at V1") + §Synthesis (line 92: "Linear / Notion / Figma / Warp are not counter-examples — they are hosted-only products whose value is the hosted surface"). The Sourcegraph + Windsurf + Cursor counter-data points are integrated into the Thesis/Antithesis/Synthesis triad.

5. **Cloudflare Durable Object portability.** The brief's §4 DO portability evidence (workerd not production-safe; PartyKit is wrapper not replacement; Node + Redis is industry pattern) lands as ADR-020 §Decision §Relay Infrastructure (lines 65–69: "Self-hostable relay: Node.js WebSocket implementation of the same v2 relay protocol"). The shared-protocol-contract design is explicitly named (line 69: "Both backends implement the v2 relay protocol behind one shared contract").

6. **Rate-limiter scope.** The brief's §5 RLF-Postgres analysis lands as ADR-020 §Decision §Rate-Limiter Backends (lines 71–76) committing to ship both backends in V1 under the deployment-aware abstraction.

7. **Tripwires.** The brief's §11.4 revisit triggers (3+ enterprise deals; FedRAMP customer; regulatory change; competitor signal; internal signal) are conceptually compressed into ADR-020 §Tripwires #1–#3 (lines 201–203), reframed for the OSS-posture decision (competitive re-host; community-support drag; hosted MAU floor). Some specific brief tripwires (e.g., FedRAMP customer with paperwork) are not literally enumerated in the ADR — see §3 unique-content risk note 1.

8. **Failure modes.** The brief's implicit failure-mode analysis (license-cannibalization, support drag, architecture drift) lands as ADR-020 §Failure Mode Analysis table (lines 140–148).

9. **First-run UX.** The brief's mention of OIDC table-stakes ([20]) lands as ADR-020 §Decision §First-Run UX (lines 56–62: three-way choice with self-host TOFU prompt) and as the rejection rationale for Option C enterprise OIDC/SAML (lines 110–114).

**Verdict:** Absorption is comprehensive. All major analytic claims from the brief are present in ADR-020 body prose, alternatives, tripwires, or failure-mode rows.

---

## §3 — Unique-Content Risk

The following analytic claims from the brief are NOT literally present in ADR-020. Each is flagged with a recommendation (carry-forward needed vs. acceptable to omit):

1. **Specific FedRAMP-customer tripwire ([brief §11.4 line 466]).** The brief enumerates a literal "**One named FedRAMP / government customer** with compliance paperwork delivered" tripwire that ADR-020 does not include in its §Tripwires section. The ADR's §Tripwires #1 (competitor re-host) does not cover this case. **Risk:** if a FedRAMP-adjacent prospect appears, the ADR has no explicit revisit pointer. **Recommendation:** acceptable to omit — Option C rejection (lines 110–114) explicitly cites enterprise-compliance items as V1.1+ scope, which functionally captures the same trigger. No T13 action.

2. **Quantified "0.2–0.4 FTE → 0.5–1 FTE year 3" projection ([brief §7.3 lines 274–280]).** The brief gives a specific quantified ongoing-cost projection that ADR-020 references generally (§Antithesis line 88: "20–30% of a small team's weekly capacity") but does not preserve the year-1-vs-year-3 ramp. **Risk:** future capacity planning may not have access to the specific numbers. **Recommendation:** acceptable to omit from ADR body — but T13 should ensure the bl-053 brief deletion does not orphan this number. Options: (a) preserve in ADR-020 §Failure Mode Analysis as a row note; (b) carry to Spec-027 secure-defaults doc capacity-planning section; (c) accept loss (the 30%-of-capacity ADR tripwire is the load-bearing replacement). **Default recommendation: (c) accept loss** — the ADR tripwire metric (30% sustained) is the operationally meaningful threshold and supersedes the FTE estimate.

3. **Sourcegraph 10% Cloud revenue cannibalization signal ([brief §9.3 line 357]).** The brief uses Sourcegraph's 10% Cloud revenue figure as evidence that self-host-first cannibalizes hosted revenue indefinitely. ADR-020 §Antithesis names Sourcegraph (line 88: "Sourcegraph...all hosted-only at V1, some opened self-host later") but does not preserve the 10% number. **Risk:** the cannibalization-pattern argument loses its quantitative anchor. **Recommendation:** the [22] Sourcegraph row in §1 carries the URL forward; if T13 lands the URL in the table the quantitative claim remains accessible to a reader following the citation. Acceptable to omit from body prose. **No additional action beyond §1 destination.**

4. **PostHog 90% Cloud revenue counter-signal ([brief §3 line 100, §9.3 line 358]).** Same pattern as #3 above — the 90% figure is a quantitative anchor not preserved in ADR-020 body prose. The [25] Checkthat.ai row in §1 carries the URL forward. **No additional action beyond §1 destination.**

5. **Atlassian DC EOL specific dates ([brief §2.3 lines 67–70]).** The brief enumerates four specific EOL dates (2025-12-16, 2026-03-30, 2028-03-30, 2029-03-28). ADR-020 does not name Atlassian directly in body prose — it relies on the Linear/Notion/Figma/Warp/Cursor list for the hosted-only case. **Risk:** if a future reviewer wants to argue "even Atlassian is retreating from self-host," they would reach the bl-053 brief — which this audit is deleting. **Recommendation:** the [21] Deiser row in §1 carries the URL forward; the Atlassian-EOL claim becomes a citable-URL fact rather than ADR body prose. Acceptable, but T13 should confirm the URL row is included with a key-finding line that captures the "retreating from self-host" framing.

6. **License-coupling consequence framing ([brief §9.2 line 351]).** The brief's specific framing — "Permissive licenses expose us to SaaS re-hosting (Sentry's Catch-22)" — is captured in ADR-020 §Failure Mode Analysis row 1 (line 142: "Competitor re-hosts codebase as competing managed service") and §Tripwire 1 (line 201). **No risk; absorbed.**

7. **The "Inferred" markers throughout the brief.** The brief explicitly marks inferred claims with **[Inferred]** notation (lines 76–77, 142, 148, 158, 179, 191, 322). ADR-020 has its own §Assumptions Audit table (lines 130–136) which captures the same uncertainties under named assumptions. **No risk; absorbed.**

**Verdict:** Unique-content risk is **LOW**. The major analytic claims have been absorbed into ADR-020. Quantitative anchors (FTE projections, 10%/90% revenue ratios, Atlassian EOL dates) are accessible via the URLs T13 will land in §Research Conducted. **Safe to delete bl-053 brief after T13 embed.**

---

## Surveyor Notes

- **Format precedent followed:** Source/Type/Key Finding/URL/Destination columns match canonical examples in ADR-016 (lines 156–164) and ADR-017 (lines 116–122).
- **No filtering:** all 36 brief citations are surfaced. T13 may down-select to a subset by load-bearing priority (per the §1 Mapping summary), but the surveyor recommends landing the high+highest priority subset (~20 rows) at minimum to preserve evidence chain.
- **Inferred-claim handling:** the brief's `[Inferred]` markers do not need to be carried forward — ADR-020's §Assumptions Audit captures the same epistemic posture.
- **Generic vs. deepening rows:** rows [25][26][27][31] cite specific PostHog/CF-DO URLs that supplement the generic rows already in ADR-020. T13 should ADD them as separate rows (not replace), because they cite different load-bearing claims (e.g., the 90% Cloud-revenue figure vs. the OSS-self-host-existence fact).
- **No anomalies in the brief itself.** All 36 sources have URLs; types are recoverable from context. The brief is well-structured for citation extraction.
