use rstest::rstest;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::session::goal::{
    SessionGoal, SessionGoalClearedPayload, SessionGoalStatus, SessionGoalUpdatedPayload,
};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;

use super::{ClaudeSessionGoal, GoalEnding, GoalEndingInput, GoalTurnEnd, classify_goal_ending};
use crate::driver::claude::goals::records::GoalStatusRecord;
use crate::driver::test_registry::new_session_id;

// What Claude Code wrote, owned so a case can hold it.
enum Written {
    Lead(&'static str),
    Helper(&'static str),
    Synthetic(&'static str),
    Meta,
    Record(GoalStatusRecord),
    End(GoalTurnEnd),
}

// The row a case expects drawn.
enum Drawn {
    Nothing,
    Active(&'static str),
    Complete(&'static str),
    Impossible(&'static str, &'static str),
    Cleared,
    NotMet,
    CheckUnfinished,
}

fn record(met: bool, failed: bool, sentinel: bool, condition: Option<&str>) -> GoalStatusRecord {
    GoalStatusRecord {
        met,
        failed,
        sentinel,
        condition: condition.map(str::to_owned),
        reason: None,
    }
}

fn updated(
    session: &ClaudeSessionGoal,
    condition: &str,
    status: SessionGoalStatus,
    reason: Option<&str>,
) -> GoalEnding {
    GoalEnding::Updated(SessionGoalUpdatedPayload {
        session_id: session.session_id,
        agent_id: session.agent_id,
        goal: SessionGoal {
            text: FreeFormText::new(condition.to_owned()).expect("a test condition fits"),
        },
        status,
        reason: reason.map(|reason| FreeFormText::new(reason.to_owned()).expect("it fits")),
    })
}

// One case per row of the goal table, each naming its row; the mutation each kills:
// `set_again` the condition compare dropped (the same condition posts again); `replaced` a
// replaced goal dropped; `sentinel_clear` the sentinel read dropped or read without `met` (a clear
// reads as complete); `impossible` `failed` read as complete; `stop_hook_feedback`, `unmet` and
// `check_in` a check frame or unmet record that clears the goal or reads as a message; `capped` the
// cap mark dropped (the empty `result` posts no `goalNotMet`); `deferred` the liveness check
// dropped (a deferred result reads as unfinished); `step_bound` and `interrupted` either fact
// dropped (the turn reads as unfinished); `no_goal_set_*` the active check dropped either way.
#[rstest]
#[case::set(None, Written::Lead("Goal set: c"), Drawn::Active("c"), Some("c"))]
#[case::set_again(Some("c"), Written::Lead("Goal set: c"), Drawn::Nothing, Some("c"))]
#[case::replaced(
    Some("c"),
    Written::Record(record(false, false, true, Some("d"))),
    Drawn::Active("d"),
    Some("d")
)]
#[case::sentinel_same(
    Some("d"),
    Written::Record(record(false, false, true, Some("d"))),
    Drawn::Nothing,
    Some("d")
)]
#[case::cleared_line(Some("d"), Written::Lead("Goal cleared: d"), Drawn::Cleared, None)]
#[case::cleared_after_error(
    Some("d"),
    Written::Lead("Goal cleared after an unrecoverable error"),
    Drawn::Cleared,
    None
)]
#[case::sentinel_clear(
    Some("c"),
    Written::Record(record(true, false, true, Some("c"))),
    Drawn::Cleared,
    None
)]
#[case::sentinel_clear_already_recorded(
    None,
    Written::Record(record(true, false, true, Some("c"))),
    Drawn::Nothing,
    None
)]
#[case::no_goal_set_none(
    None,
    Written::Lead("No goal set. Usage: /goal <condition>"),
    Drawn::Nothing,
    None
)]
#[case::no_goal_set_active(Some("c"), Written::Lead("No goal set"), Drawn::Cleared, None)]
#[case::complete(
    Some("c"),
    Written::Record(record(true, false, false, Some("c"))),
    Drawn::Complete("c"),
    None
)]
#[case::complete_already_recorded(
    None,
    Written::Record(record(true, false, false, Some("c"))),
    Drawn::Nothing,
    None
)]
#[case::impossible(
    Some("c"),
    Written::Record(GoalStatusRecord {
        reason: Some("it cannot be done".to_owned()),
        ..record(false, true, false, Some("c"))
    }),
    Drawn::Impossible("c", "it cannot be done"),
    None
)]
#[case::unmet(
    Some("c"),
    Written::Record(GoalStatusRecord {
        reason: Some("not yet".to_owned()),
        ..record(false, false, false, Some("c"))
    }),
    Drawn::Nothing,
    Some("c")
)]
#[case::stop_hook_feedback(
    Some("c"),
    Written::Synthetic("Stop hook feedback: [c]: not yet"),
    Drawn::Nothing,
    Some("c")
)]
#[case::check_in(Some("c"), Written::Meta, Drawn::Nothing, Some("c"))]
#[case::capped(
    Some("c"),
    Written::End(GoalTurnEnd {
        is_check_capped: true,
        is_text_empty: true,
        has_record: true,
        ..GoalTurnEnd::default()
    }),
    Drawn::NotMet,
    Some("c")
)]
#[case::deferred(
    Some("c"),
    Written::End(GoalTurnEnd { has_live_work: true, ..GoalTurnEnd::default() }),
    Drawn::Nothing,
    Some("c")
)]
#[case::check_unfinished(
    Some("c"),
    Written::End(GoalTurnEnd::default()),
    Drawn::CheckUnfinished,
    Some("c")
)]
#[case::step_bound(
    Some("c"),
    Written::End(GoalTurnEnd { is_step_bound: true, ..GoalTurnEnd::default() }),
    Drawn::Nothing,
    Some("c")
)]
#[case::interrupted(
    Some("c"),
    Written::End(GoalTurnEnd { is_interrupted: true, ..GoalTurnEnd::default() }),
    Drawn::Nothing,
    Some("c")
)]
#[case::end_without_goal(None, Written::End(GoalTurnEnd::default()), Drawn::Nothing, None)]
#[case::helper_goal_line(None, Written::Helper("Goal set: c"), Drawn::Nothing, None)]
fn each_row_of_the_goal_table_draws_its_row_and_leaves_its_goal(
    #[case] active_before: Option<&str>,
    #[case] written: Written,
    #[case] drawn: Drawn,
    #[case] active_after: Option<&str>,
) {
    let mut session = ClaudeSessionGoal {
        session_id: new_session_id(),
        agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id"),
        active_condition: active_before.map(str::to_owned),
    };
    let input = match &written {
        Written::Lead(text) => GoalEndingInput::LeadText(text),
        Written::Helper(text) => GoalEndingInput::HelperText(text),
        Written::Synthetic(text) => GoalEndingInput::SyntheticUser(text),
        Written::Meta => GoalEndingInput::MetaUser,
        Written::Record(record) => GoalEndingInput::Record(record),
        Written::End(end) => GoalEndingInput::Result(*end),
    };
    let (session_id, agent_id) = (session.session_id, session.agent_id);
    let expected = match drawn {
        Drawn::Nothing => GoalEnding::Nothing,
        Drawn::Active(condition) => updated(&session, condition, SessionGoalStatus::Active, None),
        Drawn::Complete(condition) => {
            updated(&session, condition, SessionGoalStatus::Complete, None)
        }
        Drawn::Impossible(condition, reason) => updated(
            &session,
            condition,
            SessionGoalStatus::Impossible,
            Some(reason),
        ),
        Drawn::Cleared => GoalEnding::Cleared(SessionGoalClearedPayload {
            session_id,
            agent_id,
        }),
        Drawn::NotMet => GoalEnding::NoticeNotMet(SessionNotice::GoalNotMet {
            session_id,
            agent_id,
        }),
        Drawn::CheckUnfinished => {
            GoalEnding::NoticeCheckUnfinished(SessionNotice::GoalCheckUnfinished {
                session_id,
                agent_id,
            })
        }
    };

    let ending = classify_goal_ending(&mut session, &input);

    assert_eq!(ending, expected);
    assert_eq!(session.active_condition.as_deref(), active_after);
}
