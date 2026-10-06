// Which window a command acts in. Commands are contributed once for the app, and a chord or a
// palette row runs in the window a person is using, so a feature's mounted target is looked up
// among that window's mounts at press time. The app publishes how to read that window here.

import type { Unsubscribe } from "#shared/preload-api.js";
import { PublishedValue } from "#renderer/lib/published-value.js";

/** Publishes how to read the document of the window used last; only the app calls it. */
export function publishCommandWindow(readDocument: () => Document | undefined): Unsubscribe {
  return commandWindows.publish(readDocument);
}

/** The document of the window a command acts in; `undefined` while no window is open. */
export function readCommandWindow(): Document | undefined {
  return commandWindows.current?.();
}

const commandWindows = new PublishedValue<() => Document | undefined>();
