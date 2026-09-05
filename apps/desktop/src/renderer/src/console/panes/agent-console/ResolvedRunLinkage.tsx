import { useEffect, useState } from "react";
import { RunLinkage, type AgentConsoleModels } from "../../agents/index.js";
import { HeldRunLinkage } from "./HeldRunLinkage.js";
import { linkageReadFor, type AcquiredLinkage } from "./RunLinkageMount.js";

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
