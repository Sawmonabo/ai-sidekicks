// Where the shipped Tier-1 renderer families mount, and the guard all three share.
//
// Three families shipped before the console existed and were rendered by the
// renderer root directly: the session probe, the participant roster, and the
// runtime-node roster. When the console took over the root they stopped being
// rendered by anything, which is not a decision anybody made — it is what happens
// when a new mount point lands before the old surfaces are re-homed. This module
// re-homes them.
//
// TWO OF THE THREE NOW MOUNT INSIDE A CONSOLE-AUTHORED SURFACE. T-023p-1C-4 built
// the all-sessions list and the agent console, which claim the `sessions` and
// `agent-console` slots this module used to hold. Those two families are not
// discarded: the probe is still the only caller of `session.create` and
// `session.join` that exists, and the node roster still answers which machines a
// session's agents can run on, so each is absorbed into the console surface whose
// subject it already was. What this module keeps is the SLOT for the one family
// that has no console-authored home yet, and — for the two that still need one —
// the guard, which is the part that must not be written twice.
//
// ABSORBED BY IMPORT, NOT BY CALL. A plan-owned subtree whose owner MOUNTS INTO
// the console reaches the frame by calling `registerConsoleSurface`; the console
// imports it through no path, which is why the layering gate bans those subtrees
// outright. These three are the stated exception — they are shipped Tier-1
// components with no owner left to make the call, so the console absorbs them.
//
// WHY THIS IS A `.ts` MODULE THAT BUILDS ELEMENTS RATHER THAN A COMPONENT FILE.
// It owns a TABLE — slot, owner, and what mounts there — not a view. Written as a
// `.tsx` it would be one file holding three anonymous components, which is the
// shape the file-naming rule exists to prevent; split into three component files
// it would be three files whose only content is one element each, and the table
// itself — the part a reader actually needs — would be spread across four places.
//
// WHY TWO OF THE THREE MOUNTS ARE GUARDED ON THE BRIDGE SOURCE. The session probe
// and the invite acceptance read `window.sidekicks` directly rather than taking a
// bridge from context, so the console's fixture cannot stand in for the preload
// the way it does for every console-authored surface. Under the fixture they would
// reach past it: in a window with no preload at all they throw into the surface
// boundary and read as a crash, and in the fixture build they would answer from
// the live daemon beside fixture data in the same window, which is worse than
// answering nothing. So the frame says the question was not put, which is exactly
// what happened.
//
// THE NODE ROSTER IS NO LONGER ONE OF THEM, AND ITS GUARD IS GONE RATHER THAN
// RELAXED. That view now takes an optional read seam and this module builds one
// from the bridge the console has already resolved, so it asks whichever bridge
// this window is running on: the control plane under the preload, the scenario's
// own roster frames under the fixture. There is no longer a window in which it
// could reach past the console's bridge, so the condition the guard tested does
// not arise for it — and every fixture build that used to render "the question was
// not put" where the roster belongs now renders the roster. The guard stays
// exactly where it is still true, which is the other two.

import { createElement, type ReactNode } from "react";

import type { SessionId } from "@ai-sidekicks/contracts";

import { type ConsoleBridge, type ConsoleBridgeSource } from "../bridge/index.js";
import { ConsoleRefusalError } from "../core/index.js";
import { Nothing } from "../primitives/index.js";
import { routeSessionId } from "../routing/index.js";
import { SurfaceAbsence } from "./SurfaceAbsence.js";
import { NodeRoster, type NodeRosterReads } from "../../runtime-node-attach/index.js";
import { SessionBootstrap } from "../../session-bootstrap/index.js";
// Deep, because `session-members/` ships no barrel. The other two are reached
// through theirs. Adding one is that family's own diff, not the console's — the
// console does not author files inside a subtree it merely absorbs.
import { ParticipantRoster } from "../../session-members/participant-roster.js";
import { InviteAcceptView } from "../../session-members/invite-accept-view.js";
import { type ConsoleSurfaceDescriptor, type ConsoleSurfaceRegistry } from "./surface-registry.js";

/**
 * The shipped family that still holds a slot of its own, and which slot.
 *
 * The participant roster takes `workspace` because that destination names it and
 * because no console-authored workspace surface has landed. The other two are
 * mounted by the console surfaces that absorbed them, through the two exported
 * helpers below.
 *
 * The components each family exports beyond these three take inputs no route
 * carries — an invite token, an attach draft — so a route cannot supply them and
 * a slot for them would be a slot nothing could ever fill. The invite acceptance
 * view is exactly that case and is exported below rather than registered: its
 * caller holds the token.
 */
const LEGACY_SURFACES: readonly ConsoleSurfaceDescriptor[] = [
  {
    slot: "workspace",
    owner: "session-members",
    render: (context) =>
      mountSessionScopedLegacySurface(
        context.bridge.source,
        routeSessionId(context.route),
        (sessionId) => createElement(ParticipantRoster, { sessionId }),
      ),
  },
];

/**
 * The session probe, mounted inside the console's all-sessions list.
 *
 * Exported rather than registered because the list owns the `sessions` slot now and
 * the probe is one region of it — its create and join controls. The guard travels
 * with it: a caller cannot mount this component past the fixture check, because the
 * check is not the caller's to make.
 */
export function renderAbsorbedSessionProbe(bridgeSource: ConsoleBridgeSource): ReactNode {
  return mountLegacySurface(bridgeSource, () => createElement(SessionBootstrap));
}

/**
 * The runtime-node roster, mounted inside the console's agent console.
 *
 * Takes the session id rather than a route, because the two mounts that need it
 * carry a session differently — one from a pane's own store, one from an auxiliary
 * address — and neither should have to build a route to reach a component.
 *
 * Takes the BRIDGE rather than its source, because it now hands the view the pair
 * of reads that bridge already serves rather than deciding whether to mount it at
 * all. The bridge is optional for one caller's sake: the agent console is mounted
 * from two contexts and types its own bridge prop as possibly absent, and a helper
 * that demanded one would move that absence into the caller — which is precisely
 * what the guard rule here says not to do.
 *
 * The seam it hands over is the SAME OBJECT for the same bridge, every call. That
 * is what lets the view depend on it: this helper runs on every parent render, so
 * a freshly composed pair each time would tear the roster's subscription down and
 * re-open it on every keystroke above it, and a pair that never changed identity
 * would leave the roster reading a bridge the provider has already replaced.
 */
export function renderAbsorbedNodeRoster(
  bridge: ConsoleBridge | undefined,
  sessionId: string | undefined,
): ReactNode {
  if (bridge === undefined) {
    return centredAbsence({
      kind: "not-checked",
      title: "This surface was not handed a bridge to read the roster through.",
      detail:
        "The roster is one read per session, and this mount resolved nothing to perform it with. Nothing was asked.",
    });
  }
  const resolvedSessionId = brandedSessionId(sessionId);
  if (resolvedSessionId === undefined) {
    return noSessionAbsence();
  }
  return createElement(NodeRoster, {
    sessionId: resolvedSessionId,
    reads: nodeRosterReadSeams.forBridge(bridge),
  });
}

/**
 * One read seam per bridge, held for as long as that bridge is reachable.
 *
 * WHY THE IDENTITY IS THE POINT. `SidekicksBridgeProvider` replaces its resolution
 * as STATE without remounting anything below it — when the `bridge` prop or the
 * scenario changes, and again when its own engine has been disposed and a second
 * mount must take a fresh one. So "same session, different transport" is a state
 * this console genuinely reaches, and the roster's effect has to notice it. It can
 * only notice by depending on the seam, and depending on a pair rebuilt on every
 * render would make the dependency fire on renders where nothing changed. Caching
 * by bridge gives the effect exactly one signal: a different seam means a different
 * bridge, and nothing else does.
 *
 * A `WeakMap` rather than a `Map` because the key is the whole lifetime: a
 * superseded bridge is unreachable the moment the provider drops it, and its seam
 * goes with it rather than accumulating one entry per scenario swap for the life of
 * the window.
 *
 * A class with a private field rather than a module-level `Map`, on the
 * `keybinding-override-store.ts` precedent — module scope is window scope here,
 * since an auxiliary window is its own renderer process and no channel joins two
 * windows' module graphs.
 */
class NodeRosterReadSeams {
  readonly #seamsByBridge = new WeakMap<ConsoleBridge, NodeRosterReads>();

  public forBridge(bridge: ConsoleBridge): NodeRosterReads {
    const existingSeam = this.#seamsByBridge.get(bridge);
    if (existingSeam !== undefined) {
      return existingSeam;
    }
    const seam = nodeRosterReadsFrom(bridge);
    this.#seamsByBridge.set(bridge, seam);
    return seam;
  }
}

/** This window's seams. Not exported: the helper above is the only way in. */
const nodeRosterReadSeams = new NodeRosterReadSeams();

/**
 * The roster's two reads, as the console's own bridge answers them.
 *
 * BOTH ARMS CONVERT A RETURNED REFUSAL INTO A THROWN ONE, and the conversion is
 * the whole adapter. The bridge answers outcomes because a surface that renders a
 * refusal wants a value; this view renders a refusal from its own error arm, which
 * is reached by a rejection. `ConsoleRefusalError` is the console's one shape for a
 * refusal that has to travel as an exception, so the code, the sentence, and the
 * origin all survive the trip — the view renders `ConsoleRefusalError` followed by
 * `<origin>: <code>: <detail>`, which is the refuser's own code verbatim rather
 * than a paraphrase.
 *
 * The SUBSCRIBE arm throws for a second reason beyond symmetry. Handing back a
 * no-op unsubscribe would leave the roster believing it is live: it would never
 * re-read and would go quietly stale, which is the one failure a live roster exists
 * to prevent. The view's own subscribe arm catches a synchronous throw, renders it,
 * and deliberately SKIPS the initial read rather than painting a snapshot with no
 * channel behind it — so a refusal here reads as a roster that is not live, which
 * is what it is.
 */
function nodeRosterReadsFrom(bridge: ConsoleBridge): NodeRosterReads {
  return {
    readRoster: async (request) => {
      const outcome = await bridge.runtimeNodeRosterRead(request);
      if (outcome.status === "refused") {
        throw new ConsoleRefusalError(outcome);
      }
      return outcome.value;
    },
    subscribePresence: (sessionId, onPresenceChange) => {
      const subscription = bridge.runtimeNodePresenceSubscribe(sessionId, onPresenceChange);
      if (subscription.status === "refused") {
        throw new ConsoleRefusalError(subscription);
      }
      return subscription.unsubscribe;
    },
  };
}

/**
 * The invite acceptance prompt, mounted inside the console's invite confirmation.
 *
 * Takes the token rather than a route for the reason the slot table gives: no
 * address carries one, so a route could never supply it. The component performs
 * the acceptance itself — this console authors no second `invite.accept` caller —
 * and the guard travels with it, so a confirmation cannot mount the prompt past
 * the fixture check.
 */
export function renderAbsorbedInviteAcceptance(
  bridgeSource: ConsoleBridgeSource,
  token: string,
): ReactNode {
  return mountLegacySurface(bridgeSource, () => createElement(InviteAcceptView, { token }));
}

/**
 * Claim a slot for each shipped Tier-1 family.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for the
 * same reason `registerConsoleFamilies` does: composition is the caller's, so a
 * test can compose into a registry it owns and an auxiliary window can compose a
 * subset without a second code path.
 */
export function registerLegacySurfaces(registry: ConsoleSurfaceRegistry): void {
  for (const descriptor of LEGACY_SURFACES) {
    registry.register(descriptor);
  }
}

/**
 * Render a shipped component, or say that no question was put.
 *
 * `not-checked` rather than `error`: nothing failed. The console is running
 * against the fixture, this surface reads the installed bridge directly, and so
 * the console declined to ask on its behalf. Reporting that as an error would
 * assert a failure that never happened, which is the conflation the five kinds of
 * nothing exist to prevent.
 */
function mountLegacySurface(bridgeSource: ConsoleBridgeSource, build: () => ReactNode): ReactNode {
  if (bridgeSource !== "live") {
    return centredAbsence({
      kind: "not-checked",
      title: "This surface reads the installed bridge, and this window is running on the fixture.",
      detail:
        "It renders in the application, where the preload bridge is installed. Nothing was asked of the daemon here.",
    });
  }
  return build();
}

/** The same, for a component that needs a session the caller has resolved. */
function mountSessionScopedLegacySurface(
  bridgeSource: ConsoleBridgeSource,
  subject: string | undefined,
  build: (sessionId: SessionId) => ReactNode,
): ReactNode {
  return mountLegacySurface(bridgeSource, () => {
    const sessionId = brandedSessionId(subject);
    return sessionId === undefined ? noSessionAbsence() : build(sessionId);
  });
}

/**
 * The absence a session-scoped surface renders at an address that names none.
 *
 * Written once because two mounts reach it from opposite sides now — the guarded
 * path above, and the node roster, which has no guard left to reach it through —
 * and one sentence a person reads must not exist in two places to drift between.
 */
function noSessionAbsence(): ReactNode {
  return centredAbsence({
    kind: "empty",
    title: "This surface needs a session, and this address names none.",
    detail: "Open a session from the Sessions list and the surface follows it.",
  });
}

/**
 * One whole-surface absence, centred, with its second line below.
 *
 * Centred, because these fill the whole surface. Left in flow one renders as a
 * strip in the top-left corner of the pane — the shape `SurfaceAbsence` exists to
 * prevent, and the one a reader mistakes for a paint that did not finish.
 *
 * `placement: "surface"` for the same reason, one level down. These kinds are
 * ordinarily mounted beside a value they qualify, and a badge is right there; here
 * each stands in for an entire pane, so it takes the block. Centring a badge would
 * have moved the strip to the middle of the window rather than retired it, and the
 * badge shape has nowhere to put the second line below — which is the line that
 * says where this surface DOES render.
 */
function centredAbsence(absence: {
  readonly kind: "not-checked" | "empty";
  readonly title: string;
  readonly detail: string;
}): ReactNode {
  return createElement(
    SurfaceAbsence,
    null,
    createElement(Nothing, {
      kind: absence.kind,
      placement: "surface",
      title: absence.title,
      detail: absence.detail,
    }),
  );
}

/**
 * A resolved session id, as the wire's branded id.
 *
 * The brand is compile-time nominal typing over a plain string, and the narrowing
 * happens HERE — once, named, at the one seam where an address segment becomes a
 * wire argument — rather than at each call site. It is deliberately not a
 * validation: whether the id names a session is the daemon's answer, every one of
 * these components already renders the daemon's refusal verbatim, and a
 * renderer-side UUID check would be a second authority on that question bought
 * with a schema validator in a bundle budget measured in kilobytes.
 */
function brandedSessionId(sessionId: string | undefined): SessionId | undefined {
  return sessionId === undefined ? undefined : (sessionId as SessionId);
}
