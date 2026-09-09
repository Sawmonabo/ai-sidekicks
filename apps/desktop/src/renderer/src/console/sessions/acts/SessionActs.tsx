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
//
// THE IMPORT IS HELD HERE AND NOT IN THE PANEL IT IS DRAWN IN, because the panel is
// one of the two conditional children below and an import outlives a disclosure.
// `provider-import-model.ts` states the defect in full; what this bar owes it is the
// mount: held one level down, an import lost its progress subscription and its id the
// moment somebody switched to the join form, and the panel's one-import-at-a-time
// guard came back derived from an id that no longer existed.
//
// AND THE SWITCH ITSELF CLOSES WHILE ONE IS RUNNING, which is a different claim from
// the lift and is worth both. This panel is the only place this window reports an
// import, so a switch that takes it off screen leaves a person with a running import
// and nothing to read about it. `Spec-023 §Console Design (Meridian)` rule 9: the
// control is DISABLED with its sentence beside it, never hidden.

import { useState } from "react";

import { Menu } from "@base-ui/react/menu";

import { AutoPinSetting } from "./AutoPinSetting.js";
// The two disclosed bodies arrive through their MOUNTS and never by name: each is
// absent from the tree until a press, so each is a chunk of its own rather than code
// every session downloads. `act-body-mounts.ts` holds the two loaders; a static import
// of either component here would put it back on the initial graph, because a symbol
// reachable both statically and dynamically is assigned to the STATIC chunk.
import { joinSessionFormMount, providerImportPanelMount } from "./act-body-mounts.js";
import { useProviderImport } from "./provider-import-model.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { OverlayMenuPopup } from "../../primitives/index.js";
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
  /**
   * Why STARTING alone is refused, where the other two acts are still open.
   *
   * A SECOND PROP AND NOT A WIDER FIRST ONE, because the two causes have different
   * audiences. `blockedReason` is a fact about the window — it cannot reach the
   * runtime, or it is reading stale state — and it closes every act on this bar.
   * This one is a fact about the START act itself, and the only act it may close: a
   * create already running is no reason at all to refuse a join, and folding the two
   * would disable a form for a call it has nothing to do with.
   */
  readonly startBlockedReason?: string | undefined;
}

/** Which secondary act is disclosed. One at a time — two open forms is two primaries. */
type DisclosedAct = "none" | "join" | "import";

/**
 * Why the disclosure will not move while an import is being read.
 *
 * It says what is true rather than what would be lost: the reading survives a switch
 * now, and claiming otherwise would be this bar describing a defect it no longer has.
 * What a person cannot do is watch the import from anywhere else.
 */
const IMPORT_UNDERWAY_DISCLOSURE_SENTENCE =
  "An import is being read. This panel is the only place this window reports it, so it stays until the reading ends.";

export function SessionActs(props: SessionActsProps): React.JSX.Element {
  const { bridge, preferences, onStart, onJoined, blockedReason } = props;
  const [disclosed, setDisclosed] = useState<DisclosedAct>("none");
  const providerImport = useProviderImport(bridge.growth);
  // The window's cause first, because it is the stronger fact and the one that says
  // what a person can do next; the start act's own only where nothing else stands.
  const startBlockedReason = blockedReason ?? props.startBlockedReason;
  // Why the disclosure may not move, or `undefined` where it may. Scoped to the
  // import alone: a degraded list or an unreachable shell refuses the ACTS, which
  // each control already renders for itself, and neither is a reason to stop somebody
  // reading a form.
  const disclosureBlockedReason = providerImport.isUnderway
    ? IMPORT_UNDERWAY_DISCLOSURE_SENTENCE
    : undefined;

  return (
    <div className="meridian-session-acts">
      <div className="meridian-session-acts__row">
        <button
          type="button"
          className="meridian-sessions__start"
          disabled={startBlockedReason !== undefined}
          title={startBlockedReason}
          onClick={onStart}
        >
          Start a session
        </button>
        <button
          type="button"
          className="meridian-session-acts__secondary"
          aria-expanded={disclosed === "join"}
          disabled={disclosureBlockedReason !== undefined}
          title={disclosureBlockedReason}
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
          {/* The anchored part of the menu is the primitive's, which is what puts it
              in the window's airspace (`Spec-023 §Console Design (Meridian)` 12.3): a
              bar that mounted its own portal would be a menu a native browser-pane
              view paints over and takes the presses of. */}
          <OverlayMenuPopup
            positionerClassName="meridian-session-acts__menu-positioner"
            sideOffset={4}
            className="meridian-session-acts__menu"
          >
            <Menu.Item
              className="meridian-session-acts__menu-item"
              onClick={() => {
                setDisclosed("import");
              }}
            >
              Import a provider session
            </Menu.Item>
          </OverlayMenuPopup>
        </Menu.Root>
      </div>

      {/* The strongest cause standing on this bar, which is the start act's, since it
          already folds the window's. A control that is disabled with its sentence off
          screen is a control that has quietly stopped working. */}
      {startBlockedReason === undefined ? null : (
        <p className="meridian-session-acts__blocked">{startBlockedReason}</p>
      )}

      {/* The disclosure's own cause, beside the switch it closes rather than folded
          into the sentence above: they are two different facts about two different
          controls, and one line carrying both would be true of neither. */}
      {disclosureBlockedReason === undefined ? null : (
        <p className="meridian-session-acts__blocked">{disclosureBlockedReason}</p>
      )}

      {/* The mount's own render and not an element built here: what a loader-backed
          body renders is the board's decision — the settled module where a chunk has
          already landed, the reserved region where it has not — and this bar's job is
          to say which props it takes. */}
      {disclosed === "join"
        ? joinSessionFormMount.render({ bridge, onJoined, blockedReason })
        : null}
      {disclosed === "import"
        ? providerImportPanelMount.render({ model: providerImport, blockedReason })
        : null}

      <AutoPinSetting preferences={preferences} />
    </div>
  );
}
