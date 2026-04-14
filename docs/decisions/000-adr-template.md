# ADR-{NNN}: {Title}

<!--
  Architecture Decision Record Template

  Audience: Engineers and AI agents
  Process: Classify the decision type FIRST, then complete the relevant sections.
  Sections marked [T2] are required only for Type 2 (one-way door) decisions.
  All other sections are required for both types.
-->

| Field          | Value                                                                    |
| -------------- | ------------------------------------------------------------------------ |
| **Status**     | `proposed` · `accepted` · `deprecated` · `superseded by [ADR-NNN]`      |
| **Type**       | `Type 1 (two-way door)` · `Type 2 (one-way door)`                       |
| **Domain**     | e.g., State Management, Routing, Auth, Styling, Data Fetching            |
| **Date**       | YYYY-MM-DD                                                               |
| **Author(s)**  | Name(s) or `Claude (AI-assisted)`                                        |
| **Reviewers**  | Name(s)                                                                  |

> **Type guidance:**
>
> - **Type 1 (two-way door):** Easily reversible. Low switching cost. Can be changed in < 1 sprint. *Skip sections marked [T2].*
> - **Type 2 (one-way door):** Hard to reverse. High switching cost. Affects multiple features or teams. Requires migration to undo. *Complete all sections.*

---

## Context

{Describe the current state of the world. What exists today? What forces are at play?
Include relevant constraints: technical, business, timeline, team capability.}

## Problem Statement

{One to three sentences. What specific problem or question does this decision address?
Frame it as a question when possible: "How should we...?" or "What approach should we take for...?"}

### Trigger

{What prompted this decision now? A new requirement, a pain point, tech debt, scaling issue, etc.
If you cannot name the trigger, question whether this decision is needed yet.}

---

## Decision

{State the decision clearly in one sentence. "We will use X for Y."}

### Thesis — Why This Option

{Present the affirmative case. What makes this the right choice?
Include evidence: benchmarks, docs, community adoption, team experience, precedent.}

### Antithesis — The Strongest Case Against [T2]

{Argue against your own decision as if you were an adversarial reviewer trying to block this PR.
Do not use weak counterarguments. What would a skeptical staff engineer say?
If you cannot construct a strong counterargument, question whether this decision is significant
enough to warrant an ADR.}

### Synthesis — Why It Still Holds [T2]

{Address every point raised in Antithesis directly. Do not hand-wave.
If you cannot rebut a point, acknowledge it as an accepted risk and explain
why the trade-off is still worth it.
If the antithesis changed your decision, document how your thinking evolved.}

---

## Alternatives Considered

<!--
  Include every option that was seriously evaluated.
  If only one option was considered, explain why no alternatives exist.
  Minimum: 2 options (the chosen one + at least one rejected).
-->

### Option A: {Name} (Chosen)

- **What:** {Brief description}
- **Steel man:** {The strongest possible case FOR this option}
- **Weaknesses:** {Honest shortcomings — do not omit known issues}

### Option B: {Name} (Rejected)

- **What:** {Brief description}
- **Steel man:** {Present the BEST case for this option as if you were its advocate. You must argue for it convincingly before rejecting it.} [T2]
- **Why rejected:** {Specific, evidence-based reasons — not "it didn't feel right"}

### Option C: {Name} (Rejected)

{Same structure. Include as many alternatives as were seriously considered.}

---

## Assumptions Audit [T2]

<!--
  This is the highest-value section. Most bad decisions come from unstated
  assumptions — not from picking the wrong option.
-->

| # | Assumption | Evidence | What Breaks If Wrong |
|---|-----------|----------|----------------------|
| 1 | {What must be true for this decision to work?} | {How do you know this is true? Link to source.} | {Consequence if assumption is false} |
| 2 | | | |
| 3 | | | |

{If you cannot provide evidence for an assumption, flag it as **unvalidated** and describe
how you plan to validate it before or shortly after implementation.}

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
|----------|-----------|--------|-----------|------------|
| {What if this decision turns out wrong?} | Low/Med/High | Low/Med/High | {How would we know? What signal reveals the failure?} | {What would we do?} |
| {What if a key assumption breaks?} | | | | |
| {What if the ecosystem shifts? (e.g., library abandoned, breaking change)} | | | | |

<!--
  The Detection column is critical. A failure you cannot detect is far more
  dangerous than one that surfaces immediately.
-->

## Reversibility Assessment

- **Reversal cost:** {What would it take to undo this decision? Hours? Days? Weeks?}
- **Blast radius:** {What systems, features, or teams are affected?}
- **Migration path:** {If we need to reverse, what does that look like concretely?}
- **Point of no return:** {Is there a specific milestone after which reversal cost jumps significantly? e.g., "After we have >10 components using this pattern." This is your trigger to re-evaluate.}

## Consequences

### Positive

- {Expected benefit 1}
- {Expected benefit 2}

### Negative (accepted trade-offs)

- {Known downside 1 — why we accept it}
- {Known downside 2 — why we accept it}

### Unknowns

- {What we don't know yet and how we plan to learn}

---

## Decision Validation [T2]

### Pre-Implementation Checklist

- [ ] All unvalidated assumptions have a validation plan
- [ ] At least one alternative was seriously considered and steel-manned
- [ ] Antithesis was reviewed by someone other than the author
- [ ] Failure modes have detection mechanisms
- [ ] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
|--------|--------|--------------------|------------|
| {How will you know this decision was right?} | {Quantitative if possible} | {How to measure} | {When to check — creates a built-in trigger to revisit} |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
|--------|------|-------------|--------------|
| {e.g., "Next.js App Router docs"} | Documentation | {What you learned — extract the insight, don't just link} | {URL} |
| {e.g., "Bundle size comparison spike"} | Primary research | {Result} | {Link to branch/gist} |
| {e.g., "Reddit thread on X migration"} | Community discussion | {Relevant insight} | {URL} |
| {e.g., "Claude analysis of trade-offs"} | AI-assisted research | {What was explored} | {Conversation link if available} |

### Related ADRs

- {`ADR-NNN` — how it relates to this decision}

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| YYYY-MM-DD | Proposed | Initial draft |
| | Accepted/Rejected | {Rationale if rejected} |
| | Revisited | {What triggered re-evaluation} |
| | Superseded | {Link to new ADR} |
