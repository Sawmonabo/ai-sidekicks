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

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { BudgetMeter } from "../../browser/BudgetMeter.js";
import {
  PaneGeometryPublisher,
  type PaneGeometryOutcome,
} from "../../browser/geometry-publisher.js";
import { describeChordEvent, isCloseTabChord } from "../../browser/keyboard-handback.js";
import {
  isFilesystemDestination,
  useReportedNavigation,
  type NavigationActOutcome,
} from "../../browser/navigation-state.js";
import { consoleOcclusionRegistry } from "../../browser/occlusion-registry.js";
import { resolvePaneViewHost } from "../../browser/view-host.js";
import { ConsoleRefusalError, RealClock, refuse, type ConsoleRefusal } from "../../core/index.js";
import {
  Glyph,
  HOST_CHORD_PLATFORM,
  Nothing,
  RefusalBanner,
  type GlyphName,
} from "../../primitives/index.js";
import { tokenReference } from "../../tokens/index.js";
import type { ConsolePaneContext } from "../../workspace/index.js";

/** The subsystem name every refusal this pane raises itself carries. */
const BROWSER_PANE_REFUSAL_ORIGIN = "browser-pane";

/** The pane region's accessible name. The tab strip's own labels arrive with it. */
const BROWSER_PANE_LABEL = "Browser";

const CONTROL_GLYPH_SIZE = 13;

/** Carries this pane's attribution hue into the shell's inline-start edge. */
interface PaneAttributionStyle extends React.CSSProperties {
  readonly "--meridian-browser-pane-hue": string;
}

/**
 * Publish this pane's rectangle for the life of the mount. The publisher is built in
 * the effect and disposed with it, so a pane that unmounts mid-stream leaves no
 * listener behind — and on the unavailable host it has today, `observe` arms nothing
 * and hands back the sentence the viewport renders.
 */
function useGeometryPublisher(): {
  readonly hostRef: React.RefObject<HTMLDivElement | null>;
  readonly outcome: PaneGeometryOutcome | undefined;
} {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [outcome, setOutcome] = useState<PaneGeometryOutcome | undefined>(undefined);

  useEffect(() => {
    const hostElement = hostRef.current;
    if (hostElement === null) {
      return undefined;
    }
    const publisher = new PaneGeometryPublisher({
      host: resolvePaneViewHost({}),
      clock: new RealClock(),
      occlusion: consoleOcclusionRegistry,
    });
    const detach = publisher.observe(hostElement);
    setOutcome(publisher.lastOutcome());
    return () => {
      detach();
      publisher.dispose();
    };
  }, []);

  return { hostRef, outcome };
}

export function BrowserPane(context: ConsolePaneContext): React.JSX.Element {
  const { bridge, paneId, focusHue } = context;
  const navigation = useReportedNavigation(bridge, paneId);
  const geometry = useGeometryPublisher();
  const [destination, setDestination] = useState("");
  const [actRefusal, setActRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  const addressFieldId = useId();

  const refuseLocally = useCallback((code: string, detail: string): void => {
    setActRefusal(refuse(BROWSER_PANE_REFUSAL_ORIGIN, code, detail));
  }, []);

  const dispatch = useCallback((act: () => Promise<NavigationActOutcome>): void => {
    void act().then((outcome) => {
      setActRefusal(outcome.status === "unavailable" ? outcome : undefined);
    });
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
    const url = navigation.state?.url;
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
          failure instanceof ConsoleRefusalError
            ? failure.refusal
            : refuse(
                BROWSER_PANE_REFUSAL_ORIGIN,
                "open-external-failed",
                "The system browser could not be reached from this window.",
              ),
        );
      },
    );
  }, [bridge, navigation.state?.url, refuseLocally]);

  const submitDestination = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (isFilesystemDestination(destination)) {
        refuseLocally(
          "filesystem-destination",
          "The address field takes web destinations only. A local file opens through the file control, which runs the boundary check the page cannot.",
        );
        return;
      }
      dispatch(() => bridge.growth.browserNavigate({ paneId, url: destination.trim() }));
    },
    [bridge, destination, dispatch, paneId, refuseLocally],
  );

  const reported = navigation.state;
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
          value={destination}
          placeholder={reported?.url ?? "Type a destination"}
          onChange={(event) => {
            setDestination(event.target.value);
          }}
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

/**
 * One chrome control. `disabled` comes in from the view's REPORTED state and is never
 * computed here — 12.2: "The chrome never derives navigability." Absent state disables
 * the control, which is the fail-closed direction: an enabled control that cannot act
 * is a lie.
 *
 * The label is TEXT rather than an icon for the history controls, because the console's
 * closed glyph family carries no directional arrow and no reload mark, and inventing
 * one at a call site is what `tokens/glyphs.ts` exists to prevent.
 *
 * It wears the family's own `meridian-browser-action`, not a chrome-only button style:
 * three of these sit beside the settings page's and the cards', and a second button
 * shape for the same act is how two surfaces in one family stop looking like one.
 */
function ChromeControl(props: {
  readonly label: string;
  /** `| undefined` explicitly: the reload/stop slot passes one arm without a glyph. */
  readonly glyph?: GlyphName | undefined;
  readonly disabled?: boolean;
  readonly onActivate: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="meridian-browser-action"
      disabled={props.disabled === true}
      onClick={props.onActivate}
    >
      {props.glyph === undefined ? null : <Glyph name={props.glyph} size={CONTROL_GLYPH_SIZE} />}
      {props.label}
    </button>
  );
}
