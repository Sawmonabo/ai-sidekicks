/**
 * The part of Electron's `ipcRenderer` the preload carries the bridge over; each member's module
 * takes the calls it makes.
 */
export interface PreloadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  sendSync(channel: string, ...args: unknown[]): unknown;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}
