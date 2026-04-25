# Q6 — Spec-017 C-1 Dagger citation: forensic + DSL-lock-in precedent research

**Author:** Claude Opus 4.7 (1M-context) staff-level architect subagent
**Date:** 2026-04-22
**Scope:** Spec-017 §62 + §424 — Dagger "next Dagger SDKs" citation is HTTP 404; restructure C-1's DSL-lock-in precedent claim to a citation-fidelity-clean state.
**Status:** Research complete; recommendation is load-bearing for Spec-017 C-1 remediation.

---

## 1. Executive summary (≤200 words)

**Primary finding.** The broken `dagger.io/blog/next-dagger-sdks` URL is **not the only primary source** for the Dagger CUE→SDK migration — `dagger.io/blog/ending-cue-support/` (Dec 18, 2023) is live, is on-domain, and is a stronger citation because it is the official CUE SDK deprecation announcement by the Dagger team. The Changelog podcast interview with Solomon Hykes (Jul 28, 2023) supplies direct Hykes-on-record quotes. A reconstructed timeline from primary Dagger sources gives a **~2-year window** (Jan 2022 v0.1.0 CUE → Dec 2023 CUE SDK end-of-life), not 2.5 years. The "~2.5 years" quantitative claim cannot be verified from any surviving primary source as of 2026-04-22.

**Pivot from task framing.** The task proposed `dagger.io/blog/introducing-dagger-functions` (Feb 28, 2024) as option (b)'s candidate. WebFetch verification confirms that post **does not mention CUE** — it cannot carry a DSL-lock-in citation. The correct option-(b) candidate is `ending-cue-support/` + Changelog #550.

**Recommendation.** Adopt **corrected option (b)**: swap to `ending-cue-support/` + Changelog #550 as Dagger primary sources; drop "~2.5 years" language; re-anchor claim on the Dagger team's own rationale. Keep C-1's "no bespoke DSL" posture. Add a **positive companion commitment**: "YAML schema + typed TypeScript SDK with JSONSchema/LSP support" — sharpens the negative constraint without reframing. Note: the replacement text reframes what the claim *measures* — from unverifiable "rewrite duration" to primary-source-anchored "CUE-as-primary + ~12-month dual-maintenance window." Shape change, not just URL swap.

---

## 2. Dagger CUE primary-source forensic — what survives, what's gone

### 2.1 The broken citation

- **URL:** `https://dagger.io/blog/next-dagger-sdks`
- **Status:** HTTP 404 as of 2026-04-22 (reconfirmed in this research pass via search-indirect evidence; no cached/archive mirror found).
- **WebArchive reachability:** web.archive.org is blocked from this environment; WebSearch for `site:web.archive.org dagger.io next-dagger-sdks blog` returned zero hits — meaning either the snapshot does not exist OR search indexers do not expose it. Unable to verify archive presence from this environment.
- **Unverifiable claim:** "Dagger rewrote its CUE-based SDK over ~2.5 years." No live primary source on dagger.io or in the GitHub dagger/dagger repo carries this exact quantitative duration claim as of 2026-04-22.

### 2.2 Reconstructed timeline from live primary sources

| Date | Event | Primary source |
|---|---|---|
| Jan 25, 2022 | Dagger v0.1.0 released — CUE is the primary configuration language; release notes explicitly describe "CUE structural cycles", "CUE functions", "embed them in CUE" | [github.com/dagger/dagger/releases/tag/v0.1.0](https://github.com/dagger/dagger/releases/tag/v0.1.0) — fetched 2026-04-22 |
| Mar 28, 2022 | Dagger 0.2 "Europa" launch — CUE remains the canonical authoring language: "composing arbitrarily complex automations out of standardized primitives, declaratively, using CUE and Buildkit" | [dagger.io/blog/dagger-0-2](https://dagger.io/blog/dagger-0-2) — fetched 2026-04-22 |
| Nov 8, 2022 | Python SDK announcement (Go SDK ~2 weeks earlier) — multi-language SDK era begins; CUE no longer sole authoring path | [dagger.io/blog/python-sdk](https://dagger.io/blog/python-sdk) — fetched 2026-04-22 |
| Dec 2, 2022 | GitHub Discussion #4086 opened — community concern about CUE SDK port to engine 0.3; shykes (Dec 6, 2022) acknowledges security + breaking-change risk; by Dec 23, 2022 port is "stalled" | [github.com/dagger/dagger/discussions/4086](https://github.com/dagger/dagger/discussions/4086) — fetched 2026-04-22 |
| Jul 28, 2023 | Changelog podcast #550 — Hykes on-record about CUE: "It's kind of a bait and switch" / "The problem was it was different" / "death by 1000 cuts" / "we had a pretty massive cohort of people run through it... they're all going to leave" | [changelog.com/podcast/550](https://changelog.com/podcast/550) — fetched 2026-04-22 |
| Aug 3, 2023 | Dagger 0.8 "Big Summer Clean Up" — breaking-change release consolidating multi-language SDK versioning; no CUE SDK mention in release post | [dagger.io/blog/dagger-0-8](https://dagger.io/blog/dagger-0-8) — fetched 2026-04-22 |
| Dec 14, 2023 | CUE SDK support officially ended | [dagger.io/blog/ending-cue-support/](https://dagger.io/blog/ending-cue-support/) — fetched 2026-04-22 |
| Dec 18, 2023 | "Ending Support for the Dagger CUE SDK" blog post published — "After a year of keeping the lights on and collecting feedback from our community, we've concluded that there simply is not enough interest" | [dagger.io/blog/ending-cue-support/](https://dagger.io/blog/ending-cue-support/) — fetched 2026-04-22 |
| Feb 28, 2024 | Dagger Functions introduced (v0.10 milestone) — multi-language SDK + GraphQL era cemented; **post does not mention CUE** | [dagger.io/blog/introducing-dagger-functions](https://dagger.io/blog/introducing-dagger-functions) — fetched 2026-04-22 |

### 2.3 What the primary-source duration claims actually are

**Directly cite-able:**
- **"After a year of keeping the lights on"** — `ending-cue-support/` (Dec 18, 2023). This measures the Nov 2022 multi-language SDK launch → Dec 2023 sunset window. Approximately **12–13 months of dual-maintenance**.
- **Jan 25, 2022 → Dec 14, 2023** — **~23 months** (~1.9 years) of CUE being the canonical or co-canonical authoring surface.

**NOT cite-able from any primary source:**
- "~2.5 years" as a duration claim. Unverifiable.
- Any claim about a 2021 pre-v0.1.0 CUE prototype. Third-party secondary search snippets reference "first public prototype in 2021 was essentially a CUE frontend to Buildkit" but I could not locate a primary-sourced 2021 Dagger announcement with a fixed date. No load-bearing claim should rest on this.

### 2.4 Pivot from task's (b) framing

The task framed option (b) around `dagger.io/blog/introducing-dagger-functions` (Feb 28, 2024). **Verified via WebFetch 2026-04-22: that post contains zero mentions of CUE, CUE SDK, or the CUE-to-SDK migration.** It is the *completion* announcement of the post-CUE architecture, not a retrospective on CUE-lock-in cost. It therefore cannot support a C-1 DSL-lock-in citation on its own.

**Corrected option (b)** uses:
1. `dagger.io/blog/ending-cue-support/` (Dec 18, 2023) — **strongest primary source**; official on-domain deprecation announcement; carries "After a year of keeping the lights on" duration claim and the user-preference rationale quote.
2. Changelog podcast #550 (Jul 28, 2023) — **supplementary**; Solomon Hykes on-record with "bait and switch" + "death by 1000 cuts" framing.

---

## 3. Broader DSL-lock-in precedents — ranked corpus

Corpus focus: **2023–2026 primary sources on DSL vs. schema-first YAML vs. typed-SDK trade-offs in workflow/CI-CD/configuration authoring.** Ranking prioritizes (a) author authority, (b) publication recency, (c) direct applicability to C-1's "no bespoke DSL" commitment.

| Rank | Source | Date | Key quote | Applicability to C-1 |
|---|---|---|---|---|
| 1 | **Dagger — "Ending Support for the Dagger CUE SDK"** ([dagger.io/blog/ending-cue-support/](https://dagger.io/blog/ending-cue-support/)) | Dec 18, 2023 | *"engineers are tired of building CI/CD pipelines with shell scripts and YAML, what they really want is to write code in a language they already know. Learning a brand new language, however powerful, is simply not what they're looking for."* | **Direct:** the authoring-DSL-vs-familiar-language argument for C-1. |
| 2 | **GitHub Actions — "will stop running workflows written in HCL"** ([github.blog changelog 2019-09-17](https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/)) | Sept 17, 2019 | *"GitHub Actions will stop running workflows written in HCL… You'll need to migrate your HCL workflows to the new YAML syntax using the migration script."* Deprecation date: Sept 30, 2019 — **13-day breaking-change window.** | **Direct:** canonical precedent for a major CI platform abandoning HCL for YAML under breaking-change pressure. |
| 3 | **Brian Grant — "Declarative application management in Kubernetes"** ([kubernetes/design-proposals-archive](https://github.com/kubernetes/design-proposals-archive/blob/main/architecture/declarative-application-management.md)) | Aug 2, 2017 | *"custom-built languages typically lack good tools for refactoring, validation, testing, debugging, etc."* / *"configuration tooling should manipulate configuration **data**, not convert configuration to code nor other marked-up syntax"* | **Direct:** authoritative (Kubernetes lead architect) argument for schema-first YAML over bespoke config DSLs. |
| 4 | **Pulumi — "Terraform vs. Pulumi IaC" comparison** ([pulumi.com/docs/iac/comparisons/terraform](https://www.pulumi.com/docs/iac/comparisons/terraform/)) and **"Pulumi vs HCL"** ([pulumi.com/blog/hcl-vs-pulumi](https://www.pulumi.com/blog/hcl-vs-pulumi/)) | Docs: undated (live 2026-04-22); Blog: Jul 9, 2024 | *"DSLs make tradeoffs optimizing for simplicity and getting started that can become problematic over time... their lack of clear, standard structures and common functionality tend to create maintenance, support, and portability issues."* / *"Terraform requires learning HCL, a DSL that optimizes for simplicity at the expense of flexibility and scale."* / *"HCL, while robust, lacks the future-proof qualities of Pulumi SDKs due to its fixed syntax and usage constraints"* (blog Jul 9, 2024) | **Direct:** vendor-advocacy but with concrete criticism of HCL's DSL lifecycle cost; reinforces the anti-bespoke-DSL frame. |
| 5 | **Tekton — "Design Principles"** ([tektoncd/community/design-principles.md](https://github.com/tektoncd/community/blob/main/design-principles.md)) | Undated (live as of 2026-04-22) | *"Avoid implementing our own expression syntax; when required prefer existing languages which are widely used and include supporting development tools."* / *"Avoid implementing templating logic; prefer variable replacement."* | **Direct:** flagship Kubernetes-native CI project's explicit "no bespoke DSL" design principle — nearly verbatim C-1. |
| 6 | **Ruud van Asseldonk — "A reasonable configuration language"** ([ruudvanasseldonk.com/2024/a-reasonable-configuration-language](https://ruudvanasseldonk.com/2024/a-reasonable-configuration-language)) | Feb 4, 2024 | *"The prevalence of yaml in general, a format that does solve some problems (adding comments and a lighter syntax to json), but in the process introduces so many new problems that the cure is almost as bad as the disease."* + individual CUE/Dhall/Jsonnet critiques | **Adversarial:** the strongest 2024 essay *against* YAML — critical for steel-manning C-1. Also endorses typed constraints (CUE's type system) as valuable even if CUE the language didn't win. |
| 7 | **Changelog podcast #550 — "From Docker to Dagger"** ([changelog.com/podcast/550](https://changelog.com/podcast/550)) | Jul 28, 2023 | Hykes: *"It's kind of a bait and switch"* / *"The problem was it was different"* / *"We had a pretty massive cohort of people run through it... they're all going to leave"* / *"death by 1000 cuts"* | **Direct:** primary-source oral retrospective from Dagger's founder on why CUE failed. Preserves the "founder admitted DSL was wrong choice" force that the broken URL carried. |
| 8 | **The New Stack — "Solomon Hykes: Dagger Brings the Promise of Docker to CI/CD"** ([thenewstack.io/solomon-hykes-dagger-brings-the-promise-of-docker-to-ci-cd/](https://thenewstack.io/solomon-hykes-dagger-brings-the-promise-of-docker-to-ci-cd/)) | Apr 13, 2022 | *"DevOps engineers build actions using the language of their choice...and then compose them together declaratively using CUE definitions."* | **Secondary / context:** establishes Dagger's CUE-era launch framing; useful only to show the contrast with the 2023 retrospective. |
| 9 | **Dagger Docs Archive** ([archive.docs.dagger.io](https://archive.docs.dagger.io/)) | Live, version-pinned | (Structural) — Dagger maintains a pinned pre-0.3 docs archive for historical CUE-era docs | **Indirect:** demonstrates Dagger's own corpus-discipline approach to sun-setted material — they archive, they don't 404-and-annotate. Reinforces recommendation against option (c). |

Additional supporting precedents (not in top ranking but worth noting):
- **Airflow TaskFlow API** (Airflow 2.0, 2020) — `@task` decorator + Pythonic DAGs, deliberate move away from XCom-via-Jinja-template templating-logic approach toward typed Python. Evidence that even Python-native workflow systems moved toward typed-function-based authoring over template-string DSLs. ([airflow.apache.org/docs/apache-airflow/stable/core-concepts/taskflow.html](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/taskflow.html)) — fetched 2026-04-22.
- **Dhall adoption retrospective (van Asseldonk)** — notes Spago (PureScript package manager) deprecated Dhall in favor of YAML. Third-party reporting of a specific project-level DSL abandonment in the 2019–2024 window.
- **CUE Community Update (Oct 10, 2024)** — discussed at dagger/dagger discussion threads but not fetched as primary source; noted as follow-up if deeper CUE-ecosystem retrospective needed.

---

## 4. Per-option evidence and trade-offs

### Option (a) — Remove Dagger citation entirely; C-1 rests on GitHub Actions alone

**Evidence for:**
- Citation-fidelity discipline: if no primary source carries the "~2.5 years" claim, removal is the strictest-principled choice.
- The GitHub Actions HCL→YAML precedent *is* sufficient on its own as a CI-platform DSL-abandonment precedent. The deprecation changelog is on-domain (`github.blog`), dated Sept 17, 2019, and explicit about the 13-day sunset window.
- Reduces Spec-017 surface area for future citation rot.

**Evidence against:**
- **Loses Dagger-as-precedent-category.** GitHub Actions HCL→YAML was a *proprietary-platform* DSL decision; Dagger was a *community-open-source-product* DSL decision. Losing Dagger collapses the precedent set to a single platform type, weakening C-1's argument that the pattern is industry-wide.
- **Loses founder-on-record force.** Hykes's "bait and switch" / "death by 1000 cuts" framing is uniquely powerful for an architectural spec — primary founder retrospective quotes are rare and high-signal. Option (a) discards them.

**Verdict:** Principled fallback; weaker than corrected (b) because evidence is recoverable via alternate live primary sources.

### Option (b, corrected) — Swap to `ending-cue-support/` + Changelog #550; drop "~2.5 years"

**Evidence for:**
- `ending-cue-support/` is **on-domain** (`dagger.io`), **dated** (Dec 18, 2023), and **officially-authored** by the Dagger team. It carries the verbatim "After a year of keeping the lights on" duration claim and the user-preference rationale quote — both stronger evidence than a vague "2.5 years" number.
- Changelog #550 is a **primary-source founder interview**; Hykes's quotes preserve the "founder admitted DSL was wrong choice" narrative force the broken URL carried.
- Reconstructed timeline **~23 months CUE-primary** is defensible from primary sources; can be stated cautiously as "Dagger maintained CUE as primary authoring language for ~2 years (Jan 2022–Dec 2023) before discontinuing it in favor of multi-language SDKs."
- Aligns with research standard in MEMORY.md (feedback_citations_in_downstream_docs.md): primary-source citations with current-year fetch dates flow into downstream docs.

**Evidence against:**
- Two citations vs. one — modest increase in citation count but more defensible.
- Changelog #550 is audio-first; timestamp-pinned quotes are more fragile to future platform changes than blog-post quotes. Mitigation: anchor on the on-domain `ending-cue-support/` as primary; use #550 only as supplementary.

**Verdict:** **Strongest option.** Preserves the full argumentative force of C-1 while upgrading citation fidelity.

### Option (c) — Keep broken URL with "[URL 404 as of 2026-04-22]" annotation

**Evidence for:**
- Zero.

**Evidence against:**
- **No corpus-discipline backing found.** I searched for established patterns at reputable engineering orgs (Google SRE book, Kubernetes KEPs, RFC editor, CNCF white papers, academic CS paper citation norms, Wikipedia:Link rot policy) for blessing of "keep-URL-mark-as-404" patterns. None found that bless it as *preferred*. Wikipedia's `{{dead link|date=}}` template is the closest precedent — but Wikipedia policy explicitly requires editors to *attempt replacement from archive* first; the dead-link tag is a temporary holding pattern pending fix.
- **Dagger's own corpus discipline rejects it.** Dagger maintains `archive.docs.dagger.io` for CUE-era docs; they archive + redirect rather than 404 + annotate. Following the cited org's own discipline is a fidelity-compounding win.
- **Violates citation-fidelity rule.** Spec-017 is a specification, not a blog. Specifications carry normative authority; a 404'd citation inside a normative doc creates a reader who cannot verify a load-bearing claim. The claim becomes un-auditable.
- Corrected (b) is strictly available as an alternative, so there is no necessity argument.

**Verdict:** **Reject.** No procedural or substantive grounds support this option when (b) is available.

---

## 5. Recommendation + reasoning (steel-manning rejected alternatives)

### 5.1 Primary recommendation

**Adopt corrected option (b):**

1. **Replace `dagger.io/blog/next-dagger-sdks` with `dagger.io/blog/ending-cue-support/`** in Spec-017 §62 and §424.
2. **Drop "~2.5 years" quantitative claim.** Replace with primary-source-anchored form: *"Dagger maintained its CUE SDK as primary authoring language from Jan 2022 to Dec 2023, then ended CUE SDK support after one year of dual-maintenance against multi-language SDKs ([Dagger — Ending Support for the Dagger CUE SDK, 2023](https://dagger.io/blog/ending-cue-support/); [Changelog #550 — Solomon Hykes, 2023](https://changelog.com/podcast/550))."*
3. **Add Changelog #550 to Spec-017 §420 Primary Sources (external)** as supplementary on the same claim.
4. **Keep GitHub Actions HCL→YAML citation as-is** — URL is live; restructure deprecation quote to include the 13-day sunset window per the primary source.
5. **Optional C-1 sharpening:** add a positive companion commitment. Current C-1 is a negative constraint ("no bespoke DSL"). Adding the positive frame — *"Workflow authoring format: YAML schema + typed TypeScript SDK with JSONSchema/LSP editor support"* — turns C-1 from purely restrictive into explicitly prescriptive. This does not change the decision; it sharpens it. Evidence corpus (Brian Grant's 2017 manifesto + Tekton design principles + Pulumi + Dagger) uniformly supports *both* framings.

### 5.2 Steel-manned rejected alternatives

**Steel-man for option (a) — "Remove Dagger citation":** "A specification should cite the strongest, most-defensible precedents. If the Dagger citation ever held weight, it was because of the '~2.5 years' quantitative stake; without that stake, Dagger joins HCL→YAML as one of two CI-platform DSL abandonments and is less structurally different than the reader is led to believe. Better to cite one rock-solid precedent than two mediocre ones." **Why (b) wins:** `ending-cue-support/` is not a mediocre citation — it carries a stronger, more precise duration claim ("one year of keeping the lights on" against multi-language SDKs) than the original vague "~2.5 years" number. And the community-OSS-product-vs-platform-DSL distinction between Dagger and GitHub Actions is *substantive*, not cosmetic: it shows DSL-lock-in cost applies even to community-driven, bottom-up projects, not only to platform-controlled top-down ones. Losing that breadth weakens C-1.

**Steel-man for option (c) — "Keep broken URL with annotation":** "If the research team has already documented the 404, the annotation transparently communicates to readers that the source is known-broken. This is more honest than silent removal. Removal risks readers independently discovering the 404 later and wondering whether other citations are being silently massaged." **Why (b) wins:** the corrected-(b) swap is *more* transparent than an annotation — the recommendation is documented in the BL-resolution + session commit, and the new citation is verifiable today. Annotated 404s communicate "we gave up"; swapping to live primary sources communicates "we upgraded citation quality." The research team's discovery of the 404 is auditable in git history regardless of whether the URL is kept.

**Steel-man for reframing C-1 to "typed schema-first + LSP-supported" and dropping "no bespoke DSL":** "The 2024–2026 evidence corpus (Grant, Tekton, Pulumi, van Asseldonk, Dagger) uniformly supports *typed-schema + familiar-language*; the 'no bespoke DSL' framing is the *symptom*, not the *positive commitment*. Reframing sharpens what C-1 actually asks the system to be." **Why "no bespoke DSL" survives:** the negative constraint is load-bearing because it **rules out a specific class of future-self-foot-gun** (inventing a custom expression language, CUE-style, because AI Sidekicks thinks it can do better than the ecosystem). Without the negative rule, a future contributor might argue "we're not building a DSL, we're building a 'typed schema extension with light expression support,'" and slide toward the same failure mode Dagger/GitHub Actions/Terraform hit. Keeping "no bespoke DSL" as the negative rule AND adding "typed schema + LSP-supported" as the positive framing gives both. The advisor-recommended companion-assertion framing is the right one: keep C-1 as written, add positive companion.

### 5.3 Adversarial check — should C-1 be reframed entirely?

Considered. **Answer: no.** The 2024–2026 corpus is not pushing projects *toward* typed-schema+LSP as a replacement for "no bespoke DSL" — it is pushing projects toward typed-schema+LSP as a *realization* of "no bespoke DSL." Brian Grant's 2017 manifesto is still the authoritative reference ("configuration tooling should manipulate configuration **data**"); Tekton's 2024-live design principles still say "Avoid implementing our own expression syntax"; Dagger's 2023 retrospective confirms the community is happier with typed familiar languages over bespoke DSLs. C-1's "no bespoke DSL" frame is **directionally correct** for 2026; the sharpening is additive.

---

## 6. Sources table (every URL with fetch date + quoted substring)

All fetches performed 2026-04-22 from this research environment.

| # | URL | Fetched | Primary/Secondary | Exact quoted substring (verbatim) |
|---|---|---|---|---|
| 1 | https://dagger.io/blog/ending-cue-support/ | 2026-04-22 | **Primary** (Dagger team blog, on-domain) | *"Since we released multi-language support, we have seen a steep decline in usage of our original CUE configuration syntax, and have made it clear that feature parity with newer SDKs would not be a priority. After a year of keeping the lights on and collecting feedback from our community, we've concluded that there simply is not enough interest."* AND *"But we soon faced overwhelming demand in our community for supporting multiple languages. So we launched a new GraphQL-powered engine with new SDKs for Go, Python and Node.js."* AND *"We've found that while engineers are tired of building CI/CD pipelines with shell scripts and YAML, what they really want is to write code in a language they already know. Learning a brand new language, however powerful, is simply not what they're looking for."* |
| 2 | https://changelog.com/podcast/550 | 2026-04-22 | **Primary** (Solomon Hykes on-record interview) | Hykes quoted: *"It's kind of a bait and switch"* (around 44:00); *"The problem was it was different"* (44:00); *"We had a pretty massive cohort of people run through it...they're all going to leave"* (44:00); *"death by 1000 cuts"* (44:00); *"Eventually, we shipped all these SDKs. So now there's Python, Go, JavaScript, TypeScript...Rust, Elixir, .NET"* (44:00); *"The API for it is fundamentally declarative, because you're describing a graph...you can't go through a sequence of things"* (44:00) |
| 3 | https://dagger.io/blog/introducing-dagger-functions | 2026-04-22 | **Primary** (Dagger team blog) | **Verified: zero mentions of CUE.** Post focuses on Dagger Functions in v0.10, Go/Python/TypeScript SDKs, Dagger Modules. **Cannot be used for C-1 DSL-lock-in citation.** |
| 4 | https://dagger.io/blog/dagger-0-2 | 2026-04-22 | **Primary** | *"The foundation of this model is the Action API: a complete framework for composing arbitrarily complex automations out of standardized primitives, declaratively, using CUE and Buildkit."* Pub date Mar 28, 2022. |
| 5 | https://dagger.io/blog/python-sdk | 2026-04-22 | **Primary** | Pub date Nov 8, 2022. **Zero CUE mentions** — evidences the multi-language-SDK transition point. |
| 6 | https://dagger.io/blog/dagger-0-8 | 2026-04-22 | **Primary** | Pub date Aug 3, 2023. Zero CUE mentions; breaking-change release for multi-language SDK version alignment. |
| 7 | https://dagger.io/blog/how-dagger-releases | 2026-04-22 | **Primary** | Pub date Mar 21, 2023. Zero CUE mentions. |
| 8 | https://github.com/dagger/dagger/releases/tag/v0.1.0 | 2026-04-22 | **Primary** (GitHub release) | Release date Jan 25, 2022. *"Dagger packages to use shell scripts from the filesystem, rather than needing to embed them in CUE"*; *"secrets to be transformed using CUE functions"*; *"simpler and more intuitive configuration schema"* (Europa codename). |
| 9 | https://github.com/dagger/dagger/discussions/4086 | 2026-04-22 | **Primary** (GitHub discussion, Dagger team participation) | Opened Dec 2, 2022 by jlongtine. shykes Dec 6, 2022: *"It would be great to be able to merge this, but we shouldn't force a merge that introduces security regressions or painful breaking changes."* shykes Dec 23, 2022: *"It is not canceled, but it is stalled because of difficulty in reaching full compatibility with the current API."* |
| 10 | https://news.ycombinator.com/item?id=38695864 | 2026-04-22 | **Secondary** (community thread) | **Unable to fetch — HTTP 429 rate-limited on retry.** Surfaced in WebSearch as HN cover of the Dec 2023 CUE-ending announcement. No primary-source content extracted. |
| 11 | https://tfir.io/dagger-ends-support-for-cue-sdk/ | 2026-04-22 | **Secondary** (TFiR tech news coverage) | Pub date Dec 19, 2023. *"Since we released multi-language support, we have seen a steep decline in usage of our original CUE configuration syntax…"* (quoting Dagger blog) — confirms independent coverage but adds no new primary data. |
| 12 | https://thenewstack.io/solomon-hykes-dagger-brings-the-promise-of-docker-to-ci-cd/ | 2026-04-22 | **Secondary** (press coverage) | Pub date Apr 13, 2022. *"DevOps engineers build actions using the language of their choice...and then compose them together declaratively using CUE definitions."* Useful for contrasting 2022 CUE-era framing against 2023 retrospective; not a duration source. |
| 13 | https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/ | 2026-04-22 | **Primary** (GitHub changelog, on-domain) | Pub date Sept 17, 2019. *"GitHub Actions will stop running workflows written in HCL"*; sunset date Sept 30, 2019; *"You'll need to migrate your HCL workflows to the new YAML syntax using the migration script."* |
| 14 | https://www.pulumi.com/blog/hcl-vs-pulumi/ | 2026-04-22 | **Primary** (vendor blog; biased but self-sourced) | Pub date Jul 9, 2024. *"HCL, while robust, lacks the future-proof qualities of Pulumi SDKs due to its fixed syntax and usage constraints"*; *"As HCL continues to evolve, its fixed syntax and structured approach are likely to lead to greater complexity"*; *"HCL maintains a dedicated user base of several hundred thousand developers"* (contrasted with millions for general-purpose languages). |
| 15 | https://www.pulumi.com/docs/iac/comparisons/terraform/ | 2026-04-22 | **Primary** (vendor docs) | *"Terraform requires learning HCL, a DSL that optimizes for simplicity at the expense of flexibility and scale."*; *"Terraform HCL lacks processing constructs like loops, if statements, objects to encapsulate variables, abstractions, and other functionality commonly found in programming languages."*; *"DSLs make tradeoffs optimizing for simplicity and getting started that can become problematic over time... their lack of clear, standard structures and common functionality tend to create maintenance, support, and portability issues."* Undated, live at fetch. |
| 16 | https://github.com/tektoncd/community/blob/main/design-principles.md | 2026-04-22 | **Primary** (Tekton community docs, on-domain) | *"Avoid implementing our own expression syntax; when required prefer existing languages which are widely used and include supporting development tools."*; *"Avoid implementing templating logic; prefer variable replacement."*; *"Tekton should contain only the bare minimum and simplest features needed to meet the largest number of CI/CD use cases."* |
| 17 | https://github.com/kubernetes/design-proposals-archive/blob/main/architecture/declarative-application-management.md | 2026-04-22 | **Primary** (Kubernetes design-proposals archive; Brian Grant, Kubernetes lead architect) | Pub date Aug 2, 2017. *"custom-built languages typically lack good tools for refactoring, validation, testing, debugging, etc."*; *"render the configuration unparsable by other tools (e.g., extraction, injection, manipulation, validation, diff, interpretation, reconciliation, conversion)"*; *"configuration tooling should manipulate configuration **data**, not convert configuration to code nor other marked-up syntax"*; approach favored "specifications of the **literal Kubernetes API resources** required to deploy the application." |
| 18 | https://ruudvanasseldonk.com/2024/a-reasonable-configuration-language | 2026-04-22 | **Primary** (practitioner essay) | Pub date Feb 4, 2024. On CUE: *"Its type system is interesting: it helps to constrain and validate configuration, but it also plays a role in eliminating boilerplate."* On Dhall: *"I tried to use Dhall once to solve an Advent of Code challenge, but got stuck immediately because it's not possible to split strings in Dhall."* On YAML: *"The prevalence of yaml in general, a format that does solve some problems (adding comments and a lighter syntax to json), but in the process introduces so many new problems that the cure is almost as bad as the disease."* On DSL maintenance burden: *"When a project takes off, inevitably users start making requests, having opinions, and submitting well-intentioned but low-quality contributions. Keeping up with that takes time and mental energy."* |
| 19 | https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/taskflow.html | 2026-04-22 | **Primary** (Apache Airflow docs) | TaskFlow API is the Airflow 2.0+ authoring surface replacing Jinja-template-heavy XCom passing with `@task`-decorated Python functions; reinforces "typed familiar language" pattern over bespoke DSL templating. No direct quote extracted but structural evidence confirmed in search. |
| 20 | https://archive.docs.dagger.io/ | 2026-04-22 | **Primary** (Dagger-maintained docs archive) | Structural evidence: Dagger maintains a pinned pre-0.3 docs archive for historical CUE-era docs — the cited org's own corpus-discipline pattern is to archive, not to 404-and-annotate. Supports rejection of option (c). |
| 21 | https://web.archive.org/web/2024*/dagger.io/blog/next-dagger-sdks | 2026-04-22 | **Unreachable** | WebFetch blocked from environment; WebSearch `site:web.archive.org dagger.io next-dagger-sdks blog` returned zero hits. Cannot confirm or deny archive presence from this environment. Noted as unverified. |

---

## Appendix A — What was tried and didn't yield

- **WebFetch to `itnext.io/abandoned-kubernetes-configuration-ideas-...`** — TLS certificate validation failure ("unable to verify the first certificate"). Primary-source content from Brian Grant on abandoned Kubernetes config DSLs exists but could not be fetched from this environment. Recommend attempting from a different environment or via gh CLI if this source becomes load-bearing.
- **WebFetch to `itnext.io/kubernetes-configuration-in-2024-...`** — same TLS failure.
- **WebFetch to `news.ycombinator.com/item?id=38695864`** — HTTP 429 rate-limit, both initial and retry attempts.
- **WebSearch for exact phrase `"2.5 years" "CUE" Dagger`** — zero primary-source hits.
- **WebFetch to `web.archive.org/web/2024*/dagger.io/blog/next-dagger-sdks`** — blocked from environment.
- **WebSearch for "Dagger CUE SDK first release date 2022 initial announcement"** — surfaced unverified secondary claim of a "2021 prototype"; no primary-sourced 2021 announcement located.

## Appendix B — Exact replacement text for Spec-017 §62 (suggested)

Current:

> Workflow authoring format: YAML definitions + typed TypeScript SDK. **No bespoke DSL** (no CUE, no HCL, no custom expression language) — C-1 commitment. DSL lock-in cost is precedent-heavy: Dagger rewrote its CUE-based SDK over ~2.5 years ([Dagger — next Dagger SDKs, 2023](https://dagger.io/blog/next-dagger-sdks)); GitHub Actions migrated off HCL to YAML under breaking-change pressure ([GitHub Actions HCL→YAML deprecation, 2019](https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/)).

Proposed:

> Workflow authoring format: YAML definitions + typed TypeScript SDK with JSONSchema/LSP editor support. **No bespoke DSL** (no CUE, no HCL, no custom expression language) — C-1 commitment. DSL lock-in cost is precedent-heavy: Dagger maintained its CUE SDK as primary authoring language from Jan 2022 (v0.1.0) through Dec 2023, then ended CUE SDK support after a year of dual-maintenance against multi-language SDKs, citing that "engineers...want to write code in a language they already know. Learning a brand new language, however powerful, is simply not what they're looking for" ([Dagger — Ending Support for the Dagger CUE SDK, 2023](https://dagger.io/blog/ending-cue-support/); [Solomon Hykes on Changelog #550, 2023](https://changelog.com/podcast/550)). GitHub Actions migrated off HCL to YAML under a 13-day breaking-change deprecation window ([GitHub Actions HCL→YAML deprecation, 2019](https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/)).

## Appendix C — Exact replacement text for Spec-017 §423 (suggested)

Current:

> - [Dagger — next Dagger SDKs (CUE→SDK migration)](https://dagger.io/blog/next-dagger-sdks) — 2023

Proposed (two entries replace one):

> - [Dagger — Ending Support for the Dagger CUE SDK](https://dagger.io/blog/ending-cue-support/) — 2023
> - [Changelog #550 — From Docker to Dagger with Solomon Hykes](https://changelog.com/podcast/550) — 2023

---

**End of Q6 research report.**
