export {
  connectToDaemon,
  type DaemonConnection,
  type DaemonConnectionObserver,
  type DaemonConnectionOptions,
} from "./daemon-connection.js";
export { createDaemonProviderClient, type DriverClient } from "./provider.js";
export {
  createDaemonSessionClient,
  SessionStreamDroppedError,
  type SessionClient,
  type SessionEventEnvelope,
  type SessionSubscribeOptions,
} from "./session.js";
export {
  JsonRpcClient,
  JsonRpcRemoteError,
  JsonRpcSchemaError,
  JsonRpcSubscriptionOverflowError,
  JsonRpcTransportClosedError,
  type JsonRpcClientOptions,
} from "./transport/json-rpc.js";
export {
  JsonRpcTransportPeerClosedError,
  JsonRpcTransportUnavailableError,
} from "./transport/local-socket.js";
export type { ClientTransport, Handler, LocalSubscriptionConsumer } from "./transport/contract.js";
