use std::collections::HashMap;
use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::port_registration::PortRegistration;
use tempfile::TempDir;

use crate::account::home_lock::AccountHomeLock;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::account::switch::move_codex_sessions;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::server_requests::CODEX_TOKEN_REFRESH_METHOD;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_account_service_for, start_scripted_switching_service,
};
use crate::driver::codex::service::switching::CODEX_LOGIN_START_METHOD;
use crate::driver::codex::service::switching::test_moves::{
    RecordedMoves, SessionQueue, switching_person,
};
use crate::driver::codex::service::switching::test_sign_in::{
    AccountHomes, TEST_PLAN, compose_access_token, write_sign_in,
};
use crate::driver::contract::account::{FirstRequestAfterMove, SessionAccountMove, SessionToMove};
use crate::driver::test_registry::new_session_id;
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// The `ChatGPT` workspace each test account signs in to, by account.
const WORKSPACE_LEFT: &str = "workspace-of-the-account-left";
const WORKSPACE_TO: &str = "workspace-of-the-account-moved-to";

/// The switching service carrying the account a switch leaves, the home service of the account it
/// moves onto, where that account's renewal runs, the legs over both, and two sessions on the
/// switching service: one the switch names, with its lead's binding, and one it does not.
struct Fixture {
    legs: Arc<CodexAccountLegs>,
    switching: ScriptedCodexService,
    home_to: ScriptedCodexService,
    moves: Arc<RecordedMoves>,
    named: SessionQueue,
    lead: SessionToMove,
    unnamed: SessionQueue,
    left: ProviderAccountId,
    to: ProviderAccountId,
    tokens: HashMap<ProviderAccountId, String>,
    _folder: TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let left = test_provider_account_id();
        let to = ProviderAccountId::new("account-2".to_owned()).expect("a valid account id");
        let mut switching = start_scripted_switching_service();
        let home_to = start_scripted_account_service_for(to.clone());
        let homes = HashMap::from([
            (left.clone(), folder.path().join(WORKSPACE_LEFT)),
            (to.clone(), home_to.service.home().codex_home.clone()),
        ]);
        let mut tokens = HashMap::new();
        for (account, workspace) in [(&left, WORKSPACE_LEFT), (&to, WORKSPACE_TO)] {
            let token = compose_access_token(workspace);
            write_sign_in(&homes[account], workspace, &token);
            tokens.insert(account.clone(), token);
        }
        AccountHomes {
            homes,
            current: left.clone(),
            api_keys: HashMap::new(),
        }
        .register_on(switching.dependencies.switching.provider_accounts());
        let registry = CodexServiceRegistry::holding(&switching);
        registry.hold(&home_to.service);
        let moves = Arc::new(RecordedMoves::default());
        let home_lock = Arc::new(PortRegistration::new("account home lock"));
        assert!(
            home_lock
                .register(Arc::new(AccountHomeLock::default()))
                .is_ok()
        );
        let legs = CodexAccountLegs::new(
            registry,
            Arc::clone(&switching.dependencies),
            CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
            Arc::new(PortRegistration::new("provider account registry")),
            Arc::clone(&moves) as Arc<dyn RuntimeBindingWriter>,
            home_lock,
        );

        // The service carries the account left, as its start handed it.
        let service = Arc::clone(&switching.service);
        let connection = service.connection().expect("the service is up");
        let account = Arc::clone(&switching.dependencies.switching);
        let (handed, _login) = tokio::join!(
            account.hand_at_start(&service, &connection),
            answer_login(&mut switching)
        );
        handed.expect("the start's login is answered");

        let named = SessionQueue::new(new_session_id(), left.clone(), &moves);
        let unnamed = SessionQueue::new(new_session_id(), left.clone(), &moves);
        // The tasks end with the test's runtime.
        let _named_drained = named.attach(&switching.service);
        let _unnamed_drained = unnamed.attach(&switching.service);
        let lead = SessionToMove {
            session_id: named.session_id,
            binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a binding id"),
        };
        Self {
            legs,
            switching,
            home_to,
            moves,
            named,
            lead,
            unnamed,
            left,
            to,
            tokens,
            _folder: folder,
        }
    }

    // Switches from the account left onto the other for `person`, naming the lead's session, and
    // answers the named session's move once it landed.
    async fn switch(&mut self, person: DeviceId) -> SessionAccountMove {
        let (moved, _login) = tokio::join!(
            move_codex_sessions(&self.legs, self.to.clone(), vec![self.lead.clone()], person),
            answer_login(&mut self.switching)
        );
        let mut moved = moved.into_iter();
        let named = moved
            .next()
            .expect("the switch answers the named session's move");
        assert!(moved.next().is_none());
        named.expect("the move lands")
    }

    // The account each binding of the two sessions was last moved onto: the lead's, the named
    // session's record's and the other session's record's.
    fn binding_accounts(&self) -> Vec<Option<ProviderAccountId>> {
        self.moves.last_accounts(&[
            &self.lead.binding_id,
            &self.named.record_binding,
            &self.unnamed.record_binding,
        ])
    }

    // Every request the switching service's connection sent that the test has not read.
    fn unread_requests(&mut self) -> Vec<Value> {
        std::iter::from_fn(|| self.switching.script.sent.try_recv().ok())
            .map(|text| serde_json::from_str(&text).expect("the connection sends JSON"))
            .collect()
    }
}

async fn answer_login(scripted: &mut ScriptedCodexService) {
    let login = scripted.next_request(CODEX_LOGIN_START_METHOD).await;
    scripted
        .script
        .answer(&login, &json!({"type": "chatgptAuthTokens"}));
}

fn signed_in() -> Value {
    json!({"account": {"type": "chatgpt"}, "requiresOpenaiAuth": true})
}

async fn settle(moved: SessionAccountMove) -> FirstRequestAfterMove {
    moved
        .first_request
        .await
        .expect("the first request settles")
}

// Killed by settling the watches as run at the check's answer once a hand-back took the window,
// by reporting the moves back, which would show a second move per session to the daemon, and by
// refusing the refresh inside the window, which leaves both sessions on the refused login.
#[tokio::test]
async fn a_refused_login_after_a_switch_hands_the_previous_account_back() {
    let mut fixture = Fixture::new().await;
    let person = switching_person();
    let named_move = fixture.switch(person.clone()).await;

    // Codex runs the check's workspace check on the new login, which it refuses, and asks for
    // fresh tokens before it answers the read.
    let check = fixture.switching.next_request("account/read").await;
    fixture.switching.script.send(&json!({
        "jsonrpc": "2.0",
        "id": "refresh",
        "method": CODEX_TOKEN_REFRESH_METHOD,
        "params": {"reason": "unauthorized", "previousAccountId": WORKSPACE_TO},
    }));
    let renewing = fixture.home_to.next_request("account/read").await;
    assert_eq!(
        renewing["params"]["refreshToken"],
        json!(true),
        "{renewing}"
    );
    // The renewal leaves the refused token in the home: the login is dead.
    fixture.home_to.script.answer(&renewing, &signed_in());
    let answer = fixture.switching.script.next_sent().await;
    fixture.switching.script.answer(&check, &signed_in());

    let named = settle(named_move).await;
    fixture.named.wait_until_seen(2).await;
    fixture.unnamed.wait_until_seen(2).await;
    let reported = fixture.moves.settle_reported().await;
    let left = fixture.left.clone();
    let to = fixture.to.clone();

    assert_eq!(
        answer,
        json!({
            "jsonrpc": "2.0",
            "id": "refresh",
            "result": {
                "accessToken": fixture.tokens[&left],
                "chatgptAccountId": WORKSPACE_LEFT,
                "chatgptPlanType": TEST_PLAN,
            },
        })
    );
    assert_eq!(
        fixture.switching.service.provider_account_id(),
        Some(left.clone())
    );
    assert_eq!(named, FirstRequestAfterMove::HandedBack);
    assert_eq!(reported, [FirstRequestAfterMove::HandedBack]);
    assert_eq!(fixture.binding_accounts(), vec![Some(left.clone()); 3]);
    let moved_to_and_back = [
        format!("moved to {}", to.as_str()),
        format!("moved to {}", left.as_str()),
    ];
    assert_eq!(fixture.named.seen(), moved_to_and_back);
    assert_eq!(fixture.unnamed.seen(), moved_to_and_back);
    assert_eq!(
        fixture.moves.reported(),
        [(fixture.unnamed.session_id, to, Some(person))]
    );
    assert_eq!(
        fixture.unread_requests(),
        Vec::<Value>::new(),
        "the hand-back sent a login of its own"
    );
}

// Killed by a check answered with an account settling anything but run, and by a failed check
// read as a dead login: a hand-back, a refusal or any watch settled as handed back.
#[rstest]
#[case::answered_with_an_account(true, FirstRequestAfterMove::Ran)]
#[case::failed(false, FirstRequestAfterMove::Unobserved)]
#[tokio::test]
async fn the_check_closes_the_window_without_a_hand_back(
    #[case] is_answered: bool,
    #[case] expected: FirstRequestAfterMove,
) {
    let mut fixture = Fixture::new().await;
    let named_move = fixture.switch(switching_person()).await;

    let check = fixture.switching.next_request("account/read").await;
    if is_answered {
        fixture.switching.script.answer(&check, &signed_in());
    } else {
        fixture.switching.script.send(&json!({
            "jsonrpc": "2.0",
            "id": check["id"],
            "error": {"code": -32603, "message": "the network is unreachable"},
        }));
    }
    let named = settle(named_move).await;
    fixture.unnamed.wait_until_seen(1).await;
    let reported = fixture.moves.settle_reported().await;
    let to = fixture.to.clone();

    assert_eq!(named, expected);
    assert_eq!(reported, [expected]);
    assert_eq!(
        fixture.switching.service.provider_account_id(),
        Some(to.clone())
    );
    assert_eq!(fixture.binding_accounts(), vec![Some(to); 3]);
    assert_eq!(fixture.unread_requests(), Vec::<Value>::new());
    assert!(
        fixture.home_to.script.sent.try_recv().is_err(),
        "the check ran a renewal"
    );
}
