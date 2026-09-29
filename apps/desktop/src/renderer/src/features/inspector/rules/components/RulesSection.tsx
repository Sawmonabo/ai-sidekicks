// The standing-permission list's own read state, beside the list it belongs to.
//
// The rules read is a SECOND read next to the approvals projection, and its phase is
// its own: folding the two into one state would hide a readable approvals list behind
// a rules list that is still loading, or the reverse.

import { Nothing } from "@renderer/console/primitives/index.js";
import { RememberedGrants } from "./RememberedRules.js";
import { type RememberedRule } from "@renderer/services/approvals/approval-records.js";
import { type ReadPhase } from "@renderer/features/composer/approval/approval-partition.js";

/** One standing-permission list, rendered for the phase its read is in. */
export function RulesRead(props: RulesReadProps): React.JSX.Element {
  if (props.phase.status === "loading") {
    return <Nothing kind="not-loaded" placement="surface" title="Reading standing permissions." />;
  }
  return (
    <RememberedGrants
      rules={props.phase.rows}
      unreadableCount={props.phase.unreadableCount}
      revokingRuleIds={props.revokingRuleIds}
      onRevoke={props.onRevoke}
    />
  );
}

interface RulesReadProps {
  readonly phase: ReadPhase<RememberedRule>;
  readonly revokingRuleIds: ReadonlySet<string>;
  readonly onRevoke: (ruleId: string) => void;
}
