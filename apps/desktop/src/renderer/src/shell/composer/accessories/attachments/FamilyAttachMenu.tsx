// The rows other view families put in the composer's `+` menu.
//
// A REGISTRY READ AND NOT A LIST THIS FILE MAINTAINS. `seats/composer-attach-menu.ts`
// says why the handoff is a registration: the composer may not import a sibling view
// family, so a family that wants a row registers a descriptor and this renders whatever
// it finds, in registration order, deciding nothing about which rows apply.
//
// AND IT RENDERS THE ANSWER RATHER THAN LETTING THE OWNER RENDER IT. An entry returns
// its outcome, because the surface a person is looking at when they pick a menu row is
// this one — an owning family that showed its own refusal would put the answer in a pane
// that may not even be open.
//
// ONE ATTACH AT A TIME, and the rows say so. The act reaches a wire and the outcome
// lands in one slot; two in flight would race for it and the loser's answer would
// vanish. That is a fact about this window rather than an authority, which is the line
// this menu holds everywhere: it never hides a row, never derives whether attaching is
// permitted, and refuses nothing itself — every real refusal below comes back from the
// entry, in the entry's own words.
//
// THE MENU DISAPPEARS WHEN NOBODY HAS REGISTERED ANYTHING. An empty group with a heading
// would advertise a capability the build does not carry.

import { useCallback } from "react";

import type { ConsoleBridge } from "../../../../console/bridge/index.js";
import { refuse, type ConsoleRefusal } from "../../../../console/core/index.js";
import { Glyph, InlineRefusal } from "../../../../console/primitives/index.js";
import {
  composerAttachMenuEntries,
  useSessionScopedState,
  type ComposerArtifactAttachment,
  type ComposerAttachMenuEntry,
} from "../../../../console/seats/index.js";
import { GLYPH_SIZE_CHROME } from "../../../../console/tokens/index.js";

/** Where the one outstanding attach stands. Closed at three. */
type FamilyAttachState =
  | { readonly phase: "idle" }
  | { readonly phase: "attaching"; readonly entryId: string }
  | { readonly phase: "refused"; readonly entryId: string; readonly refusal: ConsoleRefusal };

const IDLE: FamilyAttachState = { phase: "idle" };

export interface FamilyAttachMenuProps {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  /** The deck pane in focus, as a handle. An entry that needs one refuses without it. */
  readonly focusedPaneId: string | undefined;
  /** Where a settled attachment goes: onto the message, as an artifact reference. */
  readonly onAttached: (attachment: ComposerArtifactAttachment) => void;
}

export function FamilyAttachMenu(props: FamilyAttachMenuProps): React.JSX.Element | null {
  const entries = composerAttachMenuEntries();
  // Held per `(bridge, session)` for the picker's reason: the composer is rebound from
  // one session to another while it stays mounted and this menu can be open across
  // that change, so an answer still in flight against the previous session settles
  // into nothing rather than into this surface.
  const { value: state, publish: publishState } = useSessionScopedState<FamilyAttachState>(
    props.bridge,
    props.sessionId,
    () => IDLE,
  );
  const { bridge, sessionId, focusedPaneId, onAttached } = props;

  const runEntry = useCallback(
    (entry: ComposerAttachMenuEntry) => {
      publishState({ phase: "attaching", entryId: entry.id });
      void entry
        .attach({ bridge, sessionId, focusedPaneId })
        .then((outcome) => {
          if (outcome.status === "refused") {
            publishState({ phase: "refused", entryId: entry.id, refusal: outcome.refusal });
            return;
          }
          onAttached(outcome.attachment);
          // Back to idle rather than to a success line: the attachment itself appears
          // on the strip above the message, which is a better report than a sentence
          // saying one did.
          publishState(IDLE);
        })
        .catch((failure: unknown) => {
          // Unreachable through the seat's own contract — an entry answers with an
          // outcome — so this arm exists for an entry that throws rather than refuses,
          // and it says exactly that rather than attributing the fault to the wire.
          publishState({
            phase: "refused",
            entryId: entry.id,
            refusal: refuse(
              entry.owner,
              "attach-entry-threw",
              `The ${entry.owner} attach entry ended without answering: ${String(failure)}`,
            ),
          });
        });
    },
    [bridge, focusedPaneId, onAttached, publishState, sessionId],
  );

  if (entries.length === 0) {
    return null;
  }
  const isBusy = state.phase === "attaching";
  return (
    <ul className="meridian-attach-menu" aria-label="Attach from a pane">
      {entries.map((entry) => (
        <li key={entry.id} className="meridian-attach-menu__row">
          <button
            type="button"
            className="meridian-attach-menu__action"
            disabled={isBusy}
            aria-busy={state.phase === "attaching" && state.entryId === entry.id}
            onClick={() => {
              runEntry(entry);
            }}
          >
            <Glyph name={entry.glyph} size={GLYPH_SIZE_CHROME} title={entry.owner} />
            <span className="meridian-attach-menu__label">{entry.label}</span>
            <span className="meridian-attach-menu__detail">{entry.detail}</span>
          </button>
          {state.phase === "refused" && state.entryId === entry.id ? (
            <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
