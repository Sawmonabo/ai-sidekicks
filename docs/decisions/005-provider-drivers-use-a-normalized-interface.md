# ADR-005: Provider Drivers Use A Normalized Interface

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 2 (one-way door)` |
| **Domain**    | `Provider Architecture` |
| **Date**      | `2026-04-14`            |
| **Author(s)** | `Codex`                 |
| **Reviewers** | `Accepted 2026-04-15`   |

## Context

The product must support multiple providers, multiple machines, and consistent run semantics across them. Claude Code and Codex are the providers built first, not a closed set: another provider is added later, and adding one must not reach across the daemon, the contracts and the desktop. Providers differ materially in transport, lifecycle, permissions, and persistence. If those differences leak into the core runtime, session and run semantics will drift by provider.

## Problem Statement

How should the core runtime interact with provider-specific execution runtimes?

### Trigger

Provider capability and recovery behavior are foundational to Local Runtime Daemon architecture and the shared run model.

## Decision

We will require every provider integration to implement a normalized driver interface, and each driver to describe itself to every screen.

- **An open provider id.** A provider is named by `ProviderId`, an open text id (`claude`, `codex`), never a closed list in shared code. It is checked against the registered drivers wherever a request or a provider message brings one in; a name with no driver is refused, and a stored row keeps the name as it was written. Provider names stay in labels, configuration, logs and tests.
- **A descriptor, then driver methods.** Each driver carries a small descriptor of fixed facts only: its id and the name a person reads, how its command is found and installed, its plan and sign-in words, its tool and effort maps, its built-in tools and fixed speed levels, its tool-server transports and fields, the environment names it sets, its skill-name limit, and the Settings rows it declares. Everything that depends on the installed build, the account, the model or the session comes from driver methods, read live where it applies, and behavior (the spawn environment, session start, queue and admission rules) is a driver method, never descriptor data.
- **Screens read the provider, never flags.** The screens draw from the provider read, `provider.list`, which carries each installed provider's descriptor, its declared rows and their live values, and from the live model rows and the session's provider state. A control appears where the provider offers it and nothing marks its absence. Capability flags remain the daemon's own gate on what it asks a driver to do, and no client reads them. The desktop renders and checks from what `provider.list` sends, and the daemon checks again.
- **One table builds the registry.** One table in the daemon's provider driver module holds one entry per provider, its descriptor and its build function, and is the one place that names a provider. At start the daemon walks the table in order and fills the registry, keyed by `ProviderId` and kept in table order; every build takes the same small bundle of shared services, stores its handles, does no I/O and starts no process; a repeated name fails the build. A request naming a provider with no registered driver is refused `provider.notFound`. A new provider is one driver folder and one table line.
- **Native drivers, no general protocol driver.** Each provider is driven by its own driver over its own wire, and there is no general driver for other protocol agents. The drivers copy the Agent Client Protocol's shapes for tool-call rows, option rows and command lists into our own internal shapes.

The hand-over brief is part of that boundary, and transcript replay is not. Every driver composes the brief a session on a different provider starts from, on a throwaway copy of the session, and no driver replays a transcript into a fresh provider session; the `exportHandoverBrief` operation is specified in [Spec-004 §The Canonical Transcript And The Hand-Over Brief](../specs/004-provider-driver-contract-and-capabilities.md#the-canonical-transcript-and-the-hand-over-brief).

### Thesis — Why This Option

A normalized driver boundary keeps session, run, queue, approval, and artifact semantics provider-agnostic. It also lets every screen draw what each provider reports, in the provider's own names, without scattering provider-name branches across the product.

### Antithesis — The Strongest Case Against

Abstraction can leak. Provider-specific features often arrive faster than normalized contracts can evolve, and building to one provider first could get the product to market faster. A normalized interface might either become too generic or too brittle.

### Synthesis — Why It Still Holds

Leaky abstraction is a manageable risk if the driver contract is intentionally small: fixed facts in the descriptor, everything else read live. Waiting to abstract until later would bake provider-specific assumptions into session, run, and UI semantics, making later extraction far more expensive. Availability read live per account, model and session lets the product show exactly what each provider offers even when providers differ, and a concept no provider has had before costs one shared entry and one screen piece, once.

## Alternatives Considered

### Option A: Normalized Driver Interface (Chosen)

- **What:** Use a provider driver contract with lifecycle methods, normalized events, a fixed descriptor per driver and live reads.
- **Steel man:** Keeps core runtime semantics stable and multi-provider by design.
- **Weaknesses:** Requires thoughtful contract design and evolution.

### Option B: Provider-Specific Branching In Core Runtime (Rejected)

- **What:** Let the session engine and UI branch directly on provider behavior.
- **Steel man:** Faster access to provider-specific features and fewer adapter layers.
- **Why rejected:** Pollutes core runtime semantics and makes multi-provider correctness much harder.

### Option C: Single-Provider-First Architecture (Rejected)

- **What:** Build deeply around one provider and abstract later.
- **Steel man:** Fastest route to an initial product.
- **Why rejected:** Contradicts the product goal of Codex and Claude support first and raises reversal cost sharply.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Providers differ materially enough that the product must not expose provider-native semantics as core runtime truth. | The provider-driver spec requires normalized driver contracts at the daemon edge, with each screen drawn from what the provider reports. | A thinner abstraction might be enough. |
| 2 | Session and run semantics must remain provider-agnostic. | Core domain and specs depend on stable shared vocabulary. | UI and runtime could become provider-specialized. |
| 3 | A small fixed descriptor plus live reads per account, model and session carry every difference a screen draws. | Availability differs per model, account, platform, session and child, which the provider reports live; the descriptor holds only what never changes for a driver. | A provider brings a concept no provider has had, which adds one shared entry and one screen piece. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Driver abstraction becomes too generic and blocks useful provider features | Med | Med | Feature work repeatedly needs driver bypasses | Add capability extensions and diagnostic side channels without breaking core semantics |
| Provider-native behavior leaks into session engine anyway | Med | High | Provider-name branches appear in core code and docs | Each provider's driver is a private module of the daemon's provider driver module, beside the one table that holds each provider's descriptor and build function, so Rust's privacy keeps every module outside it from naming a provider; the daemon's startup reaches a driver only through the registry, and review holds what privacy cannot (that one provider's module never reaches another's, and that only startup walks the table); shared code names no provider |
| A provider's reads become stale or inaccurate | Med | Med | A screen offers a control the provider no longer has, or lacks one it has | Re-read the provider at daemon start, when a provider's command path changes, on `Check again`, when a provider process starts, and when a model catalog goes stale; account, model and session state is pushed whole on change |

## Reversibility Assessment

- **Reversal cost:** High. It would affect daemon architecture, recovery, the provider read, and UI controls.
- **Blast radius:** Provider drivers, session engine, control surfaces, recovery, and tests.
- **Migration path:** Introduce provider-specific control paths and gradually unwind normalized contract usage.
- **Point of no return:** After multiple providers and control surfaces rely on the normalized interface.

## Consequences

### Positive

- Stable multi-provider runtime model
- Screens and recovery behavior drawn from what each provider reports, in its own names
- A new provider touches only its own driver folder and one table line

### Negative (accepted trade-offs)

- More adapter code and contract maintenance
- Occasional lag in exposing provider-specific features through the normalized model

### Unknowns

- How often a provider will bring a concept no provider has had, each adding one shared entry and one screen piece

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| New providers integrate without changing session or run semantics | 100% of supported providers | Driver integration review | When each provider driver is integrated |
| A control shows only where its provider offers it, with nothing marking its absence | Every control drawn from the provider read | Spec and UI test coverage | Each run of the spec and UI tests |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `specs/004-provider-driver-contract-and-capabilities.md` | Canonical spec | Provider integrations use a normalized contract; each driver describes itself and reports live what it offers | [specs/004-provider-driver-contract-and-capabilities.md](../specs/004-provider-driver-contract-and-capabilities.md) |
| `architecture/daemon.md` | Canonical architecture doc | Driver management belongs inside the local daemon edge | [architecture/daemon.md](../architecture/daemon.md) |
| `specs/018-observability-and-failure-recovery.md` | Canonical spec | Provider failures are surfaced through canonical product failure categories rather than provider-specific runtime truth | [specs/018-observability-and-failure-recovery.md](../specs/018-observability-and-failure-recovery.md) |

### Related Domain Docs

- [Machine Model](../domain/machine-model.md)
- [Agent And Run Model](../domain/agent-and-run-model.md)

### Related Architecture Docs

- [Daemon Architecture](../architecture/daemon.md)
- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)

### Related Specs

- [Provider Driver Contract And Capabilities](../specs/004-provider-driver-contract-and-capabilities.md)
- [Machine Registration](../specs/002-machine-registration.md)
- [Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md)

### Related ADRs

- [Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
