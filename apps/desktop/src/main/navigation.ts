// Navigation policy for every window this process constructs — Plan-023 Phase 1B
// (T-023p-1B-2).
//
// `Spec-023 §Security Hardening Baseline` locks the `webPreferences` block, and
// `assert-webprefs.ts` keeps it locked. That block governs what the renderer CAN
// do; it says nothing about where the renderer may GO. A hardened window is
// still a window: a link, a redirect, or a compromised dependency can navigate
// the top-level frame at a remote origin, and from that moment the locked block
// is protecting attacker-served content instead of ours — same preload, same
// bridge, same `sidekicks-renderer://`-partitioned IndexedDB. Electron's own
// security checklist names both halves (limit navigation; limit creation of new
// windows), and neither is on by default.
//
// The policy is one closed classification, applied at two seams:
//
//   `will-navigate`          — top-level navigation the page initiated.
//   `setWindowOpenHandler`   — a popup / `window.open` / `target="_blank"`.
//
// Popups are denied UNCONDITIONALLY, same origin included. A second window is
// only ever created here by `createAuxiliaryWindow`, which runs the locked
// factory; a renderer-opened one would be created by Chromium with options this
// process never reviewed, and there is no console surface that needs one.
//
// External `http(s)` targets are not simply dropped: a dropped link is a dead
// link, and the console has legitimate ones (docs, a provider's sign-in page,
// a release note). They go to the OS browser through a MAIN-owned
// `shell.openExternal` call behind a scheme allowlist. Everything else —
// `file:`, `javascript:`, `data:`, `blob:`, a custom scheme some installed app
// registered — is refused with no side effect at all. That closed allowlist is
// the point: `shell.openExternal` hands a string to the operating system's
// handler registry, so an unfiltered call is a local-code-execution primitive,
// not a link.
//
// Pure classification lives in `classifyNavigation`, which touches no Electron
// API, so every arm of the matrix is unit-testable without a window.

import { shell } from "electron";

/**
 * Schemes a refused in-window navigation may be handed to the OS browser under.
 *
 * `http:` rides beside `https:` because a self-hosted control plane or relay on
 * a LAN is a supported deployment (ADR-020), and its console links are plain
 * HTTP. The browser, not this process, is the
 * security boundary for what happens after the handoff; what this list is for is
 * making sure the handoff is to a BROWSER and not to whatever the OS has
 * registered for `ms-msdt:` this week.
 */
export const EXTERNAL_URL_SCHEME_ALLOWLIST: readonly string[] = ["https:", "http:"];

/**
 * One in-window origin: a scheme and an authority.
 *
 * A pair rather than an origin string because `URL.origin` is `"null"` for every
 * non-special scheme, and `sidekicks-renderer:` is non-special in Node's WHATWG
 * parser (Chromium gives it an origin because the scheme is registered
 * `standard: true` there, but this classification runs in the main process). A
 * comparison on `.origin` would therefore compare `"null"` to `"null"` and admit
 * every non-special scheme in existence.
 */
export interface InWindowOrigin {
  readonly protocol: string;
  readonly host: string;
}

/** What a window may do with a navigation target. */
export type NavigationVerdict =
  | { readonly kind: "in-window" }
  | { readonly kind: "external" }
  | { readonly kind: "refused"; readonly reason: string };

const IN_WINDOW: NavigationVerdict = { kind: "in-window" };
const EXTERNAL: NavigationVerdict = { kind: "external" };

/**
 * Classifies one navigation target against the origins a window may navigate
 * within.
 *
 * Fail-closed at every step: an unparseable target, a credentialed authority, or
 * any scheme outside the two lists is `refused`. Nothing here echoes the target
 * back into the verdict — a refusal reason names the CLASS, so a diagnostic
 * cannot become the log line that carries an attacker's string.
 */
export function classifyNavigation(
  targetUrl: string,
  inWindowOrigins: readonly InWindowOrigin[],
): NavigationVerdict {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return { kind: "refused", reason: "unparseable navigation target" };
  }

  // Credentials in the authority are a phishing shape (`https://app@evil.test`)
  // and no legitimate console target carries them.
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    return { kind: "refused", reason: "navigation target carries credentials" };
  }

  const host = parsedUrl.host.toLowerCase();
  const protocol = parsedUrl.protocol.toLowerCase();

  for (const origin of inWindowOrigins) {
    if (origin.protocol.toLowerCase() === protocol && origin.host.toLowerCase() === host) {
      return IN_WINDOW;
    }
  }

  if (EXTERNAL_URL_SCHEME_ALLOWLIST.includes(protocol)) {
    return EXTERNAL;
  }

  return { kind: "refused", reason: "navigation target is outside every allowed scheme" };
}

/**
 * Hands an allowlisted external target to the OS browser.
 *
 * Deferred by one turn: `setWindowOpenHandler` runs synchronously inside
 * Chromium's window-open path, and Electron's own security guidance opens
 * externally from a deferred callback rather than re-entering the browser
 * process from inside that call. `setImmediate` is a one-shot callback, not a
 * repeating timer — nothing here keeps the event loop alive past the open.
 *
 * The scheme is re-checked here rather than trusted from the caller's verdict.
 * This function is the single place a URL reaches `shell.openExternal`, and a
 * guard that only holds when the caller remembered to classify first is not a
 * guard.
 */
export function openExternalUrl(targetUrl: string): void {
  const verdict = classifyNavigation(targetUrl, []);
  if (verdict.kind !== "external") {
    console.error(
      `[ai-sidekicks/desktop] refused to open an external URL: ${
        verdict.kind === "refused" ? verdict.reason : "target is an in-window origin"
      }`,
    );
    return;
  }

  setImmediate(() => {
    shell.openExternal(targetUrl).catch((error: unknown) => {
      // The OS declined to open it. Nothing to retry and nothing to fall back
      // to; structured logging routes through Sentry main at the Tier-8
      // remainder, and until then this is the record.
      console.error("[ai-sidekicks/desktop] shell.openExternal failed:", error);
    });
  });
}
