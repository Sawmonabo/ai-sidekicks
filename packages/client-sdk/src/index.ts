export {
  connectToDaemon,
  type DaemonConnection,
  type DaemonConnectionObserver,
  type DaemonConnectionOptions,
} from "./daemon-connection.js";
export { createDaemonProviderClient, type DriverClient } from "./provider-client.js";
export {
  createDaemonSessionClient,
  SessionStreamDroppedError,
  type SessionClient,
  type SessionEventEnvelope,
  type SessionSubscribeOptions,
} from "./session-client.js";
export {
  JsonRpcClient,
  JsonRpcRemoteError,
  JsonRpcSchemaError,
  JsonRpcSubscriptionOverflowError,
  JsonRpcTransportClosedError,
  type JsonRpcClientOptions,
} from "./transport/json-rpc-client.js";
export {
  JsonRpcTransportPeerClosedError,
  JsonRpcTransportUnavailableError,
} from "./transport/local-socket-transport.js";
export type { ClientTransport, Handler, LocalSubscriptionConsumer } from "./transport/types.js";
