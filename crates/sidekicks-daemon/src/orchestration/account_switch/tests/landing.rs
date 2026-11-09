//! A move a driver reports with no switch waiting on it, landed as a switch's lead is.

use futures::FutureExt as _;
use sidekicks_contracts::provider::account::record::ProviderAccountHealthState;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::account::{FirstRequestAfterMove, SessionAccountMove};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::schema::session_directory::insert_session_row;

use super::{actor, fixture};

// Fails when a session a driver moved with no switch waiting on the move does not land as a
// switch's lead lands: `changed` in place by the person whose switch moved it, else by this
// machine's own device, its level the new account cannot run moved to `ask` with one notice, and
// its first request's hand-back recorded; or when a session whose log names no lead records
// anything; or when a move reported once the switch is gone lands, as one through a switch the
// record held strongly would.
#[tokio::test]
async fn a_move_no_switch_waits_on_lands_as_a_switch_lead_does() {
    let fixture = fixture().await;
    let left = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let to = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let reviewed = fixture
        .session(
            PROVIDERS[0].id,
            &left,
            None,
            PermissionLevel::Reviewed,
            true,
        )
        .await;
    let by_machine = fixture
        .session(PROVIDERS[0].id, &left, None, PermissionLevel::Ask, true)
        .await;
    let no_lead = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    insert_session_row(
        &fixture.database.reader(),
        no_lead.text().as_str(),
        None,
        None,
    );
    let person = actor();
    let handed_back = SessionAccountMove::landed(
        reviewed,
        to.clone(),
        futures::future::ready(Ok(FirstRequestAfterMove::HandedBack)).boxed(),
    );

    for (moved, moved_by) in [
        (handed_back, Some(person.clone())),
        (SessionAccountMove::unobserved(by_machine, to.clone()), None),
    ] {
        fixture
            .move_record
            .land(moved, moved_by)
            .await
            .expect("the lead reads")
            .await
            .expect("the landing ends");
    }
    let unled = fixture
        .move_record
        .land(SessionAccountMove::unobserved(no_lead, to.clone()), None)
        .await;

    let events = fixture.appended(reviewed);
    let kinds: Vec<&str> = events.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "agent.providerBinding.changed",
            "session.notice.posted",
            "agent.providerBinding.changeFailed"
        ]
    );
    assert_eq!(events[0].1["landedProviderAccountId"], to.as_str());
    assert_eq!(events[0].1["continuity"], "inPlace");
    assert_eq!(events[0].1["actor"], person.as_str());
    assert_eq!(events[1].1["kind"], "levelUnavailable");
    assert_eq!(events[2].1["accountState"], "reauthRequired");
    assert_eq!(events[2].1["actor"], person.as_str());
    assert_eq!(
        *lock(&fixture.level_moves.0),
        [(reviewed, PermissionLevel::Ask)]
    );
    let by_machine_events = fixture.appended(by_machine);
    assert_eq!(by_machine_events.len(), 1);
    assert_eq!(
        by_machine_events[0].1["actor"],
        fixture.machine_device_id.as_str()
    );
    assert!(unled.is_none(), "a session with no lead lands nothing");
    assert_eq!(fixture.appended(no_lead), []);
    drop(fixture.switch);
    let unswitched = fixture
        .move_record
        .land(SessionAccountMove::unobserved(by_machine, to), None)
        .await;
    assert!(
        unswitched.is_none(),
        "a move once the switch is gone lands nothing"
    );
}
