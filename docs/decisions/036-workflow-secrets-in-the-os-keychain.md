# ADR-036: Workflow Secrets In The OS Keychain

| Field         | Value                                 |
| ------------- | ------------------------------------- |
| **Status**    | `accepted`                            |
| **Type**      | `Type 2 (one-way door)`               |
| **Domain**    | Workflows, Credential Custody, Daemon |
| **Date**      | 2026-09-23                            |
| **Author(s)** | Claude (AI-assisted)                  |
| **Reviewers** | Sawmon Abo                            |

---

## Context

A workflow step often calls a service that wants a credential: an HTTP step sends a bearer token, and a step that talks to a hosted API needs its key. Workflows run unattended. A schedule, a webhook or a file watch starts them while no app window is open, and the daemon that runs them outlives the desktop app. Definitions are exported, imported, copied from shared scope into a project and read by agents that author workflows, so anything a definition holds travels further than the machine it was written on.

[Spec-015 §Secrets — by reference only (C-15)](../specs/015-workflow-authoring-and-execution.md#secrets--by-reference-only-c-15) already keeps secret values out of definitions: a node's Credential param holds a `secret://<scope>/<name>` reference, never a value. It does not say where the value itself is kept, who may create or change it, where a reference may resolve, or what a step does when the store cannot be read.

The product's custody rule for credential material is that each secret is its own item in the operating system's credential store ([ADR-020](./020-cli-identity-key-storage-custody.md)) and lives nowhere else: never in the machine's settings file, never in the daemon's database, never in a log. On a Linux machine with no Secret Service, the store is one file in the daemon's own data folder, readable only by the person (mode `0600`). Environment rows on a project refuse a credential-shaped name at save (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or any name ending in `_TOKEN`, `_SECRET`, `_KEY` or `_PASSWORD`) and point the person to a workflow step's Credential field instead. [ADR-026](./026-provider-credential-custody-posture.md) lets the daemon hold one class of credential, a provider token the person pastes, and is scoped to provider accounts. [ADR-038](./038-mcp-credential-custody.md) records the daemon's custody of MCP-server credentials. A workflow secret is a new kind of custody, and this record states it.

The daemon writes a pasted provider token to the credential store before it commits the account row, and on removal records the intent before destroying the value, so a crash between the two steps is finished at the next start. `@napi-rs/keyring` 2.1.0 is the keychain binding the product names for credential material (MIT, 47 kB plus one native package per platform). On Linux it falls back to the kernel keyring on its own when no Secret Service answers, so the daemon opens the Secret Service store explicitly.

## Problem Statement

Where does the value of a workflow secret live, where may a step's reference to it resolve, and what does a step do when the value cannot be read?

### Trigger

The workflows design makes a secret a daemon record with create, replace, delete and list verbs, reached from the step's Credential field, and has no expression spelling that lets any param resolve a secret. Contracts for the record and its verbs land before execution is built, and they fix the custody model on the wire. The same custody question applies to two more values the daemon sends on the person's behalf: the mail password behind the email digest, and the web address that receives attention moments together with its signing secret.

---

## Decision

**We will keep each workflow secret's value as its own item in the operating system's credential store under the daemon's custody, keep only its name and scope in the daemon's database, let a step's `secret://<scope>/<name>` reference resolve only at step launch and only in a field its kind marks sensitive, and fail the step with its named cause, never a fallback to another store, when the store cannot be read. The mail password, the web address and the web address's signing secret are kept the same way.**

The decision has six parts.

1. **One store, or refusal.** The daemon writes each value through `@napi-rs/keyring` on macOS and Linux, and on Windows through the service's Windows half at `CRED_PERSIST_LOCAL_MACHINE`, never a roaming persistence: one item per secret keyed by the daemon-minted `secretId`, so no secret's name appears in the operating system's keychain list. Every item the daemon opens, for a workflow secret or anything else, opens with `{linux: {store: "secret-service"}}`: on Linux it uses the Secret Service, and never the kernel keyring, which is cleared at every restart; where no Secret Service answers, the item goes in the daemon's one file readable only by the person (mode `0600`), as every daemon secret does, never silently ([ADR-020 §The Credential Store](./020-cli-identity-key-storage-custody.md#the-credential-store)). There is no other store: no database column, no environment variable. A store that is locked, or one the daemon cannot use, refuses the write with `workflow.secret_store_unavailable`, carrying `cause: locked | unavailable`, and nothing is stored anywhere else. Calls to the store for one item run one at a time, and a save that timed out and lands later is deleted, so a late write never overwrites the value its retry saved.

2. **The record holds no value.** A secret is `{secretId, scope, scopeRef, name}` in a `workflow_secrets` table with no value column. `secretId` is minted by the daemon and never accepted from a request. `scope` is `project`, with `scopeRef` naming the project, or `shared`, with no `scopeRef`; there is no session scope, because an unattended run lives in a session nobody manages and nobody would create a secret there. `project` in a reference is relative: `secret://project/github-read` means the secret named `github-read` in the project the run is running in, so a shared definition run from two projects resolves each project's own secret, and copying a shared definition into a project needs no rewrite. A name is lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters; one that breaks the pattern or is already taken in its scope is refused with `workflow.secret_name_invalid`, carrying `reason: pattern | taken`.

3. **The verbs, and the order of the two writes.**
   - `workflow.secretList {scopeRef?}` returns this project's secrets and the shared ones, by name, with no value.
   - `workflow.secretCreate {scope, scopeRef, name, secretValue}` writes the value, then commits the record.
   - `workflow.secretReplace {secretId, secretValue}` overwrites the item, then updates the record. The name cannot change, because references find a secret by name.
   - `workflow.secretDelete {secretId}` records the removal intent on the row, deletes the item, then deletes the row; a crash between the steps is finished at the next start, as a provider account's removal is.
   - `secretValue` is write-only: it is the one member that accepts the value, and no reply, event, log line or error carries it. The screen follows the same rule: the value field is masked on entry, never read back and cleared on submit.
   - These verbs cross from the renderer to the daemon over the ordinary daemon call. The desktop bridge carries no member for them, and no agent tool reaches them.

4. **Where a reference may stand.** A reference resolves only in a param its node kind marks sensitive: a step's Credential field, and an HTTP step's auth and headers. A `secret://` reference anywhere else is refused at save, and no expression resolves a secret, so a value cannot be routed through an expression into a command line, a log line or an output. HTTP auth sends `Authorization: Bearer <value>`. A value never enters a process's command line. The live expression preview never resolves a secret; a sensitive field previews the secret's name. The authoring and run-start policy checks (`workflow::author`, `workflow::start`) see which secret references a version uses.

5. **Resolution and redaction.** The daemon reads a value only in the executor of the step being launched, only for the references that step names, and only at launch. The step record keeps the reference; its log says the reference was resolved and redacted. Before anything is written, each resolved value joins the run's redaction set in its raw, base64, URL-encoded and JSON-string forms, and every writer replaces it: step input, output and log, a payload moved to an artifact for size, error messages, step events and the diagnostic sink.

6. **When the value cannot be read.** A secret the store does not hold fails the step with `workflow.secret_not_found`, which carries only `reference`, reading `The secret project/github-read is not on this machine.` over `Add it in the step's Credential field, then press Retry from this step.` A store that is locked or unavailable fails the step with `workflow.secret_store_unavailable`, naming the cause and offering `Retry from this step`. The step never waits on the store indefinitely and never falls back to a plaintext value. The step's `onError` setting routes the failure like any other.

**The delivery secrets.** The mail password that sends the email digest (`attention.mailPasswordSave`, `attention.mailPasswordRemove`), and the web address with its signing secret (`attention.webAddressSave`, `attention.webAddressSecretRotate`, `attention.webAddressRemove`), are credential material in the same sense. Each is written through the same credential-store module, with the same Secret Service store and `0600` file on Linux, in the same write-then-commit order, and with the same refusal when the store cannot take it. Each is write-only on the wire: the web address reads back as its host only, and the signing secret is shown once when it is made. What they deliver, and when, is owned by [Spec-017 §Cross-Device Delivery](../specs/017-notifications-and-attention-model.md#cross-device-delivery).

### Thesis — Why This Option

- **The credential store is the product's one home for credential material.** A second store is exactly what the custody rule forbids. The store is also where each platform's own sign-in tools put the same class of secret, protected by the person's login, and the `0600` file on a Linux machine with no Secret Service is where `gh` and Codex put theirs.
- **The daemon is the only possible holder.** Resolution happens inside the daemon at step launch, and runs are unattended: the daemon runs with no window open and outlives the app. The main process's `safeStorage` exists only while the app runs, and the main process stores nothing with it.
- **References keep definitions portable and safe to share.** A definition, an export, a step record and an agent's read of a workflow all hold references. Nothing a definition can carry reveals a value, and a definition imported on another machine resolves against that machine's own secrets.
- **Narrow resolution makes redaction tractable.** When a value can appear only in a sensitive field of the step being launched, the daemon knows every value it must redact before the first write. An expression binding that could resolve a secret anywhere would carry values into command arguments, previews and outputs the redaction set cannot anticipate.
- **Failing loudly is the honest behavior.** A locked keychain is a real state on a machine whose person has stepped away. A step that fails with its cause and offers `Retry from this step` keeps the run whole and tells the person the one thing to do. A step that silently read a weaker copy would move the value out of the only store the person trusts.
- **One module serves every secret.** Provider tokens, workflow secrets and the delivery secrets share one credential-store module in the daemon, one refusal shape (`cause: locked | unavailable`) and one removal order. The binding is imported in one place.

### Antithesis — The Strongest Case Against

- **Unattended runs are exactly when a keychain is locked.** A macOS keychain can lock on sleep or after a timeout, and a Linux Secret Service collection is locked until the person logs in. A schedule that fires at 3 AM against a locked keychain fails every time, and a product that runs work unattended should not depend on a store designed around an interactive login.
- **A headless Linux machine has no Secret Service at all.** On a server or a container with no desktop session, a workflow secret sits in a file that only its permissions protect: any program running as the person can read it.
- **The keychain read from a background process is unproven.** On macOS a keychain item written by one process can prompt when another reads it, and an unsigned build's access differs from a signed one. The daemon that reads a secret may have been started by the app or from the command line, detached and outliving both. If the read prompts, an unattended run stalls or fails.
- **One entry per secret grows the person's keychain** with opaque ids they did not create and cannot recognize there.
- **No expression access is a real loss.** An n8n user expects to build a header from a credential and a literal (`Bearer {{$credentials.token}}`) or pass a key as a query param; forbidding expressions forces every such use through a sensitive field a node kind must declare.

### Synthesis — Why It Still Holds

- **Locked keychains are a named failure, not a hang.** The step fails with `cause: locked`, the run's header and the node say so, and `Retry from this step` resumes it after the person unlocks. That is the outcome the person would choose over having the value stored somewhere weaker, and it matches what a pasted provider token does on the same machine. The cost is accepted.
- **Headless Linux keeps working, in the open.** The `0600` file is where `gh` and Codex keep their credentials on the same machines, and the daemon never moves a value there silently: the person can see where secrets are kept. Encrypting the file would need a passphrase typed at daemon start, which puts a person back in the loop on the machines it was meant to serve.
- **The background read is measured before it is claimed.** The detached-daemon read and the read before login are listed below as unknowns the signed build answers. Until they pass, the product does not claim unattended secret resolution for that start path, and a failed read reaches the person as `secret_store_unavailable` with its cause, never as a hang.
- **Opaque entries are the price of not leaking names.** A secret's name can itself say what service a person uses. Keying the entry by id keeps names in the daemon's database, where the Credential chooser shows them.
- **Sensitive fields cover the uses that matter.** The HTTP step's auth and headers take a reference directly, and a node kind that needs a credential elsewhere declares that param sensitive. What is lost is composing a secret into free text, which is the path that leaks it.

---

## Alternatives Considered

### Option A: The OS keychain under the daemon's custody, resolved only in sensitive fields, refused otherwise (Chosen)

- **What:** Parts 1 to 6 of the Decision.
- **Steel man:** One store the person already trusts, one holder that is there when runs are, one narrow path from reference to value, and one loud failure with a retry.
- **Weaknesses:** Locked keychains fail unattended runs; on headless Linux a value is protected by file permissions alone; the background read must be measured on a signed build.

### Option B: Keychain first, an encrypted daemon-owned file second (Rejected)

- **What:** A file per secret encrypted with a key derived from a passphrase, used where no keychain is available.
- **Steel man:** Headless Linux, containers and locked-keychain hosts keep working. The primitives (`@noble/ciphers`, `@noble/hashes`) are already installed.
- **Why rejected:** The file's key needs a passphrase typed when the daemon starts, so on the hosts it was meant for an unattended run either waits on a person or the file is encrypted under a key stored beside it. A widely used editor offers the same fallback as "weaker encryption" when no OS keyring can be found (VS Code's secret storage service); the product declines it.

### Option C: The main process's `safeStorage` (Rejected)

- **What:** Seal values with Electron's `safeStorage` in the desktop app and hand them to the daemon when a run needs them.
- **Steel man:** Electron manages the OS integration on every platform.
- **Why rejected:** `safeStorage` exists only while the app runs, and workflows run when it does not.

### Option D: An expression binding that resolves a secret anywhere (Rejected)

- **What:** `$secrets("<scope>/<name>")` in any param's expression, as n8n resolves credentials in expressions.
- **Steel man:** Composable, familiar and one line for any use.
- **Why rejected:** A value would reach command arguments, previews, outputs and branch conditions the redaction set cannot anticipate. A value must never enter a command line, and the expression preview must never show one. Resolution only in declared sensitive fields keeps both rules checkable at save.

### Option E: Project environment variables (Rejected)

- **What:** Let a secret be a project's environment row, passed to the steps it runs.
- **Steel man:** The place many tools keep credentials.
- **Why rejected:** Environment rows are ordinary configuration, read back plain and inherited by every process the daemon starts for that project, agents' shells included. They refuse credential-shaped names at save for that reason.

---

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | `@napi-rs/keyring` opened on the Secret Service store never writes to the Linux kernel keyring. | Every item the daemon opens passes `{linux: {store: "secret-service"}}`, and where no Secret Service answers the daemon uses its `0600` file instead; on Windows every item goes through the service's Windows half at `CRED_PERSIST_LOCAL_MACHINE`, because the binding's own Windows write uses a roaming persistence. | A value could land in the Linux kernel keyring and vanish at the next restart, or roam off a Windows machine with the user's profile. The adapter's tests fail on a host where the store choice is ignored. |
| 2 | The daemon can tell a locked keychain from a missing one. | macOS's Security framework returns `errSecInteractionNotAllowed` (-25308) when the keychain is locked and the caller cannot prompt, and `errSecNotAvailable` (-25291) or `errSecNoSuchKeychain` (-25294) when there is none (`Security.framework/Headers/SecBase.h`). A Secret Service collection reports itself locked; a session with no Secret Service on its bus takes the `0600` file. Anything the daemon cannot classify reads as `unavailable`. | The cause shown to the person is wrong, and the remedy with it. |
| 3 | A daemon started detached from the app, and one started from the command line, read a keychain item the daemon wrote, without a prompt. | **Unvalidated.** An unsigned build's keychain access differs from a signed one's, and this machine has no signing identity. Validated on the signed, packaged build before unattended resolution is claimed. | Unattended runs that use a secret fail with `secret_store_unavailable` on that start path until the entry's access is fixed. |
| 4 | A keychain can be read before the person logs in, or it fails fast when it cannot. | **Unvalidated.** Measured on the signed build, with the daemon running as the person's own service at boot. | A run fired before login waits on the keychain instead of failing; the step's no-indefinite-wait rule must hold regardless. |
| 5 | Every credential a node kind needs can be declared as a sensitive param. | The HTTP step's auth and headers, and the Credential field on every kind that takes one, cover the catalog's credential uses. | A kind needs a new sensitive param; the kind contract already carries the `sensitive` mark, so the change is to the kind, not to this decision. |

---

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The keychain is locked when a scheduled run's step launches. | Medium on a laptop left asleep | Medium | The step fails with `workflow.secret_store_unavailable`, `cause: locked`; the node and the run header show it. | The person unlocks and presses `Retry from this step`; the step's `onError` can route the failure meanwhile. |
| A headless Linux host has no Secret Service. | High on servers and containers | Medium | The D-Bus check finds no Secret Service. | The value goes in the daemon's `0600` file, and the person can see where secrets are kept. |
| A daemon started from the command line cannot read an entry written by one the app started. | Unknown until measured | High | The signed build's check (Decision Validation) fails; in use, steps fail with `cause: unavailable`. | Fix the entry's access control before claiming unattended resolution; never add a fallback store. |
| A resolved value escapes into a log, output or error. | Low | High | The redaction canary tests plant a value in every writer's path; the diagnostic sink is checked the same way. | The value joins the redaction set in each of its encodings before the first write; resolution only in sensitive fields bounds where it can appear. |
| The daemon crashes between writing a value and committing its record, or between deleting a row's item and its row. | Low | Low | A row marked for removal at the next start. | Write-then-commit leaves at most an orphan entry keyed by an id no record names, which no reference can reach; a row carrying removal intent is finished at the next start. |
| The keychain binding is abandoned or breaks on a new OS release. | Low | Medium | The adapter's contract tests on each platform in CI. | The binding sits behind one daemon module; another binding with the same refusals replaces it there. |

## Reversibility Assessment

- **Reversal cost:** Weeks. Once people hold secrets in their credential stores under the daemon's items, moving to another store means reading every value out through the daemon and writing it into the new one, on every machine.
- **Blast radius:** Workflow secrets, the Credential chooser, the HTTP step's auth, the delivery secrets, and the provider-token store that shares the credential-store module.
- **Migration path:** A new store behind the same credential-store module and the same verbs; the reference grammar and the wire do not change, because no reply ever carried a value.
- **Point of no return:** The first release that people use with real secrets.

## Consequences

### Positive

- No credential value is ever in a definition, an export, a step record, a log or a reply.
- One credential-store module, one refusal shape and one removal order serve provider tokens, workflow secrets and the delivery secrets.
- A shared definition works in every project that holds the secrets it names.
- The person manages a secret where they use it: in the step's Credential field, with `New secret`, `Replace value` and `Delete`. No Settings page holds secrets.

### Negative (accepted trade-offs)

- A locked keychain fails a step that needs a secret, and the person has to unlock and retry. Accepted: the alternative moves the value into a weaker store.
- On a Linux host with no Secret Service, a secret is protected by file permissions alone. Accepted: it is how `gh` and Codex keep theirs there, and the person can see where it is kept.
- A secret cannot be composed into free text through an expression. Accepted: that is the path that leaks it.

### Unknowns

- Whether a daemon started detached, or from the command line, reads an entry without a prompt on each platform. Measured on the signed, packaged build before unattended resolution is claimed for that start path.
- Whether a keychain read before the person logs in fails fast or waits. Measured on the signed build.

---

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| A resolved value appears in any step record, log, event, error or diagnostic write | Zero | Redaction canary tests planting a value in raw, base64, URL-encoded and JSON-string forms through every writer | Every change that touches the executor or a writer |
| A `secret://` reference outside a sensitive field, or an expression naming a secret, saves | Zero | Save-time refusal tests over every param kind | Every change that touches the kind contract |
| A locked store keeps a value anywhere else, or a Linux host with no Secret Service keeps one anywhere but the `0600` file | Zero | Adapter tests with the store locked and absent, on each platform in CI | Every change that touches the keychain module |
| A daemon started detached and one started from the command line resolve a secret without a prompt | Both pass | Manual run on the signed, packaged build on macOS, Windows and a Linux desktop | Before the first signed release |
| A crash between write and commit leaves a record without its value, or a crash mid-delete leaves a removal unfinished after the next start | Zero | Fault-injection test at each step of both orders | When the secret store lands |
| A hung `setPassword` that resolves after its retry overwrites the retry's value | Zero | A test holding one save past its timeout, retrying, then letting the first resolve | When the secret store lands |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `@napi-rs/keyring` 2.1.0 | Documentation | A native binding to each platform's credential store; one native package per platform; on Linux falls back to the kernel keyring on its own unless the Secret Service store is chosen; MIT | https://www.npmjs.com/package/@napi-rs/keyring |
| Apple Security framework, `SecBase.h` | Documentation | A locked keychain the caller cannot prompt through returns `errSecInteractionNotAllowed` (-25308); no keychain returns `errSecNotAvailable` (-25291) or `errSecNoSuchKeychain` (-25294) | macOS SDK, `Security.framework/Headers/SecBase.h` |
| freedesktop Secret Service API | Documentation | Collections report whether they are locked; a session with no service on its bus has none | https://specifications.freedesktop.org/secret-service/ |
| VS Code secret storage service | Primary research | When no OS keyring can be identified, VS Code tells the person which keyring to install and offers "Use weaker encryption"; the product encrypts nothing of its own there and keeps its items in a file readable only by the person | https://github.com/microsoft/vscode, `src/vs/workbench/services/secrets/electron-browser/secretStorageService.ts` |
| n8n credentials | Documentation | n8n keeps credentials encrypted in its own database and resolves them in expressions; the product keeps the reference-in-a-param model and drops both the own-database store and expression resolution | https://docs.n8n.io/credentials/ |

### Related ADRs

- [ADR-026: Provider Credential Custody Posture](./026-provider-credential-custody-posture.md) — the daemon's custody of a pasted provider token; this record adds a second class of credential under the same credential-store module, refusal shape and removal order.
- [ADR-020: Machine Identity Key Custody](./020-cli-identity-key-storage-custody.md) — every daemon secret as its own credential-store item, and the `0600` file on Linux with no Secret Service; this record keeps workflow and delivery secrets the same way.
- [ADR-012: Cedar Approval Policy Engine](./012-cedar-approval-policy-engine.md) — the `workflow::author` and `workflow::start` checks that see a version's secret references.
- [ADR-024: Visual Node-Graph Workflow Authoring](./024-visual-node-graph-workflow-authoring.md) — the node and param model the Credential field belongs to.
