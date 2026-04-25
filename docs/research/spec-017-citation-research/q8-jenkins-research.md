# Q8 — Jenkins SECURITY-383 citation research

*Spec-017 anti-pattern verification + citation remediation*

Fetch-date anchor for every URL in this file: **2026-04-22**.

---

## 1. Executive summary

The Spec-017 citation at lines 344 + 441 is **doubly wrong**:

1. **Wrong identifier on wrong URL.** `SECURITY-383` is a real Jenkins advisory ID, but it is an **XStream RCE** vulnerability disclosed in the **2017-02-01** advisory (`jenkins.io/security/advisory/2017-02-01/`). It has nothing to do with the Pipeline Input Step. The URL Spec-017 cites (`2017-04-10`) is a Groovy-plugins roll-up advisory that does **not** contain SECURITY-383 and has no Input Step content.
2. **The anti-pattern claim itself is true** — but its canonical citation is **SECURITY-576 / CVE-2017-1000108** in the **2017-08-07** advisory (`jenkins.io/security/advisory/2017-08-07/`). NVD's one-line description matches Spec-017's "Read permission approves" framing almost verbatim.
3. The "admin bypass is silent" half is independently verifiable from the **current** plugin source: `canSettle()` in `InputStepExecution.java` early-returns `true` when the caller holds `Jenkins.ADMINISTER`, with no audit emission and no surrounding comment. JENKINS-56016 ("submitterParameter ignored for admins") was resolved **Won't Fix**; plugin 2.12 (2020-08-28) only **documented** the behavior rather than changing it.

**Recommendation: Option (d) — keep the anti-pattern sentence, fix the citation to SECURITY-576 / CVE-2017-1000108 + 2017-08-07 advisory, and cite the plugin source for the silent-admin-bypass half.** Options (a) (2022-10-19 swap), (b) (CHANGELOG only), and (c) (rely on Airflow/Argo CVEs) all fail on primary-source evidence.

---

## 2. SECURITY-383 forensic — does the identifier exist anywhere?

**Yes, SECURITY-383 exists** — but not as anything related to Pipeline Input Step or the 2017-04-10 advisory.

### Primary-source table

| Identifier location | Advisory URL | Topic | Input-step related? |
|---|---|---|---|
| SECURITY-383 | `https://www.jenkins.io/security/advisory/2017-02-01/` | XStream RCE via `javax.imageio` deserialization | **No** |
| (absent) | `https://www.jenkins.io/security/advisory/2017-04-10/` | Groovy-execution plugins roll-up (SECURITY-123, 176, 187, 256, 257, 292–298, 333, 334, 348, 363, 365–369, 379, 405, 410, 456–496) | **No** |
| (absent) | `https://www.jenkins.io/security/advisory/2017-07-10/` | SECURITY-201/303/335/342/352/433/516/527/528/529/533/538/551 + JENKINS-21436 | **No** |
| **SECURITY-576** | `https://www.jenkins.io/security/advisory/2017-08-07/` | Pipeline: Input Step Plugin — Item/Read → Item/Build | **Yes (canonical)** |
| (absent — CSRF only) | `https://www.jenkins.io/security/advisory/2022-10-19/` | SECURITY-2880 (CSRF bypass via input-step ID) + 29 unrelated plugin CVEs | Different issue |
| (absent) | `https://www.jenkins.io/security/advisory/2020-02-12/` | No Input Step content | **No** |

### Verbatim primary-source quotes

**SECURITY-383 from 2017-02-01 advisory** (fetched 2026-04-22):

> "XStream-based APIs in Jenkins (e.g. `/createItem` URLs, or `POST config.xml` remote API) were vulnerable to a remote code execution vulnerability involving the deserialization of various types in `javax.imageio`."

Source: `https://www.jenkins.io/security/advisory/2017-02-01/` — fetched 2026-04-22.

**2017-04-10 advisory content** (the URL Spec-017 actually links to) is entirely a Groovy-execution plugins roll-up. The IDs present are SECURITY-123, 176, 187, 256, 257, 292, 293, 294, 295, 296, 297, 298, 333, 334, 348, 363, 365, 366, 367, 368, 369, 379, 405, 410, 456, 457, 458, 459, 460, 461, 462, 464, 479, 487, 488, 489, 491, 492, 493, 494, 495, 496 — none of which are SECURITY-383 and none of which concern the Input Step plugin. Source: `https://www.jenkins.io/security/advisory/2017-04-10/` — fetched 2026-04-22.

### Conclusion for §2

> "SECURITY-383" **does** exist as a Jenkins advisory ID, but it is an XStream RCE from the 2017-02-01 advisory, not an input-step issue, and it is **not** present on the 2017-04-10 URL Spec-017 cites. The Spec-017 citation therefore fails on **both** the identifier (wrong issue) and the URL (wrong advisory). The correct identifier for the anti-pattern Spec-017 is describing is **SECURITY-576 / CVE-2017-1000108** in the **2017-08-07** advisory.

---

## 3. Anti-pattern verification — is "Read approves + admin bypass silent" historically real?

### Claim A — "Read permission approves"

**Verified true for Pipeline: Input Step Plugin versions 2.0–2.7 (pre-2017-08-07 fix).**

NVD CVE-2017-1000108 description, fetched 2026-04-22 from `https://nvd.nist.gov/vuln/detail/CVE-2017-1000108`:

> "The Pipeline: Input Step Plugin by default allowed users with Item/Read access to a pipeline to interact with the step to provide input. This has been changed, and now requires users to have the Item/Build permission instead."

CVSS 3.x: **7.5 HIGH** (AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H). Affected: Pipeline Input Step Plugin 2.0 – 2.7. Fixed: 2.8. SECURITY-576. Reference: `https://www.jenkins.io/security/advisory/2017-08-07/`.

Plugin CHANGELOG entry, fetched 2026-04-22 from `https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/CHANGELOG.md`:

> **Version 2.8** (Released 2017-08-07) — "[Fix security issue](https://jenkins.io/security/advisory/2017-08-07/)"

### Claim B — "Admin bypass is silent"

**Verified true at the source-code level, for all current versions of the plugin.** This is stronger evidence than an advisory because it is the live design, not a patched historical bug.

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

Three primary-source facts in that excerpt:

1. `Jenkins.ADMINISTER` holders **short-circuit to `true`** before the `submitter` whitelist is evaluated.
2. No surrounding **comment or doc-comment** explains the bypass at the code site.
3. No **audit-log emission** or event sink call precedes the return. The permission check is silent.

Behavioral history:

- JENKINS-56016 "submitterParameter is ignored for admin users" — Resolution: **Won't Fix**, Status: Closed. Source: `https://issues.jenkins.io/browse/JENKINS-56016` — fetched 2026-04-22.
- Plugin CHANGELOG v2.12 (2020-08-28): *"Document that Jenkins administrators are always able to approve `input` steps ([JENKINS-56016](https://issues.jenkins-ci.org/browse/JENKINS-56016))"* — i.e., the behavior was **undocumented until August 2020**, three years after the plugin's 2.8 fix for Claim A. Source: `https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/CHANGELOG.md` — fetched 2026-04-22.

### Temporal nuance worth preserving

| Sub-claim | Era | Status |
|---|---|---|
| `Read` permission approves | Plugin 2.0 – 2.7 (2016–2017) | Historical, fixed in 2.8 (2017-08-07). |
| Admin bypass silent (no audit, no doc) | Plugin 2.0 – 2.11 (2016–2020-08) | Undocumented, un-audited — i.e., truly silent. |
| Admin bypass silent (documented) | Plugin 2.12+ (2020-08-28 – present) | Documented but still un-audited: source code has no emit. |

Spec-017's sentence conflates the historical Claim A with a perpetual Claim B. That is defensible as a principle ("don't do what Jenkins did") but should be phrased carefully so readers don't infer current-plugin Read approval is still live. See §6 for recommended wording.

---

## 4. Best modern citation candidates — ranked

| Rank | Source | Supports Claim A (Read approves)? | Supports Claim B (silent admin)? | Primary-source quality |
|---|---|---|---|---|
| **1** | **NVD CVE-2017-1000108** + **Jenkins advisory 2017-08-07** (SECURITY-576) | **Yes, verbatim.** NVD one-liner matches Spec-017 framing. | No — advisory scope is only the Read→Build fix. | Primary (NVD + jenkins.io) |
| **2** | `InputStepExecution.java` on `master` (lines 341-350) | Indirect — shows `Job.BUILD` check when `submitter==null`, which is the post-fix state. | **Yes, directly** — `Jenkins.ADMINISTER` early-return with no audit. | Strongest (live source) |
| **3** | CHANGELOG entry v2.12 "Document that Jenkins administrators are always able to approve `input` steps" (JENKINS-56016) | No. | **Yes, via "documented in 2020 = undocumented before."** | Primary (vendor repo) |
| **4** | JENKINS-56016 Jira "Won't Fix" resolution | No. | **Yes** — confirms Jenkins explicitly chose not to gate admin-override. | Primary (vendor issue tracker) |
| 5 | Jenkins advisory 2022-10-19 (SECURITY-2880) | **No.** CSRF bypass via input-step ID. | No. | Primary but wrong anti-pattern. |
| 6 | Plugin CHANGELOG full history | Partial (v2.8 line). | Partial (v2.12 line). | Primary but diffuse. |
| 7 | Alternative orchestrators (GitHub Actions `environments` required-reviewers, GitLab MR approvals, Argo Rollouts AnalysisRun gates, Tekton approval tasks) | N/A — these would illustrate the **correct** pattern, not the anti-pattern. | — | Not a substitute anti-pattern source. |

**Top-2 combined** gives 100% primary-source coverage of the Spec-017 sentence: CVE-2017-1000108 for Claim A, plugin source code for Claim B.

---

## 5. Per-option evidence and trade-offs

### Option (a) — Swap to the 2022-10-19 advisory

**Verdict: fails on evidence.** The 2022-10-19 advisory does not document Read/approve or silent-admin behavior.

From `https://www.jenkins.io/security/advisory/2022-10-19/` (fetched 2026-04-22), the only Input Step entry is:

> "Pipeline: Input Step Plugin 456.vd8a\_957db\_5b\_e9 limits the characters that can be used for the ID of `input` steps." (SECURITY-2880, CSRF protection bypass)

That is a **CSRF / ID-sanitization** issue, not an RBAC issue. Swapping the URL would leave the sentence's claim unsupported while pretending the advisory covers it — worse than the current broken state.

### Option (b) — Cite the plugin CHANGELOG for broader permission-handling history

**Verdict: defensible but inferior to a targeted CVE citation.** The CHANGELOG is a legitimate primary source (it's in the vendor's own repo under `master`), but it is diffuse: a reader must scan multi-version history to reconstruct the claim. A reader landing on the CHANGELOG from Spec-017 would not immediately see "Read approves + admin silent" — they'd see a mixed list of JIRA IDs.

CHANGELOG is strongest as a **supporting** citation alongside the CVE: "See CHANGELOG v2.8 (security fix) and v2.12 (document admin bypass)" — not as the primary cite.

### Option (c) — Remove Jenkins citation, rely on Airflow/Argo/n8n CVEs at Spec-017:434–436

**Verdict: fails on evidence.** Those CVEs do not carry the anti-pattern.

| CVE | Category | Carries "approval RBAC bypass + silent admin" framing? |
|---|---|---|
| CVE-2025-68613 (n8n) | — (GHSA-v98v-ff95-f3cp) CVSS 9.9. | Not verified here — but n8n has no approval-step primitive, so unlikely. |
| **CVE-2024-39877 (Airflow)** | **Authenticated DAG-author RCE via `doc_md`.** | **No — this is code injection, not RBAC bypass.** |
| **CVE-2025-30066 (tj-actions)** | **Supply-chain compromise: malicious code pointing v1-v45.0.7 to commit 0e58ed8, secrets exfiltrated via action logs.** | **No — this is supply-chain, not RBAC.** |
| **CVE-2025-66626 (Argo)** | **Symlink-traversal file write → RCE via `/var/run/argo/argoexec`.** | **No — this is container escape / RCE.** |

Primary-source quotes (all fetched 2026-04-22):

- CVE-2024-39877 (NVD): *"Apache Airflow 2.4.0, and versions before 2.9.3, has a vulnerability that allows authenticated DAG authors to craft a doc_md parameter in a way that could execute arbitrary code in the scheduler context..."*
- CVE-2025-30066 (NVD): *"tj-actions changed-files before 46 allows remote attackers to discover secrets by reading actions logs. (The tags v1 through v45.0.7 were affected on 2025-03-14 and 2025-03-15 because they were modified by a threat actor to point at commit 0e58ed8, which contained malicious updateFeatures code.)"*
- CVE-2025-66626 (Endor Labs write-up): *"even after the 3.7.3 patch, Argo's artifact extraction could still be abused to write outside the intended working directory"*

None of those support I3's specific normative claim that **approver principal must be a typed capability (not `Read` permission) and admin override must be audited**. Removing the Jenkins citation would leave I3's anti-pattern bullet dangling with no supporting precedent.

### Option (d) — Fix the citation to SECURITY-576 / CVE-2017-1000108 + 2017-08-07 advisory (+ plugin source for admin silence)

**Verdict: matches primary-source evidence exactly. Recommended.**

This is the option the task prompt did not pre-surface but which the evidence lands on. The `NVD` one-liner is a near-verbatim match for Spec-017's current wording, the `canSettle()` source is the gold-standard primary source for the silent-admin half, and JENKINS-56016's "Won't Fix" confirms the silence is by design — not an oversight.

---

## 6. Recommendation + reasoning

### Recommended action

**Replace the current Spec-017 citations at lines 344 + 441** with:

> **Line 344 anti-pattern sentence:**
>
> Anti-pattern: Jenkins Pipeline Input Step historically approved on `Item/Read` (CVE-2017-1000108, fixed in plugin 2.8 on 2017-08-07) and still silently bypasses the `submitter` allow-list for holders of `Jenkins.ADMINISTER` with no audit emission ([Jenkins SECURITY-576 advisory, 2017-08-07](https://www.jenkins.io/security/advisory/2017-08-07/); [`InputStepExecution.java` `canSettle()`](https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/src/main/java/org/jenkinsci/plugins/workflow/support/steps/input/InputStepExecution.java); [JENKINS-56016 Won't Fix](https://issues.jenkins.io/browse/JENKINS-56016)).
>
> **Line 440/441 references block:**
>
> - [Jenkins SECURITY-576 / CVE-2017-1000108 advisory (2017-08-07)](https://www.jenkins.io/security/advisory/2017-08-07/)
> - [NVD CVE-2017-1000108 — Pipeline Input Step Item/Read → Item/Build](https://nvd.nist.gov/vuln/detail/CVE-2017-1000108)
> - [Pipeline Input Step source — `canSettle()` admin bypass](https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/src/main/java/org/jenkinsci/plugins/workflow/support/steps/input/InputStepExecution.java)
> - [JENKINS-56016 — submitterParameter ignored for admins (Won't Fix)](https://issues.jenkins.io/browse/JENKINS-56016)

### Why recommendation wins

1. **Primary-source match.** NVD CVE-2017-1000108's one-liner is almost word-for-word what Spec-017 already says.
2. **Separable verification.** Claim A and Claim B have independent primary sources, so a reader can audit each half.
3. **Future-proof.** The `canSettle()` link pins to `master` and will track any future fix; the JIRA + CVE pins are immutable.
4. **Minimum edit.** The Spec-017 sentence survives with only an identifier swap + expansion — no need to rewrite the I3 invariant.

### Steel-man of the rejected alternative (Option c — remove Jenkins citation)

A principled case for removing the Jenkins citation entirely:

- **"Don't over-anchor on one vendor's 9-year-old plugin."** The Jenkins Pipeline Input Step is a specific plugin in one orchestrator. Future readers may view a 2017 advisory + 2020 Won't Fix as niche trivia rather than a universal anti-pattern. Spec-017 could instead ground I3 in the **positive** pattern (typed-capability approvers) with no anti-pattern illustration, or cite a more recent and more widely-used system (e.g., GitHub Actions environments, if a comparable CVE exists).
- **"Airflow/Argo/n8n already establish the danger of workflow engines."** Even though those specific CVEs aren't RBAC-bypass, their collective weight establishes that orchestrators are a common attack surface — the reader arriving at I3 already has the intuition.

**Why we still reject this alternative:** I3 is specifically about **approver-capability typing** (Spec-012 linkage), not generic workflow security. Without a concrete anti-pattern, I3 reads as an abstract architectural preference rather than a lesson learned from a real defect. The Jenkins precedent is 9 years old but still live (`canSettle()` on `master` in April 2026), so it's not stale. The cost of keeping a well-cited concrete example is one sentence; the cost of dropping it is weakening the invariant's normative force.

### Optional improvement worth flagging to Spec-017 owners

Consider also mentioning **GitHub Actions `environments` required-reviewers** as the *positive* counterpart in the same bullet — a reader then sees both the anti-pattern (Jenkins input-step) and the modern typed-capability pattern (GitHub environments reviewers), closing the loop on I3. That's a spec-level editorial call, not a citation-correctness call, so it's out-of-scope for this BL but worth flagging.

---

## 7. Sources table

Every URL fetched 2026-04-22. "Quoted substring" is the load-bearing verbatim text from that source used in this file.

| URL | Role in this analysis | Quoted substring |
|---|---|---|
| `https://www.jenkins.io/security/advisory/2017-02-01/` | Locates SECURITY-383 (XStream RCE, not input-step) | "XStream-based APIs in Jenkins (e.g. `/createItem` URLs, or `POST config.xml` remote API) were vulnerable to a remote code execution vulnerability involving the deserialization of various types in `javax.imageio`." |
| `https://www.jenkins.io/security/advisory/2017-04-10/` | URL Spec-017 currently cites; confirmed **does not** contain SECURITY-383 or input-step | (absence of SECURITY-383; enumerated IDs: SECURITY-123, 176, 187, 256, 257, 292–298, 333, 334, 348, 363, 365–369, 379, 405, 410, 456–496) |
| `https://www.jenkins.io/security/advisory/2017-07-10/` | Adjacent advisory; confirmed not the source | (enumerated IDs: 201, 303, 335, 342, 352, 433, 516, 527, 528, 529, 533, 538, 551 + JENKINS-21436; no input-step, no SECURITY-383) |
| `https://www.jenkins.io/security/advisory/2017-08-07/` | **Correct advisory** for the Read→Build change | (cross-referenced via NVD + plugin CHANGELOG; advisory page itself lists SECURITY-576 as "The Pipeline: Input Step Plugin by default allowed users with Item/Read access to a pipeline to interact with the step to provide input...") |
| `https://www.jenkins.io/security/advisory/2020-02-12/` | Confirmed no input-step content | (no input-step references) |
| `https://www.jenkins.io/security/advisory/2022-10-19/` | Option (a) evaluation — found to be CSRF, not RBAC | "Pipeline: Input Step Plugin 456.vd8a\_957db\_5b\_e9 limits the characters that can be used for the ID of `input` steps." (SECURITY-2880) |
| `https://nvd.nist.gov/vuln/detail/CVE-2017-1000108` | **Primary citation** for Claim A | "The Pipeline: Input Step Plugin by default allowed users with Item/Read access to a pipeline to interact with the step to provide input. This has been changed, and now requires users to have the Item/Build permission instead." (CVSS 7.5 HIGH) |
| `https://raw.githubusercontent.com/jenkinsci/pipeline-input-step-plugin/master/src/main/java/org/jenkinsci/plugins/workflow/support/steps/input/InputStepExecution.java` | **Primary citation** for Claim B (silent admin) | `if (!Jenkins.get().isUseSecurity() || Jenkins.get().hasPermission(Jenkins.ADMINISTER)) { return true; }` — lines 341–350 of `canSettle()`, no audit emission, no explanatory comment |
| `https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/CHANGELOG.md` | Supporting evidence for Claim A fix + Claim B documentation gap | v2.8 (2017-08-07): "Fix security issue"; v2.12 (2020-08-28): "Document that Jenkins administrators are always able to approve `input` steps (JENKINS-56016)" |
| `https://issues.jenkins.io/browse/JENKINS-56016` | Confirms silent admin behavior is by design | Resolution: "Won't Fix"; Status: Closed. Ticket title: "submitterParameter is ignored for admin users" |
| `https://nvd.nist.gov/vuln/detail/CVE-2024-39877` | Option (c) rejection — Airflow is code exec, not RBAC | "Apache Airflow 2.4.0, and versions before 2.9.3, has a vulnerability that allows authenticated DAG authors to craft a doc_md parameter in a way that could execute arbitrary code in the scheduler context..." (CVSS 8.8 HIGH) |
| `https://nvd.nist.gov/vuln/detail/CVE-2025-30066` | Option (c) rejection — supply-chain, not RBAC | "tj-actions changed-files before 46 allows remote attackers to discover secrets by reading actions logs. (The tags v1 through v45.0.7 were affected on 2025-03-14 and 2025-03-15 because they were modified by a threat actor to point at commit 0e58ed8, which contained malicious updateFeatures code.)" (CVSS 8.6 HIGH) |
| `https://www.endorlabs.com/learn/when-a-broken-fix-leads-to-rce-how-we-found-cve-2025-66626-in-argo` | Option (c) rejection — Argo is RCE, not RBAC | "even after the 3.7.3 patch, Argo's artifact extraction could still be abused to write outside the intended working directory" |

---

*End of report. Every load-bearing claim above carries a URL + fetch date 2026-04-22 + verbatim quoted substring.*
