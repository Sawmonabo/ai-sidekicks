// The console's routes as data. Hash routing, because the renderer is served from a custom
// `sidekicks-renderer://` scheme whose handler resolves one document
// (`main/services/renderer-protocol.ts`); a hash carries state after the `#` without asking it
// for another path. A malformed hash resolves to the not-found route, never a blank screen.

/** Where the console currently is. A closed union: every arm renders something. */
export type AppRoute =
  | { readonly kind: "sessions" }
  // One arm with an optional focus: a session address always carries its session, so
  // `{sessionId, workflowPhase}` is writable in full. `#/session/<sid>/workflow/<rid>/phase/<pid>`
  // is a session address, not a destination, so the rail and the palette scope treat it as the
  // session. A parked phase needs an address because the places that link to it (a park banner,
  // a run row, a notification) are often in a window without the run pane.
  | {
      readonly kind: "session";
      readonly sessionId: string;
      /**
       * The phase this address is focused on, where it names one.
       *
       * Omitted, never set to `undefined`, so the round trip is exact under
       * `exactOptionalPropertyTypes`. Both ids are opaque wire values: routing owns the grammar
       * and never checks that they name a live run.
       */
      readonly workflowPhase?: {
        readonly workflowRunId: string;
        readonly phaseId: string;
      };
    }
  // Bare on purpose: this destination opens the `workflow-builder` pane, which carries its own
  // context, so a definition id here would be a second locator for something not yet defined.
  | { readonly kind: "workflows" }
  // Two arms, not one optional member: `#/settings` carries no page, so a selection without a
  // page is a value `formatRoute` cannot write down; the split makes it unrepresentable. The
  // selection is a bare string because `settings/` sits above this module and decides what a
  // page does with it.
  | { readonly kind: "settings"; readonly page: undefined }
  | { readonly kind: "settings"; readonly page: string; readonly selection?: string }
  // The pane harness a fixture launch registers. `parseRoute` produces it in every window; one
  // whose composition registered no harness renders it as not-found. The pane kind is a bare
  // string because the address arrives untyped; the screen holds it to `parsePaneAddress`, the
  // same predicate a restored layout snapshot is held to.
  | {
      readonly kind: "pane-harness";
      readonly paneKind: string;
      readonly sessionId: string;
    }
  | { readonly kind: "not-found"; readonly attempted: string };

/** The route a window with no hash lands on. */
export const DEFAULT_ROUTE: AppRoute = { kind: "sessions" };

/**
 * Parse a location hash into a route. Total: every input produces a route, so a malformed
 * percent-escape or an empty segment resolves to not-found and never throws or normalizes.
 */
export function parseRoute(hash: string): AppRoute {
  const afterHash = hash.startsWith("#") ? hash.slice(1) : hash;
  // The leading slash is the one optional separator; empty segments are kept so the arms below
  // can refuse them (`#/session//foo` must not open session `foo`).
  const path = afterHash.startsWith("/") ? afterHash.slice(1) : afterHash;

  if (path === "") {
    return DEFAULT_ROUTE;
  }

  const segments = path.split("/");
  const [head, ...rest] = segments;
  // `split` never returns an empty array; the `undefined` check is for the compiler.
  if (head === undefined || segments.includes("")) {
    return notFound(hash);
  }

  if (head === "sessions") {
    return rest.length === 0 ? { kind: "sessions" } : notFound(hash);
  }

  if (head === "session") {
    return sessionRoute(hash, rest);
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
      // The key is omitted, not set to `undefined`, so the round trip stays exact.
      return { kind: "settings", page };
    }
    const selection = decodeSegment(selectionSegment);
    return selection === undefined ? notFound(hash) : { kind: "settings", page, selection };
  }

  // `#/pane-harness/<paneKind>/<sessionId>`: both segments are required because the pane
  // bodies it mounts are session-scoped.
  if (head === "pane-harness") {
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

  return notFound(hash);
}

/** Render a route back to a hash; the exact inverse of `parseRoute`. */
export function formatRoute(route: AppRoute): string {
  switch (route.kind) {
    case "sessions":
      return "#/sessions";
    case "session": {
      const sessionAddress = `#/session/${encodeURIComponent(route.sessionId)}`;
      // The `workflow` and `phase` keywords must match `sessionRoute`'s.
      const { workflowPhase } = route;
      return workflowPhase === undefined
        ? sessionAddress
        : `${sessionAddress}/workflow/${encodeURIComponent(workflowPhase.workflowRunId)}/phase/${encodeURIComponent(workflowPhase.phaseId)}`;
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
    case "not-found":
      return route.attempted;
  }
}

/**
 * Decode one path segment, or `undefined` when its percent-escapes are malformed.
 *
 * The one guard for `decodeURIComponent`'s `URIError`, so every decode answers a malformed
 * escape the same way. A hash anyone can type is a probe, so `undefined` and not a refusal.
 */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * The two session screen addresses, read from the segments after `session`.
 *
 * The keyword positions are checked before the ids are decoded, so
 * `#/session/s/anything/r/phase/p` is not-found rather than a session address missing its focus.
 */
function sessionRoute(hash: string, rest: readonly string[]): AppRoute {
  const [sessionSegment, workflowKeyword, runSegment, phaseKeyword, phaseSegment] = rest;
  if (sessionSegment === undefined) {
    return notFound(hash);
  }
  const sessionId = decodeSegment(sessionSegment);
  if (sessionId === undefined) {
    return notFound(hash);
  }
  if (rest.length === 1) {
    // The key is omitted, not set to `undefined`, so `#/session/<id>` round-trips exactly.
    return { kind: "session", sessionId };
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
    : { kind: "session", sessionId, workflowPhase: { workflowRunId, phaseId } };
}

function notFound(attempted: string): AppRoute {
  return { kind: "not-found", attempted };
}
