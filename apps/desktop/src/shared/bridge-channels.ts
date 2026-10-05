// The IPC channel each bridge member main answers is carried on. The preload invokes a channel
// and main handles it, so the name is written here once, with the channels each member rides.

import type { PreloadApi } from "./preload-api.js";

/** The channels main answers through `ipcMain.handle`, by bridge member. */
export const BRIDGE_CHANNELS = {
  daemonCall: "daemon.call",
  closeDaemonSubscription: "daemon.unsubscribe",
  requestDaemonStart: "daemon.requestStart",
  readMachineSettings: "machineSettings.read",
  writeMachineSettings: "machineSettings.write",
  showOpenDialog: "native.showOpenDialog",
  getDroppedFileRef: "native.getDroppedFileRef",
  savePastedImage: "native.savePastedImage",
  openExternal: "native.openExternal",
  openInEditor: "native.openInEditor",
  listEditors: "native.listEditors",
  getNotificationPermission: "native.getNotificationPermission",
  copyToClipboard: "native.copyToClipboard",
  revealInFileExplorer: "native.revealInFileExplorer",
  readKeyboardMap: "keyboardMap.read",
  writeKeyboardMap: "keyboardMap.write",
  setAppearance: "window.setAppearance",
  readAppearance: "window.readAppearance",
  readFullscreen: "window.readFullscreen",
  setMinimumSize: "window.setMinimumSize",
  setDefaultSizes: "window.setDefaultSizes",
} as const;

/** A channel main answers through `ipcMain.handle`. */
export type InvokedBridgeChannel = (typeof BRIDGE_CHANNELS)[keyof typeof BRIDGE_CHANNELS];

/**
 * The channel a daemon subscription opens on. Synchronous, because `daemon.subscribe` answers its
 * caller before it returns: an open that returned means main holds a link to the daemon, and one
 * that threw means it does not.
 */
export const OPEN_DAEMON_SUBSCRIPTION_CHANNEL = "daemon.subscribe";

/** The channel main pushes each daemon subscription's values on, tagged with the subscription. */
export const DAEMON_SUBSCRIPTION_VALUE_CHANNEL = "daemon.subscriptionValue";

/** The channel main tells a page one of its subscriptions ended on, tagged with the subscription. */
export const DAEMON_SUBSCRIPTION_END_CHANNEL = "daemon.subscriptionEnd";

/** The channel main pushes the appearance record on, to the console document. */
export const APPEARANCE_VALUE_CHANNEL = "window.appearance";

/** The channel main pushes each window's fullscreen state on, to the console document. */
export const FULLSCREEN_VALUE_CHANNEL = "window.fullscreen";

/** One window's fullscreen starting or ending, as main pushes it. */
export interface FullscreenPush {
  readonly windowId: string;
  readonly isFullScreen: boolean;
}

/**
 * Every bridge member a page calls, as `namespace.member`. The build facts and the window used
 * last are values the preload read at start, not calls.
 */
type BridgeMember = Exclude<
  {
    [Namespace in Exclude<keyof PreloadApi, "app">]: `${Namespace}.${Extract<
      keyof PreloadApi[Namespace],
      string
    >}`;
  }[Exclude<keyof PreloadApi, "app">],
  "window.lastUsedWindowId"
>;

/** The updater's members, which keep throwing until the updater is built. */
type UpdaterMember = Extract<BridgeMember, `update.${string}`>;

/**
 * The channels main answers for each bridge member: the one it invokes, and for a subscription
 * the one it opens on and the ones its first value is read from or it is closed on. Keyed by every
 * member but the updater's, so a member added to `PreloadApi` fails the build until it names the
 * channels main answers it on; main's installer is keyed by every channel, so each one fails the
 * build until it has an answer.
 */
export const BRIDGE_MEMBER_CHANNELS: Readonly<
  Record<
    Exclude<BridgeMember, UpdaterMember>,
    readonly (InvokedBridgeChannel | typeof OPEN_DAEMON_SUBSCRIPTION_CHANNEL)[]
  >
> = {
  "daemon.call": [BRIDGE_CHANNELS.daemonCall],
  "daemon.subscribe": [OPEN_DAEMON_SUBSCRIPTION_CHANNEL, BRIDGE_CHANNELS.closeDaemonSubscription],
  "daemon.requestStart": [BRIDGE_CHANNELS.requestDaemonStart],
  "native.showOpenDialog": [BRIDGE_CHANNELS.showOpenDialog],
  "native.getDroppedFileRef": [BRIDGE_CHANNELS.getDroppedFileRef],
  "native.savePastedImage": [BRIDGE_CHANNELS.savePastedImage],
  "native.openExternal": [BRIDGE_CHANNELS.openExternal],
  "native.openInEditor": [BRIDGE_CHANNELS.openInEditor],
  "native.listEditors": [BRIDGE_CHANNELS.listEditors],
  "native.getNotificationPermission": [BRIDGE_CHANNELS.getNotificationPermission],
  "native.copyToClipboard": [BRIDGE_CHANNELS.copyToClipboard],
  "native.revealInFileExplorer": [BRIDGE_CHANNELS.revealInFileExplorer],
  "machineSettings.read": [BRIDGE_CHANNELS.readMachineSettings],
  "machineSettings.write": [BRIDGE_CHANNELS.writeMachineSettings],
  "machineSettings.subscribe": [
    OPEN_DAEMON_SUBSCRIPTION_CHANNEL,
    BRIDGE_CHANNELS.closeDaemonSubscription,
  ],
  "keyboardMap.read": [BRIDGE_CHANNELS.readKeyboardMap],
  "keyboardMap.write": [BRIDGE_CHANNELS.writeKeyboardMap],
  "window.setAppearance": [BRIDGE_CHANNELS.setAppearance],
  "window.subscribeAppearance": [BRIDGE_CHANNELS.readAppearance],
  "window.subscribeFullscreen": [BRIDGE_CHANNELS.readFullscreen],
  "window.setMinimumSize": [BRIDGE_CHANNELS.setMinimumSize],
  "window.setDefaultSizes": [BRIDGE_CHANNELS.setDefaultSizes],
};
