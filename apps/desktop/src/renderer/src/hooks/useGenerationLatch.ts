import { useEffect, useState } from "react";

import { GenerationLatch } from "#renderer/lib/reads/generation-latch.js";

/**
 * One latch for the life of a mount, superseded on unmount.
 *
 * The teardown is what makes a settlement arriving after the component is gone a no-op
 * rather than a write into a register a remount would inherit — and because
 * `supersedeAll` is not terminal, the remount strict mode performs immediately
 * afterwards starts idle rather than wedged.
 */
export function useGenerationLatch(): GenerationLatch {
  const [latch] = useState(() => new GenerationLatch());
  useEffect(() => {
    return () => {
      latch.supersedeAll();
    };
  }, [latch]);
  return latch;
}
