# ADR-026: Provider Credential Custody Posture

| Field         | Value                                        |
| ------------- | -------------------------------------------- |
| **Status**    | `accepted`                                   |
| **Type**      | `Type 2 (one-way door)`                      |
| **Domain**    | Auth, Provider Execution, Credential Custody |
| **Date**      | 2026-08-26                                   |
| **Author(s)** | Claude (AI-assisted)                         |
| **Reviewers** | Repository owner                             |

> **Type guidance:** Type 2. The decision below takes the daemon from "never holds provider credential material, under any condition" to "holds exactly one narrowly-defined class of it." An absolute, once broken, is not restorable by deleting code: every later contributor reads the corpus as permitting custody-with-conditions and argues at the boundary rather than against the rule.

---

## Context

[Spec-025](../specs/025-provider-accounts-and-credential-homes.md) specifies node-local provider accounts: one registry row per account, an isolated credential home per account, fail-closed validation before every spawn, and a readiness projection that tells the person which provider is not ready and what to do about it. The conservative posture for those accounts is **no token custody** as an absolute: the daemon never persists, logs, relays, or serves credential material; no field on the wire accepts a provider token; no environment variable overrides a credential; and the provider-account registry has no token field at all. The same rule, scoped to material belonging to an MCP server, is [Spec-024 §Non-Goals](../specs/024-mcp-server-configuration-and-governance.md#non-goals) and [Plan-022 I-022-1](../plans/022-mcp-server-configuration-and-governance.md#i-022-1--credential-custody-is-exactly-what-adr-038-records). This record bounds the absolute for provider accounts and leaves the MCP-server rule at its scope.

That posture answers a published vendor policy. Anthropic's legal-and-compliance page states that developers "may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow", and separately carves out that the policy does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription", conditioned on the binary not being modified and on no resale or intermediation. The absolute is the conservative reading: hold nothing, and the intermediation clause cannot be reached.

Two operational facts are established against the pinned binaries and recorded at **Verified** trust in [Provider Wire Reference §claude](../reference/provider-wire/claude.md) and [§codex](../reference/provider-wire/codex.md):

1. Both providers ship a **first-party interactive sign-in flow inside the unmodified binary**, and both surface the material a person needs to complete it out of band — Codex's app-server returns an authorization URL or a device code and user code from its login-start request; Claude Code's CLI prints a URL and accepts a pasted code. Neither flow requires anything but the binary and a pinned credential home.
2. Anthropic documents a **long-lived non-interactive token** minted by its own CLI subcommand, explicitly "for CI pipelines, scripts, or other environments where interactive browser login isn't available", consumed by the unmodified binary through a documented environment variable, carrying no refresh token and a fixed one-year horizon.

The absolute forbids using either. It forbids the first because a strict reading of never relaying credential material arguably covers relaying a verification URL. It forbids the second outright. The result is a headless or no-TTY node that can register an account it can never authenticate, and a person whose only remedy is to leave the product.

## Problem Statement

What posture should the daemon take toward provider credential material: keep the inherited absolute and accept that a headless node cannot be authenticated, or define a bounded custody rule and pay for it with the loss of an absolute?

### Trigger

Under the absolute, two gaps have no answer:

- A headless or no-TTY node that cannot complete a browser sign-in can only print the remedy and refuse ([Spec-025 §Fallback Behavior](../specs/025-provider-accounts-and-credential-homes.md#fallback-behavior)), with an environment-variable override rejected. There is no path from that state to a working node without a second machine.
- [Provider Failure Runbook §Provider Re-Authentication (Per Account)](../operations/provider-failure-runbook.md#provider-re-authentication-per-account) step 7 tells the person to re-authenticate the provider CLI into that account's own credential home, and the absolute leaves it **no command and no surface** to do that with, so the step cannot be carried out.

This record decides whether the app takes custody of provider credential material — storing, relaying, or serving it — against the no-token-custody absolute.

---

## Decision

**We will replace the daemon's absolute no-token-custody posture with two bounded rules: the daemon MAY broker interactive sign-in by executing the provider's own unmodified first-party flow against a pinned credential home without reading its result, and the daemon MAY take custody of exactly one class of credential material the person supplies — a provider-documented long-lived non-interactive credential — kept as its own item in the operating system's credential store as [ADR-020](./020-cli-identity-key-storage-custody.md) records, refused where the store cannot take it, and handed only to processes bound to that account, on the channel the provider documents.**

The two rules are stated separately because only one of them is a reversal.

**D1 — Brokered interactive sign-in is not custody.** The daemon constructs and spawns the provider's own sign-in invocation, with that account's credential home pinned through the provider's reserved environment variables, and forwards to the caller only the verification material the provider itself emits for the person to act on — an authorization URL, or a device code and its verification URL. The daemon does not read, parse, copy, cache, relay, or persist the credential the flow writes. The credential is written by the provider's own tooling into the provider's own store inside that home, exactly as it would be had the person run the command themselves. Sign-in completes through the vendor's own flow, in the vendor's unmodified binary; the daemon supplies a working directory and a terminal, and learns nothing.

**D2 — Bounded token custody, one class only.** The daemon MAY accept a provider-minted long-lived non-interactive credential from the person through an explicit, non-echoing input, keep it as its own item in the operating system's credential store, and hand it to exactly two invocations: a **registration-time observation** — a single non-interactive status invocation, spawned with no model-directed code in it, whose only purpose is to let the daemon _observe_ the authentication mode rather than assume it — and provider processes bound to that account. A credential the store cannot take is refused with its cause (`locked` or `unavailable`) and stored nowhere else. On Linux the daemon opens the Secret Service store explicitly (`{linux: {store: "secret-service"}}`), so the kernel keyring, which is cleared at every restart, is never used, and where no Secret Service answers the credential goes in the daemon's one file readable only by the person (mode `0600`), never silently; on Windows every item is written through the service's Windows half at `CRED_PERSIST_LOCAL_MACHINE`, never at a roaming persistence, whether the service runs on Windows or in a WSL 2 distribution. The hand-over is the provider's documented channel, never a variable in the process's start-up environment, because any child reads that environment: on Claude Code a setup token reaches each spawn on `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, a pipe per spawn, and an in-place account switch hands it on `CLAUDE_CODE_OAUTH_TOKEN` through `apply_flag_settings {env}`; on Codex a pasted OpenAI API key reaches the account's service by `account/login/start {type: "apiKey", apiKey}` on the daemon's connection, the service started with `-c cli_auth_credentials_store="ephemeral"` so the key lives only in that service's memory and never in Codex's plaintext `auth.json` mode, and it is sent again after every restart of that service. The paste field takes what the person pastes into it; the class it exists for is the credential these five facts describe:

1. The credential is minted **by the provider** for the person's own account — through a subcommand the provider documents for this purpose (Claude Code's `claude setup-token`), or at the provider for the person's own account and consumed through a login path the provider documents (an OpenAI API key, which Codex's `codex login --with-api-key` and the app-server's `apiKey` login take). The daemon never mints, exchanges, refreshes, or derives credential material, and never speaks an OAuth token endpoint.
2. The provider **documents the channel** by which its unmodified binary consumes it — a documented variable or file descriptor, or a documented login request. The daemon hands it over on that documented path; it does not invent one.
3. The credential is **non-interactive by construction** — it carries no refresh token, so possession of it grants no ability to mint successors, and its compromise ends on the provider's side: at the provider's own fixed horizon, or when the person revokes it at the provider, never renewable by the holder.
4. The person **supplies it deliberately**, through an input that exists for this and nothing else, and that never echoes, logs, or renders the value.
5. The **hand-over keeps the credential out of every tool, shell, and subagent subprocess** the consuming process spawns. A bearer credential reachable from the environment of a process that executes model-directed commands is readable by an `env` dump the model itself can issue, which defeats every wire and log redaction for provider accounts. The exposure is **not** the vendor's documented posture — there a human exports a token for their own run and no untrusted code executes inside that environment, whereas the daemon's run child executes model-directed tools by design, so this is a risk the daemon creates rather than one it inherits, and it is why the hand-over is the documented descriptor or login request and never a start-up variable. **Observed on both legs.** On Claude Code at 2.1.282 the token delivered on `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` is kept out of every child; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is never set, and the project's own probe re-runs that check when the project moves to a new Claude Code version. On Codex the key reaches the service by a login request and never enters any process's environment, so the fact holds by construction; the empirical check, an agent's command looking for the key, runs in the Codex pin check with a real key.

**Everything outside those two rules stays refused, with four named exceptions that each move a credential without copying or showing it.** The daemon reads a provider's credential store in exactly two places: each Codex account home's `auth.json`, re-read after each five-minute limits read so a token the provider renewed is handed on to the service that runs on it, and Claude Code's credential for the one access token dictation needs, renewed through the account's own reader under Claude Code's own refresh lock when it expires within five minutes. The daemon holds Codex sign-in tokens it hands to the shared service with `account/login/start {type: "chatgptAuthTokens"}` in its memory only — never stored, logged, shown or given to the renderer — and answers the service's refresh request by running `account/read {refreshToken: true}` in that account's own home. And a move of the background service between Windows and a WSL distribution moves each account's sign-in file into the same account's folder on the new side once the old side has fully stopped, deleting the old copy, so two live copies never exist; a failed move puts the newest copy back first. Beyond those, the daemon does not copy credential material between homes; does not place credential material on any event, error, log, metric, or wire payload; does not accept a token as a general-purpose credential override on run start or in configuration; and does not accept interactively-minted session credentials, refresh tokens, or cookies from the person in any form.

### Thesis — Why This Option

**D1 is what the vendor carve-out describes.** The carve-out permits "an end user … signing in to the unmodified Claude Code binary with their own Claude subscription", conditioned on the binary not being modified and on no resale or intermediation. Spawning the shipped binary with `HOME`-class variables pointed at a directory satisfies the first condition literally — nothing is patched, no authentication method is removed, disabled, or restricted, and the flow the person sees is the vendor's. It satisfies the second because there is no third party: the person, their own subscription, and their own machine. The intermediation clause bars _collecting, storing, or intermediating_ the credential; D1 does none of the three, and the sign-in does complete through the vendor's flow. D1 is therefore not a reversal of the no-custody posture at all — it is the posture, applied to the vendor's own sign-in flow.

**D2's class is the one the vendor built for this.** Anthropic did not merely leave a token-shaped hole; it ships a subcommand whose stated purpose is "CI pipelines, scripts, or other environments where interactive browser login isn't available" and a documented variable for consuming it. Refusing to support the vendor's own non-interactive authentication path, in the name of a policy clause about _intermediating claude.ai sign-in_, reads the clause past what it says. Fact 1 keeps the daemon out of the minting path entirely, which is where the intermediation clause actually bites.

**Fact 3 is what makes the blast radius bounded rather than open-ended.** A refresh token is a renewable capability: a holder can mint successors indefinitely, so custody of one is custody of the account. The class D2 admits carries no refresh token — verified against the pinned binary, which hardcodes the refresh handle to null on this path — so a leaked token is a bounded-lifetime bearer credential that expires on the provider's clock and cannot regenerate itself. That is a materially smaller thing to hold than what the absolute was written to prevent, and the distinction is structural rather than procedural.

**The credential store already exists.** [ADR-020](./020-cli-identity-key-storage-custody.md) describes how this repository stores a local secret: each secret its own item in the OS credential store, verified by a write-probe-read-delete rather than assumed available, the daemon's `0600` file on Linux where no Secret Service answers, and a loud refusal with its cause where a locked store cannot be used, never a silent fallback. D2 uses that store and that refusal: a provider credential is kept as its own item or refused with its cause. No new cryptography is designed.

**Storing outside the credential home is the same posture, applied consistently.** Spec-025 §Non-Goals states the daemon "claims no ownership over the bytes inside a home", and §Pitfalls To Avoid forbids a design that "reads, copies, caches, or transports the material inside a home". Writing a daemon-held secret into the home would put daemon-owned bytes in provider-owned space and make the two indistinguishable to a future reader. The stored value therefore lives in daemon-owned state, keyed by `accountId`, and reaches the provider only on the channel the provider documents for one process — the one place it must exist for the vendor's binary to consume it.

### Antithesis — The Strongest Case Against [T2]

A skeptical staff engineer objects on six grounds.

**1. The clause says "store", and D2 stores.** "Developers may not collect, store, or intermediate Claude.ai credentials or session tokens." A token minted by `claude`'s own subcommand, bearing an `sk-ant-oat` prefix, authenticating against Anthropic's inference API on a Claude subscription, is a Claude credential by any reading a lawyer would apply. The thesis's move — that the clause is "about intermediating sign-in" — is doing work the text does not support: sign-in intermediation is the _third_ verb, and collecting and storing are the first two, stated independently. Fact 1 keeps us out of the minting path, which addresses "intermediate" and leaves "collect" and "store" squarely violated. We are choosing the reading that lets us ship.

**2. The absolute is load-bearing precisely because it is absolute.** It is stated without qualification, and in the `api-payload` provider-account registry as a property of the _wire shape_ — the registry has no token field at all — which is the kind of claim a reviewer can check mechanically. Replacing it with a conditional rule replaces a mechanically-checkable invariant with a judgment call, and judgment calls decay. The next contributor arrives with a token that satisfies all but one condition and a deadline, and the argument is no longer "no" — it is a negotiation about fact 3.

**3. Fact 3 is a property of today's binary, not of the class.** "Carries no refresh token" was read out of one build of one provider's minified bundle. A vendor is free to give the same subcommand a renewable token next release, and nothing in our system would notice: we would keep injecting it, keep calling the posture bounded, and the boundedness would be silently false. An invariant that depends on an undocumented, version-fragile property of a vendor artifact is not an invariant.

**4. A daemon that runs a sign-in command can be handed one to run.** Once the daemon executes a sign-in flow on the person's behalf, a client has a reason to send it the command, and a daemon that executes a string a client supplied runs whatever that client chose.

**5. Executing a sign-in flow makes the daemon a credential-handling component whether or not it reads bytes.** A spawned child writing a credential into a directory the daemon created, chose, and can read is custody in the security sense that matters: the daemon has ambient filesystem authority over the material. "We do not read it" is a policy the code follows today, enforced by nothing, and every later feature that needs "just the expiry" or "just the account email" will read it.

**6. This is a bad trade against the actual gap.** The headless case has a working answer that costs nothing: sign in on a machine with a browser, and put the credential home on the headless machine. The gap D2 closes is convenience, and we are spending an absolute on it.

### Synthesis — Why It Still Holds [T2]

**On (1) — the clause says "store."** This is the strongest objection and it is **accepted as a residual, not rebutted**. D2 does store a Claude credential, and the reading under which that is permissible — that the clause's subject is claude.ai account sign-in and session tokens, and that a vendor-minted non-interactive token consumed by the vendor's own binary through the vendor's own documented variable is the vendor sanctioning that exact flow — is a reading, not a certainty. What moves the decision is that the alternative reading condemns the vendor's own documented CI path as unusable by any tool but a hand-written shell script, and that the person here is the account holder storing their own credential on their own machine, which is the fact pattern the carve-out exists to protect. The residual is recorded in §Failure Mode Analysis with a detection signal and a defined retreat, and D2 is scoped so that the retreat is cheap: one input, one stored value, two enumerated hand-overs, all behind a single feature boundary.

**On (2) — the absolute is mechanically checkable.** Correct, and the replacement is written to stay mechanically checkable rather than to become a judgment call. Facts 3 and 5 rest on a **recorded first-party observation** rather than on vendor documentation, and the corpus surfaces state the bounded rule in the same mechanically-checkable register: exactly one wire input accepts credential material, it is named, it is write-only, and every other surface still carries none. A reviewer can still grep. What changes is the string they grep for.

**On (3) — fact 3 depends on a vendor artifact.** Accepted and mitigated rather than dismissed. The fact is restated in the specification as a **property the daemon must observe, not assume**: the account's observed authentication mode is recorded on the registry row, and the surface renders the expected re-login horizon as an **estimate** rather than a fact. If a vendor makes the token renewable, that is a change in the vendor's contract; it shows in the account's recorded authentication mode and the daemon's logs, and is investigated when seen. The honest position, recorded here: fact 3 is **Verified at the measured builds and version-fragile**, exactly like every other provider-wire fact this corpus depends on.

**On (4) — a daemon that runs a sign-in command can be handed one to run.** It cannot, because nothing it runs comes from a client. The daemon **constructs** its own sign-in invocation: a binary it already spawns on every run, with arguments it authors, against a home it owns. A client names only the account to sign in, no wire member carries a sign-in command, and no client-supplied string is ever executed.

**On (5) — ambient filesystem authority is custody in the security sense.** Accepted as an accurate description, and it is why D1 is specified with a **stated non-goal that is enforced by the shape of the code rather than by discipline**: the sign-in broker returns the provider's verification material and a completion outcome, and has no read path into the home at all. The concern that "every later feature will read it" is real and is answered structurally — the registry row already carries the observed authentication mode, the observation timestamp, and the expected horizon as **daemon-authored columns**, so the features that would otherwise reach into the home have a first-class place to read from. Where a fact genuinely is not available without opening a credential file, the specification's answer is honest absence, not a read.

**On (6) — the headless case has a workaround.** It has a workaround that requires a second machine, a file copy of credential material between hosts (which is a worse custody story than anything in D2), and re-doing it on every credential rotation. More decisively, the workaround does not address the _other_ trigger: the runbook's re-authentication step is unexecutable on **every** node, headless or not, because no surface exists to re-authenticate an account from. D1 alone closes that, and D1 is not the reversal. The trade is not "an absolute for convenience" — it is "an absolute for a working re-authentication path", with D2 as the bounded tail case for nodes that cannot run an interactive flow at all.

---

## Alternatives Considered

### Option A: Brokered sign-in plus bounded token custody (Chosen)

- **What:** D1 and D2 above. The daemon executes the vendor's own sign-in flow against a pinned home and reads nothing; separately, it accepts exactly one class of vendor-minted non-interactive credential through a dedicated no-echo input, keeps it in the credential store, and hands it to that account's processes only, on the provider's documented channel.
- **Steel man:** It closes both triggers with the smallest surface that can close them; it takes the custody step only for the case that has no other answer; the class it admits is the one the vendor documents for exactly this purpose and is structurally bounded by carrying no refresh token; and the storage mechanism already exists in ADR-020, so the decision adds a consumer rather than a mechanism.
- **Weaknesses:** It stores a provider credential, which a plain reading of the vendor's clause forbids (accepted residual, §Synthesis (1)). Its boundedness rests on a version-fragile property of a vendor artifact (a change shows in the daemon's logs and is investigated when seen, §Synthesis (3)). It gives the daemon ambient filesystem authority over credential homes it creates (accepted, mitigated structurally, §Synthesis (5)).

### Option B: Keep the absolute (Rejected)

- **What:** Change nothing. Headless and no-TTY nodes cannot authenticate; the runbook's re-authentication step stays unexecutable; the person signs in on a machine with a browser and moves the credential home themselves.
- **Steel man:** The absolute is the only posture that cannot be argued at the margin, and margins are where credential handling fails. It is trivially auditable — a reviewer greps for a token field and finds none. It carries zero legal exposure under any reading of the vendor clause, which matters disproportionately because the downside is not a bug but account termination for the person. It costs nothing to maintain, and the workaround, while inconvenient, genuinely works: a credential home is a directory, and directories are copyable. Most importantly, every argument for crossing this line is an argument about convenience, and convenience arguments are exactly the ones that should lose to an absolute in a security posture.
- **Why rejected:** It leaves a documented runbook procedure unexecutable on every node, not just headless ones — the runbook step names a re-authentication that no surface provides. And the workaround it relies on is not neutral: copying a credential home between hosts moves live credential material across machines by hand, with no credential store, no per-account isolation guarantee at the destination, and no audit — a strictly worse custody outcome than D2, arrived at by refusing to name custody. The absolute stops the daemon from holding a bounded token and pushes the person into holding an unbounded one badly. Note that Option B remains available for D2 alone: D1 closes the runbook trigger by itself, and if the §Failure Mode Analysis detection signal for the vendor-policy residual fires, D2 retreats to Option B without D1 moving.

### Option C: Broker sign-in only; refuse all token custody (Rejected)

- **What:** Adopt D1, reject D2. The daemon executes the vendor's interactive flow and surfaces the verification URL or device code, including on headless nodes where the person completes the flow on a phone or another machine.
- **Steel man:** This closes the runbook trigger, closes most of the headless case (device-code flows are specifically designed for hosts without a browser — the person reads a code off the terminal and enters it elsewhere), and does it all **without reversing the no-custody posture at all**. Every corpus absolute survives. The `api-payload` NOTE stays literally true. It is strictly the least-cost option that solves the named problem, and the residual it leaves — a provider whose CLI offers no device-code flow on a host with no browser — is narrow and may close on its own as vendors converge on device-code support.
- **Why rejected:** It is the right answer for one provider and not the other, and the difference is verified rather than assumed: the Codex leg publishes a device-code login arm returning a verification URL and user code, while the pinned Claude leg's documented non-interactive path is the minted token, not a device code. Option C therefore leaves the Claude leg with no headless path at all — the exact gap that prompted the decision — while spending the full design cost of the sign-in broker. It also strands the class of node that has no person present at any point, which is a real deployment shape for this product. Adopted in part: D1 **is** Option C, and it is specified so that it stands alone if D2 is later retreated.

### Option D: General environment-variable credential override (Rejected)

- **What:** Let the person supply any provider credential through configuration or a run-start flag, and pass it through to the child process.
- **Steel man:** It is the simplest possible implementation, it needs no storage decision at all (the value lives in the person's own environment or configuration file), it composes with every existing secret-management tool the person may already run, and it makes no claim about what the credential is — which means it never becomes wrong when a vendor changes token semantics.
- **Why rejected:** [Spec-025 §Fallback Behavior](../specs/025-provider-accounts-and-credential-homes.md#fallback-behavior) never falls back to the person's ambient credentials, and this record keeps that: an unbounded override accepts refresh tokens, session cookies, and interactively-minted credentials indistinguishably from the bounded class, which is precisely the intermediation the vendor clause bars. It also defeats the provider-account registry — a credential arriving out-of-band belongs to no registered account, so nothing keys spend, quota, or the attention entry to it. D2 is deliberately narrower on every condition.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | The vendor's carve-out permits an end user signing in to the unmodified binary with their own subscription, and spawning that binary with a pinned home meets its conditions. | The [vendor legal-and-compliance page](https://code.claude.com/docs/en/legal-and-compliance), whose rules [Spec-025 §Vendor authentication-policy constraints](../specs/025-provider-accounts-and-credential-homes.md#vendor-authentication-policy-constraints) records at **Documented** trust. | D1 falls. The sign-in broker is withdrawn and the runbook trigger reopens. |
| 2 | A vendor-minted non-interactive token consumed by the vendor's own binary through the vendor's own documented variable is not the credential intermediation the clause bars. | **Unvalidated — this is a reading, not a fact.** Recorded as an accepted residual in §Synthesis (1) and as the first row of §Failure Mode Analysis. | D2 falls back to Option B. The token input, the stored item, and the injection are removed; D1 and the provider-account registry are untouched. |
| 3 | The admitted class carries no refresh token, so possession grants no ability to mint successors. | Verified against the pinned Claude Code binary and recorded at **Verified**, version-fragile, in [Provider Wire Reference §claude](../reference/provider-wire/claude.md); an OpenAI API key carries none by its kind. | The class stops being bounded. Custody becomes custody of the account, and the blast radius argument in §Thesis fails. Detected by the project's own probe, which re-runs when the project moves to a new Claude Code version; the response is to withdraw the class on that provider until re-assessed. |
| 4 | The OS credential store is reachable and durable on the platforms this ships to. | [ADR-020](./020-cli-identity-key-storage-custody.md), already `accepted`, with a write-probe-read-delete verification rather than an availability assumption. On Linux the daemon opens the Secret Service store explicitly (`{linux: {store: "secret-service"}}`), so the binding never falls back to the kernel keyring, which is cleared at every restart, and where no Secret Service answers the daemon keeps its items in its `0600` file, never silently. On Windows every item is written through the service's Windows half at `CRED_PERSIST_LOCAL_MACHINE`, never at a roaming persistence, whether the service runs on Windows or in a WSL 2 distribution. | The store is locked or unusable: the credential is refused at paste with its cause (`locked` or `unavailable`) and stored nowhere else, so the one thing that cannot happen is a silent plaintext write. |
| 5 | The person supplying a token is the account holder supplying their own credential on their own machine. | Provider accounts are node-local by construction: [Spec-025 §Non-Goals](../specs/025-provider-accounts-and-credential-homes.md#non-goals) forbids control-plane account records, and every verb is gated on the device that asks — this machine's own client or a linked device, never a session (I-023-1). | The "each end user authenticates with their own credential" constraint is violated. Mitigated structurally: there is no surface by which one user's token could reach another's node, because accounts never leave the node. |

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The vendor reads its own clause as barring D2 — assumption 2 is wrong. | Med | High | A vendor policy revision naming third-party token storage; a support or enforcement response to the person; the vendor withdrawing the non-interactive subcommand. | Retreat D2 to Option B. The retreat is one input, one stored item, one injection — D1 and the whole provider-account registry stand. Every corpus surface that states the custody rule names D2 separably for exactly this reason. |
| The vendor makes the non-interactive token renewable — assumption 3 is wrong. | Med | High | The account's recorded authentication mode and the daemon's logs; a change is investigated when seen. | Withdraw the class on the affected provider until re-assessed. The registry records the **observed** authentication mode per account, so the affected rows are enumerable rather than needing a fleet-wide assumption. |
| A stored credential leaks — from the credential store, a service's memory, a crash dump, or a log. | Low | Med | Provider-side anomalous-use signals; the account's observed authentication state changing without an action of the person's. | Bounded by construction: no refresh token, so the leak cannot regenerate and ends at the provider, on its fixed horizon or at revocation. The person's remedy is to revoke at the provider and re-supply. No logging path may render the value. |
| A later contributor widens D2 incrementally until it is a general credential override. | Med | Med | Code review against the wire-input census. | The wire-input census names exactly one credential-accepting input, so widening it changes a named claim a reviewer reads. |
| D1's "reads nothing" becomes false as a later feature needs a fact from inside the home. | Med | Med | Review of any new read path into a credential home; the §Pitfalls prohibition is retained verbatim. | The registry row carries the daemon-authored facts (observed mode, observation time, expected horizon) that such a feature would otherwise reach into the home for. Where a fact is unavailable, the answer is honest absence. |

## Reversibility Assessment

- **Reversal cost:** D2 — days. One wire input arm, one credential-store consumer, one hand-over branch per provider, one registry column value, and the corpus prose that names them. D1 — weeks, because the sign-in broker, its verification-material surface, and its clients would be withdrawn together. **The reputational and precedential reversal of D2 is not recoverable at any cost**: once the corpus has said "the daemon may hold credential material under conditions", deleting the code does not restore the absolute.
- **Blast radius:** Provider accounts (Spec-025/Plan-023), the desktop provider-management view and CLI verbs that surface it, and the PII data map. No control-plane surface is touched — accounts are node-local, and this decision does not widen that.
- **Migration path:** To retreat D2: refuse the token input, mark affected accounts as requiring interactive re-authentication through D1's broker, delete the stored items from the credential store, and restore the corpus's token-absence claims. Accounts authenticated interactively are unaffected. To retreat D1 as well: withdraw the sign-in broker and reopen the runbook trigger.
- **Point of no return:** The moment the first stored token is written on the person's machine. Before that, this is prose; after it, retreat requires shredding material we told the person we would hold. This is the trigger to re-evaluate, and it sits at the token leg's first shipped code — not at this ADR's acceptance.

## Consequences

### Positive

- The runbook's re-authentication step becomes executable, on every node rather than only on nodes with a browser.
- A headless or no-TTY node can be authenticated without hand-copying credential material between hosts — which is a better custody outcome than the workaround it replaces, not merely a more convenient one.
- The daemon's relationship to credential material becomes **stated** rather than absolute-and-therefore-unexamined: one class of credential, one named input, one stored item, two enumerated injection sites.
- The custody mechanism is ADR-020's credential store and refusal, so no new cryptography is designed and the OS credential store is used, verified rather than assumed, with the Secret Service opened explicitly on Linux.

### Negative (accepted trade-offs)

- **The absolute is gone, permanently.** Every later credential-custody question is now a boundary argument rather than a refusal. Accepted because the absolute was already forcing a worse real-world custody outcome (§Alternatives, Option B).
- **A plain reading of the vendor's clause is violated by D2.** Accepted with a named detection signal and a cheap, pre-specified retreat (§Failure Mode Analysis row 1). This is the single largest accepted risk in this record.
- **The boundedness of the admitted class depends on a version-fragile vendor property.** Accepted, mitigated by observing rather than assuming the authentication mode; a change shows in the daemon's logs and is investigated when seen.
- **The daemon holds ambient filesystem authority over credential homes it creates.** Accepted; it holds that authority anyway, because it creates and pins those homes for every run.

### Unknowns

- Whether an agent's command on Codex can see a pasted API key: the key never enters any process's environment, so fact 5 holds by construction, and the empirical check runs in the Codex pin check once a real key is available.
- Whether the observed authentication mode is stable enough across vendor releases to be a reliable fact on the registry row, or whether it needs a re-observation cadence tighter than the health observer's.

---

## Decision Validation [T2]

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Credential material appearing on any event, error, log, metric, or wire **output**, or on any wire input other than the single named registration input | 0 | The no-credential-payload assertions on the provider-account contract surfaces, run against every response, notification, and error type plus every request except `providerAccount.register` | When the sign-in broker ships |
| Wire inputs accepting credential material | Exactly 1, named | The wire-input census on `api-payload-contracts.md` §Plan-023 | Every change to that section |
| Accounts whose observed authentication mode is recorded rather than assumed | 100% of accounts that have been observed once | The registry column, non-NULL exactly when an observation exists | When the token leg ships |
| Vendor-policy residual (assumption 2) unrealized | No enforcement or policy signal | Vendor policy-page revision date | Ongoing |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Anthropic legal and compliance policy | Vendor documentation | The unmodified-binary carve-out and its conditions; the "collect, store, or intermediate" clause that D2's residual sits against. Already recorded at **Documented** trust in Spec-025. | [Spec-025 §Vendor authentication-policy constraints](../specs/025-provider-accounts-and-credential-homes.md#vendor-authentication-policy-constraints) |
| Claude provider-wire pin | Primary research (binary) | The non-interactive token's fixed one-year horizon, its absence of a refresh handle, its documented consumption variable, and the observed authentication-mode value the CLI reports under it — all **Verified** and version-fragile. | [Provider Wire Reference §claude](../reference/provider-wire/claude.md) |
| Codex provider-wire pin | Primary research (source) | The first-party login-start arms returning either an authorization URL or a device code with its verification URL, the login-cancel arm, and the single-active-login constraint that D1's refusal shape mirrors. | [Provider Wire Reference §codex](../reference/provider-wire/codex.md) |
| ADR-020 credential store | Repo (decision) | The local-secret mechanism — each secret its own OS credential-store item verified by write-probe-read-delete, the `0600` file on Linux with no Secret Service, and a loud refusal for a store that cannot take it — whose store and refusal D2 uses. | [ADR-020](./020-cli-identity-key-storage-custody.md) |
| Codex API-key custody probe, codex-cli 0.156.0 | Primary research (binary and source) | With `cli_auth_credentials_store="ephemeral"`, an `apiKey` login is accepted in 0.025 s, no `auth.json` is written and a byte search of the home finds nothing; in `file` mode Codex writes `OPENAI_API_KEY` in plain text; a restarted service answers no account; the source's `Ephemeral` store is an in-process map. | `openai/codex` `rust-v0.156.0`, `codex-rs/login/src/auth/storage.rs` |
| Claude Code setup-token channel probe, 2.1.282 | Primary research (binary) | A token delivered on `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` authenticates the process and is absent from every child's environment. | [Provider Wire Reference §claude](../reference/provider-wire/claude.md) |
| Provider Failure Runbook step 7 | Repo (operations) | The per-account re-authentication step, which D1's brokered sign-in (`providerAccount.login`) makes executable. | [Provider Failure Runbook §Provider Re-Authentication (Per Account)](../operations/provider-failure-runbook.md#provider-re-authentication-per-account) |

### Related ADRs

- [ADR-020: Machine Identity Key Custody](./020-cli-identity-key-storage-custody.md) — supplies the keystore and the refusal D2 stores through; this decision adds a consumer, not a mechanism
- [ADR-012: Cedar Approval Policy Engine](./012-cedar-approval-policy-engine.md) — the policy engine the account verbs mint no action in, because the asking device and never a session authorizes them; no `ApprovalCategory` value is added
- [ADR-016: Shared Event Sourcing Scope](./016-shared-event-sourcing-scope.md) — the provider-account registry remains un-evented; the sign-in broker's completion travels a wire notification, never a durable session event
- [ADR-014: V1 Feature Scope Definition](./014-v1-feature-scope-definition.md) — no feature is added to the V1 set; this decision changes the credential posture of provider accounts, which already exist

### Related Specs And Plans

- [Spec-025: Provider Accounts And Credential Homes](../specs/025-provider-accounts-and-credential-homes.md) — the provider accounts whose credential custody this record sets
- [Plan-023: Provider Accounts And Credential Homes](../plans/023-provider-accounts-and-credential-homes.md) — the implementing plan
- [Spec-024: MCP Server Configuration And Governance](../specs/024-mcp-server-configuration-and-governance.md) — the same no-custody rule at MCP-server scope. Its §Non-Goals bullet is scoped to material belonging to an MCP server, as that spec's own [Plan-022 I-022-1](../plans/022-mcp-server-configuration-and-governance.md#i-022-1--credential-custody-is-exactly-what-adr-038-records) scopes it, so it does not contradict D2's bounded provider-account custody. The daemon's custody of MCP-server credentials is exactly what [ADR-038](./038-mcp-credential-custody.md) records, and nothing here widens it
- [Spec-021: Desktop App And Renderer](../specs/021-desktop-app-and-renderer.md) — the provider-management view that surfaces both legs
