//! How a child process ended, as the wire carries it: the name of the signal that ended it or its
//! exit code, with the tail of what it printed.

use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::{ProcessExit, ProcessExitWithCode, ProcessExitWithSignal};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::ChildExit;
use sidekicks_std::output_tail::OutputTail;

/// The exit a process crosses the wire with: the name of the signal that ended it, or that the
/// daemon asked, where there is one, else its exit code, with its output tail. `CAP` is at most
/// the wire's failure-detail cap, which the build checks.
pub fn compose_process_exit<const CAP: usize>(
    exit: ChildExit,
    output_tail: OutputTail<CAP>,
) -> ProcessExit {
    const {
        assert!(
            CAP <= PROVIDER_FAILURE_DETAIL_MAX_LEN,
            "a tail's cap fits the failure-detail cap"
        );
    }
    let output_tail = FreeFormText::<PROVIDER_FAILURE_DETAIL_MAX_LEN>::new(output_tail.into_text())
        .expect("a tail is never blank, holds no NUL and is within the failure-detail cap");
    match exit.signal_name {
        Some(signal) => ProcessExit::Signal(ProcessExitWithSignal {
            signal: FreeFormText::new(signal).expect("a signal's name is a short, non-blank word"),
            exit_code: None,
            silent_seconds: None,
            output_tail,
        }),
        None => ProcessExit::Code(ProcessExitWithCode {
            exit_code: ExitCode::new(exit.exit_code)
                .expect("an unsigned 32-bit code is a safe integer"),
            signal: None,
            silent_seconds: None,
            output_tail,
        }),
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::run::control::ProcessExit;
    use sidekicks_platforms::ChildExit;
    use sidekicks_std::output_tail::OutputTail;

    use super::compose_process_exit;

    #[test]
    fn a_tail_holding_nul_still_builds_an_exit() {
        let mut tail = OutputTail::<32>::new();
        tail.push(b"failed\0here");

        let exit = ChildExit {
            exit_code: 3_221_225_477,
            signal_number: None,
            signal_name: None,
        };

        let ProcessExit::Code(exit) = compose_process_exit(exit, tail) else {
            panic!("an exit with no signal carries its code");
        };

        assert_eq!(exit.output_tail.as_str(), "failed\u{FFFD}here");
    }
}
