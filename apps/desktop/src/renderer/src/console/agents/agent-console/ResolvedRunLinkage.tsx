import { useEffect, useState } from "react";
import { RunLinkage } from "../run-console/RunLinkage.js";
import { type AgentConsoleModels } from "../run-console/agent-console-model.js";
import { HeldRunLinkage } from "./HeldRunLinkage.js";
import { type ChildRunLinkageRead } from "../run-console/agent-console-reads.js";

/**
 * The mounted arm, where both halves exist and the read may be taken.
 *
 * The frame between the render that names a run and the effect that leases its read
 * holds no reading, and neither does the frame between a re-key and its re-lease —
 * both render as the `not-checked` absence the surface already has for a question
 * nothing was asked of.
 */
export function ResolvedRunLinkage(props: {
  readonly models: AgentConsoleModels;
  readonly parentRunId: string;
}): React.JSX.Element {
  const { models, parentRunId } = props;
  const [acquired, setAcquired] = useState<AcquiredLinkage | undefined>(undefined);

  useEffect(() => {
    const lease = models.acquireLinkage(parentRunId);
    lease.read.start();
    setAcquired({ parentRunId, read: lease.read });
    return () => {
      lease.release();
      setAcquired(undefined);
    };
  }, [models, parentRunId]);

  const read = linkageReadFor(acquired, parentRunId);
  if (read === undefined) {
    return <RunLinkage parentRunId={parentRunId} state={undefined} />;
  }
  return <HeldRunLinkage parentRunId={parentRunId} read={read} />;
}

export /** One acquired child-link read, with the parent run it answers for. */
interface AcquiredLinkage {
  readonly parentRunId: string;
  readonly read: ChildRunLinkageRead;
}

export /**
 * The read to render for `parentRunId`, or `undefined` for the not-checked absence.
 *
 * A pure function rather than an expression inside the body, so the rule can be
 * driven directly with an acquisition whose verdict is known — the mismatched frame
 * it exists to catch is transient in the DOM and is not observable after `act` has
 * flushed the effect that ends it.
 */
function linkageReadFor(
  acquired: AcquiredLinkage | undefined,
  parentRunId: string,
): ChildRunLinkageRead | undefined {
  if (acquired === undefined || acquired.parentRunId !== parentRunId) {
    return undefined;
  }
  return acquired.read;
}
