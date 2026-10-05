// The staged list a composer holds is re-minted when its setup re-runs, so files chosen after a
// StrictMode teardown reach a live client.

import { act, render } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import {
  useStagedAttachments,
  type StagedAttachmentsBinding,
} from "./hooks/useStagedAttachments.js";
import type { AttachmentIngestPort } from "./services/attachment-ingest-answer.js";
import { bridgeOnClock, type BridgeOnClock } from "#test/helpers/fixture/bridge.js";
import {
  INGEST_SESSION_ID,
  ScriptedIngestPort,
  patternedBytes,
} from "#test/helpers/scripted-ingest-port.js";

/** One file, exactly as a picker hands it over. */
function pickedFile(byteLength: number): File {
  return new File([patternedBytes(byteLength)], "notes.md", { type: "text/markdown" });
}

/** An element under a provider carrying this window's bridge and clock. */
function underWindow(fixture: BridgeOnClock, element: ReactElement): React.JSX.Element {
  return (
    <PlatformBridgeProvider bridge={fixture.bridge} clock={fixture.clock}>
      {element}
    </PlatformBridgeProvider>
  );
}

/** A component that holds the binding and hands its one control back to the case. */
function StagedAttachmentsProbe(props: {
  readonly bridge: PlatformBridge;
  readonly port: AttachmentIngestPort;
  readonly onBinding: (binding: StagedAttachmentsBinding) => void;
}): React.JSX.Element {
  const binding = useStagedAttachments(props.bridge, INGEST_SESSION_ID, props.port);
  props.onBinding(binding);
  return <span>{String(binding.snapshot.entries.length)}</span>;
}

describe("useStagedAttachments — a disposed staged list is re-minted on the re-run setup", () => {
  it("reaches a live client after StrictMode has torn one down and mounted again", async () => {
    // StrictMode runs the cleanup and then the setup again on the same instance. The cleanup
    // terminally disposed the ingest client, so files chosen afterwards would reach a client
    // whose `attach` returns at once, silently.
    const port = new ScriptedIngestPort();
    const fixture = bridgeOnClock("composer");
    let binding: StagedAttachmentsBinding | undefined;
    render(
      <StrictMode>
        {underWindow(
          fixture,
          <StagedAttachmentsProbe
            bridge={fixture.bridge}
            port={port.asPort()}
            onBinding={(taken) => {
              binding = taken;
            }}
          />,
        )}
      </StrictMode>,
    );

    await act(async () => {
      binding?.attachFiles([pickedFile(300)]);
      await crossMacrotaskBoundary();
    });

    expect(port.initCalls).toHaveLength(1);
    expect(port.chunkCalls).toHaveLength(1);
    expect(binding?.snapshot.entries[0]?.state).toBe("complete");
  });
});
