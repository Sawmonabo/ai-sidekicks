# Final Citation Research Report — Q#6 + Q#8

**Authored:** 2026-04-22
**Inputs:** q6-dagger-research.md + q8-jenkins-research.md
**Synthesis method:** Semantic-similarity dedup + cross-reference consolidation

---

## 1. Executive Summary (≤300 words)

Both Spec-017 citations under review are broken in ways that the H5 remediation plan's pre-surfaced option (a) would **not** have fixed. In both cases, primary-source research landed on a better option than the plan anticipated.

**Q#6 — Dagger CUE→SDK citation (Spec-017 §62 + §424):** The cited URL `dagger.io/blog/next-dagger-sdks` is HTTP 404. The H5 plan's option (b) candidate (`introducing-dagger-functions`, Feb 2024) **does not mention CUE at all** and cannot carry the claim. The "~2.5 years" duration claim is unverifiable from any surviving primary source. **Recommendation: corrected option (b)** — swap to `dagger.io/blog/ending-cue-support/` (Dec 18, 2023, on-domain, Dagger-team-authored) + Changelog #550 podcast (Jul 28, 2023, Solomon Hykes on-record). Drop "~2.5 years"; replace with primary-source-anchored "~12-month dual-maintenance window." Preserves founder-retrospective force; upgrades citation quality.

**Q#8 — Jenkins SECURITY-383 citation (Spec-017 §344 + §441):** The citation is **doubly wrong** — SECURITY-383 is a real ID but refers to an XStream RCE on the 2017-02-01 advisory, not the input-step RBAC issue; the cited URL (2017-04-10) is a Groovy-plugins roll-up that contains neither SECURITY-383 nor any input-step content. The anti-pattern claim itself is historically true; its canonical citation is **SECURITY-576 / CVE-2017-1000108** in the **2017-08-07** advisory. **Recommendation: new option (d)** (not in original plan) — fix the identifier+URL to SECURITY-576 and add plugin-source citation (`InputStepExecution.java` `canSettle()`) + JENKINS-56016 Won't Fix for the silent-admin-bypass half.

**Why both differ from H5 plan defaults:** The plan's pre-surfaced options were anchored to the task-prompt framing. Multi-round primary-source verification exposed that the "obvious" swap candidates either don't carry the claim (Q#6: wrong post) or don't fix the problem (Q#8: options a/b/c all fail on evidence, option d was undiscovered).

---

## 2. Cross-Cutting Context (deduped from both files)

### 2.1 Shared citation-fidelity principles

Three principles operate identically across both cases:

1. **Specifications carry normative authority; broken/wrong citations make load-bearing claims un-auditable.** A 404 URL or a citation pointing to the wrong advisory leaves a reader unable to verify a normative claim. "Keep URL + annotate as broken" (Q#6 option c) and "keep identifier on wrong URL" (Q#8's current state) both violate this.

2. **On-domain, dated, author-attributable primary sources beat all alternatives.** Q#6's `ending-cue-support/` wins because it is on-domain (dagger.io), dated (Dec 18, 2023), and officially Dagger-team-authored. Q#8's `2017-08-07` advisory + plugin source wins for the same reason (jenkins.io on-domain + vendor repo source on `master`).

3. **Retire the claim beats weaker substitute; better primary source beats either.** The memory rule (`feedback_citations_in_downstream_docs.md`) says load-bearing claims need primary-source citations. When the named citation fails, retiring the claim (option a) is principled but inferior if a stronger primary source exists. In both Q#6 and Q#8 a stronger primary source exists, so option (a) loses.

**Corollary — preserve argumentative force while upgrading citation quality.** Both files explicitly reject options that would preserve citation shape at the cost of losing argumentative force (Q#6 option a loses Hykes-on-record and the community-OSS-vs-platform precedent diversity; Q#8 option c leaves I3 without a concrete anti-pattern, weakening its normative force).

### 2.2 Shared research-environment constraints

- **Fetch date anchor:** 2026-04-22 across every URL in both files.
- **web.archive.org blocked from environment** (Q#6 documents this explicitly for the broken Dagger URL; WebSearch `site:web.archive.org ...` returned zero hits). Q#8 did not require archive access because the correct advisory URL is live.
- **Multi-round WebSearch expected** when task-prompt candidates fail verification (Q#6: `introducing-dagger-functions` was expected-to-work but did not mention CUE, requiring pivot to `ending-cue-support/`; Q#8: all three pre-surfaced options fail, requiring discovery of option d).
- **TLS certificate failures** on some secondary sources (Q#6: itnext.io), and **HTTP 429 rate-limits** on HN (Q#6). Q#8 encountered no fetch failures.
- **Verbatim quoted substring requirement:** both files record exact quoted substrings with fetch dates in their sources tables so downstream docs can carry them forward without re-fetching.

### 2.3 Shared meta-findings

**Meta-finding 1 — The H5 plan's pre-surfaced option (a) was wrong in both cases.** Q#6 plan option (a) = "remove Dagger citation entirely"; Q#8 plan option (a) = "swap to 2022-10-19 advisory." Both fail: Q#6 (a) discards recoverable primary-source evidence (Hykes retrospective + on-domain blog); Q#8 (a) swaps to an advisory (SECURITY-2880 CSRF) that does not carry the claim. The pattern: the plan's option (a) was anchored to the *task-prompt framing* rather than to the *evidence corpus that research surfaces*.

**Meta-finding 2 — Task-prompt-supplied candidates must be verified, not assumed.** Q#6 task prompt supplied `introducing-dagger-functions` as option (b) candidate — but WebFetch verification showed zero mentions of CUE. Q#8 task prompt implicitly anchored on the existing (wrong) SECURITY-383 identifier rather than checking whether the advisory content matched the claim. In both cases, verifying the task-prompt candidate was the step that flipped the recommendation.

**Meta-finding 3 — The correct replacement often uses MORE citations, not fewer.** Q#6 corrected (b) uses two primary sources (on-domain blog + podcast). Q#8 option (d) uses three (advisory + plugin source + Jira). Modest citation-count increase is the cost of primary-source fidelity for composite claims (duration + rationale; history + current silent-bypass behavior).

**Meta-finding 4 — Separable sub-claims should carry separate citations.** Q#6: the "duration of CUE as primary language" sub-claim and the "Hykes admitted the DSL was wrong" sub-claim land on different primary sources. Q#8: Claim A (`Read` approves) and Claim B (admin bypass silent) land on different primary sources. Splitting the citation makes each sub-claim independently auditable and future-proof against one source going stale.

---

## 3. Q#6 — Dagger CUE→SDK Citation

### 3.1 Primary-source forensic

**Broken citation:** `https://dagger.io/blog/next-dagger-sdks` — HTTP 404 as of 2026-04-22. No archive mirror located from the research environment (web.archive.org blocked).

**Unverifiable quantitative claim:** "Dagger rewrote its CUE-based SDK over ~2.5 years." No live primary source on dagger.io or in the GitHub dagger/dagger repo carries this exact duration claim as of 2026-04-22.

**Reconstructed timeline from live primary sources** (each entry fetched 2026-04-22):

| Date | Event | Primary source |
|---|---|---|
| Jan 25, 2022 | Dagger v0.1.0 released — CUE is the primary configuration language; release notes describe "CUE structural cycles", "CUE functions", "embed them in CUE" | github.com/dagger/dagger/releases/tag/v0.1.0 |
| Mar 28, 2022 | Dagger 0.2 "Europa" launch — CUE remains canonical: "composing arbitrarily complex automations out of standardized primitives, declaratively, using CUE and Buildkit" | dagger.io/blog/dagger-0-2 |
| Nov 8, 2022 | Python SDK announcement (Go SDK ~2 weeks earlier) — multi-language SDK era begins; CUE no longer sole authoring path | dagger.io/blog/python-sdk |
| Dec 2, 2022 | GitHub Discussion #4086 opened — CUE SDK port to engine 0.3 stalled; shykes (Dec 6, 2022) cites security + breaking-change risk; by Dec 23, 2022 port is "stalled" | github.com/dagger/dagger/discussions/4086 |
| Jul 28, 2023 | Changelog podcast #550 — Hykes on-record: "bait and switch" / "death by 1000 cuts" / "we had a pretty massive cohort of people run through it...they're all going to leave" | changelog.com/podcast/550 |
| Aug 3, 2023 | Dagger 0.8 "Big Summer Clean Up" — breaking-change release; no CUE SDK mention | dagger.io/blog/dagger-0-8 |
| Dec 14, 2023 | CUE SDK support officially ended | dagger.io/blog/ending-cue-support/ |
| Dec 18, 2023 | "Ending Support for the Dagger CUE SDK" published: "After a year of keeping the lights on and collecting feedback from our community, we've concluded that there simply is not enough interest" | dagger.io/blog/ending-cue-support/ |
| Feb 28, 2024 | Dagger Functions introduced (v0.10) — **post does not mention CUE** | dagger.io/blog/introducing-dagger-functions |

**Directly cite-able duration claims:**
- "After a year of keeping the lights on" (`ending-cue-support/` Dec 18, 2023) — measures Nov 2022 multi-language SDK launch → Dec 2023 sunset. ~12–13 months of dual-maintenance.
- Jan 25, 2022 → Dec 14, 2023 = ~23 months (~1.9 years) of CUE being canonical/co-canonical authoring surface.

**NOT cite-able from any primary source:**
- "~2.5 years" as a duration claim. Unverifiable.
- Any claim about a 2021 pre-v0.1.0 CUE prototype. Third-party secondary search snippets reference "first public prototype in 2021 was essentially a CUE frontend to Buildkit" but no primary-sourced 2021 Dagger announcement with a fixed date was located. No load-bearing claim should rest on this.

### 3.2 Options evaluation

**Pivot from task framing:** Task prompt supplied `dagger.io/blog/introducing-dagger-functions` (Feb 28, 2024) as option (b) candidate. WebFetch verification 2026-04-22: that post contains **zero mentions of CUE, CUE SDK, or the CUE-to-SDK migration**. It is the *completion* announcement of the post-CUE architecture, not a retrospective on CUE lock-in. It cannot support a C-1 DSL-lock-in citation on its own.

**Option (a) — Remove Dagger citation; C-1 rests on GitHub Actions alone.**
- For: strictest citation-fidelity discipline if no primary source carries the "~2.5 years" claim; reduces Spec-017 surface area; GitHub Actions HCL→YAML precedent is sufficient as a single CI-platform DSL-abandonment precedent.
- Against: loses Dagger-as-precedent-category (GitHub Actions was a proprietary-platform DSL decision; Dagger was a community-OSS-product DSL decision — losing Dagger collapses the precedent set to a single platform type, weakening C-1's industry-wide argument). Loses Hykes-on-record force ("bait and switch" / "death by 1000 cuts" are uniquely powerful for an architectural spec).
- Verdict: principled fallback; weaker than corrected (b) because evidence is recoverable via alternate live primary sources.

**Option (b, corrected) — Swap to `ending-cue-support/` + Changelog #550; drop "~2.5 years".**
- For: `ending-cue-support/` is on-domain (dagger.io), dated (Dec 18, 2023), officially Dagger-team-authored. Carries verbatim "After a year of keeping the lights on" + the user-preference rationale quote. Changelog #550 preserves the Hykes-founder-retrospective force. Reconstructed ~23-month CUE-primary window is defensible from primary sources.
- Against: two citations instead of one (modest increase; more defensible). Changelog #550 is audio-first; timestamp-pinned quotes are more fragile to future platform changes than blog-post quotes — mitigated by anchoring on `ending-cue-support/` as primary, using #550 only as supplementary.
- Verdict: **strongest option.** Preserves full argumentative force of C-1 while upgrading citation fidelity.

**Option (c) — Keep broken URL with "[URL 404 as of 2026-04-22]" annotation.**
- For: zero substantive grounds. Argument of "transparency" is weaker than (b) because (b) documents the swap in git/BL-resolution auditing while providing a verifiable citation today.
- Against: no corpus-discipline backing found (Google SRE book, Kubernetes KEPs, RFC editor, CNCF white papers, academic citation norms, Wikipedia `{{dead link}}` policy — none bless "keep-URL-mark-as-404" as preferred; Wikipedia policy explicitly requires editors to attempt replacement from archive first). Dagger's own corpus discipline rejects it — Dagger maintains `archive.docs.dagger.io` for CUE-era docs; they archive + redirect rather than 404 + annotate. Violates citation-fidelity rule: a 404 citation inside a normative spec creates an un-auditable claim.
- Verdict: **reject.**

### 3.3 Recommendation + reasoning

**Adopt corrected option (b):**

1. Replace `dagger.io/blog/next-dagger-sdks` with `dagger.io/blog/ending-cue-support/` in Spec-017 §62 and §424.
2. Drop "~2.5 years" quantitative claim; replace with primary-source-anchored form.
3. Add Changelog #550 to Spec-017 §420 Primary Sources (external) as supplementary on the same claim.
4. Keep GitHub Actions HCL→YAML citation; restructure deprecation quote to include the 13-day sunset window.
5. Optional C-1 sharpening: add positive companion commitment — "YAML schema + typed TypeScript SDK with JSONSchema/LSP editor support." Turns C-1 from purely restrictive into explicitly prescriptive; does not change the decision, sharpens it.

**Steel-manned rejected alternatives:**

- Steel-man for (a): "Cite one rock-solid precedent over two mediocre ones." Why (b) wins: `ending-cue-support/` is not mediocre — "one year of keeping the lights on" is a stronger, more precise duration claim than "~2.5 years." The community-OSS vs. platform-DSL distinction between Dagger and GitHub Actions is substantive: it shows DSL lock-in cost applies even to community-driven, bottom-up projects, not only platform-controlled top-down ones. Losing that breadth weakens C-1.
- Steel-man for (c): "Transparent annotation is more honest than silent removal." Why (b) wins: corrected-(b) swap is **more** transparent — the swap is documented in the BL-resolution + session commit and the new citation is verifiable today. Annotated 404s communicate "we gave up"; swapping to live primary sources communicates "we upgraded citation quality." Git history preserves audit-ability regardless of whether the URL is kept.
- Adversarial check — reframe C-1 entirely to "typed schema-first + LSP-supported", drop "no bespoke DSL"? **No.** The 2024–2026 corpus is not pushing projects *toward* typed-schema+LSP as a replacement for "no bespoke DSL" — it is pushing projects *toward typed-schema+LSP as a realization of* "no bespoke DSL." Brian Grant's 2017 manifesto, Tekton 2024-live design principles, and Dagger's 2023 retrospective all support keeping the negative rule AND adding the positive framing. C-1's "no bespoke DSL" frame is directionally correct for 2026; the sharpening is additive.

**Broader DSL-lock-in precedent corpus (ranked by applicability to C-1):**

| Rank | Source | Date | Applicability |
|---|---|---|---|
| 1 | Dagger — "Ending Support for the Dagger CUE SDK" | Dec 18, 2023 | Direct: authoring-DSL-vs-familiar-language argument |
| 2 | GitHub Actions — "will stop running workflows written in HCL" | Sept 17, 2019 | Direct: canonical CI-platform HCL→YAML precedent, 13-day breaking-change window |
| 3 | Brian Grant — "Declarative application management in Kubernetes" | Aug 2, 2017 | Direct: Kubernetes lead architect's argument for schema-first YAML over bespoke config DSLs |
| 4 | Pulumi — Terraform vs. Pulumi IaC + "Pulumi vs HCL" | 2024 | Direct (vendor-advocacy with concrete HCL DSL-lifecycle criticism) |
| 5 | Tekton — Design Principles | Live 2026-04-22 | Direct: "Avoid implementing our own expression syntax" — nearly verbatim C-1 |
| 6 | Ruud van Asseldonk — "A reasonable configuration language" | Feb 4, 2024 | Adversarial: strongest 2024 essay *against* YAML; useful for steel-manning C-1 |
| 7 | Changelog #550 — "From Docker to Dagger" | Jul 28, 2023 | Direct: founder primary-source retrospective on CUE failure |
| 8 | The New Stack — "Solomon Hykes: Dagger Brings the Promise of Docker to CI/CD" | Apr 13, 2022 | Secondary context: contrasts 2022 CUE-era framing vs. 2023 retrospective |
| 9 | Dagger Docs Archive (archive.docs.dagger.io) | Live | Indirect: Dagger's own corpus-discipline = archive, not 404+annotate; rejects option (c) |

Supporting precedents (not in top ranking): Airflow TaskFlow API (Airflow 2.0, 2020) — `@task` decorator move toward typed Python over Jinja-template XCom approach; Dhall/Spago abandonment (third-party reporting in van Asseldonk essay); CUE Community Update (Oct 10, 2024) discussed at dagger/dagger but not fetched as primary.

### 3.4 Exact replacement text for Spec-017 §62 (verbatim from q6)

**Current:**

> Workflow authoring format: YAML definitions + typed TypeScript SDK. **No bespoke DSL** (no CUE, no HCL, no custom expression language) — C-1 commitment. DSL lock-in cost is precedent-heavy: Dagger rewrote its CUE-based SDK over ~2.5 years ([Dagger — next Dagger SDKs, 2023](https://dagger.io/blog/next-dagger-sdks)); GitHub Actions migrated off HCL to YAML under breaking-change pressure ([GitHub Actions HCL→YAML deprecation, 2019](https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/)).

**Proposed:**

> Workflow authoring format: YAML definitions + typed TypeScript SDK with JSONSchema/LSP editor support. **No bespoke DSL** (no CUE, no HCL, no custom expression language) — C-1 commitment. DSL lock-in cost is precedent-heavy: Dagger maintained its CUE SDK as primary authoring language from Jan 2022 (v0.1.0) through Dec 2023, then ended CUE SDK support after a year of dual-maintenance against multi-language SDKs, citing that "engineers...want to write code in a language they already know. Learning a brand new language, however powerful, is simply not what they're looking for" ([Dagger — Ending Support for the Dagger CUE SDK, 2023](https://dagger.io/blog/ending-cue-support/); [Solomon Hykes on Changelog #550, 2023](https://changelog.com/podcast/550)). GitHub Actions migrated off HCL to YAML under a 13-day breaking-change deprecation window ([GitHub Actions HCL→YAML deprecation, 2019](https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/)).

**Exact replacement text for Spec-017 §423 (verbatim from q6):**

**Current:**

> - [Dagger — next Dagger SDKs (CUE→SDK migration)](https://dagger.io/blog/next-dagger-sdks) — 2023

**Proposed (two entries replace one):**

> - [Dagger — Ending Support for the Dagger CUE SDK](https://dagger.io/blog/ending-cue-support/) — 2023
> - [Changelog #550 — From Docker to Dagger with Solomon Hykes](https://changelog.com/podcast/550) — 2023

---

## 4. Q#8 — Jenkins SECURITY-383 Citation

### 4.1 Primary-source forensic

The Spec-017 citation at lines 344 + 441 is **doubly wrong**:

1. **Wrong identifier on wrong URL.** SECURITY-383 is a real Jenkins advisory ID, but it is an **XStream RCE** vulnerability disclosed in the **2017-02-01** advisory (`jenkins.io/security/advisory/2017-02-01/`). It has nothing to do with the Pipeline Input Step. The URL Spec-017 cites (`2017-04-10`) is a Groovy-plugins roll-up advisory that does **not** contain SECURITY-383 and has no Input Step content.
2. **The anti-pattern claim itself is true** — but its canonical citation is **SECURITY-576 / CVE-2017-1000108** in the **2017-08-07** advisory (`jenkins.io/security/advisory/2017-08-07/`). NVD's one-line description matches Spec-017's "Read permission approves" framing almost verbatim.
3. The "admin bypass is silent" half is independently verifiable from the **current** plugin source: `canSettle()` in `InputStepExecution.java` early-returns `true` when the caller holds `Jenkins.ADMINISTER`, with no audit emission and no surrounding comment. JENKINS-56016 ("submitterParameter ignored for admins") was resolved **Won't Fix**; plugin 2.12 (2020-08-28) only **documented** the behavior rather than changing it.

**SECURITY-383 location table:**

| Identifier location | Advisory URL | Topic | Input-step related? |
|---|---|---|---|
| SECURITY-383 | `https://www.jenkins.io/security/advisory/2017-02-01/` | XStream RCE via `javax.imageio` deserialization | **No** |
| (absent) | `https://www.jenkins.io/security/advisory/2017-04-10/` | Groovy-execution plugins roll-up (SECURITY-123, 176, 187, 256, 257, 292–298, 333, 334, 348, 363, 365–369, 379, 405, 410, 456–496) | **No** |
| (absent) | `https://www.jenkins.io/security/advisory/2017-07-10/` | SECURITY-201/303/335/342/352/433/516/527/528/529/533/538/551 + JENKINS-21436 | **No** |
| **SECURITY-576** | `https://www.jenkins.io/security/advisory/2017-08-07/` | Pipeline: Input Step Plugin — Item/Read → Item/Build | **Yes (canonical)** |
| (absent — CSRF only) | `https://www.jenkins.io/security/advisory/2022-10-19/` | SECURITY-2880 (CSRF bypass via input-step ID) + 29 unrelated plugin CVEs | Different issue |
| (absent) | `https://www.jenkins.io/security/advisory/2020-02-12/` | No Input Step content | **No** |

**Verbatim SECURITY-383 quote from 2017-02-01 advisory** (fetched 2026-04-22):

> "XStream-based APIs in Jenkins (e.g. `/createItem` URLs, or `POST config.xml` remote API) were vulnerable to a remote code execution vulnerability involving the deserialization of various types in `javax.imageio`."

### 4.2 Anti-pattern verification

**Claim A — "Read permission approves": Verified true for Pipeline: Input Step Plugin versions 2.0–2.7 (pre-2017-08-07 fix).**

NVD CVE-2017-1000108 description, fetched 2026-04-22 from `https://nvd.nist.gov/vuln/detail/CVE-2017-1000108`:

> "The Pipeline: Input Step Plugin by default allowed users with Item/Read access to a pipeline to interact with the step to provide input. This has been changed, and now requires users to have the Item/Build permission instead."

CVSS 3.x: **7.5 HIGH** (AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H). Affected: Pipeline Input Step Plugin 2.0 – 2.7. Fixed: 2.8. SECURITY-576. Reference: `https://www.jenkins.io/security/advisory/2017-08-07/`.

Plugin CHANGELOG entry (fetched 2026-04-22 from `https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/CHANGELOG.md`):

> **Version 2.8** (Released 2017-08-07) — "[Fix security issue](https://jenkins.io/security/advisory/2017-08-07/)"

**Claim B — "Admin bypass is silent": Verified true at the source-code level, for all current versions of the plugin.**

Primary source: `InputStepExecution.java` on `master` branch, fetched 2026-04-22 from `https://raw.githubusercontent.com/jenkinsci/pipeline-input-step-plugin/master/src/main/java/org/jenkinsci/plugins/workflow/support/steps/input/InputStepExecution.java`:

```java
// lines 341-350
private boolean canSettle(Authentication a) throws IOException, InterruptedException {
    String submitter = input.getSubmitter();
    if (submitter==null)
        return getRun().getParent().hasPermission(Job.BUILD);
    if (!Jenkins.get().isUseSecurity() || Jenkins.get().hasPermission(Jenkins.ADMINISTER)) {
        return true;
    }
```

Three primary-source facts:
1. `Jenkins.ADMINISTER` holders **short-circuit to `true`** before the `submitter` whitelist is evaluated.
2. No surrounding **comment or doc-comment** explains the bypass at the code site.
3. No **audit-log emission** or event sink call precedes the return. The permission check is silent.

**Behavioral history:**
- JENKINS-56016 "submitterParameter is ignored for admin users" — Resolution: **Won't Fix**, Status: Closed. (`https://issues.jenkins.io/browse/JENKINS-56016` — fetched 2026-04-22)
- Plugin CHANGELOG v2.12 (2020-08-28): *"Document that Jenkins administrators are always able to approve `input` steps ([JENKINS-56016](https://issues.jenkins-ci.org/browse/JENKINS-56016))"* — i.e., the behavior was **undocumented until August 2020**, three years after the plugin's 2.8 fix for Claim A.

**Temporal nuance worth preserving:**

| Sub-claim | Era | Status |
|---|---|---|
| `Read` permission approves | Plugin 2.0 – 2.7 (2016–2017) | Historical, fixed in 2.8 (2017-08-07) |
| Admin bypass silent (no audit, no doc) | Plugin 2.0 – 2.11 (2016–2020-08) | Undocumented, un-audited — truly silent |
| Admin bypass silent (documented) | Plugin 2.12+ (2020-08-28 – present) | Documented but still un-audited: source code has no emit |

Spec-017's current sentence conflates historical Claim A with perpetual Claim B. Defensible as a principle ("don't do what Jenkins did") but should be phrased carefully so readers don't infer current-plugin Read approval is still live.

### 4.3 Options evaluation

**Option (a) — Swap to the 2022-10-19 advisory.**
- Fails on evidence. The 2022-10-19 advisory's only Input Step entry is SECURITY-2880: *"Pipeline: Input Step Plugin 456.vd8a\_957db\_5b\_e9 limits the characters that can be used for the ID of `input` steps."* That is a CSRF / ID-sanitization issue, not an RBAC issue. Swapping the URL would leave the sentence's claim unsupported while pretending the advisory covers it — worse than the current broken state.

**Option (b) — Cite the plugin CHANGELOG for broader permission-handling history.**
- Defensible but inferior to targeted CVE citation. CHANGELOG is legitimate primary source (vendor repo under `master`) but diffuse: a reader must scan multi-version history to reconstruct the claim. A reader landing on CHANGELOG from Spec-017 would not immediately see "Read approves + admin silent" — they'd see a mixed list of JIRA IDs. CHANGELOG is strongest as a **supporting** citation alongside the CVE, not as primary cite.

**Option (c) — Remove Jenkins citation, rely on Airflow/Argo/n8n CVEs at Spec-017:434–436.**
- Fails on evidence. Those CVEs do not carry the anti-pattern:

| CVE | Category | Carries "approval RBAC bypass + silent admin"? |
|---|---|---|
| CVE-2025-68613 (n8n) | GHSA-v98v-ff95-f3cp, CVSS 9.9 | Unverified here; n8n has no approval-step primitive, so unlikely |
| CVE-2024-39877 (Airflow) | Authenticated DAG-author RCE via `doc_md` | **No — code injection, not RBAC bypass** |
| CVE-2025-30066 (tj-actions) | Supply-chain compromise (v1–v45.0.7 pointed to commit 0e58ed8, secrets exfiltrated) | **No — supply-chain, not RBAC** |
| CVE-2025-66626 (Argo) | Symlink-traversal file write → RCE via `/var/run/argo/argoexec` | **No — container escape / RCE, not RBAC** |

Primary-source quotes (all fetched 2026-04-22):
- CVE-2024-39877 (NVD): *"Apache Airflow 2.4.0, and versions before 2.9.3, has a vulnerability that allows authenticated DAG authors to craft a doc_md parameter in a way that could execute arbitrary code in the scheduler context..."*
- CVE-2025-30066 (NVD): *"tj-actions changed-files before 46 allows remote attackers to discover secrets by reading actions logs. (The tags v1 through v45.0.7 were affected on 2025-03-14 and 2025-03-15 because they were modified by a threat actor to point at commit 0e58ed8, which contained malicious updateFeatures code.)"*
- CVE-2025-66626 (Endor Labs): *"even after the 3.7.3 patch, Argo's artifact extraction could still be abused to write outside the intended working directory"*

None support I3's specific normative claim that **approver principal must be a typed capability (not `Read` permission) and admin override must be audited.** Removing the Jenkins citation would leave I3's anti-pattern bullet dangling with no supporting precedent.

**Option (d, new — not in original plan) — Fix the citation to SECURITY-576 / CVE-2017-1000108 + 2017-08-07 advisory (+ plugin source for admin silence).**
- Matches primary-source evidence exactly. The NVD one-liner is a near-verbatim match for Spec-017's current wording; `canSettle()` source is the gold-standard primary source for the silent-admin half; JENKINS-56016's "Won't Fix" confirms the silence is by design, not oversight.

**Top-2 combined (CVE + plugin source) gives 100% primary-source coverage of the Spec-017 sentence:** CVE-2017-1000108 for Claim A, plugin source code for Claim B.

**Ranked citation candidates:**

| Rank | Source | Claim A? | Claim B? | Quality |
|---|---|---|---|---|
| 1 | NVD CVE-2017-1000108 + Jenkins advisory 2017-08-07 (SECURITY-576) | Yes, verbatim | No | Primary (NVD + jenkins.io) |
| 2 | `InputStepExecution.java` on `master` (lines 341-350) | Indirect (Job.BUILD post-fix state) | Yes, directly | Strongest (live source) |
| 3 | CHANGELOG v2.12 "Document that Jenkins administrators are always able to approve `input` steps" (JENKINS-56016) | No | Yes (via "documented in 2020 = undocumented before") | Primary (vendor repo) |
| 4 | JENKINS-56016 Jira "Won't Fix" | No | Yes — confirms Jenkins explicitly chose not to gate admin-override | Primary (vendor issue tracker) |
| 5 | Jenkins advisory 2022-10-19 (SECURITY-2880) | No | No | Primary but wrong anti-pattern |
| 6 | Plugin CHANGELOG full history | Partial (v2.8) | Partial (v2.12) | Primary but diffuse |
| 7 | GitHub Actions `environments`, GitLab MR approvals, Argo Rollouts AnalysisRun gates, Tekton approval tasks | N/A (illustrate *correct* pattern, not anti-pattern) | — | Not a substitute |

### 4.4 Recommendation + reasoning

**Recommended: option (d) — SECURITY-576 / CVE-2017-1000108 + 2017-08-07 advisory + plugin source + JENKINS-56016.**

**Why (d) wins:**
1. **Primary-source match.** NVD CVE-2017-1000108's one-liner is almost word-for-word what Spec-017 already says.
2. **Separable verification.** Claim A and Claim B have independent primary sources, so a reader can audit each half.
3. **Future-proof.** The `canSettle()` link pins to `master` and will track any future fix; the JIRA + CVE pins are immutable.
4. **Minimum edit.** The Spec-017 sentence survives with only an identifier swap + expansion — no need to rewrite the I3 invariant.

**Steel-manned rejected alternative (option c — remove Jenkins citation):**
- *"Don't over-anchor on one vendor's 9-year-old plugin. Future readers may view a 2017 advisory + 2020 Won't Fix as niche trivia rather than a universal anti-pattern. Spec-017 could instead ground I3 in the positive pattern (typed-capability approvers) with no anti-pattern illustration, or cite a more recent and more widely-used system."*
- *"Airflow/Argo/n8n already establish the danger of workflow engines collectively."*

Why still reject: I3 is specifically about **approver-capability typing** (Spec-012 linkage), not generic workflow security. Without a concrete anti-pattern, I3 reads as abstract architectural preference rather than a lesson learned from a real defect. The Jenkins precedent is 9 years old but still live (`canSettle()` on `master` in April 2026). The cost of keeping a well-cited concrete example is one sentence; the cost of dropping it is weakening the invariant's normative force.

**Optional improvement worth flagging to Spec-017 owners (out-of-scope for this BL):** mention GitHub Actions `environments` required-reviewers as the *positive* counterpart in the same bullet — a reader then sees both the anti-pattern (Jenkins input-step) and the modern typed-capability pattern (GitHub environments reviewers), closing the loop on I3. Spec-level editorial call, not citation-correctness.

### 4.5 Exact replacement text for Spec-017 (verbatim from q8)

**Line 344 anti-pattern sentence:**

> Anti-pattern: Jenkins Pipeline Input Step historically approved on `Item/Read` (CVE-2017-1000108, fixed in plugin 2.8 on 2017-08-07) and still silently bypasses the `submitter` allow-list for holders of `Jenkins.ADMINISTER` with no audit emission ([Jenkins SECURITY-576 advisory, 2017-08-07](https://www.jenkins.io/security/advisory/2017-08-07/); [`InputStepExecution.java` `canSettle()`](https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/src/main/java/org/jenkinsci/plugins/workflow/support/steps/input/InputStepExecution.java); [JENKINS-56016 Won't Fix](https://issues.jenkins.io/browse/JENKINS-56016)).

**Line 440/441 references block:**

> - [Jenkins SECURITY-576 / CVE-2017-1000108 advisory (2017-08-07)](https://www.jenkins.io/security/advisory/2017-08-07/)
> - [NVD CVE-2017-1000108 — Pipeline Input Step Item/Read → Item/Build](https://nvd.nist.gov/vuln/detail/CVE-2017-1000108)
> - [Pipeline Input Step source — `canSettle()` admin bypass](https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/src/main/java/org/jenkinsci/plugins/workflow/support/steps/input/InputStepExecution.java)
> - [JENKINS-56016 — submitterParameter ignored for admins (Won't Fix)](https://issues.jenkins.io/browse/JENKINS-56016)

---

## 5. Consolidated Sources Table

Every URL cited across both files, with which question it supports. Fetch date 2026-04-22 across all entries. No URL appears in both files' primary-source corpora — the two questions operate on disjoint evidence sets.

| # | URL | Quoted Substring (verbatim) | Supports Q# | Primary/Secondary |
|---|---|---|---|---|
| 1 | https://dagger.io/blog/ending-cue-support/ | "Since we released multi-language support, we have seen a steep decline in usage of our original CUE configuration syntax… After a year of keeping the lights on and collecting feedback from our community, we've concluded that there simply is not enough interest." / "engineers are tired of building CI/CD pipelines with shell scripts and YAML, what they really want is to write code in a language they already know. Learning a brand new language, however powerful, is simply not what they're looking for." | Q#6 | Primary (Dagger team blog, on-domain) |
| 2 | https://changelog.com/podcast/550 | Hykes (~44:00): "It's kind of a bait and switch" / "The problem was it was different" / "We had a pretty massive cohort of people run through it...they're all going to leave" / "death by 1000 cuts" | Q#6 | Primary (Solomon Hykes on-record interview) |
| 3 | https://dagger.io/blog/introducing-dagger-functions | Verified: zero mentions of CUE. Cannot be used for C-1 DSL-lock-in citation. | Q#6 | Primary (used for verification/exclusion) |
| 4 | https://dagger.io/blog/dagger-0-2 | "The foundation of this model is the Action API: a complete framework for composing arbitrarily complex automations out of standardized primitives, declaratively, using CUE and Buildkit." (Mar 28, 2022) | Q#6 | Primary |
| 5 | https://dagger.io/blog/python-sdk | Pub date Nov 8, 2022. Zero CUE mentions — evidences multi-language-SDK transition. | Q#6 | Primary |
| 6 | https://dagger.io/blog/dagger-0-8 | Pub date Aug 3, 2023. Zero CUE mentions; breaking-change release. | Q#6 | Primary |
| 7 | https://dagger.io/blog/how-dagger-releases | Pub date Mar 21, 2023. Zero CUE mentions. | Q#6 | Primary |
| 8 | https://github.com/dagger/dagger/releases/tag/v0.1.0 | Jan 25, 2022. "Dagger packages to use shell scripts from the filesystem, rather than needing to embed them in CUE"; "secrets to be transformed using CUE functions". | Q#6 | Primary (GitHub release) |
| 9 | https://github.com/dagger/dagger/discussions/4086 | Dec 2, 2022. shykes (Dec 6, 2022): "It would be great to be able to merge this, but we shouldn't force a merge that introduces security regressions or painful breaking changes." shykes (Dec 23, 2022): "It is not canceled, but it is stalled because of difficulty in reaching full compatibility with the current API." | Q#6 | Primary |
| 10 | https://news.ycombinator.com/item?id=38695864 | Unable to fetch — HTTP 429 rate-limited on retry. Noted only as community-thread reference. | Q#6 | Secondary (unfetched) |
| 11 | https://tfir.io/dagger-ends-support-for-cue-sdk/ | Dec 19, 2023. Quotes Dagger blog; no new primary data. | Q#6 | Secondary |
| 12 | https://thenewstack.io/solomon-hykes-dagger-brings-the-promise-of-docker-to-ci-cd/ | Apr 13, 2022. "DevOps engineers build actions using the language of their choice...and then compose them together declaratively using CUE definitions." | Q#6 | Secondary |
| 13 | https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/ | Sept 17, 2019. "GitHub Actions will stop running workflows written in HCL"; sunset Sept 30, 2019; "You'll need to migrate your HCL workflows to the new YAML syntax using the migration script." | Q#6 | Primary (GitHub changelog, on-domain) |
| 14 | https://www.pulumi.com/blog/hcl-vs-pulumi/ | Jul 9, 2024. "HCL, while robust, lacks the future-proof qualities of Pulumi SDKs due to its fixed syntax and usage constraints"; "HCL maintains a dedicated user base of several hundred thousand developers". | Q#6 | Primary (vendor blog; biased but self-sourced) |
| 15 | https://www.pulumi.com/docs/iac/comparisons/terraform/ | "Terraform requires learning HCL, a DSL that optimizes for simplicity at the expense of flexibility and scale."; "DSLs make tradeoffs optimizing for simplicity and getting started that can become problematic over time... their lack of clear, standard structures and common functionality tend to create maintenance, support, and portability issues." | Q#6 | Primary (vendor docs) |
| 16 | https://github.com/tektoncd/community/blob/main/design-principles.md | "Avoid implementing our own expression syntax; when required prefer existing languages which are widely used and include supporting development tools."; "Avoid implementing templating logic; prefer variable replacement."; "Tekton should contain only the bare minimum and simplest features needed to meet the largest number of CI/CD use cases." | Q#6 | Primary (Tekton community docs, on-domain) |
| 17 | https://github.com/kubernetes/design-proposals-archive/blob/main/architecture/declarative-application-management.md | Aug 2, 2017. "custom-built languages typically lack good tools for refactoring, validation, testing, debugging, etc."; "configuration tooling should manipulate configuration **data**, not convert configuration to code nor other marked-up syntax". | Q#6 | Primary (Kubernetes archive; Brian Grant) |
| 18 | https://ruudvanasseldonk.com/2024/a-reasonable-configuration-language | Feb 4, 2024. On YAML: "The prevalence of yaml in general, a format that does solve some problems (adding comments and a lighter syntax to json), but in the process introduces so many new problems that the cure is almost as bad as the disease." On DSL maintenance: "When a project takes off, inevitably users start making requests, having opinions, and submitting well-intentioned but low-quality contributions. Keeping up with that takes time and mental energy." | Q#6 | Primary (practitioner essay) |
| 19 | https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/taskflow.html | TaskFlow API = Airflow 2.0+ authoring surface replacing Jinja-template XCom passing with `@task`-decorated Python functions. Structural evidence. | Q#6 | Primary |
| 20 | https://archive.docs.dagger.io/ | Structural: Dagger maintains pinned pre-0.3 CUE-era docs archive — cited org's own corpus-discipline is archive, not 404+annotate. | Q#6 | Primary (Dagger-maintained archive) |
| 21 | https://web.archive.org/web/2024*/dagger.io/blog/next-dagger-sdks | WebFetch blocked from environment; WebSearch returned zero hits. Unverified. | Q#6 | Unreachable |
| 22 | https://www.jenkins.io/security/advisory/2017-02-01/ | "XStream-based APIs in Jenkins (e.g. `/createItem` URLs, or `POST config.xml` remote API) were vulnerable to a remote code execution vulnerability involving the deserialization of various types in `javax.imageio`." (Locates SECURITY-383; not input-step.) | Q#8 | Primary (Jenkins advisory, on-domain) |
| 23 | https://www.jenkins.io/security/advisory/2017-04-10/ | URL Spec-017 currently cites; confirmed does not contain SECURITY-383 or input-step. Enumerated IDs: SECURITY-123, 176, 187, 256, 257, 292–298, 333, 334, 348, 363, 365–369, 379, 405, 410, 456–496. | Q#8 | Primary (for exclusion verification) |
| 24 | https://www.jenkins.io/security/advisory/2017-07-10/ | Adjacent advisory; enumerated IDs 201, 303, 335, 342, 352, 433, 516, 527, 528, 529, 533, 538, 551 + JENKINS-21436; no input-step, no SECURITY-383. | Q#8 | Primary (for exclusion verification) |
| 25 | https://www.jenkins.io/security/advisory/2017-08-07/ | Correct advisory for Read→Build change; lists SECURITY-576 as "The Pipeline: Input Step Plugin by default allowed users with Item/Read access to a pipeline to interact with the step to provide input..." | Q#8 | Primary (Jenkins advisory, on-domain) |
| 26 | https://www.jenkins.io/security/advisory/2020-02-12/ | Confirmed no input-step content. | Q#8 | Primary (for exclusion verification) |
| 27 | https://www.jenkins.io/security/advisory/2022-10-19/ | "Pipeline: Input Step Plugin 456.vd8a\_957db\_5b\_e9 limits the characters that can be used for the ID of `input` steps." (SECURITY-2880 — CSRF, not RBAC.) | Q#8 | Primary (evaluated for option a; rejected) |
| 28 | https://nvd.nist.gov/vuln/detail/CVE-2017-1000108 | "The Pipeline: Input Step Plugin by default allowed users with Item/Read access to a pipeline to interact with the step to provide input. This has been changed, and now requires users to have the Item/Build permission instead." CVSS 7.5 HIGH. Affected 2.0–2.7; fixed 2.8. | Q#8 | Primary (NVD) |
| 29 | https://raw.githubusercontent.com/jenkinsci/pipeline-input-step-plugin/master/src/main/java/org/jenkinsci/plugins/workflow/support/steps/input/InputStepExecution.java | Lines 341–350 of `canSettle()`: `if (!Jenkins.get().isUseSecurity() || Jenkins.get().hasPermission(Jenkins.ADMINISTER)) { return true; }` — no audit emission, no explanatory comment. | Q#8 | Primary (live source on master) |
| 30 | https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/CHANGELOG.md | v2.8 (2017-08-07): "Fix security issue"; v2.12 (2020-08-28): "Document that Jenkins administrators are always able to approve `input` steps (JENKINS-56016)". | Q#8 | Primary (vendor repo) |
| 31 | https://issues.jenkins.io/browse/JENKINS-56016 | Resolution: "Won't Fix"; Status: Closed. Ticket title: "submitterParameter is ignored for admin users". | Q#8 | Primary (vendor issue tracker) |
| 32 | https://nvd.nist.gov/vuln/detail/CVE-2024-39877 | "Apache Airflow 2.4.0, and versions before 2.9.3, has a vulnerability that allows authenticated DAG authors to craft a doc_md parameter in a way that could execute arbitrary code in the scheduler context..." CVSS 8.8 HIGH. (Code injection, not RBAC.) | Q#8 | Primary (option c rejection) |
| 33 | https://nvd.nist.gov/vuln/detail/CVE-2025-30066 | "tj-actions changed-files before 46 allows remote attackers to discover secrets by reading actions logs. (The tags v1 through v45.0.7 were affected on 2025-03-14 and 2025-03-15 because they were modified by a threat actor to point at commit 0e58ed8, which contained malicious updateFeatures code.)" CVSS 8.6. (Supply-chain, not RBAC.) | Q#8 | Primary (option c rejection) |
| 34 | https://www.endorlabs.com/learn/when-a-broken-fix-leads-to-rce-how-we-found-cve-2025-66626-in-argo | "even after the 3.7.3 patch, Argo's artifact extraction could still be abused to write outside the intended working directory" (RCE, not RBAC.) | Q#8 | Secondary (option c rejection) |

---

## 6. Decision Matrix for User

Side-by-side comparison of Q#6 options and Q#8 options for the user's staff-level architectural decision.

| Dimension | Q#6 option (a) remove Dagger | Q#6 option (b-corrected) swap to ending-cue-support/ + Changelog #550 | Q#6 option (c) keep 404 + annotate | Q#8 option (a) swap to 2022-10-19 | Q#8 option (b) CHANGELOG only | Q#8 option (c) remove Jenkins | Q#8 option (d-new) SECURITY-576 + plugin source + JENKINS-56016 |
|---|---|---|---|---|---|---|---|
| Primary-source coverage of the claim | Partial (GHA alone) | Full | Broken (404 un-auditable) | Zero (wrong advisory topic) | Partial (diffuse) | Zero (unrelated CVEs) | Full (separable A + B) |
| Argumentative force preserved | Weakened (loses Hykes + community-OSS breadth) | Preserved + sharpened | Preserved (but unverifiable) | Destroyed (misleading swap) | Weakened (reader must reconstruct) | Destroyed (I3 dangles) | Preserved + strengthened (plugin source on master) |
| On-domain primary | Partial | Yes | N/A (404) | Yes (but wrong topic) | Yes (but diffuse) | N/A | Yes (multiple) |
| Future-proof against source rot | Medium | High (two sources) | Low (404 persists) | Low (would need re-fix) | Medium | N/A | High (JIRA immutable; master tracks) |
| Citation-count delta | -1 | +1 | 0 | 0 | 0 | -1 | +2 |
| Corpus-discipline precedent | Neutral | Positive (matches Dagger's own archive discipline) | None found | Negative | Neutral | Negative (loses anti-pattern illustration) | Positive |
| **Verdict** | Principled fallback | **Recommended** | Reject | Reject | Reject as primary; OK as supporting | Reject | **Recommended** |

**Cross-question pattern:** In both questions, the recommendation is the option that combines a **Dagger-team-authored / Jenkins-vendor-primary on-domain source** with a **secondary verification source** (Changelog podcast for Q#6; plugin-code source for Q#8). This matches the MEMORY rule `feedback_citations_in_downstream_docs.md` that load-bearing claims carry primary-source citations with fetch dates, and the corollary that separable sub-claims carry separate citations.

---

## 7. Cross-linkage to Spec-017 Remediation

**Immediate Spec-017 edits required (if both recommendations are adopted):**

**For Q#6:**
- §62 — replace current "Dagger rewrote its CUE-based SDK over ~2.5 years ([Dagger — next Dagger SDKs, 2023](https://dagger.io/blog/next-dagger-sdks))" sentence with the §3.4 proposed text above.
- §423 / §424 — replace the single `next-dagger-sdks` bullet with two bullets (ending-cue-support/ + Changelog #550).
- §420 Primary Sources (external) — add Changelog #550 entry as supplementary.
- Optional: sharpen C-1 framing to add "YAML schema + typed TypeScript SDK with JSONSchema/LSP editor support" as positive companion commitment.

**For Q#8:**
- §344 — replace current anti-pattern sentence with the §4.5 proposed text above.
- §440/§441 references block — replace SECURITY-383 / 2017-04-10 entries with four new entries (2017-08-07 advisory, NVD CVE-2017-1000108, plugin source, JENKINS-56016).

**Downstream doc impact to audit:**

1. **BL-resolution artifacts** that carry the current Spec-017 citations forward. The MEMORY rule `feedback_citations_in_downstream_docs.md` states: "Every ADR/spec/plan/BL-resolution lands primary-source citations for each load-bearing decision; research citations must be carried forward, not left in research/ dir." Any BL resolution that cites the broken Dagger URL or the wrong SECURITY-383 identifier must be updated in the same session as the Spec-017 edit.

2. **Plan-001 and other plans** that reference C-1 (no-bespoke-DSL commitment) or I3 (typed-capability approvers). If the Spec-017 §62 framing gains a positive companion ("YAML schema + typed TypeScript SDK with JSONSchema/LSP support"), any plan that consumes C-1 should check whether it needs to mirror that positive framing.

3. **Spec-012 (permissions/capabilities)** — Q#8's I3 has a Spec-012 linkage per the q8 file. If Spec-012 carries parallel anti-pattern citations, verify they use SECURITY-576 rather than SECURITY-383.

4. **Session commits / BL-close records** — the research audit trail (this file + the two input research files) should be referenced in the Session-level commit that lands the Spec-017 corrections, so the why-we-swapped reasoning is preserved for future readers. Consistent with the MEMORY rule that research citations flow forward, not backward.

5. **Research-citation-discipline amendment candidate** — the meta-finding that "task-prompt-supplied option (a) candidates were wrong in both cases" suggests a discipline addition: **pre-surfaced remediation options must be verified against primary sources before being presented**, not just listed. This could be captured as a standing rule in `.claude/rules/` or folded into `feedback_websearch_before_recommendation.md` as a citation-remediation-specific corollary. Spec-017 owner should consider whether to codify.

**Conflict flag:** No conflicts detected between the two input files. The files operate on disjoint evidence sets and reach structurally parallel conclusions (corrected (b) for Q#6; new (d) for Q#8) — both reject the H5 plan's pre-surfaced option (a), both adopt a composite citation pattern (on-domain primary + secondary verification), both preserve the argumentative force of the claim while upgrading citation fidelity.

---

**End of final report.**
