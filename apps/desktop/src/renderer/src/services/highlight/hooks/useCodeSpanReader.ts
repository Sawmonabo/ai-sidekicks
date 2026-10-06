import { useMemo } from "react";

import type { CodeSpanReader } from "#renderer/components/Markdown/highlight/code-span-reader.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { DaemonCodeSpanReader } from "../daemon-code-span-reader.js";

/**
 * The window's code-span reader, for whoever draws markdown. One per bridge and clock; every
 * reader of one bridge shares that bridge's span cache.
 */
export function useCodeSpanReader(): CodeSpanReader {
  const bridge = usePlatformBridge();
  const clock = useClock();
  return useMemo(() => new DaemonCodeSpanReader(bridge, clock), [bridge, clock]);
}
