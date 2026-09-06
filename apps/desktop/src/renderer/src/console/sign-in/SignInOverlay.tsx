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
import type { ConsoleSurfaceContext } from "../seats/index.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "../store/index.js";
import { SignInCeremony } from "./ceremony-adapter.js";
import { SignInCard } from "./SignInCard.js";
import { SignInFlow } from "./sign-in-flow.js";

/** The command id this family owns. Namespaced by family, per the command rules. */
const SIGN_IN_COMMAND_ID = "signIn.open";

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
  const { bridge } = props.context;
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

  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal="trap-focus">
      <Dialog.Portal>
        <Dialog.Backdrop className="meridian-sign-in__backdrop" />
        <Dialog.Popup className="meridian-sign-in__popup">
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
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
