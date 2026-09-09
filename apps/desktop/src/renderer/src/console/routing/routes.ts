// The console's routes, as data.
//
// Hash routing, not history routing, and for a concrete reason: the renderer is
// served from a custom `sidekicks-renderer://` scheme through a bundle handler that
// resolves exactly one document (`Plan-023` Phase 1B, `src/main/protocol.ts`). A
// history-API route would ask that handler for a path that is not a file; a hash
// route asks for the same document every time and carries its state after the `#`.
// The auxiliary-window factory already relies on this — `createAuxiliaryWindow`
// loads `…/index.html#/window/<route>`.
//
// Two families of route:
//
//   • **Main-window routes**, one per icon-rail destination plus the session
//     workspace. The workspace is a route and NOT a rail destination: a session is
//     reached from the sessions destination, which is why `railDestinationFor`
//     answers `sessions` for it.
//   • **Auxiliary-window routes**, `#/window/<route>[/<sessionId>[/<agentId>]]`.
//     These are the routes a detached pane opens into, and they are the reason the
//     grammar has optional trailing segments at all.
//
// An auxiliary route arriving BARE — no session id — is not an error. A person can
// open the timeline window from the Window menu before choosing anything, and
// `Spec-023 §Console Design (Meridian)` §The surface set gives that case a context
// picker rather than an empty window. A route arriving MALFORMED (an unknown route
// name, too many segments, an empty segment) is different: it resolves to the
// not-found route, which says what it could not open rather than rendering blank.
//
// THE AUXILIARY GRAMMAR IS NOT DECLARED HERE. `src/shared/auxiliary-routes.ts`
// owns the route names, their labels, and the `#/window/…` producer/consumer pair,
// because the main process PRODUCES those fragments (the Window menu, the
// auxiliary-window factory) and this module CONSUMES them — two halves in two
// processes, which is exactly the pair that drifts when each writes its own. This
// module keeps the console-wide grammar (`#/sessions`, `#/session/<id>`,
// `#/workflows`, `#/settings`) and delegates the one arm it shares with main, so
// the console cannot accept a fragment the menu cannot produce or the reverse.

import {
  formatAuxiliaryFragment,
  parseAuxiliaryFragment,
  type AuxiliaryRouteTarget,
} from "../../../../shared/auxiliary-route-fragment.js";

/** Where the console currently is. A closed union — every arm renders something. */
export type ConsoleRoute =
  | { readonly kind: "sessions" }
  // ONE ARM CARRYING AN OPTIONAL FOCUS, unlike the settings split below, and the
  // difference is what the two grammars can express. `#/settings` has nowhere to put
  // a page-scoped selection, so the pair `{page: undefined, selection}` is a value the
  // formatter cannot write down and the split makes it unrepresentable. A workspace
  // address always carries its session, so `{sessionId, workflowPhase}` is writable in
  // full and reads back byte-for-byte — there is no half-supplied context to forbid.
  //
  // THE PHASE DEEP LINK IS A WORKSPACE ADDRESS RATHER THAN A DESTINATION OF ITS OWN.
  // `#/session/<sid>/workflow/<rid>/phase/<pid>` opens the session it names, focused
  // on one phase of one run — so the rail highlights `sessions` exactly as a bare
  // workspace does, the surface the route mounts is the workspace, and the palette's
  // scope row names the session. A seventh route kind would have had to answer all
  // three of those questions again and would have answered them the same way.
  //
  // WHY A PARKED PHASE NEEDS AN ADDRESS AT ALL. A `waiting-human` park ends when a
  // person answers that phase's form, and the surfaces that say so — a park banner, a
  // run row, a notification — are frequently not in the window holding the run pane.
  // Without a written-down address the phase is reachable only by somebody who has
  // already navigated to it, which is the one person who does not need the link.
  | {
      readonly kind: "workspace";
      readonly sessionId: string;
      /**
       * The phase this address is focused on, where it names one.
       *
       * OMITTED and never set to `undefined`, which is what keeps the round trip
       * exact under `exactOptionalPropertyTypes` — the same rule the settings arm's
       * `selection` obeys one arm down, and for the same reason: a present-but-
       * undefined member and an absent one are different values to the structural
       * comparison {@link parseRoute}'s tests hold this grammar to.
       *
       * Both ids travel as opaque wire values. Routing owns the grammar and never the
       * meaning, so nothing here parses either one or asserts they name a live run.
       */
      readonly workflowPhase?: {
        readonly workflowRunId: string;
        readonly phaseId: string;
      };
    }
  // Bare, and deliberately so. `Spec-023 §Console Design (Meridian)` §The surface
  // set opens the `workflow-builder` pane from this destination, and a pane
  // carries its own context — a definition id written into the address here would
  // be a second, unowned locator for something the builder has not defined yet.
  | { readonly kind: "workflows" }
  // TWO ARMS AND NOT ONE OPTIONAL MEMBER. `#/settings` carries no page and therefore
  // has nowhere to put a page-scoped selection: such a pair is a value
  // {@link formatRoute} cannot write down, and a route that cannot be written down is
  // one {@link parseRoute} can never give back. The split makes it unrepresentable
  // rather than merely undocumented — the same disposition the auxiliary arm takes to
  // half-supplied context.
  //
  // The selection is a bare `string` for `pane-harness`' reason, the DAG: `settings/`
  // sits above this module, so WHAT a page does with the segment is that page's to
  // decide. Routing owns the grammar and never the meaning.
  | { readonly kind: "settings"; readonly page: undefined }
  | { readonly kind: "settings"; readonly page: string; readonly selection?: string }
  // The shared target with a kind tag, INTERSECTED rather than restated. That
  // target is route-discriminated — an agent console carries its agent with its
  // session or not at all, a timeline carries no agent — and writing the arm out
  // here as two independent optionals would reintroduce the half-supplied context
  // the shared grammar exists to make unrepresentable, in the one module that
  // delegates both directions of that grammar precisely so it cannot drift.
  //
  // Distributing over the union gives four auxiliary arms rather than one, so
  // `route.sessionId` reads only where a session is actually carried and the
  // `"agentId" in route` test narrows instead of merely testing for `undefined`.
  | ({ readonly kind: "auxiliary" } & AuxiliaryRouteTarget)
  // Fixture builds only. The arm exists in the type in every build — types are
  // erased — but {@link parseRoute} can only PRODUCE it behind
  // `__SIDEKICKS_CONSOLE_FIXTURES__`, so a release renderer resolves this address
  // to `not-found` exactly as it resolves any other unknown one.
  //
  // The pane kind travels as a bare `string` rather than as `PaneKind`, and that is
  // the DAG rather than laziness: `seats/` sits four families above `routing/`, so
  // this module cannot name that set. The surface the slot mounts holds the segment
  // to `parseConsolePaneAddress`, which is the console's one admission point for an
  // address that arrived untyped — the same predicate a restored layout snapshot is
  // held to, so a route a person types and a snapshot read off disk cannot disagree
  // about which kinds exist.
  | {
      readonly kind: "pane-harness";
      readonly paneKind: string;
      readonly sessionId: string;
    }
  | { readonly kind: "not-found"; readonly attempted: string };

/** The route a window with no hash lands on. */
export const DEFAULT_ROUTE: ConsoleRoute = { kind: "sessions" };

/**
 * Parse a location hash into a route.
 *
 * Total: every input produces a route, because a renderer that throws while
 * deciding what to render has no way to tell anyone why. Totality is a property
 * of this function and not a hope about its input — the two ways a hash breaks a
 * parser are both closed below. Every percent-escape goes through
 * {@link decodeSegment}, and every empty segment is refused before an arm reads
 * one, so neither a `URIError` nor a silently normalised path leaves here.
 */
export function parseRoute(hash: string): ConsoleRoute {
  const afterHash = hash.startsWith("#") ? hash.slice(1) : hash;
  // The LEADING slash is the one optional separator; every other one is grammar.
  // The filter that used to drop empty segments deleted the evidence the arms
  // below validate on, so `#/session//foo` resolved to session `foo` — a different
  // session than the link names — and `#/window/timeline/` opened a bare timeline.
  const path = afterHash.startsWith("/") ? afterHash.slice(1) : afterHash;

  if (path === "") {
    return DEFAULT_ROUTE;
  }

  const segments = path.split("/");
  const [head, ...rest] = segments;
  // One refusal covering both grammars: the main-window arms below and the
  // auxiliary fragment re-composed for the shared parser read the same segments,
  // so an empty one cannot be malformed for one and invisible to the other.
  // `String.prototype.split` never answers an empty array, so `head` is present —
  // the `undefined` arm is the compiler's obligation, answered the same way.
  if (head === undefined || segments.includes("")) {
    return notFound(hash);
  }

  if (head === "sessions") {
    return rest.length === 0 ? { kind: "sessions" } : notFound(hash);
  }

  if (head === "session") {
    return workspaceRoute(hash, rest);
  }

  if (head === "workflows") {
    return rest.length === 0 ? { kind: "workflows" } : notFound(hash);
  }

  if (head === "settings") {
    if (rest.length > 2) {
      return notFound(hash);
    }
    const [pageSegment, selectionSegment] = rest;
    if (pageSegment === undefined) {
      return { kind: "settings", page: undefined };
    }
    const page = decodeSegment(pageSegment);
    if (page === undefined) {
      return notFound(hash);
    }
    if (selectionSegment === undefined) {
      // The key is OMITTED and never set to `undefined`, which is what keeps the
      // round trip exact under `exactOptionalPropertyTypes`: a present-but-undefined
      // member and an absent one are different values to a structural comparison, and
      // this is the arm `#/settings/<page>` has to give back.
      return { kind: "settings", page };
    }
    const selection = decodeSegment(selectionSegment);
    return selection === undefined ? notFound(hash) : { kind: "settings", page, selection };
  }

  // Behind the build-time constant so Rollup collapses `if (false && …)` and this
  // arm is physically absent from a release renderer, which is the same treatment
  // `Spec-023 §Pitfalls To Avoid` requires of the fixture bridge and its scenarios.
  // The address is `#/pane-harness/<paneKind>/<sessionId>`, and BOTH segments are
  // required: the pane bodies this mounts are session-scoped, so an address with no
  // session would open a harness that could only ever render the pane's own
  // not-bound absence — a surface measuring nothing.
  if (__SIDEKICKS_CONSOLE_FIXTURES__ && head === "pane-harness") {
    const [paneKindSegment, sessionIdSegment] = rest;
    if (paneKindSegment === undefined || sessionIdSegment === undefined || rest.length > 2) {
      return notFound(hash);
    }
    const paneKind = decodeSegment(paneKindSegment);
    const sessionId = decodeSegment(sessionIdSegment);
    return paneKind === undefined || sessionId === undefined
      ? notFound(hash)
      : { kind: "pane-harness", paneKind, sessionId };
  }

  if (head === "window") {
    // Re-composed from the already-split segments rather than passed through as
    // `hash`, so this module keeps its own tolerance for a leading `#` or `#/`
    // while the SEGMENTS are read by the shared grammar: segment-count bounds,
    // the closed route-name check, and the per-segment decode. That decode is the
    // reason to delegate rather than to re-derive — the arm this replaced called
    // `decodeURIComponent` directly, and a malformed escape
    // (`#/window/timeline/%zz`) throws `URIError` out of a function whose own
    // contract is that every input produces a route. The empty-segment refusal is
    // enforced once above for both grammars, and again by the shared parser, which
    // also serves the main process and cannot rely on this caller.
    const target = parseAuxiliaryFragment(`#/window/${rest.join("/")}`);
    if (target === null) {
      return notFound(hash);
    }
    // A bare auxiliary route is legitimate and gets the context picker; only an
    // unparseable one is not-found. The target is spread whole rather than
    // destructured field by field, which is what keeps this arm honest as the
    // shared grammar grows a route: a third route's context keys arrive here with
    // no edit, where a field list would have silently dropped them.
    return { kind: "auxiliary", ...target };
  }

  return notFound(hash);
}

/** Render a route back to a hash. Round-trips with `parseRoute`. */
export function formatRoute(route: ConsoleRoute): string {
  switch (route.kind) {
    case "sessions":
      return "#/sessions";
    case "workspace": {
      const workspaceAddress = `#/session/${encodeURIComponent(route.sessionId)}`;
      // The keywords are written literally on both sides of one grammar, three lines
      // from the parse that reads them, so the pair cannot drift into a link that
      // opens the workspace with its focus quietly dropped.
      const { workflowPhase } = route;
      return workflowPhase === undefined
        ? workspaceAddress
        : `${workspaceAddress}/workflow/${encodeURIComponent(workflowPhase.workflowRunId)}/phase/${encodeURIComponent(workflowPhase.phaseId)}`;
    }
    case "workflows":
      return "#/workflows";
    case "settings": {
      if (route.page === undefined) {
        return "#/settings";
      }
      const pageAddress = `#/settings/${encodeURIComponent(route.page)}`;
      return route.selection === undefined
        ? pageAddress
        : `${pageAddress}/${encodeURIComponent(route.selection)}`;
    }
    case "pane-harness":
      return `#/pane-harness/${encodeURIComponent(route.paneKind)}/${encodeURIComponent(route.sessionId)}`;
    case "auxiliary": {
      // Encoded by the shared producer, which keeps this the exact inverse of the
      // parse above — both sides of one grammar, written once. Only the kind tag
      // is dropped; the rest of the route IS the target, so there is no arm-by-arm
      // reconstruction here to disagree with the grammar it is reconstructing.
      const { kind: _consoleRouteKind, ...target } = route;
      return formatAuxiliaryFragment(target);
    }
    case "not-found":
      return route.attempted;
  }
}

/**
 * Decode one path segment, or `undefined` when its percent-escapes are malformed.
 *
 * ONE helper rather than a `try` at each decode site. `decodeURIComponent` raises
 * `URIError` on an escape like `%zz`, and {@link parseRoute}'s contract is that
 * every input produces a route — a promise that holds only while EVERY decode in
 * this module answers a malformed escape the same way. A guard pasted per site is
 * how the next arm to grow a segment ships without one. The auxiliary arm reaches
 * the same discipline through the shared grammar, which decodes its own segments
 * and answers `null`, so it needs no third call here.
 *
 * `undefined` rather than a raised refusal, because the caller has an answer for
 * this: a hash anyone can type into the address bar is a probe, not an incident,
 * and the not-found route says what it could not open.
 */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * The two workspace addresses, read from the segments after `session`.
 *
 * A HELPER RATHER THAN A THIRD BRANCH INSIDE {@link parseRoute}, because this arm is
 * the only one whose grammar has interior KEYWORDS — `workflow` and `phase` sit
 * between the three ids and are the whole of what distinguishes a focused address
 * from a session id that happens to have slashes in it. Reading them inline would
 * have put five destructured segments and two literal comparisons in the middle of a
 * function whose other arms are two lines each.
 *
 * The keyword positions are checked BEFORE the ids are decoded, so
 * `#/session/s/anything/r/phase/p` is not-found rather than a workspace address
 * silently missing its focus. Every id still goes through {@link decodeSegment}, which
 * is what keeps {@link parseRoute} total over a malformed percent-escape.
 */
function workspaceRoute(hash: string, rest: readonly string[]): ConsoleRoute {
  const [sessionSegment, workflowKeyword, runSegment, phaseKeyword, phaseSegment] = rest;
  if (sessionSegment === undefined) {
    return notFound(hash);
  }
  const sessionId = decodeSegment(sessionSegment);
  if (sessionId === undefined) {
    return notFound(hash);
  }
  if (rest.length === 1) {
    // The key is OMITTED rather than set to `undefined`: this is the arm
    // `#/session/<id>` has to give back, and the two are different values under
    // `exactOptionalPropertyTypes`.
    return { kind: "workspace", sessionId };
  }
  if (
    rest.length !== 5 ||
    workflowKeyword !== "workflow" ||
    phaseKeyword !== "phase" ||
    runSegment === undefined ||
    phaseSegment === undefined
  ) {
    return notFound(hash);
  }
  const workflowRunId = decodeSegment(runSegment);
  const phaseId = decodeSegment(phaseSegment);
  return workflowRunId === undefined || phaseId === undefined
    ? notFound(hash)
    : { kind: "workspace", sessionId, workflowPhase: { workflowRunId, phaseId } };
}

function notFound(attempted: string): ConsoleRoute {
  return { kind: "not-found", attempted };
}
