# ADR-028: Provider Credential Custody Posture

| Field         | Value                                        |
| ------------- | -------------------------------------------- |
| **Status**    | `accepted`                                   |
| **Type**      | `Type 2 (one-way door)`                      |
| **Domain**    | Auth, Provider Execution, Credential Custody |
| **Date**      | 2026-08-26                                   |
| **Author(s)** | Claude (AI-assisted)                         |
| **Reviewers** | Repository owner (ratified)                  |

> **Type guidance:** Type 2. The decision below takes the daemon from "never holds provider credential material, under any condition" to "holds exactly one narrowly-defined class of it." An absolute, once broken, is not restorable by deleting code: every later contributor reads the corpus as permitting custody-with-conditions and argues at the boundary rather than against the rule. All sections completed.

---

## Context

[Spec-029](../specs/029-provider-accounts-and-credential-homes.md) specifies a node-local provider-account plane: one registry row per account, an isolated credential home per account, fail-closed validation before every spawn, and a readiness projection that tells the operator which provider is not ready and what to do about it. It inherited a **no-token-custody** posture from [Spec-028 §Non-Goals](../specs/028-mcp-server-configuration-and-governance.md#non-goals) — whose bullet omitted the MCP-plane scope its own [Plan-028 I-028-1](../plans/028-mcp-server-configuration-and-governance.md#i-028-1--no-credential-custody) already carried, and so read as daemon-general — and restated it as an absolute across five surfaces: §Non-Goals ("The daemon never persists, logs, relays, or serves credential material"), §Vendor authentication-policy constraints ("there is **no field anywhere on this plane's wire into which an operator could paste a provider token**"), §Fallback Behavior (no environment-variable credential override), §Pitfalls To Avoid, and the `api-payload-contracts.md` §Plan-029 registry NOTE ("There is no token field to omit here — there is no token"). This record's swap bounds the first of those five on the provider-account plane and restores the MCP-plane scope of the Spec-028 bullet they descend from; the other four are restated or bounded by the Spec-029 amendment that rides this swap.

That posture was chosen against a published vendor policy. Anthropic's legal-and-compliance page states that developers "may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow", and separately carves out that the policy does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription", conditioned on the binary not being modified and on no resale or intermediation. The absolute was the conservative reading: hold nothing, and the intermediation clause cannot be reached.

Two operational facts have since been established against the pinned binaries and are recorded at **Verified** trust in [Provider Wire Reference §claude](../reference/provider-wire/claude.md) and [§codex](../reference/provider-wire/codex.md):

1. Both providers ship a **first-party interactive sign-in flow inside the unmodified binary**, and both surface the material an operator needs to complete it out of band — Codex's app-server returns an authorization URL or a device code and user code from its login-start request; Claude Code's CLI prints a URL and accepts a pasted code. Neither flow requires anything but the binary and a pinned credential home.
2. Anthropic documents a **long-lived non-interactive token** minted by its own CLI subcommand, explicitly "for CI pipelines, scripts, or other environments where interactive browser login isn't available", consumed by the unmodified binary through a documented environment variable, carrying no refresh token and a fixed one-year horizon.

The absolute forbids using either. It forbids the first because a strict reading of "the daemon never … relays … credential material" arguably covers relaying a verification URL, and because the landed sign-in remedy is display-only ("the daemon never executes it"). It forbids the second outright. The result is a headless or no-TTY node that can register an account it can never authenticate, and an operator whose only remedy is to leave the product.

## Problem Statement

What posture should the daemon take toward provider credential material: keep the inherited absolute and accept that a headless node cannot be authenticated, or define a bounded custody rule and pay for it with the loss of an absolute?

### Trigger

Two concrete gaps, both already recorded in the corpus rather than hypothesized here:

- [Spec-029 §Fallback Behavior](../specs/029-provider-accounts-and-credential-homes.md#fallback-behavior)'s headless arm currently terminates in "print the remedy and refuse", with the environment-variable override explicitly named and rejected. There is no path from that state to a working node without a second machine.
- [Provider Failure Runbook §Provider Re-Authentication (Per Account)](../operations/provider-failure-runbook.md#provider-re-authentication-per-account) step 7 instructs the operator to "Re-authenticate the provider CLI into that account's own credential home" and names **no command and no surface** — because none exists. The runbook step is unexecutable as written.

Spec-029 §ADR Triggers names this decision explicitly: "Taking custody of provider credential material — storing, relaying, or serving it — would reverse the inherited no-token-custody posture and requires an ADR, not an amendment." This is that ADR.

---

## Decision

**We will replace the daemon's absolute no-token-custody posture with two bounded rules: the daemon MAY broker interactive sign-in by executing the provider's own unmodified first-party flow against a pinned credential home without reading its result, and the daemon MAY take custody of exactly one class of operator-supplied credential material — a provider-documented long-lived non-interactive token — sealed through the [ADR-021](./021-cli-identity-key-storage-custody.md) custody ladder and injected only into the child environment of processes bound to that account.**

The two rules are stated separately because only one of them is a reversal.

**D1 — Brokered interactive sign-in is not custody.** The daemon constructs and spawns the provider's own sign-in invocation, with that account's credential home pinned through the provider's reserved environment variables, and forwards to the caller only the verification material the provider itself emits for the operator to act on — an authorization URL, or a device code and its verification URL. The daemon does not read, parse, copy, cache, relay, or persist the credential the flow writes. The credential is written by the provider's own tooling into the provider's own store inside that home, exactly as it would be had the operator run the command themselves. Sign-in completes through the vendor's own flow, in the vendor's unmodified binary; the daemon supplies a working directory and a terminal, and learns nothing.

**D2 — Bounded token custody, one class only.** The daemon MAY accept a provider-minted long-lived non-interactive token from the operator through an explicit, non-echoing input, seal it through the ADR-021 ladder, and inject it into the child environment of exactly two invocations: a **registration-time observation** — a single non-interactive status invocation, spawned with no model-directed code in it, whose only purpose is to let the daemon _observe_ the authentication mode rather than assume it — and, where condition 5 is met, provider processes bound to that account. The class is bounded by **five** conjunctive conditions, and material failing **any** of them is refused:

1. The token is minted by the **provider's own tooling** for the operator's own account, through a subcommand the provider documents for this purpose. The daemon never mints, exchanges, refreshes, or derives credential material, and never speaks an OAuth token endpoint.
2. The provider **documents the variable** by which its unmodified binary consumes it. The daemon injects into a documented consumption path; it does not invent one.
3. The token is **non-interactive by construction** — it carries no refresh token, so possession of it grants no ability to mint successors, and its compromise expires on the provider's own fixed horizon rather than being renewable by the holder.
4. The operator **supplies it deliberately**, through an input that exists for this and nothing else, and that never echoes, logs, or renders the value.
5. The **consuming process runs no model-directed code**, or the provider is shown to strip the variable from the environment of every tool, shell, and subagent subprocess it spawns. This condition is not satisfied by conditions 1–4 and was added 2026-08-26 after review: a bearer token placed in the environment of a process that executes model-generated commands is readable by an `env` dump the model itself can issue, which defeats every wire and log redaction on this plane. The exposure is **not** the vendor's documented posture — there a human exports a token for their own run and no untrusted code executes inside that environment, whereas the daemon's run child executes model-directed tools by design, so this is a risk the daemon creates rather than one it inherits. Until the strip behavior is **observed** on a provider leg (not assumed from documentation), that leg admits the class **only** for a non-model-executing invocation — the registration-time observation below — and **refuses** run-bound injection. [D1](#decision) remains available there, which is the fallback this record already contemplates.

**Everything outside those two rules stays refused.** The daemon does not read a provider's credential store; does not copy credential material between homes; does not place credential material on any event, error, log, metric, or wire payload; does not accept a token as a general-purpose credential override on run start or in configuration; and does not accept interactively-minted session credentials, refresh tokens, or cookies in any form.

### Thesis — Why This Option

**D1 is what the vendor carve-out describes.** The carve-out permits "an end user … signing in to the unmodified Claude Code binary with their own Claude subscription", conditioned on the binary not being modified and on no resale or intermediation. Spawning the shipped binary with `HOME`-class variables pointed at a directory satisfies the first condition literally — nothing is patched, no authentication method is removed, disabled, or restricted, and the flow the operator sees is the vendor's. It satisfies the second because there is no third party: the operator, their own subscription, and their own machine. The intermediation clause bars _collecting, storing, or intermediating_ the credential; D1 does none of the three, and the sign-in does complete through the vendor's flow. D1 is therefore not a reversal of the no-custody posture at all — it is the posture, applied to a flow the corpus had only ever described as display-only.

**D2's class is the one the vendor built for this.** Anthropic did not merely leave a token-shaped hole; it ships a subcommand whose stated purpose is "CI pipelines, scripts, or other environments where interactive browser login isn't available" and a documented variable for consuming it. Refusing to support the vendor's own non-interactive authentication path, in the name of a policy clause about _intermediating claude.ai sign-in_, reads the clause past what it says. Condition 1 keeps the daemon out of the minting path entirely, which is where the intermediation clause actually bites.

**Condition 3 is what makes the blast radius bounded rather than open-ended.** A refresh token is a renewable capability: a holder can mint successors indefinitely, so custody of one is custody of the account. The class D2 admits carries no refresh token — verified against the pinned binary, which hardcodes the refresh handle to null on this path — so a leaked token is a bounded-lifetime bearer credential that expires on the provider's clock and cannot regenerate itself. That is a materially smaller thing to hold than what the absolute was written to prevent, and the distinction is structural rather than procedural.

**The ladder already exists and is already ratified.** [ADR-021](./021-cli-identity-key-storage-custody.md) settled how this repository stores a local secret: the OS keystore first, verified by a write-probe-read-delete rather than assumed available; an Argon2id-encrypted file second; a loud refusal third, never a silent plaintext fallback. D2 adds a **consumer** of that ladder, not a mechanism. No new cryptography is designed, and the storage question was answered before this ADR existed.

**Storing outside the credential home is the same posture, applied consistently.** Spec-029 §Non-Goals states the daemon "claims no ownership over the bytes inside a home", and §Pitfalls To Avoid forbids a design that "reads, copies, caches, or transports the material inside a home". Writing a daemon-held secret into the home would put daemon-owned bytes in provider-owned space and make the two indistinguishable to a future reader. The sealed value therefore lives in daemon-owned state, keyed by `accountId`, and reaches the provider only as an environment variable on a child process — the one place it must exist for the vendor's binary to consume it.

### Antithesis — The Strongest Case Against [T2]

A skeptical staff engineer blocks this PR on six grounds.

**1. The clause says "store", and D2 stores.** "Developers may not collect, store, or intermediate Claude.ai credentials or session tokens." A token minted by `claude`'s own subcommand, bearing an `sk-ant-oat` prefix, authenticating against Anthropic's inference API on a Claude subscription, is a Claude credential by any reading a lawyer would apply. The thesis's move — that the clause is "about intermediating sign-in" — is doing work the text does not support: sign-in intermediation is the _third_ verb, and collecting and storing are the first two, stated independently. Condition 1 keeps us out of the minting path, which addresses "intermediate" and leaves "collect" and "store" squarely violated. We are choosing the reading that lets us ship.

**2. The absolute was load-bearing precisely because it was absolute.** Five corpus surfaces state it without qualification, and one of them — the `api-payload` registry NOTE — states it as a property of the _wire shape_ ("there is no token field to omit here — there is no token"), which is the kind of claim a reviewer can check mechanically. Replacing it with a four-condition rule replaces a mechanically-checkable invariant with a judgment call, and judgment calls decay. The next contributor arrives with a token that satisfies three of four conditions and a deadline, and the argument is no longer "no" — it is a negotiation about condition 3.

**3. Condition 3 is a property of today's binary, not of the class.** "Carries no refresh token" was read out of one build of one provider's minified bundle. A vendor is free to give the same subcommand a renewable token next release, and nothing in our system would notice: we would keep injecting it, keep calling the posture bounded, and the boundedness would be silently false. An invariant that depends on an undocumented, version-fragile property of a vendor artifact is not an invariant.

**4. D1 contradicts landed, reviewed text.** The `signInInvocation` remedy shipped ten days ago (2026-08-25, §6 node NS-77) with an explicit rationale: "the daemon never executes it, and this is not a shell string a client is invited to run on the operator's behalf". Plan-029's own §Notes carries a dated record titled "Why no login verb was minted." Reversing a design that was reasoned, reviewed, and merged inside a fortnight is evidence that the original reasoning was not actually load-bearing — or that this one is not.

**5. Executing a sign-in flow makes the daemon a credential-handling component whether or not it reads bytes.** A spawned child writing a credential into a directory the daemon created, chose, and can read is custody in the security sense that matters: the daemon has ambient filesystem authority over the material. "We do not read it" is a policy the code follows today, enforced by nothing, and every later feature that needs "just the expiry" or "just the account email" will read it.

**6. This is a bad trade against the actual gap.** The headless case has a working answer that costs nothing: sign in on a machine with a browser, and put the credential home on the headless machine. The gap D2 closes is convenience, and we are spending an absolute on it.

### Synthesis — Why It Still Holds [T2]

**On (1) — the clause says "store."** This is the strongest objection and it is **accepted as a residual, not rebutted**. D2 does store a Claude credential, and the reading under which that is permissible — that the clause's subject is claude.ai account sign-in and session tokens, and that a vendor-minted non-interactive token consumed by the vendor's own binary through the vendor's own documented variable is the vendor sanctioning that exact flow — is a reading, not a certainty. What moves the decision is that the alternative reading condemns the vendor's own documented CI path as unusable by any tool but a hand-written shell script, and that the operator here is the account holder storing their own credential on their own machine, which is the fact pattern the carve-out exists to protect. The residual is recorded in §Failure Mode Analysis with a detection signal and a defined retreat, and D2 is scoped so that the retreat is cheap: one input, one sealed value, one environment injection, all behind a single feature boundary.

**On (2) — the absolute was mechanically checkable.** Correct, and the replacement is written to stay mechanically checkable rather than to become a judgment call. The four conditions are not a balancing test: they are conjunctive, and three of them are checkable without judgment (is the value one the provider's own tooling minted; is the consumption variable one the provider documents; did it arrive on the dedicated input). The corpus surfaces are amended to state the **new** absolute in the same mechanically-checkable register: exactly one wire input accepts credential material, it is named, it is write-only, and every other surface still carries none. A reviewer can still grep. What changes is the string they grep for.

**On (3) — condition 3 depends on a vendor artifact.** Accepted and mitigated rather than dismissed. The condition is restated in the specification as a **property the daemon must observe, not assume**: the account's observed authentication mode is recorded on the registry row, the token class is admitted only under that recorded mode, and the surface renders the expected re-login horizon as an **estimate** rather than a fact. If a vendor makes the token renewable, that is a change in the vendor's contract. **It is not caught by the nightly provider-CLI compatibility check** — that job's token leg observes only that a secret is present and that one bounded turn executes, neither of which inspects token shape (corrected 2026-08-26 after review, having been asserted here and at four other sites). Detection is therefore not a watch but an **enforced pin**: the class is admitted only on provider versions whose refresh-token absence has been re-verified first-party and recorded in the provider-wire reference, and **fail-closed spawn validation refuses the token class on any other version**, so an unverified upgrade disables the class instead of silently widening it. The honest position, recorded here: condition 3 is **Verified against pinned binaries and version-fragile**, exactly like every other provider-wire fact this corpus depends on, and it is governed by the same machinery.

**On (4) — D1 contradicts landed text.** It narrows it; it does not contradict it. The landed sentence refuses to execute **a shell string the daemon received**, and the reason given is that a client must not be able to hand the daemon a command to run on the operator's behalf. That reason is untouched: `signInInvocation` remains display-only, and no client-supplied string is ever executed. What D1 adds is a daemon-**constructed** invocation of a binary the daemon already spawns on every run, with arguments the daemon authors, against a home the daemon owns. The dated §Notes record stays in place with a superseding pointer, per the corpus's provenance rule — the original reasoning was correct for the surface it governed (first-run readiness needed no login verb), and this decision governs a different surface (an operator administering accounts on a node that may have no browser).

**On (5) — ambient filesystem authority is custody in the security sense.** Accepted as an accurate description, and it is why D1 is specified with a **stated non-goal that is enforced by the shape of the code rather than by discipline**: the sign-in broker returns the provider's verification material and a completion outcome, and has no read path into the home at all. The concern that "every later feature will read it" is real and is answered structurally — the registry row already carries the observed authentication mode, the observation timestamp, and the expected horizon as **daemon-authored columns**, so the features that would otherwise reach into the home have a first-class place to read from. Where a fact genuinely is not available without opening a credential file, the specification's answer is honest absence, not a read.

**On (6) — the headless case has a workaround.** It has a workaround that requires a second machine, a file copy of credential material between hosts (which is a worse custody story than anything in D2), and re-doing it on every credential rotation. More decisively, the workaround does not address the _other_ trigger: the runbook's re-authentication step is unexecutable on **every** node, headless or not, because no surface exists to re-authenticate an account from. D1 alone closes that, and D1 is not the reversal. The trade is not "an absolute for convenience" — it is "an absolute for a working re-authentication path", with D2 as the bounded tail case for nodes that cannot run an interactive flow at all.

---

## Alternatives Considered

### Option A: Brokered sign-in plus bounded token custody (Chosen)

- **What:** D1 and D2 above. The daemon executes the vendor's own sign-in flow against a pinned home and reads nothing; separately, it accepts exactly one class of vendor-minted non-interactive token through a dedicated no-echo input, seals it through the ADR-021 ladder, and injects it into that account's child environment only.
- **Steel man:** It closes both triggers with the smallest surface that can close them; it takes the custody step only for the case that has no other answer; the class it admits is the one the vendor documents for exactly this purpose and is structurally bounded by carrying no refresh token; and the storage mechanism was already ratified, so the decision adds a consumer rather than a mechanism.
- **Weaknesses:** It stores a provider credential, which a plain reading of the vendor's clause forbids (accepted residual, §Synthesis (1)). Its boundedness rests on a version-fragile property of a vendor artifact (mitigated by observation and the enforced version pin, not by the nightly compatibility check, §Synthesis (3)). It gives the daemon ambient filesystem authority over credential homes it creates (accepted, mitigated structurally, §Synthesis (5)).

### Option B: Keep the absolute (Rejected)

- **What:** Change nothing. Headless and no-TTY nodes cannot authenticate; the runbook's re-authentication step stays unexecutable; operators sign in on a machine with a browser and move the credential home themselves.
- **Steel man:** The absolute is the only posture that cannot be argued at the margin, and margins are where credential handling fails. It is trivially auditable — a reviewer greps for a token field and finds none. It carries zero legal exposure under any reading of the vendor clause, which matters disproportionately because the downside is not a bug but account termination for the operator. It costs nothing to maintain, and the workaround, while inconvenient, genuinely works: a credential home is a directory, and directories are copyable. Most importantly, every argument for crossing this line is an argument about convenience, and convenience arguments are exactly the ones that should lose to an absolute in a security posture.
- **Why rejected:** It leaves a documented operator procedure unexecutable on every node, not just headless ones — the runbook step names a re-authentication that no surface provides. And the workaround it relies on is not neutral: copying a credential home between hosts moves live credential material across machines by hand, with no sealing, no per-account isolation guarantee at the destination, and no audit — a strictly worse custody outcome than D2, arrived at by refusing to name custody. The absolute stops the daemon from holding a bounded token and pushes the operator into holding an unbounded one badly. Note that Option B remains available for D2 alone: D1 closes the runbook trigger by itself, and if the §Failure Mode Analysis detection signal for the vendor-policy residual fires, D2 retreats to Option B without D1 moving.

### Option C: Broker sign-in only; refuse all token custody (Rejected)

- **What:** Adopt D1, reject D2. The daemon executes the vendor's interactive flow and surfaces the verification URL or device code, including on headless nodes where the operator completes the flow on a phone or another machine.
- **Steel man:** This closes the runbook trigger, closes most of the headless case (device-code flows are specifically designed for hosts without a browser — the operator reads a code off the terminal and enters it elsewhere), and does it all **without reversing the no-custody posture at all**. Every corpus absolute survives. The `api-payload` NOTE stays literally true. It is strictly the least-cost option that solves the named problem, and the residual it leaves — a provider whose CLI offers no device-code flow on a host with no browser — is narrow and may close on its own as vendors converge on device-code support.
- **Why rejected:** It is the right answer for one provider and not the other, and the difference is verified rather than assumed: the Codex leg publishes a device-code login arm returning a verification URL and user code, while the pinned Claude leg's documented non-interactive path is the minted token, not a device code. Option C therefore leaves the Claude leg with no headless path at all — the exact gap that prompted the decision — while spending the full design cost of the sign-in broker. It also strands the class of node that has no interactive operator present at any point, which is a real deployment shape for this product. Adopted in part: D1 **is** Option C, and it is specified so that it stands alone if D2 is later retreated.

### Option D: General environment-variable credential override (Rejected)

- **What:** Let the operator supply any provider credential through configuration or a run-start flag, and pass it through to the child process.
- **Steel man:** It is the simplest possible implementation, it needs no storage decision at all (the value lives in the operator's own environment or configuration file), it composes with every existing secret-management tool the operator may already run, and it makes no claim about what the credential is — which means it never becomes wrong when a vendor changes token semantics.
- **Why rejected:** [Spec-029 §Fallback Behavior](../specs/029-provider-accounts-and-credential-homes.md#fallback-behavior) already rejected it, and the rejection holds under this ADR: an unbounded override accepts refresh tokens, session cookies, and interactively-minted credentials indistinguishably from the bounded class, which is precisely the intermediation the vendor clause bars. It also defeats the account plane — a credential arriving out-of-band belongs to no registered account, so nothing keys spend, quota, or the attention epoch to it. D2 is deliberately narrower on all four conditions.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | The vendor's carve-out permits an end user signing in to the unmodified binary with their own subscription, and spawning that binary with a pinned home meets its conditions. | Vendor legal-and-compliance page, quoted in [Spec-029 §Vendor authentication-policy constraints](../specs/029-provider-accounts-and-credential-homes.md#vendor-authentication-policy-constraints) at **Documented** trust. | D1 falls. The sign-in broker is withdrawn and the corpus returns to the display-only remedy; the runbook trigger reopens. |
| 2 | A vendor-minted non-interactive token consumed by the vendor's own binary through the vendor's own documented variable is not the credential intermediation the clause bars. | **Unvalidated — this is a reading, not a fact.** Recorded as an accepted residual in §Synthesis (1) and as the first row of §Failure Mode Analysis. | D2 falls back to Option B. The token input, the sealed store, and the injection are removed; D1 and the account plane are untouched. |
| 3 | The admitted token class carries no refresh token, so possession grants no ability to mint successors. | Verified against the pinned binary and recorded at **Verified**, version-fragile, in [Provider Wire Reference §claude](../reference/provider-wire/claude.md). | The class stops being bounded. Custody becomes custody of the account, and the blast radius argument in §Thesis fails. Detected by the nightly provider-CLI compatibility check; the response is to refuse the class until re-assessed. |
| 4 | The OS keystore is reachable on the platforms this ships to, or the encrypted-file tier is acceptable where it is not. | [ADR-021](./021-cli-identity-key-storage-custody.md), already `accepted`, with a tier-1 write-probe-read-delete verification rather than an availability assumption. **Partially unvalidated, and the gap is named rather than assumed away**: the tier-1 verification proves a keystore _answers_, not that it _persists_. The Linux binding is documented to fall back silently to an in-memory kernel keyring that is lost at reboot, and exposes no backend-introspection API, so a write-probe-read-delete **passes** against a store that will be empty tomorrow. A durability probe distinct from the availability probe is therefore owed on that platform. | The token survives one boot and vanishes. The failure is recoverable (the operator re-supplies) but it presents as an unexplained re-authentication demand rather than as a storage fault, so the mitigation is to detect and say so — refuse or degrade explicitly on a non-durable backend — rather than to write and hope. ADR-021's third tier is a loud refusal, so the one thing that cannot happen is a silent plaintext write. |
| 5 | An operator supplying a token is the account holder supplying their own credential on their own machine. | The plane is node-local by construction: [Spec-029 §Non-Goals](../specs/029-provider-accounts-and-credential-homes.md#non-goals) forbids control-plane account records, and every mutating verb is gated on node-operator authority (I-029-1). | The "each end user authenticates with their own credential" constraint is violated. Mitigated structurally: there is no surface by which one participant's token could reach another's node, because accounts never leave the node. |

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The vendor reads its own clause as barring D2 — assumption 2 is wrong. | Med | High | A vendor policy revision naming third-party token storage; a support or enforcement response to an operator; the vendor withdrawing the non-interactive subcommand. | Retreat D2 to Option B. The retreat is one input, one sealed store, one injection — D1 and the whole account plane stand. Every corpus surface amended here names D2 separably for exactly this reason. |
| The vendor makes the non-interactive token renewable — assumption 3 is wrong. | Med | High | **Not** the nightly compatibility check — its token leg inspects no token shape. Fail-closed spawn validation refuses the class on any provider version whose refresh-token absence is not first-party re-verified and recorded, so an unverified upgrade trips the refusal. | Refuse the class on the affected provider until re-assessed. The registry records the **observed** authentication mode per account, so the affected rows are enumerable rather than needing a fleet-wide assumption. |
| A sealed token leaks — from the keystore, the encrypted file, a crash dump, or a log. | Low | Med | Provider-side anomalous-use signals; the account's observed authentication state changing without an operator action. | Bounded by construction: no refresh token, so the leak expires on the provider's fixed horizon and cannot regenerate. The operator's remedy is to revoke at the provider and re-supply. No logging path may render the value. |
| A later contributor widens D2's four conditions incrementally until it is a general credential override. | Med | Med | Code review against the conjunctive condition list; the corpus's own count-claim discipline on the wire-input census. | The conditions are conjunctive and stated in the spec's normative voice, and the wire-input census names exactly one credential-accepting input. Widening it moves a counted claim, which the corpus's review discipline surfaces. |
| D1's "reads nothing" becomes false as a later feature needs a fact from inside the home. | Med | Med | Review of any new read path into a credential home; the §Pitfalls prohibition is retained verbatim. | The registry row carries the daemon-authored facts (observed mode, observation time, expected horizon) that such a feature would otherwise reach into the home for. Where a fact is unavailable, the answer is honest absence. |

## Reversibility Assessment

- **Reversal cost:** D2 — days. One wire input arm, one sealed-storage consumer, one environment-injection branch, one registry column value, and the corpus prose that names them. D1 — weeks, because the sign-in broker, its verification-material surface, and its clients would be withdrawn together. **The reputational and precedential reversal of D2 is not recoverable at any cost**: once the corpus has said "the daemon may hold credential material under conditions", deleting the code does not restore the absolute.
- **Blast radius:** The provider-account plane (Spec-029/Plan-029), the desktop provider-management view and CLI verbs that surface it, the readiness projection consumed by first-run onboarding, and the PII data map. No control-plane surface is touched — accounts are node-local, and this decision does not widen that.
- **Migration path:** To retreat D2: refuse the token input, mark affected accounts as requiring interactive re-authentication through D1's broker, shred sealed values from the keystore or encrypted file, and restore the corpus's token-absence claims to their pre-2026-08-26 wording. Accounts authenticated interactively are unaffected. To retreat D1 as well: restore the display-only remedy and reopen the runbook trigger.
- **Point of no return:** The moment the first sealed token is written on an operator's machine. Before that, this is prose; after it, retreat requires shredding material we told operators we would hold. This is the trigger to re-evaluate, and it sits at the token leg's first shipped code — not at this ADR's acceptance.

## Consequences

### Positive

- The runbook's re-authentication step becomes executable, on every node rather than only on nodes with a browser.
- A headless or no-TTY node can be authenticated without hand-copying credential material between hosts — which is a better custody outcome than the workaround it replaces, not merely a more convenient one.
- The daemon's relationship to credential material becomes **stated** rather than absolute-and-therefore-unexamined: four conditions a reviewer can check, one named input, one sealed store, one injection point.
- The custody mechanism is ADR-021's ratified ladder, so no new cryptography is designed and the OS keystore is used where it exists, verified rather than assumed.

### Negative (accepted trade-offs)

- **The absolute is gone, permanently.** Every later credential-custody question is now a boundary argument rather than a refusal. Accepted because the absolute was already forcing a worse real-world custody outcome (§Alternatives, Option B).
- **A plain reading of the vendor's clause is violated by D2.** Accepted with a named detection signal and a cheap, pre-specified retreat (§Failure Mode Analysis row 1). This is the single largest accepted risk in this record.
- **The boundedness of the admitted class depends on a version-fragile vendor property.** Accepted, mitigated by observing rather than assuming the authentication mode, and governed by an enforced version pin refused at spawn rather than by the nightly compatibility check, which inspects no token shape, unlike the corpus's other provider-wire facts.
- **The daemon holds ambient filesystem authority over credential homes it creates.** Accepted; it already did, since it creates and pins those homes for every run.
- **The encrypted-file tier cannot use the platform's fastest primitives on every surface.** Recorded here because no other document does, and a later contributor optimizing toward Node core would break the desktop surface silently: the desktop daemon runs inside Electron's bundled runtime, which links BoringSSL rather than OpenSSL, and there core's Argon2 binding is present-but-throwing while ChaCha20-Poly1305 is absent from the cipher list entirely — neither is version-gated, so neither is fixed by raising the Node floor. The portable primitives are the audited pure-JS ones this repository already depends on, and the tier is built on those rather than on `node:crypto`.

### Unknowns

- Whether the second provider will ship an equivalent documented non-interactive token path, which would let D2's conditions apply symmetrically instead of being exercised on one leg.
- Whether the observed authentication mode is stable enough across vendor releases to be a reliable admission gate, or whether it needs a re-observation cadence tighter than the health observer's.

---

## Decision Validation [T2]

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan — assumption 2 is flagged unvalidated with a detection signal and a defined retreat; assumption 3 is assigned to an enforced version pin refused at fail-closed spawn validation, the nightly check having been verified 2026-08-26 to inspect no token shape.
- [x] At least one alternative was seriously considered and steel-manned — Options B, C, and D, with Option C adopted in part as D1.
- [x] Antithesis was reviewed by someone other than the author — reviewed at ratification; the six-point antithesis is answered point-by-point in §Synthesis, with points 1, 3, and 5 accepted as residuals rather than rebutted.
- [x] Failure modes have detection mechanisms — five scenarios, each with a named signal.
- [x] Point of no return is identified and communicated — the first sealed token written on an operator machine, stated in §Reversibility Assessment.

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Credential material appearing on any event, error, log, metric, or wire **output**, or on any wire input other than the single named registration input | 0 | The no-credential-payload assertions on the provider-account contract surfaces, run against every response, notification, and error type plus every request except `providerAccount.register` | At the sign-in broker's first shipped PR |
| Wire inputs accepting credential material | Exactly 1, named | The wire-input census on `api-payload-contracts.md` §Plan-029 | Every PR touching that section |
| Accounts whose observed authentication mode is recorded rather than assumed | 100% of accounts that have been observed once | The registry column, non-NULL exactly when an observation exists | At the token leg's first shipped PR |
| Vendor-policy residual (assumption 2) unrealized | No enforcement or policy signal | Nightly provider-CLI compatibility check plus vendor policy-page revision date | Ongoing |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Anthropic legal and compliance policy | Vendor documentation | The unmodified-binary carve-out and its conditions; the "collect, store, or intermediate" clause that D2's residual sits against. Already recorded at **Documented** trust in Spec-029. | [Spec-029 §Vendor authentication-policy constraints](../specs/029-provider-accounts-and-credential-homes.md#vendor-authentication-policy-constraints) |
| Claude provider-wire pin | Primary research (binary) | The non-interactive token's fixed one-year horizon, its absence of a refresh handle, its documented consumption variable, and the observed authentication-mode value the CLI reports under it — all **Verified** and version-fragile. | [Provider Wire Reference §claude](../reference/provider-wire/claude.md) |
| Codex provider-wire pin | Primary research (source) | The first-party login-start arms returning either an authorization URL or a device code with its verification URL, the login-cancel arm, and the single-active-login constraint that D1's refusal shape mirrors. | [Provider Wire Reference §codex](../reference/provider-wire/codex.md) |
| ADR-021 custody ladder | Repo (canonical decision) | The ratified three-tier local-secret mechanism — OS keystore verified by write-probe-read-delete, Argon2id-encrypted file, loud refusal — which D2 consumes rather than replacing. | [ADR-021](./021-cli-identity-key-storage-custody.md) |
| Provider Failure Runbook step 7 | Repo (canonical operations) | The re-authentication step names no command and no surface, because none exists — the trigger D1 closes. | [Provider Failure Runbook §Provider Re-Authentication (Per Account)](../operations/provider-failure-runbook.md#provider-re-authentication-per-account) |

### Related ADRs

- [ADR-021: CLI Identity Key Storage Custody](./021-cli-identity-key-storage-custody.md) — supplies the custody ladder D2 stores through; this decision adds a consumer, not a mechanism
- [ADR-012: Cedar Approval Policy Engine](./012-cedar-approval-policy-engine.md) — the authorization engine the new operator-authority verbs evaluate against; no `ApprovalCategory` value is added
- [ADR-017: Shared Event Sourcing Scope](./017-shared-event-sourcing-scope.md) — the provider-account registry remains un-evented; the sign-in broker's completion travels a wire notification, never a durable session event
- [ADR-015: V1 Feature Scope Definition](./015-v1-feature-scope-definition.md) — no feature is added to the V1 set; this decision changes the posture of an existing plane

### Related Specs And Plans

- [Spec-029: Provider Accounts And Credential Homes](../specs/029-provider-accounts-and-credential-homes.md) — the plane whose §ADR Triggers required this record
- [Plan-029: Provider Accounts And Credential Homes](../plans/029-provider-accounts-and-credential-homes.md) — the implementing plan
- [Spec-026: First-Run Onboarding](../specs/026-first-run-onboarding.md) — deliberately **untouched on both axes**, and the second axis is worth stating because only the first is obvious. **Token axis (D2):** token supply is excluded from the onboarding flow, so that spec's "no field, flag, or environment variable anywhere in this flow" statement remains true as written — and its Group-B headless bullet's rationale survives too, because the bounded rule still bars credential material on every input except the single named one, and onboarding's inputs are not it. **Login axis (D1):** D1 mints verbs that run a provider's login binary, and Spec-026's Group-B sign-in control states that the flow "displays the invocation and never runs it on the operator's behalf". That control is deliberately **not** rewired here: onboarding continues to hand off and re-probe, and the brokered verbs are reached from the provider-management surface rather than from the first-run flow. An implementer of Plan-026's provider step reads its "the corresponding `providerAccount.*` verb" instruction as excluding `providerAccount.login` / `providerAccount.loginCancel`
- [Spec-028: MCP Server Configuration And Governance](../specs/028-mcp-server-configuration-and-governance.md) — the doc this record's §Context names as the posture's origin. Its §Non-Goals bullet took an **erratum-class** scope restoration in this swap, because the sentence as written ("the daemon never persists, logs, relays, or serves credential material") was daemon-general while that spec's own [Plan-028 I-028-1](../plans/028-mcp-server-configuration-and-governance.md#i-028-1--no-credential-custody) already scoped the identical rule to material belonging to an MCP server. The bullet now carries that scope, so it no longer contradicts D2's bounded provider-account custody. This is a restoration, not a widening: the MCP plane's guarantee is unchanged, no Status moves, and a proposal to store MCP credential material still requires its own ADR, exactly as that spec's §ADR Triggers demands
- [Spec-023: Desktop Shell And Renderer](../specs/023-desktop-shell-and-renderer.md) — the provider-management view that surfaces both legs

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-08-26 | Drafted and ratified — `accepted` | Required by [Spec-029 §ADR Triggers](../specs/029-provider-accounts-and-credential-homes.md#adr-triggers). Lands `accepted` on the user's prior ratification of the token-mode decision, so Plan-029's §Preconditions "Required ADRs are accepted" box stays true — the same-PR-accepted shape [ADR-025](./025-runtime-node-control-plane-caller-authorization.md) established at §6 node NS-60. D1 is adopted from Option C and is specified to stand alone if D2 is later retreated. Antithesis points 1, 3, and 5 are accepted as residuals rather than rebutted; the vendor-policy residual is the largest accepted risk in this record. |
