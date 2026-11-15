use std::sync::Arc;

use futures::FutureExt as _;
use rstest::rstest;
use serde_json::json;
use sidekicks_agent::tools::secret_key::ToolServerSecretKey;
use sidekicks_agent::tools::session::SessionReference;
use sidekicks_agent::tools::session::errors::{SharedNameHolder, shared_name};
use sidekicks_agent::tools::session::read::{SessionReadArguments, position_unknown, rest_of_row};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::TranscriptBodyReadResponse;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::test_registry::registry_of_first_providers;
use sidekicks_session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};
use sidekicks_store::credential_store::SecretKeychain;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::credential_store::test_keychain::test_keychain;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{
    TestDatabase, insert_lead, insert_test_event, test_run_id, test_session_id,
};
use sidekicks_store::events::test_log::AT;

use super::{READ_PAGE_MAX_BYTES, page_cut, read_session};
use crate::agent_tools::AgentToolError;
use crate::agent_tools::session::read::output::LineCursorKey;
use crate::daemon::schema::schema_parts;
use crate::orchestration::session_directory::SessionDirectory;

// A database holding this machine's row.
fn database_of_this_machine() -> (TestDatabase, rusqlite::Connection) {
    let database = TestDatabase::new(schema_parts());
    let reader = database.opener()().expect("the test creates its database");
    reader
        .execute(
            "INSERT INTO local_machine (singleton, machine_id, owner_user_id, name, minted_at)
             VALUES (1, ?1, ?2, 'this Mac', ?3)",
            [
                mint_uuid_v7().to_string(),
                mint_uuid_v7().to_string(),
                WireInstant::now().as_str().to_owned(),
            ],
        )
        .expect("the test records this machine");
    (database, reader)
}

// The directory and the session store over `database`, its one provider holding no session
// typed in a terminal.
fn directory_and_sessions(database: &TestDatabase) -> (SessionDirectory, SessionService) {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_list_terminal_sessions()
        .returning(|| async { Ok(Vec::new()) }.boxed());
    driver
        .expect_list_standalone_terminal_sessions()
        .returning(|| async { Ok(Vec::new()) }.boxed());
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        SESSION_SERVICE_STATEMENT_CAPACITY,
    ));
    let directory = SessionDirectory {
        pool: Arc::clone(&pool),
        providers: Arc::new(registry_of_first_providers(vec![
            Arc::new(driver) as Arc<dyn ProviderDriver>
        ])),
        read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
    };
    let sessions = SessionService::new(
        pool,
        Arc::new(|_: &SessionId| None),
        Arc::new(|_: &ProviderId| None),
    );
    (directory, sessions)
}

// The line cursor key derived from the tool-server key `keychain` keeps, read back anew as each
// start of the daemon reads it.
async fn cursor_key(keychain: &dyn SecretKeychain) -> LineCursorKey {
    let key = ToolServerSecretKey::read_or_create(keychain)
        .await
        .expect("the test keychain keeps the key");
    LineCursorKey::of(&key)
}

// The text a cut row's last line, or a page's last line, quotes last: its cursor.
fn quoted_cursor(line: &str) -> &str {
    line.rsplit('"').nth(1).expect("the line quotes a cursor")
}

// A name two sessions share is refused with both holders before any transcript is read.
// Killed by reading the first session the name matches.
#[tokio::test]
async fn session_read_on_an_ambiguous_name_answers_the_choices_and_reads_nothing() {
    let (database, reader) = database_of_this_machine();
    let caller: SessionId = test_session_id();
    let builders: [SessionId; 2] = [test_session_id(), test_session_id()];
    for builder in builders {
        insert_session_row(&reader, builder.text().as_str(), Some("builder"), None);
        insert_lead(&database, builder, PROVIDERS[0].id);
    }
    let (directory, sessions) = directory_and_sessions(&database);
    let arguments = SessionReadArguments {
        session: SessionReference::new("builder".to_owned()).expect("a valid reference"),
        turns: None,
        around: None,
        include: None,
        output: None,
        lines: None,
        search: None,
        cursor: None,
    };

    let (_data_folder, _store, keychain) = test_keychain(KeychainService::ToolServerKey);
    let cursor_key = cursor_key(keychain.as_ref()).await;

    let refused = read_session(&directory, &sessions, &cursor_key, &caller, arguments).await;
    let Err(AgentToolError::Refused(text)) = refused else {
        panic!("a shared name is refused, never read");
    };
    let [first, second] = builders.map(|builder| builder.to_string());
    assert_eq!(
        text,
        shared_name(
            "builder",
            &[
                SharedNameHolder {
                    name: "builder",
                    id: &first,
                    project: "no project",
                },
                SharedNameHolder {
                    name: "builder",
                    id: &second,
                    project: "no project",
                },
            ],
        )
    );
}

// An answer longer than a page is cut there with a line naming the id its rest reads under,
// and that read walks the whole body by lines, page by page, as it was written. Killed by an
// over-page row with no such line, and by a line split wrongly where the body's parts meet.
#[tokio::test]
async fn an_answer_past_a_page_reads_on_by_its_lines() {
    let (database, reader) = database_of_this_machine();
    let caller: SessionId = test_session_id();
    let builder: SessionId = test_session_id();
    insert_session_row(&reader, builder.text().as_str(), Some("builder"), None);
    insert_lead(&database, builder, PROVIDERS[0].id);
    let lines: Vec<String> = (1..=20_000).map(|line| format!("line {line:05}")).collect();
    let body = lines.join("\n");
    insert_test_event(
        &reader,
        builder,
        json!({
            "type": "agent.message.sent",
            "payload": {
                "sessionId": builder,
                "runId": test_run_id(),
                "providerMessageId": "m1",
            },
        }),
        Some(&body),
        AT,
    );
    let (directory, sessions) = directory_and_sessions(&database);
    let (_data_folder, _store, keychain) = test_keychain(KeychainService::ToolServerKey);
    let cursor_key = cursor_key(keychain.as_ref()).await;
    let read = |arguments: serde_json::Value| {
        let arguments: SessionReadArguments =
            serde_json::from_value(arguments).expect("the test's arguments parse");
        read_session(&directory, &sessions, &cursor_key, &caller, arguments)
    };

    let answer = read(json!({"session": "builder"}))
        .await
        .expect("the answer reads");
    let (shown, rest) = answer
        .rsplit_once('\n')
        .expect("a cut answer ends with a line");
    assert!(shown.starts_with("answer: line 00001\nline 00002\n"));
    assert!(shown.len() <= READ_PAGE_MAX_BYTES);
    let output = rest
        .split('"')
        .nth(1)
        .expect("the line names the answer's id");
    let cut_line = u64::try_from(shown.lines().count()).expect("a count fits 64 bits");
    assert_eq!(rest, rest_of_row(output, cut_line, quoted_cursor(rest)));

    let mut read_lines: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut arguments = json!({"session": "builder", "output": output, "lines": "1-20000"});
        if let Some(cursor) = &cursor {
            arguments["cursor"] = json!(cursor);
        }
        let page = read(arguments).await.expect("a page of lines reads");
        cursor = None;
        for line in page.lines() {
            match line.strip_prefix("More: next_cursor \"") {
                Some(next) => cursor = Some(next.trim_end_matches('"').to_owned()),
                None => read_lines.push(line.to_owned()),
            }
        }
        if cursor.is_none() {
            break;
        }
    }
    let numbered: Vec<String> = (1_u64..)
        .zip(&lines)
        .map(|(number, line)| format!("{number}: {line}"))
        .collect();
    assert_eq!(read_lines, numbered);

    let last = read(json!({"session": "builder", "output": output, "lines": "-2"}))
        .await
        .expect("the last lines read");
    assert_eq!(last, "19999: line 19999\n20000: line 20000");
}

// A message whose first line is longer than two pages, whose text only its event holds, is cut
// inside that line with a line naming its id and a cursor, and following the cursors reads that
// line to its last byte, then every line after it to the last, page by page. Each read rebuilds
// the cursor key from the tool-server key the keychain keeps, as a later start of the daemon
// does; a cursor read under another keychain's key, or moved to another line, is refused. Killed
// by a message read refused as no output, by a line cut with no cursor inside it or cut at a byte
// that is not the next page's first, by a cursor key that is not derived from the kept key, and by
// a cursor taken at a place it was not handed out for.
#[tokio::test]
async fn a_message_past_a_page_reads_on_by_its_lines_to_its_last() {
    let (database, reader) = database_of_this_machine();
    let caller: SessionId = test_session_id();
    let builder: SessionId = test_session_id();
    insert_session_row(&reader, builder.text().as_str(), Some("builder"), None);
    insert_lead(&database, builder, PROVIDERS[0].id);
    // A line of 150,000 bytes of one-, two- and three-byte characters, so pages cut between the
    // bytes of a character unless the cut finds its boundary, then about 66 KB of short lines.
    let long_line = "é漢a".repeat(25_000);
    let lines: Vec<String> = std::iter::once(long_line.clone())
        .chain((2..=6_000).map(|line| format!("line {line:05}")))
        .collect();
    let (_, message_id) = insert_test_event(
        &reader,
        builder,
        json!({
            "type": SessionEventType::UserMessageSent.as_str(),
            "payload": {"sessionId": builder, "actor": "person", "message": lines.join("\n")},
        }),
        None,
        AT,
    );
    let (directory, sessions) = directory_and_sessions(&database);
    let (_data_folder, _store, keychain) = test_keychain(KeychainService::ToolServerKey);
    let (directory, sessions, caller, keychain) = (&directory, &sessions, &caller, &keychain);
    let read = move |arguments: serde_json::Value| async move {
        let cursor_key = cursor_key(keychain.as_ref()).await;
        let arguments: SessionReadArguments =
            serde_json::from_value(arguments).expect("the test's arguments parse");
        read_session(directory, sessions, &cursor_key, caller, arguments).await
    };

    let turn = read(json!({"session": "builder", "turns": 1}))
        .await
        .expect("the turn reads");
    let (shown, rest) = turn
        .rsplit_once('\n')
        .expect("a cut message ends with a line");
    let opening = shown
        .strip_prefix("message: ")
        .expect("the row opens with its label");
    assert!(long_line.starts_with(opening));
    let pointed = quoted_cursor(rest);
    assert_eq!(rest, rest_of_row(&message_id, 1, pointed));

    let mut read_long_line = opening.to_owned();
    let mut read_lines: Vec<String> = Vec::new();
    let mut cursor = Some(pointed.to_owned());
    let mut first_cursor: Option<String> = None;
    while let Some(from) = cursor.take() {
        let page = read(json!({"session": "builder", "output": message_id, "cursor": from}))
            .await
            .expect("a page of lines reads");
        for line in page.lines() {
            if let Some(next) = line.strip_prefix("More: next_cursor ") {
                cursor = Some(next.trim_matches('"').to_owned());
            } else if let Some(more) = line.strip_prefix("1 (cont.): ") {
                read_long_line.push_str(more);
            } else {
                read_lines.push(line.to_owned());
            }
        }
        if first_cursor.is_none() {
            first_cursor.clone_from(&cursor);
        }
    }
    assert_eq!(read_long_line, long_line);
    let numbered: Vec<String> = (1_u64..)
        .zip(&lines)
        .skip(1)
        .map(|(number, line)| format!("{number}: {line}"))
        .collect();
    assert_eq!(read_lines, numbered);

    let (_other_folder, _other_store, other_keychain) =
        test_keychain(KeychainService::ToolServerKey);
    let other_key = cursor_key(other_keychain.as_ref()).await;
    let arguments: SessionReadArguments = serde_json::from_value(
        json!({"session": "builder", "output": message_id, "cursor": pointed}),
    )
    .expect("the test's arguments parse");
    let refused = read_session(directory, sessions, &other_key, caller, arguments).await;
    let Err(AgentToolError::Refused(text)) = refused else {
        panic!("a cursor read under another key is refused");
    };
    assert_eq!(text, position_unknown(pointed, "builder"));

    let first_cursor = first_cursor.expect("the long line takes more than one page");
    let place = first_cursor
        .find(['@', '+'])
        .expect("a cursor names its line");
    let line: u64 = first_cursor[..place]
        .parse()
        .expect("a cursor's line is a number");
    let moved = format!("{}{}", line + 1, &first_cursor[place..]);
    let refused = read(json!({"session": "builder", "output": message_id, "cursor": moved})).await;
    let Err(AgentToolError::Refused(text)) = refused else {
        panic!("a cursor moved off its line is refused");
    };
    assert_eq!(text, position_unknown(&moved, "builder"));
}

// A search finds text anywhere in a line longer than a page, however far in, holding a page at a
// time, and its cursors show only the pages that hold it. The text runs across the boundary
// between two parts of the stored body, deep in its second line, and again far past that; a short
// first line and a short third line match too. The result shows the first line and ends with the
// cursor at the long line's page that holds the text; that cursor's read shows the page, the next
// the page of the second match and the next the third line, with no page between. Killed by
// testing only a line's opening page, by a scan that carries no bytes from one part into the next,
// by a cursor at any page but the one where the text starts, and by a cursor from inside a line
// that reads on without the search.
#[tokio::test]
async fn a_search_finds_text_past_a_long_lines_first_page_across_two_parts() {
    let (database, reader) = database_of_this_machine();
    let caller: SessionId = test_session_id();
    let builder: SessionId = test_session_id();
    insert_session_row(&reader, builder.text().as_str(), Some("builder"), None);
    insert_lead(&database, builder, PROVIDERS[0].id);
    let first_line = "line one NEEDLE\n";
    let long_line = "x".repeat(1_200_000);
    let third_line = "\nline three NEEDLE";
    let insert_answer = |provider_message_id: &str, body: &str| {
        insert_test_event(
            &reader,
            builder,
            json!({
                "type": "agent.message.sent",
                "payload": {
                    "sessionId": builder,
                    "runId": test_run_id(),
                    "providerMessageId": provider_message_id,
                },
            }),
            Some(body),
            AT,
        )
        .1
    };
    // Where the store's first part of such a body ends, read from a body of the same bytes but the
    // search's, so the text is placed across it.
    let probe = insert_answer("probe", &format!("{first_line}{long_line}{third_line}"));
    let (directory, sessions) = directory_and_sessions(&database);
    let part = sessions
        .read_row_body(builder, probe, 0)
        .await
        .expect("the body reads");
    let Some(TranscriptBodyReadResponse::Available {
        next_offset: Some(part_end),
        ..
    }) = part
    else {
        panic!("a body this long is read in more than one part");
    };
    let part_end = usize::try_from(part_end.get()).expect("an offset fits memory");
    // The text's start in the long line: its first three bytes end the first part.
    let at = part_end - 3 - first_line.len();
    let first_room = READ_PAGE_MAX_BYTES - "2: ".len();
    assert!(
        at > first_room,
        "the text lies past the long line's first page"
    );
    // The second match, far past the first, in the store's second part.
    let second_at = 1_100_000;
    let mut searched_line = long_line;
    searched_line.replace_range(at..at + "NEEDLE".len(), "NEEDLE");
    searched_line.replace_range(second_at..second_at + "NEEDLE".len(), "NEEDLE");
    let output = insert_answer(
        "searched",
        &format!("{first_line}{searched_line}{third_line}"),
    );
    let (_data_folder, _store, keychain) = test_keychain(KeychainService::ToolServerKey);
    let cursor_key = cursor_key(keychain.as_ref()).await;
    let read = |arguments: serde_json::Value| {
        let arguments: SessionReadArguments =
            serde_json::from_value(arguments).expect("the test's arguments parse");
        read_session(&directory, &sessions, &cursor_key, &caller, arguments)
    };

    let found = read(json!({"session": "builder", "output": output, "search": "NEEDLE"}))
        .await
        .expect("the search reads");
    let (shown, more) = found
        .split_once('\n')
        .expect("the result ends with a cursor");
    assert_eq!(shown, "1: line one NEEDLE");
    let cursor = more
        .strip_prefix("More: next_cursor ")
        .expect("the result ends with a cursor")
        .trim_matches('"');
    // Every page past a line's first holds as many bytes of this one-byte text.
    let room = READ_PAGE_MAX_BYTES - "2 (cont.): ".len();
    let page_of = |offset: usize| first_room + (offset - first_room) / room * room;
    let page_start = page_of(at);
    assert!(cursor.starts_with(&format!("2+{}.", first_line.len() + page_start)));
    let search_on = |cursor: String| {
        read(json!({"session": "builder", "output": output, "search": "NEEDLE", "cursor": cursor}))
    };
    let shown_page = |page_start: usize| {
        format!(
            "2 (cont.): {}",
            &searched_line[page_start..page_start + room]
        )
    };

    let page = search_on(cursor.to_owned())
        .await
        .expect("the cursor reads");
    let (text, more) = page.split_once('\n').expect("the page ends with a cursor");
    assert_eq!(text, shown_page(page_start));
    let second_page = search_on(quoted_cursor(more).to_owned())
        .await
        .expect("the next cursor reads");
    let (text, more) = second_page
        .split_once('\n')
        .expect("the page ends with a cursor");
    assert_eq!(text, shown_page(page_of(second_at)));
    let third_page = search_on(quoted_cursor(more).to_owned())
        .await
        .expect("the last cursor reads");
    assert_eq!(third_page, "3: line three NEEDLE");
}

// A page cut keeps a line ending's `\r\n` whole on the next page, so the line read on from the cut
// is never empty, and cuts on a character's boundary. Killed by a cut at or inside a `\r\n` and by
// one inside a character.
#[rstest]
#[case::before_a_line_ending("ab\r\ncd", 2, 1)]
#[case::inside_a_line_ending("ab\r\ncd", 3, 1)]
#[case::inside_a_character("a漢b", 2, 1)]
#[case::on_plain_text("abcd", 2, 2)]
fn a_page_cut_opens_no_empty_continued_line(
    #[case] text: &str,
    #[case] room: usize,
    #[case] cut: usize,
) {
    assert_eq!(page_cut(text, room), cut);
    assert_ne!(text[cut..].lines().next(), Some(""));
}
