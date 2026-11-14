import { useState } from "react";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";

/**
 * `What's new`: hands a provider's release notes address to the system browser, with the refusal
 * beside it when the browser could not be reached.
 */
export function ReleaseNotesButton(props: { readonly address: string }): React.JSX.Element {
  const bridge = usePlatformBridge();
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  return (
    <>
      <button
        type="button"
        className="meridian-attention__link"
        onClick={() => {
          setRefusal(undefined);
          // The rejection's own message crosses IPC with the channel's name in it, so it goes to
          // the window's diagnostics and the screen shows the refusal instead.
          bridge.native.openExternal(props.address).catch((failure: unknown) => {
            recordRejectedRequest(
              RELEASE_NOTES_UNOPENED.origin,
              RELEASE_NOTES_UNOPENED.code,
              failure,
            );
            setRefusal(RELEASE_NOTES_UNOPENED);
          });
        }}
      >
        {"What's new"}
      </button>
      {refusal === undefined ? null : <InlineRefusal code={refusal.code} detail={refusal.detail} />}
    </>
  );
}

/** What a refused open says. */
const RELEASE_NOTES_UNOPENED = refuse(
  "provider-release-notes",
  "open-release-notes-failed",
  "Could not open the browser.",
);
