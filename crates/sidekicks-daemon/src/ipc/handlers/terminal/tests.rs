//! The `terminal.*` methods through the registry: a write past a connection's waiting limit, a
//! paste's parts kept whole, and the refusals of a request naming a shell.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::message::JsonRpcId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{TERMINAL_WRITES_WAITING_LIMIT, TerminalId};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_ipc::call_fixtures::context;
use sidekicks_ipc::jsonrpc_error_mapping::{CallFailure, map_json_rpc_error};
use sidekicks_ipc::registry::{
    Dispatch, DispatchError, MethodRegistryBuilder, Reply, Request, TransportId,
};
use sidekicks_shell::control_lease::{ShellConnection, ShellControlLease, ShellLeaseCaller};
use sidekicks_shell::input_lookup::ShellInputLookup;
use sidekicks_shell::refusals::terminal_not_found;
use sidekicks_shell::test_table::table_fixture;
use sidekicks_shell::write::{QueueTerminalWrite, ShellInput, ShellInputHooks};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;
use tokio::time::timeout;

use super::{register_terminal_methods, register_terminal_write};

// The one session the shell table's fixture holds.
const SESSION: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e";

// A session the shell table's fixture does not hold.
const UNHELD_SESSION: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0f";

const PASTE: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d1f";

// How long another connection's keys may wait on a paste that its last part closes.
const OTHER_WRITE_BOUND: Duration = Duration::from_secs(5);

/// A shell whose terminal hands each write's take to `queue_write`, its program asking for
/// pasted text to be marked when `is_bracketed`, its lease broadcasting every change at once,
/// and that lease.
fn shell(
    terminal_id: &str,
    is_bracketed: bool,
    queue_write: QueueTerminalWrite,
) -> (Arc<ShellInput>, Arc<ShellControlLease>) {
    let terminal_id = TerminalId::new(terminal_id.to_owned()).expect("a terminal id");
    let lease = Arc::new(ShellControlLease::new(
        SessionId::new(SESSION).expect("a session id"),
        terminal_id.clone(),
        DeviceId::new("device-machine".to_owned()).expect("a device id"),
        Arc::new(|_change| async { Ok(()) }.boxed()),
        Arc::new(|_caller: &ShellLeaseCaller| Ok(())),
    ));
    let input = ShellInput::new(
        terminal_id,
        Arc::clone(&lease),
        ShellInputHooks {
            queue_write,
            queue_answer: Box::new(|_answer| {}),
            is_bracketed_paste_requested: Box::new(move || is_bracketed),
        },
        tokio::runtime::Handle::current(),
    );
    (input, lease)
}

/// The pane of connection `transport` on every shell.
fn pane(transport: u64) -> String {
    format!("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c000{transport}")
}

/// Lets each of `transports` hold the shell of `lease` through its own pane, as the device's
/// connections.
async fn hold(lease: &ShellControlLease, transports: &[u64]) {
    for &transport in transports {
        let caller = ShellLeaseCaller {
            connection: ShellConnection {
                device_id: DeviceId::new("device".to_owned()).expect("a device id"),
                transport_id: TransportId(transport),
            },
            output_subscription_id: SubscriptionId::new(&pane(transport))
                .expect("a subscription id"),
        };
        lease
            .take(&caller, false)
            .await
            .expect("the device takes the shell");
    }
}

/// A call of `method` carrying `params`.
fn call(method: &str, params: &Value) -> Request {
    Request {
        method: method.to_owned(),
        params: Some(RawValue::from_string(params.to_string()).expect("params are JSON")),
        attachments: Vec::new(),
    }
}

/// A `terminal.write` call carrying `params`.
fn terminal_write(params: &Value) -> Request {
    call("terminal.write", params)
}

/// Typed keys for `terminal_id` through the pane of connection `transport`.
fn write(terminal_id: &str, transport: u64) -> Request {
    terminal_write(&json!({
        "kind": "keys",
        "sessionId": SESSION,
        "terminalId": terminal_id,
        "outputSubscriptionId": pane(transport),
        "data": "a",
    }))
}

/// The part `data` of the one paste for `terminal_id` through the pane of connection
/// `transport`, its last when `is_last_part`.
fn paste_part(terminal_id: &str, transport: u64, data: &str, is_last_part: bool) -> Request {
    terminal_write(&json!({
        "kind": "paste",
        "sessionId": SESSION,
        "terminalId": terminal_id,
        "outputSubscriptionId": pane(transport),
        "data": data,
        "pasteId": PASTE,
        "isLastPart": is_last_part,
    }))
}

// Killed by admitting a write past the waiting limit, or by a full shell holding the same
// connection's write to another shell or another connection's write to it.
#[tokio::test]
async fn a_connection_s_write_past_the_waiting_limit_on_a_shell_is_refused_and_others_answered() {
    // The first shell's program reads nothing, so its writes wait; the second takes at once.
    let (full, full_lease) = shell(
        "terminal-1",
        false,
        Box::new(|_bytes| futures::future::pending().boxed()),
    );
    let (free, _free_lease) = shell(
        "terminal-2",
        false,
        Box::new(|_bytes| async { Ok(()) }.boxed()),
    );
    // Two connections of the device hold the first shell, each through its own pane.
    hold(&full_lease, &[1, 2]).await;
    let lookup: ShellInputLookup =
        Arc::new(move |_session, terminal_id| match terminal_id.as_str() {
            "terminal-1" => Ok(Arc::clone(&full)),
            "terminal-2" => Ok(Arc::clone(&free)),
            _ => Err(futures::future::ready(terminal_not_found(terminal_id).into()).boxed()),
        });
    let mut builder = MethodRegistryBuilder::new();
    register_terminal_write(&mut builder, lookup).expect("terminal.write registers");
    let registry = builder.freeze();

    let mut waiting: Vec<_> = (0..TERMINAL_WRITES_WAITING_LIMIT)
        .map(|_| registry.dispatch(write("terminal-1", 1), context(1)))
        .collect();
    let refused = registry
        .dispatch(write("terminal-1", 1), context(1))
        .now_or_never()
        .expect("the refusal is answered in the write's step")
        .err()
        .expect("the write past the limit is refused");
    let response = map_json_rpc_error(CallFailure::Dispatch(refused), JsonRpcId::Number(1.into()));
    let response: serde_json::Value =
        serde_json::from_slice(&response.to_vec().expect("an error response writes"))
            .expect("an error response is JSON");
    assert_eq!(response["error"]["code"], -31_000);
    assert_eq!(
        response["error"]["data"]["type"],
        "terminal.write.limitReached"
    );
    assert_eq!(response["error"]["data"]["category"], "resourceExhausted");
    assert_eq!(
        response["error"]["data"]["fields"],
        json!({ "terminalId": "terminal-1", "limit": TERMINAL_WRITES_WAITING_LIMIT })
    );

    registry
        .dispatch(write("terminal-2", 1), context(1))
        .await
        .expect("the same connection's write to another shell is answered");
    assert!(
        registry
            .dispatch(write("terminal-1", 2), context(2))
            .now_or_never()
            .is_none(),
        "another connection's write to the same shell is admitted and waits"
    );

    // A waiting write that ends frees its place.
    drop(waiting.pop());
    assert!(
        registry
            .dispatch(write("terminal-1", 1), context(1))
            .now_or_never()
            .is_none(),
        "a write admitted in the freed place waits on the shell"
    );
}

// Killed by taking a paste's last part for a middle one, which leaves the marked paste open, so
// the other connection's keys wait past the bound: its two parts, then another connection's
// keys, reach the program as the whole paste, end mark included, before the keys.
#[tokio::test]
async fn a_paste_s_parts_reach_the_shell_whole_before_another_connection_s_write() {
    let written: Arc<Mutex<Vec<u8>>> = Arc::default();
    let (input, lease) = shell(
        "terminal-1",
        true,
        Box::new({
            let written = Arc::clone(&written);
            move |bytes| {
                lock(&written).extend_from_slice(&bytes);
                async { Ok(()) }.boxed()
            }
        }),
    );
    hold(&lease, &[1, 2]).await;
    let lookup: ShellInputLookup = Arc::new(move |_session, _terminal_id| Ok(Arc::clone(&input)));
    let mut builder = MethodRegistryBuilder::new();
    register_terminal_write(&mut builder, lookup).expect("terminal.write registers");
    let registry = builder.freeze();

    for (data, is_last_part) in [("one ", false), ("two", true)] {
        registry
            .dispatch(paste_part("terminal-1", 1, data, is_last_part), context(1))
            .await
            .expect("the paste's part is answered");
    }
    timeout(
        OTHER_WRITE_BOUND,
        registry.dispatch(write("terminal-1", 2), context(2)),
    )
    .await
    .expect("the other connection's write is answered once the paste is whole")
    .expect("the other connection's write is taken");

    assert_eq!(*lock(&written), b"\x1b[200~one two\x1b[201~a");
}

/// A holding pane's appearance report, the session and shell left to the call.
fn holding_pane_appearance() -> Value {
    json!({
        "source": "holdingPane",
        "colors": {
            "foreground": "#d0d0d0",
            "background": "#101820",
            "cursor": "#ffcc00",
            "palette": vec!["#000000"; 16],
        },
        "cellSize": { "width": 9, "height": 18 },
    })
}

/// The JSON a call answered, or the code it was refused with.
fn answer(reply: Result<Reply, DispatchError>) -> Result<Value, RefusalCode> {
    match reply {
        Ok(Reply::Result(result)) => {
            Ok(serde_json::from_slice(&result.json).expect("a result is JSON"))
        }
        Ok(Reply::Subscription { method, .. }) => panic!("{method} was answered a subscription"),
        Err(DispatchError::Refused(refusal)) => Err(refusal.code),
        Err(
            other @ (DispatchError::MethodNotFound
            | DispatchError::ParamsInvalid(_)
            | DispatchError::Canceled
            | DispatchError::Internal(_)
            | DispatchError::ResultInvalid { .. }),
        ) => panic!("a refusal, not {other:?}"),
    }
}

// Killed by any of these paths finding its shell without reading the session on a miss, which
// answers an unheld session `terminal.notFound` (flow control: accepted), and by flow control
// refusing a missing shell in a held session.
#[rstest]
#[case::close("terminal.close", json!({}), Err(RefusalCode::TerminalNotFound))]
#[case::resize(
    "terminal.resize",
    json!({ "columns": 80, "rows": 24 }),
    Err(RefusalCode::TerminalNotFound)
)]
#[case::holding_pane_appearance(
    "terminal.appearance.report",
    holding_pane_appearance(),
    Err(RefusalCode::TerminalNotFound)
)]
#[case::output_subscribe(
    "terminal.output.subscribe",
    json!({}),
    Err(RefusalCode::TerminalNotFound)
)]
#[case::control_take(
    "terminal.control.take",
    json!({ "outputSubscriptionId": pane(1) }),
    Err(RefusalCode::TerminalNotFound)
)]
#[case::flow_control(
    "terminal.flowControl.update",
    json!({ "paused": true }),
    Ok(json!({ "accepted": true }))
)]
#[tokio::test(flavor = "multi_thread")]
async fn a_request_naming_a_shell_refuses_an_unheld_session_and_a_missing_shell(
    #[case] method: &str,
    #[case] members: Value,
    #[case] missing_shell: Result<Value, RefusalCode>,
) {
    let (_gate, gate_reader) = watch::channel(true);
    let fixture = table_fixture(gate_reader).await;
    let mut builder = MethodRegistryBuilder::new();
    register_terminal_methods(&mut builder, Arc::clone(&fixture.table))
        .expect("the terminal methods register");
    let registry = builder.freeze();
    // The held session has no shell, so `terminal-1` is missing from it.
    let request = |session_id: &str| {
        let mut params = json!({ "sessionId": session_id, "terminalId": "terminal-1" });
        let params_members = params.as_object_mut().expect("the params are an object");
        params_members.extend(
            members
                .as_object()
                .expect("the members are an object")
                .clone(),
        );
        call(method, &params)
    };

    let unheld = answer(registry.dispatch(request(UNHELD_SESSION), context(1)).await);
    let missing = answer(registry.dispatch(request(SESSION), context(1)).await);

    assert_eq!(unheld, Err(RefusalCode::SessionNotFound), "{method}");
    assert_eq!(missing, missing_shell, "{method}");
}
