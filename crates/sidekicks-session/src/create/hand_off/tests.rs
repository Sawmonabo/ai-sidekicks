use rstest::rstest;
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::mount::ExecutionMode;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_store::database::writer::DatabaseWriter;

use super::{SessionHandOff, record_hand_off_statement};
use crate::create::tests::{
    FIRST_ACCOUNT, Fixture, PROJECT_ID, SECOND_ACCOUNT, chat_request, lead, new_key,
    project_request,
};

const TITLE: &str = "Add the export button";
const MANAGED_MOUNTS: &str = "SELECT count(*) FROM repo_mounts WHERE origin = 'managed'";

/// Where the planning session works when its plan is handed off.
#[derive(Clone, Copy, Debug)]
enum PlanningSession {
    /// A project session at its mount's root.
    ProjectAtRoot,
    /// A project session in a subfolder of its repository.
    ProjectInSubfolder,
    /// A chat in its own folder.
    Chat,
}

/// Stores the hand-off of a plan made in `planning` to the fresh session `fresh`, as the verdict's
/// write does.
async fn record_hand_off(writer: &DatabaseWriter, planning: SessionId, fresh: SessionId) {
    let hand_off = SessionHandOff {
        session_id: fresh,
        client_idempotency_key: hand_off_key(fresh),
        plan_id: PlanId::try_from(mint_uuid_v7()).expect("a minted UUID is a plan id"),
        planning_session_id: planning,
        lead: lead(),
        permission_level: PermissionLevel::Ask,
        title: TITLE.to_owned(),
        device_id: DeviceId::new("device-1".to_owned()).expect("a device id"),
    };
    writer
        .write(vec![record_hand_off_statement(&hand_off)])
        .await
        .expect("the hand-off is recorded");
}

fn hand_off_key(fresh: SessionId) -> ClientUuid {
    ClientUuid::new(fresh.to_string()).expect("a session id is a client UUID")
}

// Dies to a second session minted for the key, to the birth run again on a born key (its record
// is refused), to `provisionedWorktree`, to `create_chat` called (a managed mount made), to the
// folder not written or the mount's root not folded to none, to the finish run (`active`, or a
// workspace bound), to the name missing or written with another origin, and to the planning
// session's account kept in place of the provider's current one.
#[rstest]
#[case::project_at_root(PlanningSession::ProjectAtRoot)]
#[case::project_in_subfolder(PlanningSession::ProjectInSubfolder)]
#[case::chat(PlanningSession::Chat)]
#[tokio::test]
async fn a_hand_off_births_its_fresh_session_once_where_the_planning_session_works(
    #[case] planning: PlanningSession,
) {
    let fixture = Fixture::new().await;
    let request = match planning {
        PlanningSession::ProjectAtRoot | PlanningSession::ProjectInSubfolder => {
            project_request(new_key(), None)
        }
        PlanningSession::Chat => chat_request(new_key()),
    };
    let planning_session = fixture
        .creation
        .create(request)
        .await
        .expect("the planning session is made")
        .session_id;
    let folder = match planning {
        PlanningSession::ProjectAtRoot | PlanningSession::Chat => "mount.canonical_root",
        PlanningSession::ProjectInSubfolder => "mount.canonical_root || '/packages/export'",
    };
    // The bind leaves the folder to the workspace's preparation, which a test stands in for.
    fixture.execute(&format!(
        "UPDATE workspaces SET state = 'ready', fs_root = \
         (SELECT {folder} FROM repo_mounts AS mount WHERE mount.id = workspaces.repo_mount_id) \
         WHERE session_id = '{planning_session}'"
    ));
    fixture.execute(&format!(
        "UPDATE provider_accounts SET is_default = 0 WHERE account_id = '{FIRST_ACCOUNT}';
         UPDATE provider_accounts SET is_default = 1 WHERE account_id = '{SECOND_ACCOUNT}';"
    ));
    let fresh = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    record_hand_off(&fixture.writer, planning_session, fresh).await;
    let managed_mounts = fixture.count(MANAGED_MOUNTS);

    for _ in 0..2 {
        fixture
            .creation
            .create_handed_off(hand_off_key(fresh))
            .await
            .expect("the fresh session is born, or answered once born");
    }

    assert_eq!(
        fixture.count(&format!(
            "SELECT count(*) FROM session_events \
             WHERE session_id = '{fresh}' AND type = 'session.created'"
        )),
        1
    );
    assert_eq!(fixture.count("SELECT count(*) FROM sessions"), 2);
    assert_eq!(
        fixture.text(&format!("SELECT state FROM sessions WHERE id = '{fresh}'")),
        Some("provisioning".to_owned())
    );
    assert_eq!(
        fixture.count(&format!(
            "SELECT count(*) FROM workspaces WHERE session_id = '{fresh}'"
        )),
        0
    );
    assert_eq!(fixture.count(MANAGED_MOUNTS), managed_mounts);

    let recorded = fixture
        .creation
        .read_recorded(hand_off_key(fresh))
        .await
        .expect("the record reads")
        .expect("the birth recorded its create");
    let session = recorded.session;
    assert_eq!(session.session_id, fresh);
    assert_eq!(session.execution_mode, ExecutionMode::BoundRoot);
    let project = match planning {
        PlanningSession::ProjectAtRoot | PlanningSession::ProjectInSubfolder => {
            Some(ProjectId::new(PROJECT_ID).expect("a project id"))
        }
        PlanningSession::Chat => None,
    };
    assert_eq!(session.project_id, project);
    assert_eq!(session.provider_account_id.as_str(), SECOND_ACCOUNT);
    let directory = match planning {
        PlanningSession::ProjectAtRoot | PlanningSession::Chat => None,
        PlanningSession::ProjectInSubfolder => fixture.text(&format!(
            "SELECT fs_root FROM workspaces WHERE session_id = '{planning_session}'"
        )),
    };
    assert_eq!(
        session
            .directory
            .as_ref()
            .map(|path| path.as_str().to_owned()),
        directory
    );

    assert_eq!(
        fixture.text(&format!("SELECT name FROM sessions WHERE id = '{fresh}'")),
        Some(TITLE.to_owned())
    );
    assert_eq!(
        fixture.text(&format!(
            "SELECT json_extract(payload, '$.origin') FROM session_events \
             WHERE session_id = '{fresh}' AND type = 'session.renamed'"
        )),
        Some("auto".to_owned())
    );
}
