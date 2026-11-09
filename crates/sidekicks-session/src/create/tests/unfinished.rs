//! A session whose create has not finished: the person's archive, unarchive and close each take
//! it, and the unarchive runs its finish again at once.

use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::test_registry::test_driver_services;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use tokio::time::timeout;

use super::{Fixture, new_key, project_request};
use crate::changes::{
    SESSION_CHANGES_STATEMENT_CAPACITY, SessionChanges, UnarchivedCreateListener,
};

// Long enough for an unarchive and its finish that nothing holds back.
const FINISH_WAIT: Duration = Duration::from_secs(10);

// The person's changes over the fixture's database, the creation finishing what they unarchive.
fn session_changes(fixture: &Fixture) -> SessionChanges {
    let changes = SessionChanges::new(
        Arc::new(DatabaseReadPool::new(
            fixture.database.path(),
            SESSION_CHANGES_STATEMENT_CAPACITY,
        )),
        Arc::clone(&fixture.event_log),
        Arc::new(ProviderRegistry::register_from(
            &[],
            &test_driver_services(),
        )),
    );
    changes
        .unarchived_creates()
        .register(Arc::clone(&fixture.creation) as Arc<dyn UnarchivedCreateListener>)
        .expect("the creation registers once");
    changes
}

fn state_of(fixture: &Fixture, session_id: SessionId) -> Option<String> {
    fixture.text(&format!(
        "SELECT state FROM sessions WHERE id = '{session_id}'"
    ))
}

fn activations(fixture: &Fixture, session_id: SessionId) -> i64 {
    fixture.count(&format!(
        "SELECT count(*) FROM session_events \
         WHERE session_id = '{session_id}' AND type = 'session.activated'"
    ))
}

// A session made while its project clones, which reads `provisioning` until a finish binds it.
async fn create_while_cloning(fixture: &Fixture) -> SessionId {
    fixture.start_cloning();
    let created = fixture
        .creation
        .create(project_request(new_key(), None))
        .await
        .expect("the create lands");
    assert_eq!(created.state, SessionState::Provisioning);
    created.session_id
}

// A session whose finish can never succeed is archived, unarchived to `provisioning` with its
// finish failing again, and closed; a session that was activated unarchives to `active`. Dies to
// the archive or the close refusing a `provisioning` session, which leaves the session with no way
// out; to the unarchive answering `active` for a session never activated, which sets it live with
// nothing bound; and to the unarchive answering `provisioning` for an activated one, which sends
// every archived session back to a finish that never comes.
#[tokio::test]
async fn a_session_whose_finish_cannot_succeed_is_archived_unarchived_and_closed() {
    let fixture = Fixture::new().await;
    let stuck = create_while_cloning(&fixture).await;
    fixture.end_cloning();
    // The lead's driver is gone, so every retry, every start and every unarchive fails the finish.
    fixture.execute(&format!(
        "UPDATE session_events \
         SET payload = json_set(payload, '$.mainAgent.binding.providerName', 'gone') \
         WHERE type = 'session.created' AND session_id = '{stuck}'"
    ));
    fixture
        .creation
        .finish_stopped_creates()
        .await
        .expect_err("the start cannot finish the session");
    let activated = fixture
        .creation
        .create(project_request(new_key(), None))
        .await
        .expect("the create lands")
        .session_id;
    let changes = session_changes(&fixture);

    for session_id in [stuck, activated] {
        changes
            .archive(session_id)
            .await
            .expect("the session is archived");
        assert_eq!(state_of(&fixture, session_id), Some("archived".to_owned()));
        changes
            .reactivate(session_id)
            .await
            .expect("the archived session is unarchived");
    }
    // Every finish the unarchives started has ended.
    changes.stop().await;

    assert_eq!(state_of(&fixture, stuck), Some("provisioning".to_owned()));
    assert_eq!(activations(&fixture, stuck), 0);
    assert_eq!(state_of(&fixture, activated), Some("active".to_owned()));
    assert_eq!(activations(&fixture, activated), 1);
    changes
        .close(stuck)
        .await
        .expect("a session left provisioning is closed");
    assert_eq!(state_of(&fixture, stuck), Some("closed".to_owned()));
}

// The unarchive of a session whose create can now finish answers at once, before the finish
// reaches its activation, and the finish then sets it `active`. Dies to the unarchive handing the
// session to no finish, which leaves it `provisioning` until the daemon's next start, and to the
// finish run before the unarchive answers, which holds the person's answer on the bind.
#[tokio::test]
async fn an_unarchived_session_whose_create_can_now_finish_is_finished_at_once() {
    let fixture = Fixture::new().await;
    let session_id = create_while_cloning(&fixture).await;
    let changes = session_changes(&fixture);
    changes
        .archive(session_id)
        .await
        .expect("the session is archived");
    fixture.end_cloning();
    let held = fixture.creation.activated_append_pause.arm();

    timeout(FINISH_WAIT, changes.reactivate(session_id))
        .await
        .expect("the unarchive answers while the finish is held")
        .expect("the archived session is unarchived");
    assert_eq!(
        state_of(&fixture, session_id),
        Some("provisioning".to_owned())
    );
    timeout(FINISH_WAIT, held.reached)
        .await
        .expect("the unarchive starts the finish")
        .expect("the finish reaches its append");
    held.release.send(()).expect("the finish waits");
    changes.stop().await;

    assert_eq!(state_of(&fixture, session_id), Some("active".to_owned()));
}
