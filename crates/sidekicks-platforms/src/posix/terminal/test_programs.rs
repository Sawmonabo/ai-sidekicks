//! The programs the terminal tests run on macOS and Linux, each a script `/bin/sh` runs.

use crate::terminal::{AbnormalExit, TestProgram};

/// A shell that prints `text` on a line of its own and exits with code 0.
pub fn echo_program(text: &str) -> TestProgram {
    shell_script(&format!("echo {text}"))
}

/// A shell that turns its terminal's echo off, prints `ready`, waits for one input line, then
/// prints the numbers from 0 below `line_count`, one a line, and exits with code 0.
pub fn waiting_printer(line_count: usize) -> TestProgram {
    shell_script(&format!(
        "stty -echo; echo ready; read line; i=0; \
         while [ $i -lt {line_count} ]; do echo $i; i=$((i+1)); done"
    ))
}

/// A shell that ends itself with `SIGTERM`, which the terminal reports as code 0 and signal 15.
pub fn abnormal_exit() -> AbnormalExit {
    AbnormalExit {
        program: shell_script("kill -TERM $$"),
        exit_code: 0,
        signal_code: Some(libc::SIGTERM),
    }
}

/// A shell that takes its terminal's input unread and byte by byte, its interrupt key left on,
/// prints `ready` and sleeps 20 seconds; the exit is the one its interrupt key gives it.
pub fn interruptible_sleeper() -> AbnormalExit {
    AbnormalExit {
        program: shell_script("stty -icanon -echo; echo ready; exec sleep 20"),
        exit_code: 0,
        signal_code: Some(libc::SIGINT),
    }
}

/// A shell that ignores its interrupt, has its terminal echo its input with the interrupt key
/// shown as `^C` and keep the input on that key, prints `ready`, reads one input line and prints
/// `got:<line>`, then exits after one more line, so input written behind the first line is
/// echoed before it exits.
pub fn echoing_line_reader() -> TestProgram {
    shell_script(concat!(
        "trap '' INT; stty echo echoctl noflsh; echo ready; ",
        "read line; echo \"got:$line\"; read rest"
    ))
}

/// A shell that turns its terminal raw with no echo, asks it for its device attributes, prints
/// `ready`, copies the next `byte_count` input bytes to the file `path`, then prints `done`.
pub fn input_recorder(path: &std::path::Path, byte_count: usize) -> TestProgram {
    let path = path.display().to_string().replace('\'', "'\\''");
    shell_script(&format!(
        "stty raw -echo; printf '\\033[c'; echo ready; head -c {byte_count} > '{path}'; echo done"
    ))
}

/// A shell that takes its input unread and byte by byte, asks its terminal for its device
/// attributes `question_count` times, prints `asked`, and a second later reads every input byte
/// until two seconds pass with none, printing `read <bytes> key <count>`, where the count is of
/// `Z` bytes among them.
pub fn device_attribute_asker(question_count: usize) -> TestProgram {
    shell_script(&format!(
        "stty -icanon -echo; i=0; while [ $i -lt {question_count} ]; do printf '\\033[c'; \
         i=$((i+1)); done; echo asked; sleep 1; stty min 0 time 20; cat | od -An -tx1 -v | \
         awk '{{for(i=1;i<=NF;i++){{n++; if($i==\"5a\")z++}}}} \
         END{{print \"read \" n+0 \" key \" z+0}}'"
    ))
}

/// A shell that takes its terminal's input unread and without echo, prints `ready`, then prints
/// the numbers from 0, one a line, until it reads the key `Z`, when it prints `key` and exits with
/// code 0.
pub fn key_stopped_printer() -> TestProgram {
    shell_script(
        "stty -icanon -echo min 0 time 0; echo ready; i=0; while :; do echo $i; i=$((i+1)); \
         key=$(dd bs=1 count=1 2>/dev/null); if [ \"$key\" = Z ]; then echo key; exit 0; fi; done",
    )
}

/// A shell that prints the folder it runs in, then its whole environment, one `NAME=value` a line.
pub fn launch_printer() -> TestProgram {
    shell_script("pwd -P; env")
}

/// The program `/bin/sh` running `script`.
pub(crate) fn shell_script(script: &str) -> TestProgram {
    TestProgram {
        program: "/bin/sh".to_owned(),
        arguments: vec!["-c".to_owned(), script.to_owned()],
    }
}
