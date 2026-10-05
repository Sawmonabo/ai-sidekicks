import { useState } from "react";

import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import type { Refusal } from "#renderer/lib/refusal/refusal.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";

/**
 * `Open the sign-in page`: hands the provider's sign-in address to the system browser, keeping
 * the refusal where the browser could not be reached so the address beside it is the way on.
 */
export function useOpenSignInPage(): {
  readonly refusal: Refusal | undefined;
  readonly openSignInPage: (verificationUri: string) => void;
} {
  const bridge = usePlatformBridge();
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  const openSignInPage = (verificationUri: string): void => {
    setRefusal(undefined);
    bridge.native.openExternal(verificationUri).catch((error: unknown) => {
      setRefusal(coerceToRefusal(error, SIGN_IN_PAGE_ORIGIN, "open-sign-in-page-failed"));
    });
  };
  return { refusal, openSignInPage };
}

/** The subsystem name a refused open carries when the bridge raised no refusal of its own. */
const SIGN_IN_PAGE_ORIGIN = "provider-sign-in-page";
