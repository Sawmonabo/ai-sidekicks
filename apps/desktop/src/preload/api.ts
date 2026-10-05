// The object the preload exposes: the stub bridge, with the members main answers carried over
// IPC. The updater has no main handler yet, so its members still throw `NotImplementedError`.

import { ipcRenderer, webUtils } from "electron";

import { readAppFactsSwitches } from "@shared/app-facts.js";
import { BRIDGE_CHANNELS } from "@shared/bridge-channels.js";
import { readLastUsedWindowIdSwitch } from "@shared/window/window-id.js";
import {
  createStubBridge,
  type EditorEntry,
  type FilePathRef,
  type KeyboardMap,
  type KeyboardMapReading,
  type NotificationPermission,
  type OpenDialogOptions,
  type OpenDialogPurpose,
  type OpenDialogResults,
  type PreloadApi,
} from "@shared/preload-api.js";
import { createDaemonWire, DaemonSubscriptions } from "./daemon-wire.js";
import { createMachineSettingsBridge } from "./machine-settings-bridge.js";
import { createWindowBridge } from "./window-bridge.js";

/** The bridge object `index.ts` exposes on `window.desktopBridge`. */
export function createPreloadApi(argv: readonly string[]): PreloadApi {
  const lastUsedWindowId = readLastUsedWindowIdSwitch(argv);
  const stub = createStubBridge(readAppFactsSwitches(argv), lastUsedWindowId);
  const subscriptions = new DaemonSubscriptions(ipcRenderer);
  return {
    ...stub,
    daemon: createDaemonWire(ipcRenderer, subscriptions),
    machineSettings: createMachineSettingsBridge(ipcRenderer, subscriptions),
    native: {
      ...stub.native,
      showOpenDialog: async <Purpose extends OpenDialogPurpose>(
        options: OpenDialogOptions<Purpose>,
      ): Promise<OpenDialogResults[Purpose]> =>
        (await ipcRenderer.invoke(
          BRIDGE_CHANNELS.showOpenDialog,
          options,
        )) as OpenDialogResults[Purpose],
      // Only the preload can read a dropped file's path; main checks it and mints the token.
      getDroppedFileRef: async (file): Promise<FilePathRef> =>
        (await ipcRenderer.invoke(
          BRIDGE_CHANNELS.getDroppedFileRef,
          webUtils.getPathForFile(file),
        )) as FilePathRef,
      savePastedImage: async (bytes): Promise<FilePathRef> =>
        (await ipcRenderer.invoke(BRIDGE_CHANNELS.savePastedImage, bytes)) as FilePathRef,
      openExternal: async (url): Promise<void> => {
        await ipcRenderer.invoke(BRIDGE_CHANNELS.openExternal, url);
      },
      openInEditor: async (ref, line): Promise<void> => {
        await ipcRenderer.invoke(BRIDGE_CHANNELS.openInEditor, { ref, line });
      },
      listEditors: async (): Promise<EditorEntry[]> =>
        (await ipcRenderer.invoke(BRIDGE_CHANNELS.listEditors)) as EditorEntry[],
      getNotificationPermission: async (): Promise<NotificationPermission> =>
        (await ipcRenderer.invoke(
          BRIDGE_CHANNELS.getNotificationPermission,
        )) as NotificationPermission,
      copyToClipboard: async (content): Promise<void> => {
        await ipcRenderer.invoke(BRIDGE_CHANNELS.copyToClipboard, content);
      },
      revealInFileExplorer: async (ref): Promise<void> => {
        await ipcRenderer.invoke(BRIDGE_CHANNELS.revealInFileExplorer, ref);
      },
    },
    keyboardMap: {
      read: async (): Promise<KeyboardMapReading> =>
        (await ipcRenderer.invoke(BRIDGE_CHANNELS.readKeyboardMap)) as KeyboardMapReading,
      write: async (map): Promise<KeyboardMap> =>
        (await ipcRenderer.invoke(BRIDGE_CHANNELS.writeKeyboardMap, map)) as KeyboardMap,
    },
    window: createWindowBridge(ipcRenderer, lastUsedWindowId),
  };
}
