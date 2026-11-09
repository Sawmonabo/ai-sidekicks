//! Two switches by the person while the driver holds the first's moves for a turn to end: the
//! second joins the held moves, a switch back among them, and the transcript records each
//! session's landing once.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::{
    ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::account::{
    FirstRequestAfterMove, ProviderSwitchLegs, SessionAccountMove, SessionToMove,
    SwitchMovesAccepted,
};
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use super::{actor, fixture_switching_through};

// The first switch's moves, held until a second switch joins them: where they land, and the
// sessions the second names too.
type HeldLanding = oneshot::Sender<(ProviderAccountId, HashSet<SessionId>)>;

// Switch legs that hold a switch as a driver holds one until a turn ends, telling the daemon at
// once that its moves wait; a second switch joins it, and both land on the second's account, each
// session the second names too answered to the first as replaced. Each call's account left is
// recorded, the one a driver hands back after a refused login.
#[derive(Default)]
struct HoldingSwitchLegs {
    held: Mutex<Option<HeldLanding>>,
    left: Mutex<Vec<ProviderAccountId>>,
}

impl ProviderSwitchLegs for HoldingSwitchLegs {
    fn move_sessions(
        &self,
        from: ProviderAccountId,
        to: ProviderAccountId,
        sessions: Vec<SessionToMove>,
        _actor: DeviceId,
        accepted: SwitchMovesAccepted,
    ) -> BoxFuture<'_, Vec<Result<SessionAccountMove, (SessionId, DriverError)>>> {
        lock(&self.left).push(from);
        accepted
            .send(())
            .expect("the daemon waits for the moves to be held");
        let named: HashSet<SessionId> = sessions.iter().map(|session| session.session_id).collect();
        let held = lock(&self.held).take();
        async move {
            // The second switch lands the held one on its own account.
            let (landed_on, replaced) = if let Some(first) = held {
                first
                    .send((to.clone(), named))
                    .expect("the first switch waits");
                (to, HashSet::new())
            } else {
                let (landing, landed) = oneshot::channel();
                *lock(&self.held) = Some(landing);
                landed.await.expect("a second switch joins the held one")
            };
            sessions
                .into_iter()
                .map(|session| {
                    Ok(if replaced.contains(&session.session_id) {
                        SessionAccountMove::replaced(session.session_id, landed_on.clone())
                    } else {
                        SessionAccountMove::landed(
                            session.session_id,
                            landed_on.clone(),
                            futures::future::ready(Ok(FirstRequestAfterMove::Ran)).boxed(),
                        )
                    })
                })
                .collect()
        }
        .boxed()
    }
}

// A second switch asked while the driver holds the first's moves begins at once and joins them:
// each session lands once, on the newest account, with one `changed` naming it and nothing for
// the switch it replaced. Killed by the provider's lock held through the hold (the second switch
// never begins, so neither lands), by a replaced move recorded as `changeFailed`, and by one
// recorded as a second `changed`.
#[tokio::test]
async fn two_switches_during_held_moves_record_each_landing_once_on_the_newest_account() {
    let legs = Arc::new(HoldingSwitchLegs::default());
    let fixture = fixture_switching_through(Some(legs as Arc<dyn ProviderSwitchLegs>)).await;
    let old = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let first = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let newest = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let mut sessions = Vec::new();
    for _ in 0..2 {
        sessions.push(
            fixture
                .session(PROVIDERS[0].id, &old, None, PermissionLevel::Ask, true)
                .await,
        );
    }

    let replaced = fixture
        .switch
        .make_current(first, actor())
        .await
        .expect("the first switch is made");
    let newer = tokio::time::timeout(
        Duration::from_secs(10),
        fixture.switch.make_current(newest.clone(), actor()),
    )
    .await
    .expect("the second switch begins while the first's moves are held")
    .expect("the second switch is made");
    for settled in [replaced.settled, newer.settled] {
        tokio::time::timeout(Duration::from_secs(10), settled)
            .await
            .expect("every move lands")
            .expect("the switch's task ends");
    }

    for session in sessions {
        let events = fixture.appended(session);
        let kinds: Vec<&str> = events.iter().map(|(kind, _)| kind.as_str()).collect();
        assert_eq!(kinds, ["agent.providerBinding.changed"], "{events:?}");
        assert_eq!(events[0].1["landedProviderAccountId"], newest.as_str());
    }
}

// A switch back onto the account the sessions still run on, asked while the driver holds their
// move away from it, names them and lands them back: each records one `changed` onto the account
// it never left, and both switches name that account as the one the session leaves, so a refused
// login on the switch back hands the session the account it runs on, never the held move's. Killed
// by the switch back reading each session by its binding alone, which skips them, so the held move
// never joins and lands nowhere, and by the held move's account named as the one left (a refused
// login then sends the session to the account switched away from).
#[tokio::test]
async fn a_switch_back_during_held_moves_lands_each_session_on_the_account_it_ran_on() {
    let legs = Arc::new(HoldingSwitchLegs::default());
    let fixture =
        fixture_switching_through(Some(Arc::clone(&legs) as Arc<dyn ProviderSwitchLegs>)).await;
    let ran_on = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let other = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let session = fixture
        .session(PROVIDERS[0].id, &ran_on, None, PermissionLevel::Ask, true)
        .await;

    let away = fixture
        .switch
        .make_current(other, actor())
        .await
        .expect("the switch away is made");
    let back = fixture
        .switch
        .make_current(ran_on.clone(), actor())
        .await
        .expect("the switch back is made");
    assert_eq!(back.moving_sessions, [session]);
    for settled in [away.settled, back.settled] {
        tokio::time::timeout(Duration::from_secs(10), settled)
            .await
            .expect("every move lands")
            .expect("the switch's task ends");
    }

    let events = fixture.appended(session);
    let kinds: Vec<&str> = events.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(kinds, ["agent.providerBinding.changed"], "{events:?}");
    assert_eq!(events[0].1["landedProviderAccountId"], ran_on.as_str());
    assert_eq!(*lock(&legs.left), [ran_on.clone(), ran_on]);
}
