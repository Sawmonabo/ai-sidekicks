// The browser pane's controls: the address line, the page tab strip and the page body.
//
// The chrome derives nothing. Back and forward are enabled from the view's reported
// history state and the tabs are drawn from the page list, both handed in as readings,
// and every control dispatches through the acts it is handed, so the component holds no
// subscription and no second copy of either. `PreviewPane.tsx` is what the pane layout mounts;
// this is the body that goes inside `seats/PaneFrame`, which draws the section,
// its accessible name and the actor's hue.
//
// The close-tab chord is claimed here: left alone, the platform chord closes the window.
// The pane captures it, prevents the default, and closes the selected page, or, where no
// page is selected, refuses locally rather than letting the window take it.
//
// One act sequence keeps the refusal banner correct: an older act never overwrites a
// newer one's answer, so the banner shows what the person last did.

import "./PreviewPaneContent.css";

import { useCallback, useId } from "react";

import type { PageHost } from "../geometry/page-host.js";
import {
  addressFieldSubmission,
  addressFieldValue,
  editingAddressField,
  FOLLOWING_ADDRESS_FIELD,
  isFileAddress,
} from "../address-field-model.js";
import { describeChordEvent, isCloseTabChord } from "../handback/chord-claim.js";
import { type NavigationReading } from "../types.js";
import { activePageOf, type PageListReading } from "../page-list-reading.js";
import { PageTabStrip } from "./PageTabStrip.js";
import { HOST_CHORD_PLATFORM, Nothing, RefusalBanner } from "@renderer/console/primitives/index.js";
import { usePreviewPaneActs } from "../hooks/usePreviewPaneActs.js";
import { useGeometryPublisher } from "../hooks/useGeometryPublisher.js";
import { usePaneAddressField } from "../hooks/usePaneAddressField.js";
import { AddressLineButton } from "./AddressLineButton.js";
import { PaneFrame, type PaneContextOf } from "@renderer/console/seats/index.js";
import type { PreviewPaneRejectionFallback } from "../pane-refusals.js";

/** What the control that hands the page to the system browser refuses with. */
const OPEN_EXTERNAL_FALLBACK: PreviewPaneRejectionFallback = {
  code: "open-external-failed",
  detail: "The system browser could not be reached from this window.",
};

/** The page acts the pane's controls dispatch. */
export interface BrowserChromeActs {
  readonly navigate: (url: string) => void;
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly reload: () => void;
  readonly stopLoading: () => void;
  readonly selectPage: (pageId: string) => void;
  readonly closePage: (pageId: string) => void;
  readonly reorderPage: (pageId: string, toIndex: number) => void;
}

/** What the pane's content draws from, beside the pane layout's context. */
export interface PreviewPaneContentProps extends PaneContextOf<"browser"> {
  /** Where the page is, and whether it can go back or forward. */
  readonly navigation: NavigationReading;
  /** The pages the session owns. */
  readonly pages: PageListReading;
  /** What each control does when pressed. */
  readonly acts: BrowserChromeActs;
  /** Where the pane's rectangle goes. */
  readonly pageHost: PageHost;
}

/** The pane body: tab strip, address line, and the viewport a native view is placed over. */
export function PreviewPaneContent(props: PreviewPaneContentProps): React.JSX.Element {
  const { bridge, paneId, focusHue, sessionStore, navigation, pages, acts, pageHost } = props;
  const sessionId = sessionStore?.sessionId;
  const geometry = useGeometryPublisher(bridge, paneId, pageHost);
  const { addressField, setAddressField } = usePaneAddressField(bridge, paneId);
  const paneActs = usePreviewPaneActs(bridge, paneId);
  const { refusal: actRefusal, run: runAct, refuseLocally, dismiss: dismissActRefusal } = paneActs;
  const addressFieldId = useId();
  // Only a served reading reports a page. Any other arm leaves every history control
  // disabled and the address field with nothing to follow.
  const reported = navigation.kind === "served" ? navigation.state : undefined;
  const reportedUrl = reported?.address;

  const onCloseTabChord = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): void => {
      if (!isCloseTabChord(describeChordEvent(event.nativeEvent), HOST_CHORD_PLATFORM)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const selected = activePageOf(pages);
      if (selected === undefined) {
        refuseLocally(
          "no-selected-page",
          "There is no selected page to close. The chord was caught here so it could not close this window instead.",
        );
        return;
      }
      acts.closePage(selected.pageId);
    },
    [acts, pages, refuseLocally],
  );

  const openInSystemBrowser = useCallback((): void => {
    const url = reportedUrl;
    if (url === undefined) {
      refuseLocally("no-current-page", "There is no page to hand to the system browser.");
      return;
    }
    runAct(async () => {
      await bridge.native.openExternal(url);
      return undefined;
    }, OPEN_EXTERNAL_FALLBACK);
  }, [bridge, refuseLocally, reportedUrl, runAct]);

  const submitDestination = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const submitted = addressFieldSubmission(addressField, reportedUrl);
      if (isFileAddress(submitted)) {
        // The draft is KEPT so the person can correct it. Returning to following
        // here would replace what they typed with the location they are still on,
        // which reads as the field having silently eaten the destination.
        refuseLocally("file-address", "The address field takes web destinations only.");
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
    // The chord claim rides the frame's own section, so it covers the head the frame
    // draws above the body as well as everything inside it.
    <PaneFrame
      kind="browser"
      sessionId={sessionId}
      focusHue={focusHue}
      onKeyDownCapture={onCloseTabChord}
    >
      <div className="meridian-preview-pane" tabIndex={-1}>
        <PageTabStrip
          reading={pages}
          onSelect={acts.selectPage}
          onClose={acts.closePage}
          onReorder={acts.reorderPage}
        />

        <form onSubmit={submitDestination} className="meridian-preview-chrome">
          <AddressLineButton
            label="Back"
            disabled={(reported?.backDepth ?? 0) === 0}
            onActivate={acts.goBack}
          />
          <AddressLineButton
            label="Forward"
            disabled={(reported?.forwardDepth ?? 0) === 0}
            onActivate={acts.goForward}
          />
          {/* One button, two acts: the view's reported load state swaps reload for stop. */}
          <AddressLineButton
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
            className="meridian-preview-chrome__address"
          />
          {/* Always available: it is what the pane falls back to when nothing else acts. */}
          <AddressLineButton
            label="Open externally"
            glyph="external"
            onActivate={openInSystemBrowser}
          />
        </form>

        {actRefusal === undefined ? null : (
          <RefusalBanner {...actRefusal} onDismiss={dismissActRefusal} />
        )}

        <div
          ref={geometry.hostRef}
          data-pane-viewport={paneId}
          className="meridian-preview-pane__viewport"
        >
          {geometry.outcome?.status === "suppressed" ? (
            <Nothing
              kind="not-checked"
              placement="block"
              title="No page is shown here."
              detail={geometry.outcome.refusal.detail}
            />
          ) : null}
        </div>
      </div>
    </PaneFrame>
  );
}
