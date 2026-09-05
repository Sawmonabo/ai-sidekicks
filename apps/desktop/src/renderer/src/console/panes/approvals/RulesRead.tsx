// The standing-permission list's own read state, beside the list it belongs to.
//
// Split from `ApprovalsPane.tsx`. The rules read is a SECOND read next to the
// approvals projection, and it fails independently — so it reports independently.
// Folding the two into one state would hide a readable approvals list behind an
// unreadable rules list, or the reverse, and a reader could not tell which of the
// two the daemon actually refused.

import { Nothing } from "../../primitives/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { RememberedGrants } from "./RememberedGrants.js";
import { type RememberedRule } from "../../bridge/index.js";
import { type ReadPhase } from "./approvals-reader.js";

interface RulesReadProps {
  readonly phase: ReadPhase<RememberedRule>;
  readonly revokingRuleIds: ReadonlySet<string>;
  readonly revokeRefusalByRuleId: ReadonlyMap<string, ConsoleRefusal>;
  readonly onRevoke: (ruleId: string) => void;
}

export function RulesRead(props: RulesReadProps): React.JSX.Element {
  if (props.phase.status === "not-checked") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="Standing permissions have not been read."
      />
    );
  }
  if (props.phase.status === "loading") {
    return <Nothing kind="not-loaded" placement="surface" title="Reading standing permissions." />;
  }
  if (props.phase.status === "refused") {
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={props.phase.refusal.code}
        detail={props.phase.refusal.detail}
      />
    );
  }
  return (
    <RememberedGrants
      rules={props.phase.rows}
      unreadableCount={props.phase.unreadableCount}
      revokingRuleIds={props.revokingRuleIds}
      revokeRefusalByRuleId={props.revokeRefusalByRuleId}
      onRevoke={props.onRevoke}
    />
  );
}
