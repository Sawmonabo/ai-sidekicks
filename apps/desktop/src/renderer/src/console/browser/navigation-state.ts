// What the pane KNOWS about the page, as opposed to what it draws.
//
// `Spec-023 §Console Design (Meridian)` 12.2 turns on one rule — "the chrome never
// derives navigability" — and that rule only holds if there is exactly one place the
// reading comes from. So the subscription and the shape it yields live here, apart
// from the component that renders them, and the component holds no second copy of
// either. The address field's filesystem guard is here for the same reason: it is a
// decision about a destination, not about a layout, and it is the kind of predicate
// that has to be driveable from a test without mounting a pane.
//
// The shapes are DERIVED from the growth port rather than restated. Writing
// `{ url, title, isLoading, canGoBack, canGoForward }` out again would be a second
// declaration of a contract this family does not own, and the two would agree only
// until somebody widened one.

import { useEffect, useState } from "react";

import { isWireErrorEnvelope, normalizeWireRejection } from "../../../../shared/wire-errors.js";
import type { ConsoleBridge } from "../bridge/index.js";
import { ConsoleRefusalError, refuse, type ConsoleRefusal } from "../core/index.js";

/** The subsystem name every refusal this module raises itself carries. */
const NAVIGATION_REFUSAL_ORIGIN = "browser-navigation";

/**
 * The code a broken subscription refuses under, when the failure carries none.
 *
 * Distinct from the pane's `navigation-call-failed`, which is one act that did not
 * answer: this is the READING going away, and the difference is what a person needs
 * to know. A retry of a control is a different remedy from a pane that has stopped
 * being told anything at all.
 */
const SUBSCRIPTION_FAILED_CODE = "navigation-subscription-failed";

/**
 * What a broken navigation subscription renders as.
 *
 * The subscription crosses the preload boundary, and a boundary that fails — a
 * torn-down transport, a preload that never installed, a producer that dies
 * mid-stream — REJECTS rather than answering with a refusal. Left unhandled that was
 * an unhandled rejection in the renderer and a pane held forever in the state it has
 * before any read answers: no reading and no refusal, so every history control stayed
 * disabled and nothing on screen said why.
 *
 * A refusal the bridge itself raised travels through untouched, because it already
 * names its own origin and code. A typed wire envelope keeps its own code too, since
 * flattening `browser.pane_not_found` into this module's generic one would throw away
 * the only actionable half. Everything else becomes this module's code, and every arm
 * carries the thrown message verbatim in the sentence — `normalizeWireRejection` is
 * the console's one wire-rejection reader, `total` because a rejection reaching a
 * renderer is arbitrary `unknown` and a stringify that threw here would replace the
 * refusal with a crash.
 */
function navigationSubscriptionRefusal(failure: unknown): ConsoleRefusal {
  if (failure instanceof ConsoleRefusalError) {
    return failure.refusal;
  }
  const code = isWireErrorEnvelope(failure) ? failure.code : SUBSCRIPTION_FAILED_CODE;
  const reported = normalizeWireRejection(failure, { total: true }).message;
  return refuse(
    NAVIGATION_REFUSAL_ORIGIN,
    code,
    `The page's navigation state is no longer being reported to this window: ${reported}`,
  );
}

/** The subscription's own outcome type, and the three shapes read out of it. */
type NavigationOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserSubscribeNavigation"]>>;
type NavigationStream = Extract<NavigationOutcome, { readonly status: "served" }>["value"];
type NavigationState = NavigationStream extends { readonly events: AsyncIterable<infer Event> }
  ? Event
  : never;
/** What any one navigation act answers with. Every chrome control dispatches one. */
export type NavigationActOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserGoBack"]>>;

/** What the pane knows about the page right now. Both fields absent until a read answers. */
export interface NavigationReading {
  readonly state: NavigationState | undefined;
  readonly refusal: ConsoleRefusal | undefined;
}

/**
 * Subscribe to the view's reported navigation state for the life of the pane.
 *
 * Both arms are implemented — the refusing arm is what runs today, and the
 * served arm drains the stream and closes it on unmount — so the day the wire lands the
 * pane is not meeting its own subscription for the first time.
 *
 * THREE WAYS IT CAN END, and all three are handled here: the port refuses, the call
 * rejects, or the served iterator throws part-way through. The last two are one
 * `catch`, because a subscription that broke and a subscription that never opened
 * leave the pane in the same place — with no reading — and the only honest thing to
 * put on screen for either is the refusal saying so.
 */
export function useReportedNavigation(bridge: ConsoleBridge, paneId: string): NavigationReading {
  const [reading, setReading] = useState<NavigationReading>({
    state: undefined,
    refusal: undefined,
  });

  useEffect(() => {
    let stream: NavigationStream | undefined;
    let cancelled = false;
    /** Close the acquired stream at most once, from whichever path reaches it first. */
    const closeStream = (): void => {
      const acquired = stream;
      stream = undefined;
      acquired?.close();
    };
    void (async () => {
      try {
        const outcome = await bridge.growth.browserSubscribeNavigation({ paneId });
        if (cancelled) {
          // Whoever finishes last owns the stream. Cleanup ran while `stream` was
          // still undefined — there was nothing for it to close — so a stream served
          // after that point is closed HERE or never: dropping it leaves the bridge
          // subscription and the producer behind it alive for the life of the
          // window, once per open/close cycle, and quick cycling is exactly what a
          // pane deck invites.
          if (outcome.status === "served") {
            outcome.value.close();
          }
          return;
        }
        if (outcome.status === "unavailable") {
          setReading({ state: undefined, refusal: outcome });
          return;
        }
        stream = outcome.value;
        for await (const state of stream.events) {
          if (cancelled) {
            return;
          }
          setReading({ state, refusal: undefined });
        }
      } catch (failure) {
        // The stream goes first and unconditionally: a producer that threw part-way
        // is still a subscription somebody has to end, and a failure after the pane
        // has gone publishes nothing — there is no surface left to read it.
        closeStream();
        if (!cancelled) {
          setReading({ state: undefined, refusal: navigationSubscriptionRefusal(failure) });
        }
      }
    })();
    return () => {
      cancelled = true;
      closeStream();
    };
  }, [bridge, paneId]);

  return reading;
}

/**
 * Whether a destination names a place on this machine's disk.
 *
 * 12.2: "The address field never accepts a filesystem path. Local files open through
 * the file control, which runs the boundary check of 12.5." Deliberately broad,
 * because every spelling it misses is a page navigating to a local file — and that
 * failure is silent, since a navigation to `C:secret.txt` looks like a successful
 * navigation to everything above this predicate.
 *
 * Breadth is spelled as the ROOTS a local path can start from rather than as a list of
 * examples, because Windows has more of them than the ones with separators in the
 * obvious places:
 *
 *   • `file:` — the scheme, whatever follows it.
 *   • A leading `/` — POSIX root, and with it the forward-slash UNC form
 *     `//server/share`: Win32 takes either separator, so both spellings land here.
 *   • A leading backslash — every backslash-rooted Windows form at once. Root-relative
 *     `\Windows\System32` resolves against the current drive; UNC `\\server\share`,
 *     the extended-length `\\?\C:\...` prefix, and the device namespace `\\.\pipe\...`
 *     differ from it only in what follows the first separator.
 *   • `~` — the home shorthand.
 *   • A drive letter and a colon — `C:\Windows` and `C:/Windows`, but ALSO the
 *     drive-relative `C:secret.txt` and the bare `C:`, which resolve against that
 *     drive's current directory and carry no separator at all. The arm is therefore
 *     the letter and the colon, with nothing required after them.
 *
 * The last arm refuses a hypothetical one-letter URI scheme with it. No such scheme is
 * registered, and refusing a destination that cannot be reached is the cheap direction;
 * admitting one that reads a file is not.
 */
export function isFilesystemDestination(destination: string): boolean {
  const trimmed = destination.trim();
  return (
    /^file:/iu.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("\\") ||
    /^[a-z]:/iu.test(trimmed)
  );
}
