// What the pane shows when it has no page view: the reason, and nothing that acts.
//
// `Spec-023 §Console Design (Meridian)` 12.1 gives the pane host a degraded state —
// "page rendering unavailable on this node, the pane renders one sentence naming that
// and the tool set is withheld rather than offered-and-refusing". This is that
// sentence, and the withholding is structural: the body that carries the chrome, the
// tab strip, and the five subscriptions is a sibling component this arm does not
// render, so there is nothing here to press and nothing here that asks the host about a
// view it has said it does not have.
//
// TWO ARMS AND TWO KINDS OF ABSENCE, which is rule 8 rather than a nicety. A pane whose
// attach has not answered is `not-loaded` — the read is in flight and a sentence would
// be replaced a beat later — and a pane whose attach was answered with a refusal is
// `error`, carrying the host's own message text verbatim. The third possibility, a
// build whose browser namespace is registered nowhere, never reaches this component at
// all: nobody asked, so the pane draws its chrome and each surface inside it renders its
// own not-checked absence, which is what that build is designed to show.
//
// THE CHROME FRAME IS STILL DRAWN, and the close-tab chord claim deliberately is not.
// The frame is `seats/ConsolePaneChrome`'s, so the pane keeps its section, its heading
// trail, and the deck's own host controls — a person can still close it. The chord claim
// is the pane's, and it exists to stop the platform's close-tab keystroke closing the
// WINDOW while a pane holds pages; a pane with no view holds none, so claiming the
// keystroke here would swallow it and leave a person unable to close anything from a
// surface that has nothing to close.

import { Nothing } from "../../primitives/index.js";
import { ConsolePaneChrome, type PaneContextOf } from "../../seats/index.js";
import type { PaneViewAttachment } from "./view-binding.js";

/** The two arms this component renders, narrowed from the binding's own reading. */
export type UnattachedPaneView = Extract<
  PaneViewAttachment,
  { readonly kind: "attaching" } | { readonly kind: "refused" }
>;

export interface BrowserPaneViewAbsenceProps {
  readonly context: PaneContextOf<"browser">;
  readonly view: UnattachedPaneView;
}

export function BrowserPaneViewAbsence(props: BrowserPaneViewAbsenceProps): React.JSX.Element {
  const { context, view } = props;
  return (
    <ConsolePaneChrome
      kind="browser"
      sessionId={context.sessionStore?.sessionId}
      focusHue={context.focusHue}
    >
      <div className="meridian-browser-pane">
        {view.kind === "attaching" ? (
          <Nothing
            kind="not-loaded"
            placement="surface"
            title="This pane is asking for a page view."
          />
        ) : (
          <Nothing
            kind="error"
            placement="surface"
            title="This pane has no page view."
            detail={view.refusal.detail}
          />
        )}
      </div>
    </ConsolePaneChrome>
  );
}
