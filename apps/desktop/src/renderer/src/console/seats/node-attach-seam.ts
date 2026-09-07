// What the console can hand the shipped attach flow, and what it deliberately cannot.
//
// `runtime-node-attach/AttachFlow.tsx` is Plan-003's, absorbed by import and never
// edited here. Until it took an optional transport seam it reached the installed
// preload bridge itself, which made it unrenderable under a fixture build twice over:
// in a window with no preload it throws into a surface boundary and reads as a crash,
// and in the fixture build it would answer from the live daemon beside fixture data in
// the same window — worse than answering nothing. This module builds the seam from the
// bridge the console has already resolved, exactly as `node-roster-seam.ts` builds the
// roster's, so the flow asks whichever transport this window is running on.
//
// THE PROCEDURE NAME IS NOT HERE, AND THAT IS THE POINT. `attachReadsOverControlPlane`
// is the absorbed subtree's own composer: this module hands it a call and it supplies
// which procedure performs an attach. A seam assembled here with the name written out
// would make the console a second home for a registered wire string, which is the
// divergence the roster seam's header records as having already happened once.
//
// AND THE DECLARATION IS NOT COMPOSED HERE EITHER. `Spec-023 §Trust Stance` puts the
// attach draft — a machine's claim about its own identity, contract version, health
// and capability set — in the main process, off the node registry. A renderer may not
// vouch for a machine on its own word, so this module RESOLVES a draft where one has
// been supplied and invents none where one has not. Under the fixture the scenario
// supplies it, which is fixture data reaching a surface through the fixture; under the
// live bridge nothing supplies one yet, and the mount says so rather than guessing.
//
// THAT ABSENCE IS A REGISTERED GAP AND NOT AN OVERSIGHT. `node-self-declaration` on
// the growth slate is the missing wire, filed as a `bridge-member` prerequisite rather
// than a growth operation because a port method here would be one nothing calls: the
// draft is resolved synchronously from the bridge this window already holds, at the
// moment the mount renders. The row is what makes the live arm's absence readable as a
// wire the shell owes rather than as a control somebody forgot to finish.

import type { ConsoleBridge } from "../bridge/index.js";
import {
  attachReadsOverControlPlane,
  type ControlPlaneAttachCall,
  type RuntimeNodeAttachDraft,
  type RuntimeNodeAttachReads,
} from "../../runtime-node-attach/index.js";

/**
 * The attach seam this bridge serves.
 *
 * Composed per call rather than cached per bridge, which is the opposite of what the
 * roster's seam does and is right for the opposite reason: that view depends on its
 * seam's IDENTITY inside a subscription effect, so a fresh pair each render would tear
 * the subscription down and reopen it. This one is read only inside a click handler,
 * so identity buys nothing and a cache would be a lifetime to reason about for no
 * behaviour.
 */
export function nodeAttachReadsFor(bridge: ConsoleBridge): RuntimeNodeAttachReads {
  // The cast is about THIS bridge's own generic member — `controlPlane.call` is typed
  // over a `never`-shaped procedure brand until the control-plane tRPC surface narrows
  // it, so no string literal is structurally assignable — and it is the console's
  // claim to make about the bridge it resolved. The input and result types it pins are
  // the shipped contract shapes, so the request the flow builds is checked and the
  // resolved value needs no second cast.
  const controlPlaneAttachCall = bridge.sidekicks.controlPlane.call as ControlPlaneAttachCall;
  return attachReadsOverControlPlane(controlPlaneAttachCall);
}

/**
 * The node declaration this window can offer for review, or nothing.
 *
 * `undefined` is a reading rather than a gap, and it is the LIVE bridge's ordinary
 * answer: no registered read delivers a local node's self-description to this
 * renderer, so there is nothing to review and the mount renders that. Under the
 * fixture the running scenario is asked, and a scenario that names no draft answers
 * the same way — a deck surface with nothing scripted has not been asked either.
 */
export function nodeAttachDraftFor(bridge: ConsoleBridge): RuntimeNodeAttachDraft | undefined {
  return bridge.scenarioEngine?.scenario.runtimeNodeAttachDraft;
}
