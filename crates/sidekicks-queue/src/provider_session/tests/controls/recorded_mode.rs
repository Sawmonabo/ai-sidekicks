//! The mode stored for a session whose provider has already moved to it.

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_provider::driver::contract::params_and_results::{
    ProviderReportedLevel, SessionProcessState,
};
use sidekicks_session::console_state::read_session_mode;
use sidekicks_session::permission_level::read_session_permission_level;

use super::super::Opening;
use super::{controls_moved, posted_notices, store_plan_mode};

// A Plan session whose live provider moved to Build is stored in Build once, with no mode move
// sent to its driver; when the provider's own report of the move was followed first, the record
// writes nothing more. Killed by recording through the mode move, which sends the driver a move,
// and by a record that writes a second move over the stored one.
#[rstest]
#[case::recorded(false)]
#[case::reported_first(true)]
#[tokio::test]
async fn a_mode_the_provider_moved_to_is_stored_once_without_a_driver_move(
    #[case] is_reported_first: bool,
) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), move |driver, _| {
        driver
            .expect_session_process_state()
            .return_const(SessionProcessState::Live);
        driver
            .expect_reported_level()
            .return_const(Some(ProviderReportedLevel {
                level: None,
                session_mode: SessionMode::Build,
            }));
        driver.expect_update_permission_level().never();
        // Only the followed report moves the driver; a move the daemon sent would match nothing.
        driver
            .expect_update_session_mode()
            .withf(|params| params.is_provider_reported && params.mode == SessionMode::Build)
            .times(usize::from(is_reported_first))
            .returning(|_params| async { Ok(()) }.boxed());
    })
    .await;
    store_plan_mode(&opening);
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    let level = read_session_permission_level(&opening.database.reader(), &opening.session_id)
        .expect("the stored level reads");
    if is_reported_first {
        opening
            .sessions
            .follow_reported_level(opening.session_id)
            .await
            .expect("the reported mode is followed");
    }

    opening
        .sessions
        .record_mode(opening.session_id, SessionMode::Build)
        .await
        .expect("the mode is stored");

    let stored = read_session_mode(&opening.database.reader(), &opening.session_id)
        .expect("the stored mode reads");
    assert_eq!(stored, SessionMode::Build);
    assert_eq!(
        posted_notices(&opening),
        vec![controls_moved(&opening, level, SessionMode::Build)]
    );
}
