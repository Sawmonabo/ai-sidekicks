// Where the sign-in card is reached from, and when it is on screen.
//
// SIGN-IN IS NOT A DESTINATION. `Spec-023 §WebAuthn Credential Flow` gives the
// ceremony a start and no screen, and `Spec-026 §Trigger` deliberately does not gate
// first launch — so the console is fully usable signed out and this card appears
// only when someone asks for it. It is a window-scoped overlay for that reason,
// beside the command palette rather than on the icon rail: a rail destination is a
// place a person goes, and this is a moment a person is in.
//
// THE COMMAND IS REGISTERED FROM AN EFFECT, on the frame's own rule: it closes over
// this window's flow, which module scope cannot reach, so it is contributed on mount
// and withdrawn on unmount rather than through the family contribution door.
//
// THE CARD SAYS IT IS UP, because the frame cannot see it. `Spec-023 §Console
// Libraries` adopts the dialog family under `modal="trap-focus"`, which traps focus
// and leaves inerting the app root to the shell — and Base UI marks `.meridian-frame`
// `aria-hidden` while this card is open, so a reader that follows the accessibility
// tree is handled and one that navigates by STRUCTURE is not: the rail and the whole
// route surface stay reachable underneath. The shell already has the guard —
// `AppFrame`'s `modalOverlayOpen`, which hangs `inert` on the background — and cannot
// arm it for this card, because `console-view-family-isolation` forbids `frame/` from
// naming a view family. So the card publishes into the WINDOW store and the frame
// folds it with the palette's own state, which is the one seam the two are allowed to
// meet at. Cleared on close AND on unmount, in one cleanup: a render React discards
// mid-ceremony must not leave a window inert with nothing on screen to close. That
// wiring is `store/modal/modal-surface-lifetime.ts` now — hoisted when the onboarding
// walkthrough became the second window-scoped overlay to owe it.
//
// AND IT IS A DIALOG WITH A NAME, through the primitive that owns both halves. The
// popup carried `role="dialog"` and no `Dialog.Title`, no `aria-label`, and no
// `aria-labelledby` — the card's ordinary `<h2>` names a section and never the dialog
// role above it — so focus was trapped inside a modal a screen reader announced with
// no context at all. `OverlayDialogPopup` takes the name as `label` for exactly this
// case, a surface that heads its popup with an ordinary element rather than a title,
// and mounting through it also puts this card in the window's airspace: a dialog
// portalled by hand here was in none, so a native browser-pane view painted over it
// and took its input. One migration answers both, which is why the popup is not
// mounted here any more.
//
// THE FLOW IS SUPERSEDED ON UNMOUNT AND ON A BRIDGE SWAP, and it is held through the
// console's one subject-scoped holder to get that. An OS dialog belongs to main and
// outlives this component; the settlement that arrives afterwards has to publish
// nowhere rather than into a card that is gone. Holding the flow in a `useState` cell
// beside a remembered bridge would be a seventh copy of the substrate that exists for
// exactly this, and it would miss the case that substrate was written for: a render
// React discards still built a flow, and nothing would ever retire it.

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { consoleCommands, registerConsoleCommands } from "../palette/index.js";
import { OverlayDialogPopup } from "../primitives/index.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";
import {
  useModalSurfaceLifetime,
  useSubjectScopedResource,
  type SubjectScopedDisposal,
} from "../store/index.js";
import { SignInCeremony } from "./ceremony-adapter.js";
import { SignInCard } from "./SignInCard.js";
import { SignInFlow } from "./sign-in-flow.js";

/** The command id this family owns. Namespaced by family, per the command rules. */
const SIGN_IN_COMMAND_ID = "signIn.open";

/**
 * What a reader hears when focus is trapped inside this card.
 *
 * The same words as the card's own visible heading, and named once here so the two
 * cannot drift into announcing one thing and showing another. It travels as `label`
 * rather than as a `Dialog.Title` because the heading belongs to `SignInCard`, which
 * is a card and not a dialog — a second heading mounted beside it for the role's sake
 * would put the same sentence on screen twice.
 */
const SIGN_IN_DIALOG_LABEL = "Sign in";

/**
 * How a retired flow ends: superseded, and still a working object afterwards.
 *
 * A RELEASE rather than a terminal disposal. `supersede()` advances the generation
 * so a settlement that arrives later publishes nowhere; it closes nothing and leaves
 * no corpse, so there is no closed state to read. Declared at module level so its
 * identity is stable across renders.
 */
const SIGN_IN_FLOW_DISPOSAL: SubjectScopedDisposal<SignInFlow> = {
  release: (retired) => {
    retired.supersede();
  },
};

export interface SignInOverlayProps {
  readonly context: ConsoleSurfaceContext;
}

export function SignInOverlay(props: SignInOverlayProps): React.JSX.Element {
  const { bridge, frameStore } = props.context;
  const [open, setOpen] = useState(false);
  // One flow per bridge, opened during the render that first sees a bridge and
  // retired however that render ended. A replacement bridge retires the flow built on
  // the old one: its unsettled ceremony would answer over a transport that no longer
  // exists. There is no second axis to key on — a window has one sign-in — so the key
  // is `undefined`.
  const { value: flow } = useSubjectScopedResource(
    bridge,
    undefined,
    () => new SignInFlow(new SignInCeremony(bridge)),
    SIGN_IN_FLOW_DISPOSAL,
  );

  const subscribe = useCallback((listener: () => void) => flow.subscribe(listener), [flow]);
  const readState = useCallback(() => flow.state, [flow]);
  const state = useSyncExternalStore(subscribe, readState);

  useEffect(() => {
    registerConsoleCommands([
      {
        id: SIGN_IN_COMMAND_ID,
        title: "Sign in",
        group: "Account",
        keywords: ["passkey", "identity", "account", "sign in"],
        run: () => {
          setOpen(true);
        },
      },
    ]);
    return () => {
      consoleCommands.unregister(SIGN_IN_COMMAND_ID);
    };
  }, []);

  // The window's background is inert for exactly this card's lifetime — see the
  // header note. Through the store family's own hook rather than an effect here,
  // since the onboarding walkthrough is the second window-scoped overlay to need it
  // and the half that is easy to omit is the cleanup.
  useModalSurfaceLifetime(frameStore, open);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal="trap-focus">
      {/* The popup shell is the primitive's, which is also what puts this card in the
          window's airspace (`Spec-023 §Console Design (Meridian)` 12.3): a native
          browser-pane view yields to whatever is registered there, and a card that
          mounted its own portal would be a dialog the view paints over — backdrop
          included, which is the half that covers the whole window. */}
      <OverlayDialogPopup
        backdropClassName="meridian-sign-in__backdrop"
        className="meridian-sign-in__popup"
        label={SIGN_IN_DIALOG_LABEL}
      >
        <SignInCard
          state={state}
          isBusy={flow.isBusy}
          onSignIn={() => {
            void flow.signIn();
          }}
          onRegisterAnother={() => {
            void flow.register();
          }}
          onOpenBrowser={() => {
            if (state.kind !== "handing-off") {
              return;
            }
            // The hand-off and the wait, in that order and in one act. The browser
            // is opened through `native.openExternal`, which the process model
            // makes the only sanctioned way out — a renderer-opened window would
            // put a control-plane origin inside this renderer's own frame tree.
            // Its rejection is deliberately not rendered separately: the wait
            // below settles into whatever the ceremony reports, and a person who
            // saw no browser open has the address and the code on screen already.
            void bridge.sidekicks.native.openExternal(state.handoff.verificationUri).catch(() => {
              // Swallowed on purpose, and only here: nothing about this window's
              // state depends on whether the OS had a browser to hand, and the
              // ceremony's own settlement is what the card renders next.
            });
            void flow.awaitDeviceGrant();
          }}
          onDismissRefusal={() => {
            flow.dismissRefusal();
          }}
        />
      </OverlayDialogPopup>
    </Dialog.Root>
  );
}
