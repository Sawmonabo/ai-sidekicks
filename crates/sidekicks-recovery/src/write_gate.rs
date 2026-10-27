//! Refuses a mutating call that would write on top of read state the daemon cannot trust. Until
//! the restart's pass has listed the sessions it must rebuild, or once the local store has failed,
//! the whole daemon refuses; the stop, the restart and the flush are still taken, since they are
//! how a person gets out of a stuck recovery and none writes session state. A call that names no
//! session can reach any, through a project, a mount, a workspace or a tree, so it waits for the
//! whole pass. From then on, a session the pass is still rebuilding refuses the calls that name it,
//! and so does a session whose history is damaged, except its own two recovery actions; every
//! other session takes its writes.

use std::fmt;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde::Deserialize;
use serde::de::{Deserializer, IgnoredAny, MapAccess, Visitor};
use serde_json::value::RawValue;
use sidekicks_contracts::daemon::lifecycle::{DaemonFlush, DaemonRestart, DaemonStop};
use sidekicks_contracts::daemon::recovery::{
    DaemonWriteRefusedDetails, DaemonWriteRefusedRecovery,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{SessionRecoveryContinue, SessionRecoveryDelete};

use crate::session_write_refusal::refuse_call_naming_session;
use crate::status::RecoveryStatusTracker;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    Dispatch, DispatchError, HandlerContext, MethodRegistry, Reply, Request,
};

// The calls taken however the recovery stands: how a person gets out of a stuck one.
const METHODS_TAKEN_WHILE_RECOVERING: [&str; 3] = [
    DaemonStop::DESCRIPTOR.method,
    DaemonRestart::DESCRIPTOR.method,
    DaemonFlush::DESCRIPTOR.method,
];

// The two actions a session with damaged history offers.
const METHODS_TAKEN_BY_A_DAMAGED_SESSION: [&str; 2] = [
    SessionRecoveryContinue::DESCRIPTOR.method,
    SessionRecoveryDelete::DESCRIPTOR.method,
];

/// The gate that holds every mutating call to state the daemon can trust: a call other than the
/// stop, the restart and the flush is refused `daemon.writeRefused` while the daemon takes no
/// writes, and one naming a session the pass is still rebuilding, or one with damaged history, is
/// refused `session.rebuilding` or `session.history.damaged`. A call it takes goes on untouched.
pub struct RecoveryWriteGate {
    /// The dispatch the calls go on to.
    next: Arc<dyn Dispatch>,
    /// The frozen registry, whose entries say which method mutates.
    registry: Arc<MethodRegistry>,
    /// Answers, at each call, whether the daemon and the named session take writes.
    status: Arc<RecoveryStatusTracker>,
}

impl RecoveryWriteGate {
    /// The gate over `next`; `registry` says which method mutates and `status` where the recovery
    /// stands.
    pub fn new(
        next: Arc<dyn Dispatch>,
        registry: Arc<MethodRegistry>,
        status: Arc<RecoveryStatusTracker>,
    ) -> Self {
        Self {
            next,
            registry,
            status,
        }
    }

    /// The refusal of `request`, `None` when the gate takes it.
    fn refusal_of(&self, request: &Request) -> Option<DomainError> {
        let method = request.method.as_str();
        let is_mutating = self
            .registry
            .descriptor(method)
            .is_some_and(|descriptor| descriptor.is_mutating);
        if !is_mutating || METHODS_TAKEN_WHILE_RECOVERING.contains(&method) {
            return None;
        }
        let session_id = named_session(request.params.as_deref());
        if let Some(recovery) = self.status.read_daemon_write_refusal(session_id.is_some()) {
            return Some(daemon_write_refused(method, recovery));
        }
        if METHODS_TAKEN_BY_A_DAMAGED_SESSION.contains(&method) {
            return None;
        }
        refuse_call_naming_session(&self.status, &session_id?, method).err()
    }
}

impl Dispatch for RecoveryWriteGate {
    fn dispatch(
        &self,
        request: Request,
        context: HandlerContext,
    ) -> BoxFuture<'static, Result<Reply, DispatchError>> {
        match self.refusal_of(&request) {
            Some(refusal) => futures::future::ready(Err(DispatchError::Refused(refusal))).boxed(),
            None => self.next.dispatch(request, context),
        }
    }
}

/// The `sessionId` member of a call's params, read before the registry parses them: the last one
/// written, as a JSON object reader keeps it, every member borrowed or skipped unread.
struct NamedSession(Option<SessionId>);

impl<'de> Deserialize<'de> for NamedSession {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(NamedSessionVisitor)
    }
}

struct NamedSessionVisitor;

impl<'de> Visitor<'de> for NamedSessionVisitor {
    type Value = NamedSession;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("params written as an object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut members: A) -> Result<Self::Value, A::Error> {
        let mut last = None;
        while let Some(name) = members.next_key::<MemberName>()? {
            match name {
                MemberName::SessionId => last = Some(members.next_value::<&'de RawValue>()?),
                MemberName::Other => {
                    members.next_value::<IgnoredAny>()?;
                }
            }
        }
        // A member that is no session id names none, as the method's own check refuses it.
        Ok(NamedSession(last.and_then(|value| {
            serde_json::from_str::<SessionId>(value.get()).ok()
        })))
    }
}

// A member's name as the peek tells them apart, compared where it is read.
enum MemberName {
    SessionId,
    Other,
}

impl<'de> Deserialize<'de> for MemberName {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_identifier(MemberNameVisitor)
    }
}

struct MemberNameVisitor;

impl Visitor<'_> for MemberNameVisitor {
    type Value = MemberName;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a member name")
    }

    fn visit_str<E: serde::de::Error>(self, name: &str) -> Result<Self::Value, E> {
        Ok(if name == "sessionId" {
            MemberName::SessionId
        } else {
            MemberName::Other
        })
    }
}

// The session a call names: the last `sessionId` member of params written as an object. Params
// written as an array, or that do not read as an object, name none here, and the registry's own
// check refuses them once the pass lets calls through; while it runs, a call naming no session is
// refused whole.
fn named_session(params: Option<&RawValue>) -> Option<SessionId> {
    let text = params?.get();
    if !text.trim_start().starts_with('{') {
        return None;
    }
    serde_json::from_str::<NamedSession>(text)
        .ok()
        .and_then(|named| named.0)
}

fn daemon_write_refused(method: &str, recovery: DaemonWriteRefusedRecovery) -> DomainError {
    let state: &'static str = recovery.into();
    DomainError::new(
        format!("The service is not taking {method} until its recovery lets it; it is {state}"),
        RefusalCode::DaemonWriteRefused,
    )
    .with_detail(DaemonWriteRefusedDetails { recovery })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use rstest::rstest;
    use serde_json::value::RawValue;
    use serde_json::{Value, json};
    use sidekicks_contracts::daemon::lifecycle::DaemonStop;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::method::Method;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::methods::{SessionArchive, SessionRecoveryContinue};

    use super::RecoveryWriteGate;
    use crate::status::RecoveryStatusTracker;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{
        Dispatch, DispatchError, EncodedValue, HandlerContext, HandlerError, MethodRegistry,
        MethodRegistryBuilder, Reply, Request,
    };

    // Where the recovery stands when the call arrives.
    #[derive(Clone, Copy, Debug)]
    enum Stage {
        // The pass has yet to list the sessions it must rebuild.
        Listing,
        // The session is still listed for rebuilding once the pass no longer holds the whole
        // daemon, so only the session's own refusal can answer.
        Rebuilding,
        // The pass ended with none of the session's events readable.
        Damaged,
        // The local store failed once the pass ended.
        StoreFailed,
    }

    // How the call's params are written.
    #[derive(Clone, Copy, Debug)]
    enum Params {
        // An object naming the session.
        Object,
        // An array holding the session's id, as a positional call would send it.
        Array,
        // An object naming another session first and the session last, which a JSON object reader
        // reads as the last.
        DuplicatedKey,
    }

    // A dispatch answering every call, recording the methods it takes.
    struct Next {
        taken: Arc<Mutex<Vec<String>>>,
    }

    impl Dispatch for Next {
        fn dispatch(
            &self,
            request: Request,
            _context: HandlerContext,
        ) -> BoxFuture<'static, Result<Reply, DispatchError>> {
            self.taken
                .lock()
                .expect("no test thread panics holding it")
                .push(request.method);
            futures::future::ready(Ok(Reply::Result(EncodedValue {
                json: b"{}".to_vec(),
                attachments: Vec::new(),
            })))
            .boxed()
        }
    }

    fn tracker_at(stage: Stage, session_id: &SessionId) -> RecoveryStatusTracker {
        let tracker = RecoveryStatusTracker::new();
        match stage {
            Stage::Listing => {}
            Stage::Rebuilding => {
                tracker.mark_session_rebuilding(session_id);
                tracker.mark_pass_ended();
            }
            Stage::Damaged => {
                tracker.mark_session_unreadable(session_id);
                tracker.mark_pass_ended();
            }
            Stage::StoreFailed => {
                tracker.mark_pass_ended();
                tracker.mark_store_failed();
            }
        }
        tracker
    }

    // The gate reads only which methods mutate, so each method's handler never runs.
    fn registry() -> MethodRegistry {
        let mut builder = MethodRegistryBuilder::new();
        builder
            .register::<DaemonStop, _>(|_params, _context| {
                futures::future::ready(Err(HandlerError::Canceled)).boxed()
            })
            .expect("the stop registers");
        builder
            .register::<SessionArchive, _>(|_params, _context| {
                futures::future::ready(Err(HandlerError::Canceled)).boxed()
            })
            .expect("the archive registers");
        builder
            .register::<SessionRecoveryContinue, _>(|_params, _context| {
                futures::future::ready(Err(HandlerError::Canceled)).boxed()
            })
            .expect("the recovery's continue registers");
        builder.freeze()
    }

    // Dropping the exemption of the stop or of a damaged session's recovery action, refusing
    // nothing while the pass lists, skipping the named session's own refusal, peeking array params
    // by position (which would refuse the array case `session.rebuilding`), or reading the first
    // of two `sessionId` members, or none of them, each fails a case, and so does a whole-daemon
    // refusal naming the wrong state. Array params name no session: the pass refuses them whole,
    // a failed store refuses them as it refuses every write, and once the pass has ended with the
    // store working the gate lets them on to the registry, whose own check refuses them.
    #[rstest]
    #[case::the_stop_while_listing(
        Stage::Listing,
        DaemonStop::DESCRIPTOR.method,
        Params::Object,
        None
    )]
    #[case::a_write_while_listing(
        Stage::Listing,
        SessionArchive::DESCRIPTOR.method,
        Params::Object,
        Some(RefusalCode::DaemonWriteRefused)
    )]
    #[case::array_params_while_listing(
        Stage::Listing,
        SessionArchive::DESCRIPTOR.method,
        Params::Array,
        Some(RefusalCode::DaemonWriteRefused)
    )]
    #[case::a_write_naming_a_rebuilding_session_last(
        Stage::Rebuilding,
        SessionArchive::DESCRIPTOR.method,
        Params::DuplicatedKey,
        Some(RefusalCode::SessionRebuilding)
    )]
    #[case::a_write_naming_a_rebuilding_session(
        Stage::Rebuilding,
        SessionArchive::DESCRIPTOR.method,
        Params::Object,
        Some(RefusalCode::SessionRebuilding)
    )]
    #[case::array_params_naming_a_rebuilding_session(
        Stage::Rebuilding,
        SessionArchive::DESCRIPTOR.method,
        Params::Array,
        None
    )]
    #[case::the_recovery_action_of_a_damaged_session(
        Stage::Damaged,
        SessionRecoveryContinue::DESCRIPTOR.method,
        Params::Object,
        None
    )]
    #[case::a_write_naming_a_damaged_session(
        Stage::Damaged,
        SessionArchive::DESCRIPTOR.method,
        Params::Object,
        Some(RefusalCode::SessionHistoryDamaged)
    )]
    #[case::a_write_once_the_store_failed(
        Stage::StoreFailed,
        SessionArchive::DESCRIPTOR.method,
        Params::Object,
        Some(RefusalCode::DaemonWriteRefused)
    )]
    #[case::array_params_once_the_store_failed(
        Stage::StoreFailed,
        SessionArchive::DESCRIPTOR.method,
        Params::Array,
        Some(RefusalCode::DaemonWriteRefused)
    )]
    #[tokio::test]
    async fn refuses_each_untrusted_write_and_passes_the_rest_on(
        #[case] stage: Stage,
        #[case] method: &str,
        #[case] params: Params,
        #[case] refusal: Option<RefusalCode>,
    ) {
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let taken = Arc::new(Mutex::new(Vec::new()));
        let registry = Arc::new(registry());
        let gate = RecoveryWriteGate::new(
            Arc::new(Next {
                taken: Arc::clone(&taken),
            }),
            registry,
            Arc::new(tracker_at(stage, &session_id)),
        );
        let call = match params {
            Params::Object => request(method, Some(&json!({ "sessionId": session_id }))),
            Params::Array => request(method, Some(&json!([session_id]))),
            Params::DuplicatedKey => {
                let other =
                    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
                Request {
                    params: Some(
                        RawValue::from_string(format!(
                            r#"{{"sessionId": "{other}", "sessionId": "{session_id}"}}"#
                        ))
                        .expect("the params are JSON"),
                    ),
                    ..request(method, None)
                }
            }
        };

        let answer = gate.dispatch(call, context(1)).await;

        let taken = taken
            .lock()
            .expect("no test thread panics holding it")
            .clone();
        match (answer, refusal) {
            (Ok(_), None) => assert_eq!(taken, [method], "the call reaches the next dispatch"),
            (Err(DispatchError::Refused(error)), Some(code)) => {
                assert_eq!(error.code, code);
                assert!(taken.is_empty(), "a refused call goes no further");
                if code == RefusalCode::DaemonWriteRefused {
                    let recovery = match stage {
                        Stage::StoreFailed => "blocked",
                        Stage::Listing | Stage::Rebuilding | Stage::Damaged => "rebuilding",
                    };
                    assert_eq!(
                        error.detail.map(Value::Object),
                        Some(json!({ "recovery": recovery }))
                    );
                }
            }
            (Ok(_), Some(code)) => panic!("expected {code:?}, the call passed"),
            (Err(error), _) => panic!("expected {refusal:?}, got {error:?}"),
        }
    }
}
