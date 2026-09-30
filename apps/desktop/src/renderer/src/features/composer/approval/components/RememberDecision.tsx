// The remembered-rule control: whether to remember an approval, and for how far.
//
// THE POLICY IS IN FRONT OF THE PERSON BEFORE THEY ANSWER. The rule a remembered
// approval mints covers exactly the subject the daemon derived from the ask — a
// command's program and first subcommand, a network request's host, a written file's
// name — and each reach the control offers names that subject in its own label,
// `Always allow <subject> this session`. The person chooses only
// the reach: this session, or every session on this project. The daemon refuses a
// subject that differs from its own derivation, so the control offers no way to type
// one.
//
// Its own module rather than more of `ApprovalCard.tsx`: this is a second
// responsibility — composing one request member — rather than more of the card's. The
// class names stay the card's block, because this renders inside the card and shares
// its disclosure styling.

import {
  REMEMBERED_SCOPE_KINDS,
  type RememberedScope,
  type RememberedScopeKind,
} from "@ai-sidekicks/contracts";
import { Checkbox } from "@base-ui/react/checkbox";
import { Collapsible } from "@base-ui/react/collapsible";
import { Select } from "@base-ui/react/select";

import { OverlaySelectPopup } from "../../components/OverlaySelectPopup/OverlaySelectPopup.js";
import { RULE_SCOPE_LABELS } from "@renderer/lib/approval-vocabulary.js";

/** What the person has said about remembering this answer, so far. */
export interface RememberedRuleIntent {
  /** False until the opt-in is checked. An unengaged intent sends nothing. */
  readonly isRemembering: boolean;
  readonly kind: RememberedScopeKind;
}

/** The intent a card starts with: remembering nothing, at the session's reach. */
export const IDLE_REMEMBERED_RULE_INTENT: RememberedRuleIntent = {
  isRemembering: false,
  kind: "session",
};

export interface RememberDecisionProps {
  readonly intent: RememberedRuleIntent;
  /** The subject the daemon derived from the ask, which the rule covers. */
  readonly subject: string;
  readonly onChange: (intent: RememberedRuleIntent) => void;
}

/**
 * The allow rule this intent composes for an approval, or nothing at all.
 *
 * The pattern is the subject the card showed, echoed as the daemon derived it.
 */
export function rememberedScopeFor(
  intent: RememberedRuleIntent,
  subject: string,
): RememberedScope | undefined {
  if (!intent.isRemembering) {
    return undefined;
  }
  return { kind: intent.kind, pattern: subject, sense: "allow" };
}

export function RememberDecision(props: RememberDecisionProps): React.JSX.Element {
  const { intent, subject, onChange } = props;

  return (
    <Collapsible.Root className="meridian-approval-card__remember">
      <Collapsible.Trigger className="meridian-disclosure-trigger">
        Remember this answer
      </Collapsible.Trigger>
      <Collapsible.Panel className="meridian-approval-card__disclosure-panel">
        <p className="meridian-approval-card__remember-note">
          A remembered rule is minted only when you approve. Later asks for {subject} in the reach
          you choose are answered without a card, and the rule can be revoked from the Rules section
          at any time.
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
          Remember my approval
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
            className="meridian-approval-card__scope-trigger meridian-action-button meridian-action-button--regular meridian-action-button--outline"
            aria-label="Remembered scope"
            disabled={!intent.isRemembering}
          >
            <Select.Value />
          </Select.Trigger>
          {/* The anchored list is the primitive's, which is what puts it in the
              window's airspace: a card that mounted its own portal would be a popup a
              native browser-pane view paints over. */}
          <OverlaySelectPopup className="meridian-approval-card__scope-popup">
            {REMEMBERED_SCOPE_KINDS.map((kind) => (
              <Select.Item className="meridian-approval-card__scope-item" key={kind} value={kind}>
                <Select.ItemText>
                  Always allow {subject} {RULE_SCOPE_LABELS[kind]}
                </Select.ItemText>
              </Select.Item>
            ))}
          </OverlaySelectPopup>
        </Select.Root>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
