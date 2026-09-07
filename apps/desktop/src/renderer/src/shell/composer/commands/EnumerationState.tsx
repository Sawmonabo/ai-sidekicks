// What the command popover says about its own enumeration.
//
// Split from `ProviderCommandAutocomplete.tsx`. The enumeration is a live read, and
// its state — reading, refused, cut short — is a fact about the READ rather than
// about the commands, which is why it renders as its own line above the list rather
// than as an entry in it. An entry would be selectable, and there is nothing there
// to send.

import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts";
import {
  InlineRefusal,
  Nothing,
  PartialRead,
  type ReadingState,
} from "../../../console/primitives/index.js";
import { useProviderCommandEnumeration } from "./provider-command-holder.js";

/**
 * What the provider half of the list is, when it is not the whole list.
 *
 * Six outcomes and six different next moves, which is why none of them is an empty
 * list: nobody was asked (this composer addresses a channel, not an agent), the read
 * is in flight, the daemon refused, the provider answered in full for this run's
 * binding, it answered for bindings none of which is this run's — an absence about
 * ROUTING rather than about the provider's catalogue, and stated as one — or it
 * answered for this run's binding and the reply says the answer was CUT.
 *
 * The group itself is the input rather than a boolean beside it: the two questions
 * this arm asks — is there a group for this run, and did it carry everything — are
 * both answered by the group, and two derived flags would be two chances to hand
 * this component one that disagreed with the list the popover rendered.
 */
export function EnumerationState(props: {
  readonly enumeration: ReturnType<typeof useProviderCommandEnumeration>;
  /** The served reading's group for this composer's run, where one was attributed. */
  readonly addressedGroup: ProviderCommandBindingGroup | undefined;
}): React.JSX.Element | null {
  const { enumeration, addressedGroup } = props;
  switch (enumeration.phase) {
    case "not-checked":
      return (
        <div className="meridian-command-discovery__state" role="status">
          <Nothing
            kind="not-checked"
            title="No agent is addressed, so no provider was asked"
            detail="Focus an agent's pane to see the commands and skills its bound provider publishes."
          />
        </div>
      );
    case "not-loaded":
      return (
        <div className="meridian-command-discovery__state" role="status">
          <Nothing kind="not-loaded" title="Reading the provider's commands and skills" />
        </div>
      );
    case "refused":
      return (
        <div className="meridian-command-discovery__state" role="status">
          <InlineRefusal code={enumeration.refusal.code} detail={enumeration.refusal.detail} />
        </div>
      );
    case "served":
      if (addressedGroup === undefined) {
        return (
          <div className="meridian-command-discovery__state" role="status">
            <Nothing
              kind="empty"
              title="This run's binding published nothing here"
              detail="The agent answered for the bindings it holds and none of them could be attributed to the run this composer is addressed to, so no provider entry is offered — another binding's commands are never shown under this one."
            />
          </div>
        );
      }
      // Said whether the filter matched anything or not: a nonempty list off a cut
      // enumeration looks exhaustive, and an empty one reads as a finished search.
      // The figure is what the group DID carry, which is the only count the reply
      // supplies — how many were dropped is not on the wire, and the `cut` reading is
      // the one shape in the console that says so without inventing one.
      return (
        <PartialRead
          states={[cutEnumerationReading(addressedGroup)]}
          subject="this run's command list"
        />
      );
  }
}

/**
 * A served group's own account of how complete its list is.
 *
 * `complete` is the reply's member and `cut` is the console's word for what it means
 * — the one reading kind that says a producer stopped short without a figure for how
 * much it dropped. A complete group answers `served`, which renders nothing at all,
 * so this branch never has to be written twice.
 */
function cutEnumerationReading(group: ProviderCommandBindingGroup): ReadingState {
  return group.complete ? { kind: "served" } : { kind: "cut", servedCount: group.entries.length };
}
