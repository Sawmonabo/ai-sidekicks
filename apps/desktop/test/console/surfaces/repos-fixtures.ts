// Every value, port, and collaborator the repos surfaces are drawn against.
//
// SPLIT FROM `repos.tsx` ON THE SEAM BETWEEN WHAT AND HOW, and for the reason
// `apps/desktop/AGENTS.md` gives: together the two were one file doing two jobs. That
// module owns HOW each surface is reached — which registry holds the body, what it is
// mounted into, and what settled means for it — and this one owns WHAT it is drawn
// against: the fixture bridge and stores, the scripted port the payload arms need, and
// the values no registered read produces.
//
// NOTHING HERE RENDERS AND NOTHING HERE WAITS. Every export is inert, which is what
// makes the seam hold: a tier that wants a different composition states a new mount
// rather than reaching in and mutating one of these, and a fixture that stopped being
// read is dead code the gate can see rather than a surface that quietly emptied.
//
// THE VALUES ARE HERE BECAUSE NO READ PRODUCES THEM. The scenario serves this family's
// mount and branch-context reads, so a surface drawn from those is drawn from the
// fixture and cannot drift from it. The gate's `prepared` arm, its push refusal, and
// both artifact payload arms have no registered reply behind them at all — they are
// `Plan-023 §Console growth slate` rows — so they are stated once, here, rather than
// per mount.

import type { ReactNode } from "react";

import {
  REPOS_PINNED_ARTIFACT_ID,
  REPOS_SCENARIO,
} from "../../../src/renderer/src/console/bridge/scenarios/repos.js";
import {
  type ConsoleBridge,
  type GrowthArtifactSummary,
  createFixtureBridge,
  growthUnavailable,
} from "../../../src/renderer/src/console/bridge/index.js";
import type { GrowthPortAnswer } from "../../../src/renderer/src/console/bridge/growth-port/growth-port.js";
import {
  MAXIMUM_LIVE_DRAFT_COUNT,
  refuse,
  type ConsoleRefusal,
} from "../../../src/renderer/src/console/core/index.js";
import { fixtureBridgeWithGrowth } from "../../../src/renderer/src/console/bridge/fixture/fixture-bridge.test-support.js";
import { buildDiffFixture } from "../../../src/renderer/src/console/repos/diff-pane/diff-fixture.test-support.js";
import { EXTENDED_HEADER_DIFF_SHAPE } from "../../../src/renderer/src/console/repos/diff-pane/diff-fixture-shapes.test-support.js";
import type { ConsoleDiffModel } from "../../../src/renderer/src/console/repos/diff-pane/diff-model.js";
import { DraftStore, UiStateStore } from "../../../src/renderer/src/console/persistence/index.js";
import type { BranchContextReading } from "../../../src/renderer/src/console/repos/mounts/branch-context-model.js";
import type { ProposalAction } from "../../../src/renderer/src/console/repos/proposals/proposal-actions.js";
import type { ProposalGateState } from "../../../src/renderer/src/console/repos/proposals/proposal-gate-state.js";
import { FrameStore, SessionStore } from "../../../src/renderer/src/console/store/index.js";
import { registerReposPanes } from "../../../src/renderer/src/console/repos/index.js";
import {
  type ConsolePaneContext,
  type PaneKind,
} from "../../../src/renderer/src/console/seats/index.js";
import { resolvedPaneBody } from "./pane-body-resolution.js";

/** A bridge and a store both drawn from the repos scenario, which is the family's own. */
export function scenarioCollaborators(): { bridge: ConsoleBridge; sessionStore: SessionStore } {
  return {
    bridge: createFixtureBridge({ scenario: REPOS_SCENARIO }),
    sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
  };
}

/**
 * Everything a pane is bound to, beside the address it is opened at.
 *
 * READ OFF THE ARM THAT CARRIES NOTHING ELSE. `ConsolePaneContext` is the address
 * union intersected with the binding, and `runs` is a session-scoped kind — so
 * dropping its `kind` leaves exactly the binding half, derived rather than
 * transcribed. Each mount states its own address, because an address now carries the
 * entity its pane is a view of and no two panes are views of the same thing.
 */
export type ConsolePaneBinding = Omit<
  Extract<ConsolePaneContext, { readonly kind: "runs" }>,
  "kind"
>;

/**
 * The repos pane body the deck holds for a kind, loaded.
 *
 * The resolution — build a family-scoped registry, preload, read the descriptor, throw
 * by name — lives once in `test/console/surfaces/pane-body-resolution.ts`; what stays here is
 * which registrar this family's mounts compose against.
 */
export async function paneBodyComponent(
  kind: PaneKind,
): Promise<(context: ConsolePaneContext) => ReactNode> {
  return await resolvedPaneBody(kind, registerReposPanes);
}

/** The deck bindings a pane is mounted with, minus the address each caller states. */
export function paneBinding(reached: {
  readonly paneId: string;
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}): ConsolePaneBinding {
  return {
    paneId: reached.paneId,
    bridge: reached.bridge,
    sessionStore: reached.sessionStore,
    frameStore: new FrameStore(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    linkedSourcePaneId: undefined,
    focusHue: undefined,
  };
}

/**
 * The change set the diff pane is drawn over, on the shape carrying a header-only file.
 *
 * `EXTENDED_HEADER_DIFF_SHAPE` rather than the small one, so the set includes a file
 * whose whole change is in the patch's headers: a rename with no hunks, which the two
 * surfaces drew as `+0 −0` under a bare path until the parser carried what the headers
 * said. What that note looks like beside a path and inside a file-header row is a claim
 * an image holds and a DOM assertion does not.
 *
 * Built per call rather than shared, because a model two tiers hold one copy of would
 * make the second tier's mount depend on whether the first had run.
 */
export function extendedHeaderChangeSet(): ConsoleDiffModel {
  return buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);
}

/**
 * A hand-scripted growth port serving one artifact read, and refusing the rest.
 *
 * THE FIXTURE CANNOT PRODUCE A SERVED PAYLOAD: its growth port serves no `artifact*`
 * operation, so a subject that waited on the scenario for one would wait forever. The
 * reply shapes the two arms below hand in are `GrowthArtifactRead`'s own — a handle,
 * or bytes beside the encoding to read them by — so what a payload mount pins is the
 * composition the registered shape produces, not one this file invented.
 */
export function scriptedArtifactPort(readAnswer: GrowthPortAnswer<"artifactRead">): ConsoleBridge {
  return fixtureBridgeWithGrowth(REPOS_SCENARIO, {
    artifactList: async () => ({ status: "served", value: [] }),
    // The port's own refusal, not a hand-built one: `growthUnavailable` composes the
    // sentence from the slate row, so these mounts pin the words a person would read
    // rather than a paraphrase that stays put while the real one moves.
    artifactAllowlistRead: async () => growthUnavailable("artifactAllowlistRead"),
    artifactRead: async () => readAnswer,
    artifactDelete: async () => growthUnavailable("artifactDelete"),
  });
}

/** One manifest both payload arms are read against, as the port serves one. */
const SERVED_ARTIFACT_MANIFEST: GrowthArtifactSummary = {
  artifactId: REPOS_PINNED_ARTIFACT_ID,
  sessionId: REPOS_SCENARIO.sessionId,
  artifactType: "diff",
  digest: "sha256:2b4cf0e1a9d84c0b6f2e5a71c3d8b4e90",
  size: 48,
  annotations: { "org.opencontainers.image.title": "rate-limit-wiring.patch" },
  visibility: "shared",
  state: "published",
  metadata: { mediaType: "text/x-patch" },
  createdAt: "2026-01-01T09:05:00.000Z",
};

/** The DEFERRED arm of a served read: a content-addressed handle and no bytes. */
export const DEFERRED_PAYLOAD_READ: GrowthPortAnswer<"artifactRead"> = {
  status: "served",
  value: {
    manifest: SERVED_ARTIFACT_MANIFEST,
    payloadHandle: "sha256:2b4cf0e1a9d84c0b6f2e5a71c3d8b4e90",
  },
};

/** The INLINE arm: the bytes, and the encoding a reader switches on. */
export const INLINE_PAYLOAD_READ: GrowthPortAnswer<"artifactRead"> = {
  status: "served",
  value: {
    manifest: SERVED_ARTIFACT_MANIFEST,
    // "--- a/one\n+++ b/one\n@@ -1 +1 @@ read\n-was\n+is\n" in RFC 4648 base64.
    payload: "LS0tIGEvb25lCisrKyBiL29uZQpAQCAtMSArMSBAQCByZWFkCi13YXMKK2lzCg==",
    payloadEncoding: "base64",
  },
};

/** The branch context the gate is drawn against, on its richest arm. */
const PREPARED_BRANCH_CONTEXT: BranchContextReading = {
  branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
  baseBranch: "develop",
  headBranch: "sidekicks/abc123/rate-limit-wiring",
  upstreamRef: "origin/sidekicks/abc123/rate-limit-wiring",
  executionMode: "worktree",
  worktreeId: "019b7b30-0280-7c11-8420-b1a5c0de2020",
};

/**
 * The gate's `prepared` arm, which is the one that draws every part of the surface.
 *
 * THE PROPOSAL IS `ready` AND THAT IS LOAD-BEARING, not a value picked to look
 * plausible. `offeredProposalActions` withholds the remote act until the proposal says
 * a person may send it, so a `draft` fixture offers two acts instead of three, prints
 * the not-sendable sentence in place of the third, and — because a refusal is looked
 * up only for an act that IS offered — renders `PUSH_REFUSAL` nowhere at all. Every
 * subject drawn from this value was therefore pinning a surface with a missing row and
 * a dead prop, under comments claiming the opposite, and an image would have looked
 * identical if the gate had stopped rendering refusals entirely.
 *
 * The withheld composition is not unpinned by that: `proposal-actions.test.ts` owns the
 * `draft` arm, where an assertion can name which act is absent and why, which is a
 * claim a picture cannot make.
 */
export const PREPARED_GATE_STATE: ProposalGateState = {
  kind: "prepared",
  context: PREPARED_BRANCH_CONTEXT,
  detectedHost: "github",
  proposal: {
    title: "Wire the rate limiter",
    body: "Adds the concurrency cap to the subscribe path.",
    baseBranch: "develop",
    headBranch: "sidekicks/abc123/rate-limit-wiring",
    state: "ready",
    trailers: ["Co-Authored-By: a sidekick"],
    changedPaths: [
      "packages/control-plane/src/rate-limit.ts",
      "packages/control-plane/src/rate-limit.test.ts",
    ],
  },
};

/**
 * The refusal the gate draws beside a control that was pressed and did not take.
 *
 * On the REMOTE act, which is the one whose failure matters most to see: a push that
 * the daemon refused leaves the proposal intact and the offer standing, and the
 * sentence beside the control is the only thing that says the send did not happen.
 *
 * REACHED ONLY BECAUSE THE PROPOSAL ABOVE IS `ready`. `ProposalActionGroup` looks a
 * refusal up per offered act, so this map is queried for `push` if and only if `push`
 * is on screen — which is why the state and this value are one claim and not two.
 */
export const PUSH_REFUSAL: ReadonlyMap<ProposalAction, ConsoleRefusal> = new Map([
  [
    "push" satisfies ProposalAction,
    refuse(
      "gitflow.gitActionExecute",
      "wire-unregistered",
      "Not checked — the git action is not registered yet.",
    ),
  ],
]);
