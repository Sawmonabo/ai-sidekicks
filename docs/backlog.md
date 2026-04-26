# Backlog

## Purpose

This file is the active development backlog for the product defined in [vision.md](./vision.md).

## How To Use This Backlog

- Add items only when they represent real remaining work.
- Link every item to the governing spec, plan, ADR, or operations doc where possible.
- Keep items outcome-oriented. A backlog item should describe a deliverable, not a vague area of concern.
- Remove or rewrite stale items instead of letting the file become a historical log.
- When work is complete, update the canonical docs it depends on first, then move the item to [Backlog Archive](./archive/backlog-archive.md).

## Status Values

- `todo`
- `in_progress`
- `blocked`
- `completed`

## Priority Values

- `P0` — blocks all implementation or blocks a critical feature
- `P1` — blocks a specific feature or must resolve before v1
- `P2` — should resolve before v1 ship

---

## Active Items

### BL-099: Author `docs/domain/trust-and-identity.md`

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-027 — Self-Host Secure Defaults](./specs/027-self-host-secure-defaults.md), [Participant And Membership Model](./domain/participant-and-membership-model.md), [Security Architecture](./architecture/security-architecture.md), [ADR-010 — PASETO/WebAuthn/MLS Auth](./decisions/010-paseto-webauthn-mls-auth.md)
- Summary: Author the missing `docs/domain/trust-and-identity.md` domain doc to canonicalize trust-ceremony semantics (first-run secret generation, fingerprint display, device-trust establishment) currently scattered across `participant-and-membership-model.md`, `security-architecture.md`, and Spec-027. Surfaced by the 2026-04-26 read-only docs audit (M-003): Spec-027 §Domain Dependencies originally cited the file as if it existed; the audit-driven fix re-pointed Spec-027 to `participant-and-membership-model.md` as the closest existing scope match, but the trust-ceremony surface deserves its own domain doc.
- Exit Criteria: `docs/domain/trust-and-identity.md` exists; covers identity-material provisioning, fingerprint verification ceremony, and trust-state lifecycle; is referenced from Spec-027 §Domain Dependencies, ADR-010, and security-architecture.md; sibling docs cross-link consistently.

---

## Item Template

Use this shape for new backlog items:

```md
### BL-0XX: Short Title

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Relevant Spec](./specs/000-spec-template.md), [Relevant Plan](./plans/000-plan-template.md)
- Summary: One or two sentences describing the deliverable or change.
- Exit Criteria: Concrete condition that makes this item complete.
```

## Maintenance Rule

If information in a backlog item becomes durable product truth, move that information into the canonical docs and keep only the remaining work here.
