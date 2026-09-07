// The three ways work arrives here, in one bar.
//
// `Spec-023 §Console Design (Meridian)` §All-sessions list puts starting a session on
// this screen. There are three ways in and they are not equals: starting one is the
// primary act and stays a button; joining one somebody else is in is the second and
// sits beside it, disclosed rather than open, because a two-field form permanently
// open beside a button reads as the thing you are meant to fill in; importing a
// provider thread is the third and lives in the create menu, which is where an act
// that is a variant of "start something" belongs.
//
// WHY DISCLOSURE AND NOT A SECOND PANEL. Both secondary acts are forms, and both are
// rare. Open, they cost the screen its answer to "what am I in the middle of" — the
// one question this destination exists to answer in one look.
//
// THE BLOCKED CAUSE TRAVELS DOWN AND IS NEVER RE-DERIVED. When the list is reading
// stale state, creating and joining are refused with a NAMED cause, composed once in
// `session-list-degradation.ts` from the store's own worst degraded cause. Each
// control renders it rather than deciding for itself whether it is allowed — a
// renderer that recomputed eligibility would be a second source of truth for a fact
// the store owns.

import { useState } from "react";

import { Menu } from "@base-ui/react/menu";

import { AutoPinSetting } from "./AutoPinSetting.js";
import { JoinSessionForm } from "./JoinSessionForm.js";
import { ProviderImportPanel } from "./ProviderImportPanel.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import type { SessionPreferenceBinding } from "../rows/session-preferences.js";

export interface SessionActsProps {
  readonly bridge: ConsoleBridge;
  readonly preferences: SessionPreferenceBinding;
  /** Start a session. The press the absorbed probe is keyed on. */
  readonly onStart: () => void;
  /** Where a settled join goes. */
  readonly onJoined: (sessionId: string) => void;
  /** Why creating and joining are refused right now, or `undefined` where they are not. */
  readonly blockedReason?: string | undefined;
}

/** Which secondary act is disclosed. One at a time — two open forms is two primaries. */
type DisclosedAct = "none" | "join" | "import";

export function SessionActs(props: SessionActsProps): React.JSX.Element {
  const { bridge, preferences, onStart, onJoined, blockedReason } = props;
  const [disclosed, setDisclosed] = useState<DisclosedAct>("none");

  return (
    <div className="meridian-session-acts">
      <div className="meridian-session-acts__row">
        <button
          type="button"
          className="meridian-sessions__start"
          disabled={blockedReason !== undefined}
          title={blockedReason}
          onClick={onStart}
        >
          Start a session
        </button>
        <button
          type="button"
          className="meridian-session-acts__secondary"
          aria-expanded={disclosed === "join"}
          onClick={() => {
            setDisclosed((current) => (current === "join" ? "none" : "join"));
          }}
        >
          Join a session
        </button>
        <Menu.Root>
          <Menu.Trigger
            className="meridian-session-acts__menu-trigger"
            aria-label="Other ways to start"
          >
            More
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner className="meridian-session-acts__menu-positioner" sideOffset={4}>
              <Menu.Popup className="meridian-session-acts__menu">
                <Menu.Item
                  className="meridian-session-acts__menu-item"
                  onClick={() => {
                    setDisclosed("import");
                  }}
                >
                  Import a provider session
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>

      {blockedReason === undefined ? null : (
        <p className="meridian-session-acts__blocked">{blockedReason}</p>
      )}

      {disclosed === "join" ? (
        <JoinSessionForm bridge={bridge} onJoined={onJoined} blockedReason={blockedReason} />
      ) : null}
      {disclosed === "import" ? (
        <ProviderImportPanel growth={bridge.growth} blockedReason={blockedReason} />
      ) : null}

      <AutoPinSetting preferences={preferences} />
    </div>
  );
}
