// The browser pane's controls — the same command over the page that the agent has.
//
// `Spec-023 §Console Design (Meridian)` 12.2. Every control dispatches into the SAME
// page registry the tool set drives, reached through a differently authorized surface,
// and the strip derives nothing: back and forward are enabled from the view's own
// REPORTED history state, never from a count the renderer kept.
//
// THE PANE'S FRAME IS NOT THIS MODULE'S. `seats/ConsolePaneChrome` draws the section,
// the kind glyph, the breadcrumb, the control strip, and the body box for every pane
// kind in the console; what this file returns is the BODY that goes inside it. The
// section, its tab stop, its accessible name, and the actor's hue all arrive from
// there, which is why none of them is set here and why the pane is named by its whole
// address trail rather than by the word "Browser".
//
// SIX CONTROLS PLUS THE FIELD, WHICH IS THE DENSITY RULE COUNTED RATHER THAN CLAIMED.
// 12.1 and 12.2 both fix it: back, forward, the reload/stop slot, new page, open
// externally, and the overflow control. The page picker, capture, pick element,
// developer tools, the file control, the produced-object shelf, the tool-call feed,
// and site-data reset are all one click away inside that last one.
//
// WHAT IS BUILT AND WHAT RENDERS ITS ABSENCE. Every control here dispatches a growth
// operation, and `Plan-023 §Console growth slate` row `browser-pane-namespace` still
// owes the whole namespace — so what a person sees today is each control's own honest
// refusal rather than a dead button or a blank strip. Rule 8 is the reason the tab
// strip says "pages not read" instead of "no pages": nobody asked, and a surface that
// said the second would be making a claim about the session nothing checked.
//
// The close-tab chord IS wired, because of what happens if it is not: the platform
// chord reaching the window closes the WINDOW. The pane captures it, prevents the
// default, and dispatches the close against the selected page — or, where no page is
// selected, refuses locally rather than letting the window take it.
//
// FIVE READINGS AND ONE ACT SEQUENCE. Navigation, the page list, the admitted roots,
// the relayed tool calls, and the keyboard handback are each their own module, each
// held for its own subject, and the chrome derives nothing beyond them. The single act
// sequence is what makes one refusal banner correct: an older act can never overwrite
// a newer one's answer, so the banner shows what the person last did.
//
// AND THE BANNER ANSWERS AN ACT, WHICH IS WHY THE HANDBACK IS NOT IN IT. Both halves
// of 12.4 run unprompted — the mirror publishes itself when the chord table changes,
// the subscription opens at mount — so routing their refusal to the banner opened
// every browser pane with a dismissible error about a wire nobody asked for, and a
// person who then pressed a control and was served watched their answer replaced by
// it. A standing degradation is a state of the pane and not the answer to anything, so
// it reads where the pane keeps its other standing readings, in the overflow control,
// where it can also say what the mirror claims and how much has come back through it.

import { useCallback, useId, useRef } from "react";

import { BudgetMeter } from "../bounds/BudgetMeter.js";
import { useCapturedObjects } from "../cards/captured-objects.js";
import { useRelayedToolCalls } from "../cards/tool-call-relay.js";
import type { PaneGeometryOutcome } from "../geometry/geometry-publisher.js";
import {
  addressFieldSubmission,
  addressFieldValue,
  editingAddressField,
  FOLLOWING_ADDRESS_FIELD,
} from "./address-field-model.js";
import { describeChordEvent, isCloseTabChord } from "./handback/chord-claim.js";
import { useBrowserChromeActs } from "./chrome/chrome-acts.js";
import { useAdmittedRoots } from "./file/file-boundary.js";
import { useKeyboardHandbackBinding } from "./handback/handback-binding.js";
import { LoadHairline } from "./chrome/LoadHairline.js";
import {
  isFilesystemDestination,
  useReportedNavigation,
  type NavigationReading,
} from "./navigation-state.js";
import { pagesOf, useReportedPages } from "./page-state.js";
import { PaneOverflow } from "./chrome/PaneOverflow.js";
import { TabStrip } from "./chrome/TabStrip.js";
import { HOST_CHORD_PLATFORM, Nothing, RefusalBanner } from "../../primitives/index.js";
import { useBrowserPaneActs } from "./act-sequence.js";
import { useGeometryPublisher } from "./geometry-binding.js";
import { usePaneAddressField } from "./pane-address-field.js";
import { ChromeControl } from "./chrome/ChromeControl.js";
import { ConsolePaneChrome, type PaneContextOf } from "../../seats/index.js";
import type { BrowserPaneRejectionFallback } from "./pane-refusals.js";

/** The same, for the one control that leaves this window entirely. */
const OPEN_EXTERNAL_FALLBACK: BrowserPaneRejectionFallback = {
  code: "open-external-failed",
  detail: "The system browser could not be reached from this window.",
};

export function BrowserPane(context: PaneContextOf<"browser">): React.JSX.Element {
  const { bridge, paneId, focusHue, sessionStore } = context;
  const sessionId = sessionStore?.sessionId;
  const navigation = useReportedNavigation(bridge, paneId);
  const pages = useReportedPages(bridge, paneId);
  const geometry = useGeometryPublisher(bridge, paneId);
  const { addressField, setAddressField } = usePaneAddressField(bridge, paneId);
  const paneActs = useBrowserPaneActs(bridge, paneId);
  const { refusal: actRefusal, run: runAct, refuseLocally, dismiss: dismissActRefusal } = paneActs;
  const openPages = pagesOf(pages);
  const acts = useBrowserChromeActs({
    bridge,
    paneId,
    sessionId,
    acts: paneActs,
    pageCount: openPages.length,
  });
  const captured = useCapturedObjects(bridge, paneId, paneActs);
  const admittedRoots = useAdmittedRoots(bridge, sessionId);
  const toolCalls = useRelayedToolCalls(bridge, sessionId);
  const paneRootRef = useRef<HTMLDivElement | null>(null);
  const handback = useKeyboardHandbackBinding(bridge, paneId, paneRootRef);
  const addressFieldId = useId();
  // Only the REPORTING arm is a reading. An ended subscription's last frame is not
  // one, so it reaches nothing here: every history control falls back to disabled and
  // the address field stops following a location nobody is reporting any more.
  const reported = navigation.kind === "served" ? navigation.state : undefined;
  const reportedUrl = reported?.url;

  const onCloseTabChord = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): void => {
      if (!isCloseTabChord(describeChordEvent(event.nativeEvent), HOST_CHORD_PLATFORM)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const selected = openPages.find((page) => page.isSelected);
      if (selected === undefined) {
        refuseLocally(
          "no-selected-page",
          "There is no selected page to close. The chord was caught here so it could not close this window instead.",
        );
        return;
      }
      acts.closePage(selected.pageId);
    },
    [acts, openPages, refuseLocally],
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
      acts.navigate(submitted);
    },
    [acts, addressField, refuseLocally, reportedUrl, setAddressField],
  );

  /** Escape abandons the edit. The field goes back to reporting where the page is. */
  const onAddressKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setAddressField(FOLLOWING_ADDRESS_FIELD);
    },
    [setAddressField],
  );

  const isLoading = reported?.isLoading ?? false;

  return (
    // THE CHORD CLAIM RIDES THE CHROME'S OWN SECTION. What the claim protects is the
    // WINDOW, so it has to cover every element the chord can be pressed on while this
    // pane has focus — which includes the head the chrome draws above the body, and
    // the head is not a descendant of the body. The chrome publishes the capture seam
    // for exactly that reason, so the handler goes on it directly.
    <ConsolePaneChrome
      kind="browser"
      sessionId={sessionId}
      focusHue={focusHue}
      onKeyDownCapture={onCloseTabChord}
    >
      {/* The replay target. A chord claimed from the page is dispatched here and
        bubbles out through the same handlers a keystroke raised in this window would
        reach, which is what makes the handback behave like every other keystroke. */}
      <div className="meridian-browser-pane" ref={paneRootRef} tabIndex={-1}>
        <TabStrip
          reading={pages}
          onSelect={acts.selectPage}
          onClose={acts.closePage}
          onCreate={acts.createPage}
          onReorder={acts.reorderPage}
        />

        <form onSubmit={submitDestination} className="meridian-browser-chrome">
          <ChromeControl
            label="Back"
            disabled={reported?.canGoBack !== true}
            onActivate={acts.goBack}
          />
          <ChromeControl
            label="Forward"
            disabled={reported?.canGoForward !== true}
            onActivate={acts.goForward}
          />
          {/* One slot, two acts: 12.2 puts reload and stop in the same place and swaps
            them on the view's reported load state, so the control is where a person's
            hand already is at the moment they want the other one. */}
          <ChromeControl
            label={isLoading ? "Stop" : "Reload"}
            glyph={isLoading ? "stop" : undefined}
            disabled={reported === undefined}
            onActivate={isLoading ? acts.stopLoading : acts.reload}
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
          <ChromeControl
            label="Open externally"
            glyph="external"
            onActivate={openInSystemBrowser}
          />
        </form>

        {/* Under the address field, and only while something is loading. */}
        <LoadHairline isLoading={isLoading} progress={reported?.loadProgress ?? null} />

        {/* The subscription's own end, said once and where the controls are. It is a
          receipt rather than a refusal — the producer finished cleanly — so it takes
          the quiet reading line and the polite live region, not the banner. */}
        {navigation.kind === "ended" ? (
          <p className="meridian-browser-pane__reading" role="status">
            This pane is no longer being told where the page is. The chrome acts on nothing until
            the pane is opened again.
          </p>
        ) : null}

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

        <PaneOverflow
          acts={acts}
          pages={pages}
          // 12.2's degraded state: developer tools on a view the host could not create
          // is ABSENT rather than disabled. The pane is what knows whether it has a
          // host, so the pane is what answers.
          canOpenDevtools={geometry.outcome?.status !== "suppressed"}
          roots={admittedRoots}
          refusal={actRefusal}
          sessionStore={sessionStore}
          producedCards={captured.cardsByArtifactId}
          toolCalls={toolCalls}
          handback={handback}
          onCapture={captured.capture}
        />

        {/* No `readings` at all, and that is the honest prop rather than an omission.
          Nothing in this window meters a browser bound — the namespace that would
          count live views is not registered — so every row takes the not-checked arm.
          A literal `VIEWS_MAX: 0` here would render through the same live-figure span
          a genuinely metered ceiling renders through, and tell a reviewer this window
          holds zero browser views while the pane he is reading it in is one. */}
        <details className="meridian-browser-disclosure meridian-browser-pane__ceiling">
          <summary>Resource ceiling</summary>
          <div className="meridian-browser-pane__ceiling-body">
            <BudgetMeter />
          </div>
        </details>
      </div>
    </ConsolePaneChrome>
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
  if (navigation.kind === "refused") {
    return navigation.refusal.detail;
  }
  if (navigation.kind === "ended") {
    return "No page is reported here any more, so this pane reports its rectangle and shows nothing.";
  }
  return "This pane has not been told which page it holds, so it reports its rectangle and shows nothing.";
}
