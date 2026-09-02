// The announcer's mount: two regions that exist for the life of the window, and
// the context every surface reaches them through.
//
// WHY THE REGIONS RENDER HERE AND NOT AT THE CALL SITE. A live region has to be in
// the accessibility tree BEFORE the text it will speak arrives — see decision 1 in
// `live-announcer.ts`. So this provider renders both of them, empty, above whatever
// it wraps, and no other component in the console ever creates an `aria-live` node.
//
// WHY BOTH THE ROLE AND THE `aria-live` ATTRIBUTE. `role="status"` and
// `role="alert"` already imply `aria-live="polite"` / `"assertive"` and
// `aria-atomic="true"`, so the attributes are redundant on paper. They are written
// anyway because the redundancy is free and the failure it covers is silent: the
// pairing is honoured unevenly across screen-reader and browser combinations, and a
// region that is not announced looks exactly like a region nothing was sent to.
// `aria-atomic="true"` is the part that is NOT safely left implicit — without it a
// reader may speak only the changed text node, which for a message replacing a
// message is a fragment of a sentence.
//
// WHY THE REGIONS ARE OUTSIDE THE FRAME'S `inert` WRAPPER. `AppFrame` marks its
// background `inert` for the lifetime of a modal overlay, which takes everything
// under it out of the accessibility tree. A region under that attribute would go
// silent for exactly the period a person is most likely to be told a refusal — the
// one they just caused from inside the dialog. Rendering above the frame keeps them
// reachable, and costs no layout: `meridian-visually-hidden` is out of flow.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { type ConsoleClock } from "../core/index.js";
import { LiveAnnouncer, type Announce } from "./live-announcer.js";

const LiveAnnouncerContext = createContext<LiveAnnouncer | undefined>(undefined);

const OUTSIDE_PROVIDER =
  "useAnnounce was called outside <LiveAnnouncerProvider>. The console has one announcer per window, mounted by the frame, so that a surface can never speak through a region that was created at the moment it spoke.";

export interface LiveAnnouncerProviderProps {
  readonly children: ReactNode;
  /**
   * Override the announcer. Tests drive one over a `ManualClock`; the app passes
   * nothing and gets the window's own. A supplied announcer OUTLIVES this provider
   * and is never disposed here — the same ownership rule the bridge provider states
   * for an engine it did not build.
   */
  readonly announcer?: LiveAnnouncer;
  /**
   * The clock the announcer's hold deadline runs on.
   *
   * `Spec-023 §Console Design (Meridian)` §The fixture bridge: "the fixture clock
   * is the only clock the renderer reads in fixture mode". The announcer arms a
   * timeout, so an announcer left on the wall clock is a subsystem reaching past
   * the frozen one — a refusal raised in a scenario would clear on how fast the
   * runner happened to be rather than on the beat that advanced time, which makes
   * an accessibility assertion and a screenshot of a standing banner both
   * unrepeatable. The frame reads `useConsoleClock` and hands the answer down;
   * this family sits below the bridge in the DAG and cannot ask for itself.
   *
   * Ignored when `announcer` is supplied — that announcer arrived with its own.
   */
  readonly clock?: ConsoleClock;
}

/**
 * One announcer per window, and the two regions it speaks through.
 *
 * The announcer is held as STATE rather than in a memo for the reason the bridge
 * provider states: it owns a timer and a sink set, and React documents a memo's
 * cache as discardable, so a recomputed announcer would leave the region subscribed
 * to an object nothing announces through. The re-mint arm is the double-mount case
 * — StrictMode runs the effect, tears it down, and runs it again, so the second
 * pass finds an announcer its own teardown already disposed.
 */
export function LiveAnnouncerProvider(props: LiveAnnouncerProviderProps): React.JSX.Element {
  // Pinned at mount for the reason the announcer itself is state: the window runs
  // on one clock for its life, and the re-mint arm below has to build the second
  // announcer on the same one the first was built on. A caller reading the clock
  // in its own render body would otherwise hand a new identity down every pass.
  const [clock] = useState<ConsoleClock | undefined>(() => props.clock);
  const [ownedAnnouncer, setOwnedAnnouncer] = useState<LiveAnnouncer>(() => mintAnnouncer(clock));
  const suppliedAnnouncer = props.announcer;
  const announcer = suppliedAnnouncer ?? ownedAnnouncer;

  useEffect(() => {
    if (suppliedAnnouncer !== undefined) {
      return undefined;
    }
    if (ownedAnnouncer.isDisposed) {
      setOwnedAnnouncer(mintAnnouncer(clock));
      return undefined;
    }
    return () => {
      ownedAnnouncer.dispose();
    };
  }, [suppliedAnnouncer, ownedAnnouncer, clock]);

  return (
    <LiveAnnouncerContext.Provider value={announcer}>
      <LiveRegion announcer={announcer} />
      {props.children}
    </LiveAnnouncerContext.Provider>
  );
}

/**
 * The window's announcer, on the clock it was given.
 *
 * The absent arm passes no `clock` member at all rather than an explicit
 * `undefined`: `LiveAnnouncerOptions` declares the member optional under
 * `exactOptionalPropertyTypes`, so the two are different types and only one of
 * them reaches the constructor's own `RealClock` default.
 */
function mintAnnouncer(clock: ConsoleClock | undefined): LiveAnnouncer {
  return new LiveAnnouncer(clock === undefined ? {} : { clock });
}

/**
 * How a surface says something. Throws outside the provider rather than returning a
 * no-op: a component announcing into nothing is a wiring bug that is invisible to
 * everyone who can see the screen, which is the one class of defect this primitive
 * exists to prevent.
 */
export function useAnnounce(): Announce {
  const announcer = useContext(LiveAnnouncerContext);
  if (announcer === undefined) {
    throw new Error(OUTSIDE_PROVIDER);
  }
  return announcer.announce;
}

interface LiveRegionProps {
  readonly announcer: LiveAnnouncer;
}

/**
 * The two regions. Rendered once per window and never conditionally.
 *
 * `useSyncExternalStore` rather than a `useState` an effect writes into: an
 * announcement raised between this component's render and its subscription would be
 * missed by the effect shape, and a missed announcement is silent by construction.
 * The announcer holds one snapshot object between changes, so the comparison is a
 * pointer check and an unchanged region costs no render.
 */
function LiveRegion(props: LiveRegionProps): React.JSX.Element {
  const { announcer } = props;
  const subscribe = useCallback(
    (onStoreChange: () => void) => announcer.subscribe(onStoreChange),
    [announcer],
  );
  const read = useCallback(() => announcer.state, [announcer]);
  const announced = useSyncExternalStore(subscribe, read, read);
  return (
    <>
      <div
        className="meridian-visually-hidden"
        data-live-region="polite"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announced.polite}
      </div>
      <div
        className="meridian-visually-hidden"
        data-live-region="assertive"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        {announced.assertive}
      </div>
    </>
  );
}
