// The IPC channel each bridge member main answers is carried on. The preload invokes a channel
// and main handles it, so the name is written here once.

/** The channels main answers, by bridge member. */
export const BRIDGE_CHANNELS = {
  showOpenDialog: "native.showOpenDialog",
  openExternal: "native.openExternal",
  copyToClipboard: "native.copyToClipboard",
  readKeyboardMap: "keyboardMap.read",
  writeKeyboardMap: "keyboardMap.write",
} as const;
