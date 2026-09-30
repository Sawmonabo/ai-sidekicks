// The object the preload exposes: the stub bridge, with the members main answers carried
// over IPC. A member main does not answer yet throws `NotImplementedError`.

import { ipcRenderer } from "electron";

import { readAppFactsSwitches } from "@shared/app-facts.js";
import { BRIDGE_CHANNELS } from "@shared/bridge-channels.js";
import {
  createStubBridge,
  type KeyboardMap,
  type KeyboardMapReading,
  type OpenDialogOptions,
  type OpenDialogPurpose,
  type OpenDialogResults,
  type PreloadApi,
} from "@shared/preload-api.js";

/** The bridge object `index.ts` exposes on `window.desktopBridge`. */
export function createPreloadApi(argv: readonly string[]): PreloadApi {
  const stub = createStubBridge(readAppFactsSwitches(argv));
  return {
    ...stub,
    native: {
      ...stub.native,
      showOpenDialog: async <Purpose extends OpenDialogPurpose>(
        options: OpenDialogOptions<Purpose>,
      ): Promise<OpenDialogResults[Purpose]> =>
        (await ipcRenderer.invoke(
          BRIDGE_CHANNELS.showOpenDialog,
          options,
        )) as OpenDialogResults[Purpose],
      openExternal: async (url): Promise<void> => {
        await ipcRenderer.invoke(BRIDGE_CHANNELS.openExternal, url);
      },
      copyToClipboard: async (text): Promise<void> => {
        await ipcRenderer.invoke(BRIDGE_CHANNELS.copyToClipboard, text);
      },
    },
    keyboardMap: {
      read: async (): Promise<KeyboardMapReading> =>
        (await ipcRenderer.invoke(BRIDGE_CHANNELS.readKeyboardMap)) as KeyboardMapReading,
      write: async (map): Promise<KeyboardMap> =>
        (await ipcRenderer.invoke(BRIDGE_CHANNELS.writeKeyboardMap, map)) as KeyboardMap,
    },
  };
}
