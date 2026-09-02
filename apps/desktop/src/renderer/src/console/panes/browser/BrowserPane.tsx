// The browser pane's chrome — the same command over the page that the agent has.
//
// `Spec-023 §Console Design (Meridian)` 12.2. Every control dispatches into the SAME
// page registry the tool set drives, reached through a differently authorized surface,
// and the chrome derives nothing: back and forward are enabled from the view's own
// REPORTED history state, never from a count the renderer kept.
//
// WHAT IS BUILT AND WHAT RENDERS ITS ABSENCE. The console's growth port carries five
// pane-keyed navigation verbs and one navigation subscription, and nothing else —
// `Plan-023 §Console growth slate` row `browser-pane-namespace` still owes the rest. So
// the destination field, back, forward, the reload/stop slot, and the escape to the
// system browser are BUILT, each dispatching a registered operation and rendering the
// refusal it gets back today; the tab strip, the page picker, capture, pick element,
// developer tools, and site-data reset are not drawn as dead buttons. They render the
// not-checked absence, because rule 8 forbids saying "no pages" when the truth is
// "nobody asked".
//
// The close-tab chord IS wired, because of what happens if it is not: the platform
// chord reaching the window closes the WINDOW. The pane captures it, prevents the
// default, and renders the refusal naming the missing verb — the difference between an
// unbuilt feature and a destroyed session.
//
// Three surfaces beside the chrome, all from this family: `navigation-state.ts` is the
// single reading the chrome derives nothing beyond, the geometry publisher keeps the
// eventual native view exactly inside this pane's rectangle (12.3), and the budget
// meter is the resource ceiling one click away (12.10, rule 7). They are imported by
// module rather than through `browser/index.js`, which re-exports this component — a
// barrel import here would close a cycle the layering gate refuses.

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { BudgetMeter } from "../../browser/BudgetMeter.js";
import {
  PaneGeometryPublisher,
  type PaneGeometryOutcome,
} from "../../browser/geometry-publisher.js";
import {
  addressFieldSubmission,
  addressFieldValue,
  editingAddressField,
  FOLLOWING_ADDRESS_FIELD,
  type AddressFieldState,
} from "../../browser/address-field-model.js";
import { describeChordEvent, isCloseTabChord } from "../../browser/keyboard-handback.js";
import {
  isFilesystemDestination,
  useReportedNavigation,
  type NavigationActOutcome,
} from "../../browser/navigation-state.js";
import { consoleOcclusionRegistry } from "../../browser/occlusion-registry.js";
import { resolvePaneViewHost } from "../../browser/view-host.js";
import { ConsoleRefusalError, RealClock, refuse, type ConsoleRefusal } from "../../core/index.js";
import { HOST_CHORD_PLATFORM, Nothing, RefusalBanner } from "../../primitives/index.js";
import { tokenReference } from "../../tokens/index.js";
import { ChromeControl } from "./ChromeControl.js";
import type { ConsolePaneContext } from "../../workspace/index.js";

/** The subsystem name every refusal this pane raises itself carries. */
const BROWSER_PANE_REFUSAL_ORIGIN = "browser-pane";

/**
 * What a REJECTED bridge promise renders as.
 *
 * Every call this pane makes crosses the preload boundary, and a boundary that fails
 * — a torn-down transport, a preload that never installed — rejects rather than
 * answering with a refusal. Left unhandled that is an unhandled rejection in the
 * renderer and a pane still showing whatever was on screen before the click, which
 * is the failure mode a refusal exists to replace.
 *
 * A refusal the bridge itself raised travels through untouched, because it already
 * names its own origin and code; anything else becomes this pane's sentence. Hoisted
 * out of the two call sites that now share it rather than written twice: two
 * normalizers drift, and the second one to drift is the one nobody reads.
 */
function bridgeRejectionRefusal(failure: unknown, code: string, detail: string): ConsoleRefusal {
  return failure instanceof ConsoleRefusalError
    ? failure.refusal
    : refuse(BROWSER_PANE_REFUSAL_ORIGIN, code, detail);
}

/** The pane region's accessible name. The tab strip's own labels arrive with it. */
const BROWSER_PANE_LABEL = "Browser";

/** Carries this pane's attribution hue into the shell's inline-start edge. */
interface PaneAttributionStyle extends React.CSSProperties {
  readonly "--meridian-browser-pane-hue": string;
}

/** One publisher over the host this window actually has. Pure: it arms nothing. */
function createGeometryPublisher(): PaneGeometryPublisher {
  return new PaneGeometryPublisher({
    host: resolvePaneViewHost({}),
    clock: new RealClock(),
    occlusion: consoleOcclusionRegistry,
  });
}

/**
 * Publish this pane's rectangle for the life of the mount, and RENDER what the host
 * said back.
 *
 * The outcome is subscribed rather than copied. `observe` only queues the first
 * write, so a value read straight after it is `undefined` by construction — and
 * everything after it, the `pane-gone` rejection above all, would then land in the
 * publisher and reach nobody, leaving the viewport saying "no page yet" over a host
 * that has said this pane is destroyed. `useSyncExternalStore` rather than a
 * `useState` an effect writes into, for `LiveAnnouncerProvider`'s reason: an outcome
 * recorded between this component's render and its subscription is missed by the
 * effect shape, and a missed refusal is silent by construction.
 *
 * The publisher is minted in a `useState` initializer and RE-MINTED when the state
 * holds a disposed one, which is `frame/ui-state-lifecycle.ts`'s shape for the same
 * hazard: React's double-mount runs the cleanup and then mounts the same component
 * instance again, so the second mount would otherwise be handed the corpse the first
 * one's teardown just disposed. Asking the publisher rather than remembering is what
 * makes that arm correct without a second flag beside it — and the effect's only
 * dependency is the publisher, so a self-disposal after a rejection does NOT re-mint:
 * that arm is terminal on purpose.
 */
function useGeometryPublisher(): {
  readonly hostRef: React.RefObject<HTMLDivElement | null>;
  readonly outcome: PaneGeometryOutcome | undefined;
} {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [publisher, setPublisher] = useState<PaneGeometryPublisher>(createGeometryPublisher);
  const subscribe = useCallback(
    (onOutcome: () => void) => publisher.subscribeToOutcomes(onOutcome),
    [publisher],
  );
  const readOutcome = useCallback(() => publisher.lastOutcome(), [publisher]);
  const outcome = useSyncExternalStore(subscribe, readOutcome, readOutcome);

  useEffect(() => {
    if (publisher.isDisposed) {
      setPublisher(createGeometryPublisher());
      return undefined;
    }
    const hostElement = hostRef.current;
    if (hostElement === null) {
      return undefined;
    }
    const detach = publisher.observe(hostElement);
    return () => {
      detach();
      publisher.dispose();
    };
  }, [publisher]);

  return { hostRef, outcome };
}

export function BrowserPane(context: ConsolePaneContext): React.JSX.Element {
  const { bridge, paneId, focusHue } = context;
  const navigation = useReportedNavigation(bridge, paneId);
  const geometry = useGeometryPublisher();
  const [addressField, setAddressField] = useState<AddressFieldState>(FOLLOWING_ADDRESS_FIELD);
  const [actRefusal, setActRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  const addressFieldId = useId();
  const reported = navigation.state;
  const reportedUrl = reported?.url;

  const refuseLocally = useCallback((code: string, detail: string): void => {
    setActRefusal(refuse(BROWSER_PANE_REFUSAL_ORIGIN, code, detail));
  }, []);

  const dispatch = useCallback((act: () => Promise<NavigationActOutcome>): void => {
    void act().then(
      (outcome) => {
        setActRefusal(outcome.status === "unavailable" ? outcome : undefined);
      },
      (failure: unknown) => {
        setActRefusal(
          bridgeRejectionRefusal(
            failure,
            "navigation-call-failed",
            "The page could not be reached from this window, because the call into the browser never answered.",
          ),
        );
      },
    );
  }, []);

  const onCloseTabChord = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): void => {
      if (!isCloseTabChord(describeChordEvent(event.nativeEvent), HOST_CHORD_PLATFORM)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      refuseLocally(
        "close-unregistered",
        "Closing a page needs the browser namespace's close action, which is not registered yet. The chord was caught here so it could not close this window instead.",
      );
    },
    [refuseLocally],
  );

  const openInSystemBrowser = useCallback((): void => {
    const url = reportedUrl;
    if (url === undefined) {
      refuseLocally(
        "no-current-page",
        "There is no page to hand to the system browser, because this pane has not been told which page it holds.",
      );
      return;
    }
    void bridge.sidekicks.native.openExternal(url).then(
      () => {
        setActRefusal(undefined);
      },
      (failure: unknown) => {
        setActRefusal(
          bridgeRejectionRefusal(
            failure,
            "open-external-failed",
            "The system browser could not be reached from this window.",
          ),
        );
      },
    );
  }, [bridge, refuseLocally, reportedUrl]);

  const submitDestination = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const submitted = addressFieldSubmission(addressField, reportedUrl);
      if (isFilesystemDestination(submitted)) {
        // The draft is KEPT so the person can correct it. Returning to following
        // here would replace what they typed with the location they are still on,
        // which reads as the field having silently eaten the destination.
        refuseLocally(
          "filesystem-destination",
          "The address field takes web destinations only. A local file opens through the file control, which runs the boundary check the page cannot.",
        );
        return;
      }
      setAddressField(FOLLOWING_ADDRESS_FIELD);
      dispatch(() => bridge.growth.browserNavigate({ paneId, url: submitted }));
    },
    [addressField, bridge, dispatch, paneId, refuseLocally, reportedUrl],
  );

  /** Escape abandons the edit. The field goes back to reporting where the page is. */
  const onAddressKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    setAddressField(FOLLOWING_ADDRESS_FIELD);
  }, []);

  const isLoading = reported?.isLoading ?? false;

  // Rule 2: the hue answers "who", and it is a different colour on every pane — so
  // it rides a custom property on the element, the shape `LedgerRow` established.
  // An unattributed pane takes the neutral control boundary rather than borrowing
  // somebody else's colour, which is the fail-closed direction.
  const attributionStyle: PaneAttributionStyle = {
    "--meridian-browser-pane-hue": focusHue ?? tokenReference("edge-strong"),
  };

  return (
    <section
      aria-label={BROWSER_PANE_LABEL}
      className="meridian-browser-pane"
      style={attributionStyle}
      tabIndex={-1}
      onKeyDownCapture={onCloseTabChord}
    >
      <form onSubmit={submitDestination} className="meridian-browser-chrome">
        <ChromeControl
          label="Back"
          disabled={reported?.canGoBack !== true}
          onActivate={() => {
            dispatch(() => bridge.growth.browserGoBack({ paneId }));
          }}
        />
        <ChromeControl
          label="Forward"
          disabled={reported?.canGoForward !== true}
          onActivate={() => {
            dispatch(() => bridge.growth.browserGoForward({ paneId }));
          }}
        />
        {/* One slot, two acts: 12.2 puts reload and stop in the same place and swaps
            them on the view's reported load state, so the control is where a person's
            hand already is at the moment they want the other one. */}
        <ChromeControl
          label={isLoading ? "Stop" : "Reload"}
          glyph={isLoading ? "stop" : undefined}
          disabled={reported === undefined}
          onActivate={() => {
            dispatch(() =>
              isLoading
                ? bridge.growth.browserStopLoading({ paneId })
                : bridge.growth.browserReload({ paneId }),
            );
          }}
        />
        <label htmlFor={addressFieldId} className="meridian-visually-hidden">
          Destination
        </label>
        <input
          id={addressFieldId}
          type="text"
          inputMode="url"
          value={addressFieldValue(addressField, reportedUrl)}
          placeholder="Type a destination"
          onChange={(event) => {
            setAddressField(editingAddressField(event.target.value));
          }}
          onKeyDown={onAddressKeyDown}
          className="meridian-browser-chrome__address"
        />
        {/* Present on every page regardless of anything else in this chapter: it is
            the fallback the whole feature degrades to. */}
        <ChromeControl label="Open externally" glyph="external" onActivate={openInSystemBrowser} />
      </form>

      <div className="meridian-browser-pane__strip">
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Pages not read"
          detail="The tab strip, the page picker, capture, pick element, and developer tools all need the browser namespace, which is not registered yet. Nothing here says this session owns no pages — only that no question was put."
        />
      </div>

      {actRefusal === undefined ? null : (
        <RefusalBanner
          {...actRefusal}
          onDismiss={() => {
            setActRefusal(undefined);
          }}
        />
      )}

      <div
        ref={geometry.hostRef}
        data-pane-viewport={paneId}
        className="meridian-browser-pane__viewport"
      >
        <Nothing
          kind="not-checked"
          placement="surface"
          title="No page is shown here."
          detail={viewportDetail(geometry.outcome, navigation.refusal)}
        />
      </div>

      <details className="meridian-browser-disclosure meridian-browser-pane__ceiling">
        <summary>Resource ceiling</summary>
        <div className="meridian-browser-pane__ceiling-body">
          <BudgetMeter readings={{ VIEWS_MAX: 0 }} />
        </div>
      </details>
    </section>
  );
}

/**
 * The sentence under the empty viewport. It prefers the HOST's refusal over the
 * subscription's, because with no host there is nowhere to put a page at all and the
 * navigation wire's absence is the next question rather than the first.
 */
function viewportDetail(
  geometry: PaneGeometryOutcome | undefined,
  navigationRefusal: ConsoleRefusal | undefined,
): string {
  if (geometry?.status === "suppressed") {
    return geometry.refusal.detail;
  }
  return (
    navigationRefusal?.detail ??
    "This pane has not been told which page it holds, so it reports its rectangle and shows nothing."
  );
}
