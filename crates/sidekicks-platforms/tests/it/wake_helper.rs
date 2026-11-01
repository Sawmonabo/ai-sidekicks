//! The wake helper's refusals: a connection from anyone but the user at the Mac's screen, a time
//! not ahead or past eight days, and a cancel of a wake the helper did not book.

use std::cell::RefCell;
use std::io::{Read as _, Write as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::rc::Rc;
use std::time::{Duration, SystemTime};

use rstest::rstest;
use sidekicks_platforms::{
    PowerEvents, WakeBookings, WakeRefusal, WakeReply, answer_wake_connection,
};

// A fixed now, in whole seconds since 1970.
const NOW: u64 = 1_800_000_000;

const EIGHT_DAYS: i64 = 8 * 24 * 60 * 60;

#[derive(Debug, PartialEq, Eq)]
enum PowerEventCall {
    Schedule(i64),
    Cancel(i64),
}

// Accepts every call and records it, so only the helper's own rules refuse.
#[derive(Clone, Default)]
struct ScriptedPowerEvents {
    calls: Rc<RefCell<Vec<PowerEventCall>>>,
}

impl PowerEvents for ScriptedPowerEvents {
    fn schedule_wake(&mut self, wake_at: i64) -> Result<(), i32> {
        self.calls
            .borrow_mut()
            .push(PowerEventCall::Schedule(wake_at));
        Ok(())
    }

    fn cancel_wake(&mut self, wake_at: i64) -> Result<(), i32> {
        self.calls
            .borrow_mut()
            .push(PowerEventCall::Cancel(wake_at));
        Ok(())
    }
}

fn now() -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(NOW)
}

fn ahead(seconds: i64) -> i64 {
    i64::try_from(NOW).expect("now fits") + seconds
}

// Sends `request` over a real socket from this process and returns the helper's reply line, the
// helper taking `console_user` as the user at the Mac's screen.
fn send_over_socket(
    request: &str,
    console_user: Option<u32>,
    bookings: &mut WakeBookings<ScriptedPowerEvents>,
) -> String {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let socket_path = folder.path().join("wake.sock");
    let listener = UnixListener::bind(&socket_path).expect("the socket binds");
    let mut client = UnixStream::connect(&socket_path).expect("the client connects");
    client
        .write_all(request.as_bytes())
        .expect("the request is sent");
    let (server, _) = listener.accept().expect("the helper accepts");
    answer_wake_connection(&server, console_user, bookings, now()).expect("the helper answers");
    drop(server);
    let mut reply = String::new();
    client
        .read_to_string(&mut reply)
        .expect("the reply is read");
    reply
}

// Fails when the helper admits a process whose user, read from the socket, is not the user at the
// Mac's screen. Mutation: drop the `getpeereid` comparison in `answer_wake_connection`.
#[test]
fn the_wake_helper_refuses_a_connection_from_anyone_but_the_user_at_the_screen() {
    let own_user = nix::unistd::getuid().as_raw();
    let events = ScriptedPowerEvents::default();
    let mut bookings = WakeBookings::new(events.clone());
    let request = format!("book {}\n", ahead(3600));

    for console_user in [Some(own_user + 1), None] {
        let reply = send_over_socket(&request, console_user, &mut bookings);
        assert_eq!(
            reply, "refused notConsoleUser\n",
            "console user {console_user:?}"
        );
    }
    assert!(
        events.calls.borrow().is_empty(),
        "a refused peer books nothing"
    );

    let reply = send_over_socket(&request, Some(own_user), &mut bookings);

    assert_eq!(reply, "booked\n");
    assert_eq!(
        *events.calls.borrow(),
        [PowerEventCall::Schedule(ahead(3600 - 60))],
        "the wake is booked one minute before the asked time"
    );
}

// Fails when a time already past, one whose wake a minute before it would be past, or one beyond
// eight days reaches the power-event queue. Mutation: drop the eight-day bound in `book`.
#[rstest]
#[case::past(ahead(-10), Some(WakeRefusal::NotAhead))]
#[case::wake_would_be_past(ahead(30), Some(WakeRefusal::NotAhead))]
#[case::wake_would_be_now(ahead(60), Some(WakeRefusal::NotAhead))]
#[case::next_second_wake(ahead(61), None)]
#[case::eight_days(ahead(EIGHT_DAYS), None)]
#[case::past_eight_days(ahead(EIGHT_DAYS + 1), Some(WakeRefusal::BeyondEightDays))]
fn the_wake_helper_books_only_ahead_and_within_eight_days(
    #[case] asked_at: i64,
    #[case] refusal: Option<WakeRefusal>,
) {
    let events = ScriptedPowerEvents::default();
    let mut bookings = WakeBookings::new(events.clone());

    let reply = bookings.answer(&format!("book {asked_at}\n"), now());

    if let Some(refusal) = refusal {
        assert_eq!(reply, WakeReply::Refused(refusal));
        assert!(events.calls.borrow().is_empty());
    } else {
        assert_eq!(reply, WakeReply::Booked);
        assert_eq!(
            *events.calls.borrow(),
            [PowerEventCall::Schedule(asked_at - 60)]
        );
    }
}

// Fails when a cancel reaches the power-event queue for a wake this helper never booked or already
// canceled, or names another date than the one booked.
#[test]
fn the_wake_helper_cancels_only_a_wake_it_booked() {
    let events = ScriptedPowerEvents::default();
    let mut bookings = WakeBookings::new(events.clone());
    let booked_at = ahead(3600);
    assert_eq!(
        bookings.answer(&format!("book {booked_at}\n"), now()),
        WakeReply::Booked
    );

    let not_booked = bookings.answer(&format!("cancel {}\n", ahead(7200)), now());
    let canceled = bookings.answer(&format!("cancel {booked_at}\n"), now());
    let canceled_again = bookings.answer(&format!("cancel {booked_at}\n"), now());

    assert_eq!(not_booked, WakeReply::Refused(WakeRefusal::NotBooked));
    assert_eq!(canceled, WakeReply::Canceled);
    assert_eq!(canceled_again, WakeReply::Refused(WakeRefusal::NotBooked));
    assert_eq!(
        *events.calls.borrow(),
        [
            PowerEventCall::Schedule(booked_at - 60),
            PowerEventCall::Cancel(booked_at - 60),
        ],
        "the one cancel repeats the booked date"
    );
}

// Sends one request line to the installed helper's socket and returns its reply line.
fn send_to_installed_helper(request: &str) -> String {
    let mut helper = UnixStream::connect(sidekicks_platforms::WAKE_HELPER_SOCKET_PATH)
        .expect("the installed helper answers on its socket");
    helper
        .write_all(request.as_bytes())
        .expect("the request is sent");
    let mut reply = String::new();
    helper
        .read_to_string(&mut reply)
        .expect("the reply is read");
    reply
}

// The wakes the system has booked, as `pmset` lists them.
fn read_booked_wakes() -> String {
    let output = std::process::Command::new("/usr/bin/pmset")
        .args(["-g", "sched"])
        .output()
        .expect("pmset runs");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

// Fails when the installed helper's booking does not reach the system's power-event queue under
// the app's identifier, or its cancel does not remove it with the date it booked. Needs the helper
// installed, which takes an administrator prompt.
#[test]
#[ignore = "needs the wake helper installed, which takes an administrator prompt"]
fn the_installed_wake_helper_books_and_cancels_a_system_wake() {
    let identifier = sidekicks_contracts::app_identity::APP_BUNDLE_IDENTIFIER;
    let since_1970 = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("the clock is past 1970")
        .as_secs();
    let asked_at = since_1970 + 3600;

    assert_eq!(
        send_to_installed_helper(&format!("book {asked_at}\n")),
        "booked\n"
    );
    assert!(
        read_booked_wakes().contains(identifier),
        "{}",
        read_booked_wakes()
    );

    assert_eq!(
        send_to_installed_helper(&format!("cancel {asked_at}\n")),
        "canceled\n"
    );
    assert!(
        !read_booked_wakes().contains(identifier),
        "{}",
        read_booked_wakes()
    );
}
