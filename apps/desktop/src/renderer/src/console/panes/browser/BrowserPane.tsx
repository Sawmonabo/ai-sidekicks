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
} from "../../browser/address-field-model.js";
import { describeChordEvent, isCloseTabChord } from "../../browser/keyboard-handback.js";
import {
  isFilesystemDestination,
  useReportedNavigation,
  type NavigationActOutcome,
  type NavigationReading,
} from "../../browser/navigation-state.js";
import { consoleOcclusionRegistry } from "../../browser/occlusion-registry.js";
import { resolvePaneViewHost } from "../../browser/view-host.js";
import { RealClock } from "../../core/index.js";
import { HOST_CHORD_PLATFORM, Nothing, RefusalBanner } from "../../primitives/index.js";
import { tokenReference } from "../../tokens/index.js";
import { useBrowserPaneActs } from "./act-sequence.js";
import { usePaneAddressField } from "./pane-address-field.js";
import { ChromeControl } from "./ChromeControl.js";
import type { ConsolePaneContext } from "../../seats/index.js";

/** The pane region's accessible name. The tab strip's own labels arrive with it. */
const BROWSER_PANE_LABEL = "Browser";

/** What a navigation act that never answered says, where the rejection carries no code. */
const NAVIGATION_CALL_FALLBACK = {
  code: "navigation-call-failed",
  detail:
    "The page could not be reached from this window, because the call into the browser never answered.",
} as const;

/** The same, for the one control that leaves this window entirely. */
const OPEN_EXTERNAL_FALLBACK = {
  code: "open-external-failed",
  detail: "The system browser could not be reached from this window.",
} as const;

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
  const { addressField, setAddressField } = usePaneAddressField(bridge, paneId);
  const {
    refusal: actRefusal,
    run: runAct,
    refuseLocally,
    dismiss: dismissActRefusal,
  } = useBrowserPaneActs();
  const addressFieldId = useId();
  // Only the REPORTING arm is a reading. An ended subscription's last frame is not
  // one, so it reaches nothing here: every history control falls back to disabled and
  // the address field stops following a location nobody is reporting any more.
  const reported = navigation.status === "reported" ? navigation.state : undefined;
  const reportedUrl = reported?.url;

  const dispatch = useCallback(
    (act: () => Promise<NavigationActOutcome>): void => {
      runAct(async () => {
        const outcome = await act();
        return outcome.status === "unavailable" ? outcome : undefined;
      }, NAVIGATION_CALL_FALLBACK);
    },
    [runAct],
  );

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
    runAct(async () => {
      await bridge.sidekicks.native.openExternal(url);
      return undefined;
    }, OPEN_EXTERNAL_FALLBACK);
  }, [bridge, refuseLocally, reportedUrl, runAct]);

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

      {/* The subscription's own end, said once and where the controls are. It is a
          receipt rather than a refusal — the producer finished cleanly — so it takes
          the quiet reading line and the polite live region, not the banner. */}
      {navigation.status === "ended" ? (
        <p className="meridian-browser-pane__reading" role="status">
          This pane is no longer being told where the page is. The chrome acts on nothing until the
          pane is opened again.
        </p>
      ) : null}

      <div className="meridian-browser-pane__strip">
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Pages not read"
          detail="The tab strip, the page picker, capture, pick element, and developer tools all need the browser namespace, which is not registered yet. Nothing here says this session owns no pages — only that no question was put."
        />
      </div>

      {actRefusal === undefined ? null : (
        <RefusalBanner {...actRefusal} onDismiss={dismissActRefusal} />
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
          detail={viewportDetail(geometry.outcome, navigation)}
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
 *
 * The ended arm gets a sentence of its own rather than the default one, which claims
 * this pane was never told which page it holds — false once a subscription has been
 * reporting and stopped, and exactly the kind of absence rule 8 forbids collapsing.
 */
function viewportDetail(
  geometry: PaneGeometryOutcome | undefined,
  navigation: NavigationReading,
): string {
  if (geometry?.status === "suppressed") {
    return geometry.refusal.detail;
  }
  if (navigation.status === "refused") {
    return navigation.refusal.detail;
  }
  if (navigation.status === "ended") {
    return "No page is reported here any more, so this pane reports its rectangle and shows nothing.";
  }
  return "This pane has not been told which page it holds, so it reports its rectangle and shows nothing.";
}
