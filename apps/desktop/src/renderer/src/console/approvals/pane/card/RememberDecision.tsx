// The remembered-grant control: one decision with three parts, and no syntax promised.
//
// THIS CONTROL'S OWN RULE, because no committed document states it: the policy that
// will remember an answer is in front of the person BEFORE they give it. The registered
// `RememberedScope` is `{ kind: "run" | "session"; pattern?: string }`, and the
// corpus says exactly one thing about the pattern — it matches the resource within
// the kind boundary, and its absence means the grant is category-wide. So:
//
//   • **The boundary and the pattern are one decision.** A rule that covers a whole
//     category for a whole session is a different grant from one that covers a
//     single path for one run, and the two controls that decide that are labelled
//     and disclosed together rather than sitting apart.
//   • **The copy claims nothing the corpus has not registered.** No per-category
//     syntax is registered anywhere — no path-prefix rule, no host-matching rule, no
//     scope-token grammar — so the field promises none, carries no placeholder that
//     would imply one, and says only what the wire says: what you type is matched
//     against the resource.
//   • **An empty field omits the member.** Not an empty string: `pattern` absent has
//     a defined meaning on the wire (category-wide) and an empty `pattern` has none,
//     which is the same reason an untouched control omits `rememberedScope` whole.
//   • **The text is sent verbatim, whitespace included.** Trimming a pattern would
//     send the daemon something other than what the participant typed, and what a
//     pattern matches is the daemon's to decide.
//
// Its own module rather than more of `ApprovalCard.tsx`: the card was at the file
// size this package splits at, and this is a second responsibility — composing one
// request member — rather than more of the card's. The class names stay the card's
// block, because this renders inside the card and shares its disclosure styling.

import { useId } from "react";
import { Checkbox } from "@base-ui/react/checkbox";
import { Collapsible } from "@base-ui/react/collapsible";
import { Select } from "@base-ui/react/select";

import {
  REMEMBERED_SCOPE_KINDS,
  SCOPE_KIND_PHRASE,
  type RememberedScopeKind,
} from "../../../bridge/index.js";
import { type ApprovalResolveRequest } from "../approvals-wire.js";

/** What the participant has said about remembering this answer, so far. */
export interface RememberedGrantIntent {
  /** False until the opt-in is checked. An unengaged intent sends nothing. */
  readonly isRemembering: boolean;
  readonly kind: RememberedScopeKind;
  /** Verbatim, as typed. Empty means the participant narrowed nothing. */
  readonly pattern: string;
}

/** The intent a card starts with: remembering nothing, narrowed to nothing. */
export const IDLE_REMEMBERED_GRANT_INTENT: RememberedGrantIntent = {
  isRemembering: false,
  kind: "run",
  pattern: "",
};

/**
 * The `rememberedScope` member this intent composes, or nothing at all.
 *
 * Typed from the request declaration rather than restated, so the one shape the
 * wire accepts is declared once. Absent `pattern` and empty `pattern` are two
 * different requests and only the first is one the daemon has a meaning for.
 */
export function rememberedScopeFor(
  intent: RememberedGrantIntent,
): ApprovalResolveRequest["rememberedScope"] {
  if (!intent.isRemembering) {
    return undefined;
  }
  return intent.pattern === ""
    ? { kind: intent.kind }
    : { kind: intent.kind, pattern: intent.pattern };
}

export interface RememberDecisionProps {
  readonly intent: RememberedGrantIntent;
  readonly onChange: (intent: RememberedGrantIntent) => void;
}

export function RememberDecision(props: RememberDecisionProps): React.JSX.Element {
  const { intent, onChange } = props;
  const patternFieldId = useId();
  const patternNoteId = useId();

  return (
    <Collapsible.Root className="meridian-approval-card__remember">
      <Collapsible.Trigger className="meridian-approval-card__disclosure-trigger">
        Remember this answer
      </Collapsible.Trigger>
      <Collapsible.Panel className="meridian-approval-card__disclosure-panel">
        <p className="meridian-approval-card__remember-note">
          A remembered rule is an allow-rule, so it is minted only when you approve. It covers
          everything in this category within the boundary you choose, unless you narrow it below,
          and it can be revoked from the standing permissions list at any time.
        </p>
        <label className="meridian-approval-card__opt-in">
          <Checkbox.Root
            className="meridian-approval-card__checkbox"
            checked={intent.isRemembering}
            onCheckedChange={(isRemembering) => {
              onChange({ ...intent, isRemembering });
            }}
          >
            <Checkbox.Indicator className="meridian-approval-card__checkbox-mark" />
          </Checkbox.Root>
          Remember my approval for this category
        </label>
        <Select.Root
          value={intent.kind}
          // The library types a clear as `null`; there is no cleared state here, so a
          // null is the current kind kept rather than a third value the request would
          // have to represent.
          onValueChange={(kind: RememberedScopeKind | null) => {
            if (kind !== null) {
              onChange({ ...intent, kind });
            }
          }}
        >
          <Select.Trigger
            className="meridian-approval-card__scope-trigger"
            aria-label="Remembered scope"
            disabled={!intent.isRemembering}
          >
            <Select.Value />
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner>
              <Select.Popup className="meridian-approval-card__scope-popup">
                {REMEMBERED_SCOPE_KINDS.map((kind) => (
                  <Select.Item
                    className="meridian-approval-card__scope-item"
                    key={kind}
                    value={kind}
                  >
                    <Select.ItemText>{SCOPE_KIND_PHRASE[kind]}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
        <label className="meridian-approval-card__pattern-label" htmlFor={patternFieldId}>
          Narrow it to a pattern (optional)
        </label>
        {/* No placeholder: a specimen value would promise a syntax, and the corpus
            registers none for any category. */}
        <input
          aria-describedby={patternNoteId}
          className="meridian-approval-card__pattern-field"
          disabled={!intent.isRemembering}
          id={patternFieldId}
          onChange={(event) => {
            onChange({ ...intent, pattern: event.target.value });
          }}
          type="text"
          value={intent.pattern}
        />
        <p className="meridian-approval-card__pattern-note" id={patternNoteId}>
          What you type is matched against the resource this request names. Leave it empty and the
          rule covers the whole category inside the boundary.
        </p>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
