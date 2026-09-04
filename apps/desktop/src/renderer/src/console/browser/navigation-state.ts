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

import type { ConsoleBridge } from "../bridge/index.js";
import { refusalFromRejection, type ConsoleRefusal } from "../core/index.js";

/** The subsystem name every refusal this module raises itself carries. */
const NAVIGATION_REFUSAL_ORIGIN = "browser-navigation";

/**
 * What a broken navigation subscription refuses under, when the failure carries no
 * code of its own.
 *
 * The subscription crosses the preload boundary, and a boundary that fails — a
 * torn-down transport, a preload that never installed, a producer that dies
 * mid-stream — REJECTS rather than answering with a refusal. Left unhandled that was
 * an unhandled rejection in the renderer and a pane held forever in the state it has
 * before any read answers: no reading and no refusal, so every history control stayed
 * disabled and nothing on screen said why.
 *
 * The code is distinct from the pane's `navigation-call-failed`, which is one act
 * that did not answer: this is the READING going away, and the difference is what a
 * person needs to know. A retry of a control is a different remedy from a pane that
 * has stopped being told anything at all — which is why the sentence names the
 * remedy for THIS failure rather than repeating the thrown value's message.
 *
 * It is a fallback and not a mapping. `refusalFromRejection` is the console's one
 * rejection normalizer, and it is what runs here: a refusal the bridge itself raised
 * travels through untouched because it already names its own author, and a typed wire
 * envelope keeps its own code and message, since flattening `browser.pane_not_found`
 * into this module's generic one would throw away the only actionable half. This pair
 * is reached only where neither of those applies. A second mapping stood here and
 * re-derived three of that function's four arms, which is one arm short of it — a
 * bare `ConsoleRefusal` travelling as a rejection was re-coded under this module's
 * own name.
 */
const SUBSCRIPTION_FAILURE_FALLBACK = {
  code: "navigation-subscription-failed",
  detail:
    "The page's navigation state is no longer being reported to this window. Closing the pane and opening it again starts a new subscription.",
};

/** The subscription's own outcome type, and the three shapes read out of it. */
type NavigationOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserSubscribeNavigation"]>>;
type NavigationStream = Extract<NavigationOutcome, { readonly status: "served" }>["value"];
type NavigationState = NavigationStream extends { readonly events: AsyncIterable<infer Event> }
  ? Event
  : never;
/** What any one navigation act answers with. Every chrome control dispatches one. */
export type NavigationActOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["browserGoBack"]>>;

/**
 * What the pane knows about the page right now.
 *
 * Four arms rather than a pair of optional fields, because the fourth is a fact and
 * not the absence of one: a subscription that ENDED cleanly is neither a reading nor
 * a refusal, and a pane holding the last state it was sent presents a URL, a title,
 * and two history flags as current while nothing is reporting them any more. The
 * closed union is what makes that arm impossible to leave unhandled — a consumer
 * switching over it stops compiling until it says what an ended subscription renders.
 *
 * `ended` deliberately carries no last state. It is exactly the value a chrome must
 * not present as live, and an arm that carried it would be an invitation to.
 */
export type NavigationReading =
  /**
   * Nothing has answered yet. Not "no page" — no question has come back.
   *
   * Also what a pane reads the moment its SUBJECT changes. A hook instance handed a
   * different pane or a different bridge has asked a new question and has no answer
   * to it, which is this arm exactly.
   */
  | { readonly status: "unread" }
  | { readonly status: "reported"; readonly state: NavigationState }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal }
  /** The producer finished. The pane was being told, and is not being told now. */
  | { readonly status: "ended" };

/** The reading before any subject has been answered, and after one has changed. */
const UNREAD_NAVIGATION: NavigationReading = { status: "unread" };

/**
 * A reading and the `(bridge, paneId)` it was read under.
 *
 * The reading alone is not a fact about anything: it is a fact about ONE pane on ONE
 * bridge, and a hook instance outlives both. React reuses the instance across a prop
 * change, so a deck that swaps which pane a slot holds replaces the effect and its
 * subscription while the state still holds the previous pane's frame — and until the
 * replacement stream produces one, the chrome presented the OLD page's URL and
 * enabled its history controls while dispatching Back and Forward against the NEW
 * `paneId`. That is not a stale render; it is one pane's reading driving another
 * pane's acts.
 *
 * So the reading travels with its subject and the hook compares before returning it.
 * A stamp rather than a reset-in-an-effect, because a reset is a second render pass
 * that the first pass — the one that dispatches — happens before.
 */
interface StampedNavigationReading {
  readonly bridge: ConsoleBridge;
  readonly paneId: string;
  readonly reading: NavigationReading;
}

/**
 * Subscribe to the view's reported navigation state for the life of the pane.
 *
 * Both arms are implemented — the refusing arm is what runs today, and the
 * served arm drains the stream and closes it on unmount — so the day the wire lands the
 * pane is not meeting its own subscription for the first time.
 *
 * FOUR WAYS IT CAN END, and all four are handled here: the port refuses, the call
 * rejects, the served iterator throws part-way through, or the producer simply
 * FINISHES. The middle two are one `catch`, because a subscription that broke and a
 * subscription that never opened leave the pane in the same place — with no reading —
 * and the only honest thing to put on screen for either is the refusal saying so.
 *
 * The fourth is not a failure and is not nothing. Falling out of the loop left the
 * bridge handle allocated for the life of the mount and left the chrome presenting
 * the last URL, title, and history flags as current — a pane acting on a page nobody
 * is reporting. So the same close the failing path runs happens here too, and the
 * reading says the subscription is over rather than staying on its final frame.
 *
 * AND THE READING IS STAMPED TO ITS SUBJECT. Every write carries the `(bridge,
 * paneId)` the subscription was opened under, and the return compares that stamp
 * against the subject this render is for: a mismatch reads `unread`, so a changed
 * pane renders its designed unread arm — no URL, no history controls — until the new
 * stream's first frame, and a frame from the old stream that arrives after the
 * change is dropped by the same comparison rather than by the cancellation flag
 * alone.
 */
export function useReportedNavigation(bridge: ConsoleBridge, paneId: string): NavigationReading {
  const [stamped, setStamped] = useState<StampedNavigationReading>({
    bridge,
    paneId,
    reading: UNREAD_NAVIGATION,
  });

  useEffect(() => {
    let stream: NavigationStream | undefined;
    let cancelled = false;
    /** Publish a reading under the subject THIS effect subscribed to, never another. */
    const setReading = (reading: NavigationReading): void => {
      setStamped({ bridge, paneId, reading });
    };
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
          setReading({ status: "refused", refusal: outcome });
          return;
        }
        stream = outcome.value;
        for await (const state of stream.events) {
          if (cancelled) {
            return;
          }
          setReading({ status: "reported", state });
        }
        // The producer finished. The stream goes for the same reason it goes on the
        // failing path — a handle nobody will read again is a handle to close — and
        // the reading stops claiming the frame it stopped on.
        closeStream();
        if (!cancelled) {
          setReading({ status: "ended" });
        }
      } catch (failure) {
        // The stream goes first and unconditionally: a producer that threw part-way
        // is still a subscription somebody has to end, and a failure after the pane
        // has gone publishes nothing — there is no surface left to read it.
        closeStream();
        if (!cancelled) {
          setReading({
            status: "refused",
            refusal: refusalFromRejection(
              NAVIGATION_REFUSAL_ORIGIN,
              failure,
              SUBSCRIPTION_FAILURE_FALLBACK,
            ),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      closeStream();
    };
  }, [bridge, paneId]);

  // The comparison the whole stamp exists for, and it runs on the render that
  // dispatches rather than one after it.
  return stamped.bridge === bridge && stamped.paneId === paneId
    ? stamped.reading
    : UNREAD_NAVIGATION;
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
