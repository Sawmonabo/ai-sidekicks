// The app's routes as data. Hash routing, because the renderer is served from a custom
// `sidekicks-renderer://` scheme whose handler resolves one document
// (`main/services/renderer/protocol.ts`); a hash carries state after the `#` without asking it
// for another path. A malformed hash resolves to the not-found route, never a blank screen.

/** Where the app currently is. A closed union: every arm renders something. */
export type AppRoute =
  | { readonly kind: "sessions" }
  // A session, opened at one message where the address names one. The message is its event
  // cursor, a bare string because the daemon issued it and only the transcript reads it; the
  // transcript decides what an unknown one shows.
  | { readonly kind: "session"; readonly sessionId: string; readonly messageAnchorCursor?: string }
  // Two arms, as Settings has: `#/workflows` names no tab, and `#/workflows/runs` names the Runs
  // tab, with one run's page under it. A run id is a bare string because the run page decides
  // what an unknown one shows.
  | { readonly kind: "workflows"; readonly tab?: undefined }
  | { readonly kind: "workflows"; readonly tab: "runs"; readonly runId?: string }
  // Three arms: the library at `#/sidekicks`, a new definition at `#/sidekicks/new` and a saved
  // one at `#/sidekicks/<definitionId>`, so `new` is never an id. The id is a bare string because
  // the agents feature decides what an unknown one shows; ids are daemon-minted UUIDs, so neither
  // `new` nor `plugins` is ever one.
  | { readonly kind: "sidekicks"; readonly definition?: undefined }
  | { readonly kind: "sidekicks"; readonly definition: "new" }
  | { readonly kind: "sidekicks"; readonly definition: "saved"; readonly definitionId: string }
  // `Browse plugins`, at `#/sidekicks/plugins`.
  | { readonly kind: "sidekicks-plugins" }
  // Three arms: the list at `#/skills`, the new-skill form at `#/skills?new` and one folder at
  // `#/skills/<skillId>`, opened at its entry file or, with `filePath`, at one other file. The
  // form's address is a query, so a folder named `new` keeps its real name. The file path is
  // relative to the folder and spans the remaining segments, one escaped segment per name.
  | { readonly kind: "skills"; readonly folder?: undefined }
  | { readonly kind: "skills"; readonly folder: "new" }
  | {
      readonly kind: "skills";
      readonly folder: "existing";
      readonly skillId: string;
      readonly filePath?: string;
    }
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

  // The new-skill form is the one address with a query; `formatRoute` escapes every other `?`.
  if (path.includes("?")) {
    return path === "skills?new" ? { kind: "skills", folder: "new" } : notFound(hash);
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
    return parseSessionRoute(rest, hash);
  }

  if (head === "workflows") {
    return parseWorkflowsRoute(rest, hash);
  }

  if (head === "sidekicks") {
    return parseSidekicksRoute(rest, hash);
  }

  if (head === "skills") {
    return parseSkillsRoute(rest, hash);
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
      return route.messageAnchorCursor === undefined
        ? sessionAddress
        : `${sessionAddress}/${encodeURIComponent(route.messageAnchorCursor)}`;
    }
    case "workflows": {
      if (route.tab === undefined) {
        return "#/workflows";
      }
      return route.runId === undefined
        ? "#/workflows/runs"
        : `#/workflows/runs/${encodeURIComponent(route.runId)}`;
    }
    case "sidekicks":
      if (route.definition === undefined) {
        return "#/sidekicks";
      }
      return route.definition === "new"
        ? "#/sidekicks/new"
        : `#/sidekicks/${encodeURIComponent(route.definitionId)}`;
    case "sidekicks-plugins":
      return "#/sidekicks/plugins";
    case "skills": {
      if (route.folder === undefined) {
        return "#/skills";
      }
      if (route.folder === "new") {
        return "#/skills?new";
      }
      const folderAddress = `#/skills/${encodeURIComponent(route.skillId)}`;
      return route.filePath === undefined
        ? folderAddress
        : `${folderAddress}/${route.filePath.split("/").map(encodeURIComponent).join("/")}`;
    }
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
      return (
        `#/pane-harness/${encodeURIComponent(route.paneKind)}` +
        `/${encodeURIComponent(route.sessionId)}`
      );
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
 * `#/session/<sessionId>` and `#/session/<sessionId>/<messageAnchorCursor>`, and nothing deeper.
 */
function parseSessionRoute(rest: readonly string[], hash: string): AppRoute {
  const [sessionSegment, messageSegment] = rest;
  if (sessionSegment === undefined || rest.length > 2) {
    return notFound(hash);
  }
  const sessionId = decodeSegment(sessionSegment);
  if (sessionId === undefined) {
    return notFound(hash);
  }
  if (messageSegment === undefined) {
    // The key is omitted, not set to `undefined`, so the round trip stays exact.
    return { kind: "session", sessionId };
  }
  const messageAnchorCursor = decodeSegment(messageSegment);
  return messageAnchorCursor === undefined
    ? notFound(hash)
    : { kind: "session", sessionId, messageAnchorCursor };
}

/** `#/workflows`, `#/workflows/runs` and `#/workflows/runs/<runId>`, and nothing deeper. */
function parseWorkflowsRoute(rest: readonly string[], hash: string): AppRoute {
  const [tabSegment, runSegment] = rest;
  if (tabSegment === undefined) {
    return { kind: "workflows" };
  }
  if (tabSegment !== "runs" || rest.length > 2) {
    return notFound(hash);
  }
  if (runSegment === undefined) {
    // The key is omitted, not set to `undefined`, so the round trip stays exact.
    return { kind: "workflows", tab: "runs" };
  }
  const runId = decodeSegment(runSegment);
  return runId === undefined ? notFound(hash) : { kind: "workflows", tab: "runs", runId };
}

/**
 * `#/sidekicks`, `#/sidekicks/new`, `#/sidekicks/plugins` and `#/sidekicks/<definitionId>`, and
 * nothing deeper.
 */
function parseSidekicksRoute(rest: readonly string[], hash: string): AppRoute {
  const [definitionSegment] = rest;
  if (definitionSegment === undefined) {
    return { kind: "sidekicks" };
  }
  if (rest.length > 1) {
    return notFound(hash);
  }
  if (definitionSegment === "new") {
    return { kind: "sidekicks", definition: "new" };
  }
  if (definitionSegment === "plugins") {
    return { kind: "sidekicks-plugins" };
  }
  const definitionId = decodeSegment(definitionSegment);
  return definitionId === undefined
    ? notFound(hash)
    : { kind: "sidekicks", definition: "saved", definitionId };
}

/**
 * `#/skills`, `#/skills/<skillId>` and `#/skills/<skillId>/<file path>`, the path spanning every
 * remaining segment; the form's `#/skills?new` is read before the path is split.
 */
function parseSkillsRoute(rest: readonly string[], hash: string): AppRoute {
  const [skillSegment, ...fileSegments] = rest;
  if (skillSegment === undefined) {
    return { kind: "skills" };
  }
  const skillId = decodeSegment(skillSegment);
  if (skillId === undefined) {
    return notFound(hash);
  }
  if (fileSegments.length === 0) {
    // The key is omitted, not set to `undefined`, so the round trip stays exact.
    return { kind: "skills", folder: "existing", skillId };
  }
  const fileNames = fileSegments.map(decodeSegment);
  if (fileNames.some((fileName) => fileName === undefined)) {
    return notFound(hash);
  }
  return { kind: "skills", folder: "existing", skillId, filePath: fileNames.join("/") };
}

function notFound(attempted: string): AppRoute {
  return { kind: "not-found", attempted };
}
