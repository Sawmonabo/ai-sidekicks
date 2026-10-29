use rstest::rstest;

use super::*;

// Past the 10,000-character rule, so the long line meets that rule and not the reader's bound.
const LIMIT: usize = 64 * 1024;

#[rstest]
// A writing program in a pipeline, and `tee`, which is never listed.
#[case::tee_in_a_pipeline("rg x | tee out", false)]
#[case::find_delete("find . -name x -delete", false)]
#[case::redirect_to_a_file("cat a > b", false)]
// `xargs` is a wrapper the list never holds, whatever program it runs.
#[case::xargs_with_a_writing_program("xargs rm", false)]
#[case::xargs_with_a_reading_program("xargs cat", false)]
#[case::line_not_read_whole("cat 'a", false)]
#[case::rg_pre("rg --pre sh x", false)]
#[case::git_log_output("git log --output=f", false)]
#[case::git_config_option("git -c core.pager=x log", false)]
#[case::find_fls("find . -fls f", false)]
#[case::cd_with_git("cd sub && git status", false)]
#[case::special_variable("PATH=/tmp/bin cat a", false)]
// A word only the run decides, here a file's text, can turn into any option.
#[case::option_from_a_substitution("rg $(cat options) x", false)]
// Only the system program of a listed name reads; one a folder names may be anything.
#[case::program_in_this_folder("./cat x", false)]
#[case::program_in_another_folder("/tmp/x/git status", false)]
// `time` with an option of the `time` program's own is that program, which is never listed.
#[case::time_program_option("time -o f ls", false)]
#[case::ls_long("ls -la", true)]
#[case::rg_search("rg foo src", true)]
#[case::git_status("git status", true)]
#[case::git_log_count("git log --oneline -5", true)]
#[case::cat_into_head("cat a | head -3", true)]
#[case::errors_to_null("rg x 2>/dev/null", true)]
#[case::errors_to_output("rg x 2>&1", true)]
#[case::cd_and_list("cd sub && ls", true)]
#[case::wrapped_reader("/bin/zsh -lc 'git diff --stat'", true)]
#[case::time_keyword("time ls", true)]
fn a_line_reads_only(#[case] line: &str, #[case] is_read_only: bool) {
    let mut reader = ShellLineReader::new(LIMIT);

    assert_eq!(is_read_only_command(&mut reader, line), is_read_only);
}

#[test]
fn a_line_over_ten_thousand_characters_is_not_read_only() {
    let mut reader = ShellLineReader::new(LIMIT);
    let line = format!("echo {}", "a".repeat(MAX_LINE_CHARACTERS));

    assert!(reader.read(&line).is_whole());
    assert!(!is_read_only_command(&mut reader, &line));
}
