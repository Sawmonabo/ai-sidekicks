// The standing-permission list's own read state. Its phase is separate from the approvals
// projection's, so neither list hides behind the other's loading.

import type { RememberedRule } from "@ai-sidekicks/contracts/approval";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { RememberedRules } from "./RememberedRules.js";
import { type ReadPhase } from "@renderer/lib/reads/read-phase.js";

/**
 * One standing-permission list, rendered for the phase its read is in.
 *
 * @consumedBy the inspector's Rules section
 */
export function RulesSection(props: RulesSectionProps): React.JSX.Element {
  if (props.phase.status === "loading") {
    return <Nothing kind="not-loaded" placement="block" title="Reading standing permissions." />;
  }
  return (
    <RememberedRules
      rules={props.phase.rows}
      unreadableCount={props.phase.unreadableCount}
      revokingRuleIds={props.revokingRuleIds}
      onRevoke={props.onRevoke}
    />
  );
}

interface RulesSectionProps {
  readonly phase: ReadPhase<RememberedRule>;
  readonly revokingRuleIds: ReadonlySet<string>;
  readonly onRevoke: (ruleId: string) => void;
}
