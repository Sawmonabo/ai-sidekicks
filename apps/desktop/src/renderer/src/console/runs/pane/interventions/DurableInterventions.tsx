// The daemon's own intervention rows for one run, and the three absences a read has.
//
// Its own module because a `.tsx` declares one component. It is the half of the history
// that says what happened to the RUN — every intervention, whoever raised it — while
// `DispatchedInterventions.tsx` beside it says what this window asked for.

import { Nothing, RefusalCard } from "../../../primitives/index.js";
import { DurableInterventionRow } from "./DurableInterventionRow.js";
import { InterventionSourceList } from "./InterventionSourceList.js";
import type { DurableInterventionHistoryReading } from "./durable-intervention-history.js";

/**
 * The daemon's own rows for this run: every intervention, whoever raised it.
 *
 * Three absences and never one. Nobody has answered yet, the read was put and the port
 * refused it, and the daemon answered naming none are three different facts, and this
 * surface renders each in its own words rather than letting a skeleton stand in for a
 * refusal.
 */
export function DurableInterventions(props: {
  readonly reading: DurableInterventionHistoryReading;
}): React.JSX.Element {
  const { reading } = props;
  if (reading === undefined) {
    return (
      <Nothing
        kind="not-loaded"
        placement="inline"
        title="Reading the run's intervention record."
      />
    );
  }
  if (reading.kind === "unreadable") {
    return <RefusalCard code={reading.refusal.code} detail={reading.refusal.detail} />;
  }
  const { outcome } = reading;
  if (outcome.status !== "served") {
    return <RefusalCard code={outcome.code} detail={outcome.detail} />;
  }
  if (outcome.value.records.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="No intervention has been raised against this run."
        detail="The daemon's durable record answered and named none. Every intervention is recorded, including the attempts that fail, so an empty record means none was ever raised."
      />
    );
  }
  return (
    <InterventionSourceList caption="Everything directed at this run">
      {outcome.value.records.map((record) => (
        <DurableInterventionRow key={record.interventionId} record={record} />
      ))}
    </InterventionSourceList>
  );
}
