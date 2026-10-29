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
#[case::xargs_with_a_reading_program("xargs cat", false)]
#[case::line_not_read_whole("cat 'a", false)]
#[case::rg_pre("rg --pre sh x", false)]
// An option's value is skipped unchecked, so a value of `--` ends no option and one that reads as
// an option is no option.
#[case::rg_value_of_dashes("rg -e -- --pre=sh x", false)]
#[case::diff_value_of_dashes("diff -x -- --paginate a b", false)]
#[case::rg_long_value_of_dashes("rg --regexp -- --pre=sh x", false)]
// A value inside the option's own word leaves the next word an option.
#[case::rg_long_value_inside_the_word("rg --regexp=foo --pre=sh x", false)]
#[case::rg_value_inside_the_cluster("rg -efoo --pre=sh x", false)]
#[case::rg_pattern_like_an_option("rg -e -z src", true)]
// Git's `-U` takes only the value inside its word, so the next word is git's own option.
#[case::git_diff_attached_value("git diff -U --output=f", false)]
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
// A wrapper's value splits into the command it runs, and a wrapper whose own words use up the
// command is its program, as `sudo -s` runs a shell that reads the pipe.
#[case::split_string_inside_the_word("env -S'touch f'", false)]
#[case::shell_through_a_wrapper("echo x | sudo -s", false)]
// Bash evaluates a number comparison's operands and an array subscript as arithmetic, which runs
// a `$(…)` even inside quotes and can set a variable.
#[case::arithmetic_test_operand("[[ 'a[$(touch f)]' -eq 0 ]]", false)]
#[case::substitution_in_a_subscript("echo ${a['$(touch f)']}", false)]
#[case::assignment_in_a_subscript("echo ${a[PATH=0]}; ls", false)]
#[case::variable_test_in_a_subscript("[[ -v 'a[$(touch f)]' ]]", false)]
#[case::file_test_and_read("[[ -f a ]] && cat a", true)]
// A `${…}` offset is arithmetic, `!` reads the variable a value names, `@P` runs a value as a
// prompt, and a pattern's `$(…)` runs; `$_` hands each the previous command's last word.
#[case::expression_as_an_offset("echo ${HOME:(PATH=0)}; ls", false)]
#[case::indirect_expansion("echo 'a[$(touch f)]'; echo ${!_}", false)]
#[case::prompt_transform("echo '$(touch f)'; echo ${_@P}", false)]
#[case::substitution_in_a_pattern("echo ${HOME#$(touch f)}", false)]
#[case::backquote_in_a_word("echo ${x:-`touch f`}", false)]
#[case::process_substitution_in_a_word("echo ${x:-<(touch f)}", false)]
// Only the listed parts make a reading `${…}`; an array is none of them.
#[case::unlisted_expansion_part("echo ${x:-(a b)}", false)]
#[case::reading_expansions("echo ${HOME:0:2} ${HOME:-a} ${HOME##*/} ${HOME/a/b} ${#HOME}", true)]
// zsh evaluates `[…]` right after `$name` as a subscript, in a word, a string or a here-document.
#[case::zsh_subscript_assignment("echo $a[PATH=0]; ls", false)]
#[case::zsh_subscript_substitution("echo $a['$(touch f)']", false)]
#[case::zsh_subscript_in_a_string("echo \"$a[PATH=0]\"; ls", false)]
#[case::zsh_subscript_in_a_here_document("cat <<EOF\n$a[PATH=0]\nEOF\nls", false)]
// zsh's `$#name[…]` is the length of a subscripted name, its subscript evaluated too.
#[case::zsh_length_of_a_subscript("echo $#a[PATH=0]; ls", false)]
#[case::zsh_length_of_a_subscript_in_a_string("echo \"$#a[PATH=0]\"; ls", false)]
// `{name}` before a redirect assigns the descriptor it opens to `name`.
#[case::descriptor_name("echo hi {PATH}>/dev/null; ls", false)]
#[case::descriptor_element("echo hi {a[PATH=0]}>/dev/null; ls", false)]
#[case::ls_long("ls -la", true)]
#[case::rg_search("rg foo src", true)]
#[case::git_status("git status", true)]
#[case::git_log_count("git log --oneline -5", true)]
#[case::cat_into_head("cat a | head -3", true)]
#[case::errors_to_null("rg x 2>/dev/null", true)]
#[case::errors_to_quoted_null("rg x 2>'/dev/null'", true)]
// `/dev/stdout` reopens the file behind the descriptor, which a write truncates.
#[case::output_to_standard_output("cat a >/dev/stdout", false)]
#[case::errors_to_output("rg x 2>&1", true)]
#[case::cd_and_list("cd sub && ls", true)]
#[case::wrapped_reader("/bin/zsh -lc 'git diff --stat'", true)]
#[case::time_keyword("time ls", true)]
// A primary's value that starts with `-` is no primary.
#[case::find_value_with_a_dash("find . -mtime -7", true)]
// `command -v` looks a name up and runs nothing.
#[case::command_lookup("command -v rm", true)]
fn a_line_reads_only(#[case] line: &str, #[case] is_read_only: bool) {
    let mut reader = ShellLineReader::new(LIMIT);

    assert_eq!(is_read_only_command(&mut reader, line), is_read_only);
}

#[test]
fn a_line_of_ten_thousand_characters_reads_only_and_one_more_does_not() {
    let mut reader = ShellLineReader::new(LIMIT);
    let line_of = |length: usize| format!("echo {}", "a".repeat(length - "echo ".len()));
    let longest = line_of(MAX_LINE_CHARACTERS);
    let too_long = line_of(MAX_LINE_CHARACTERS + 1);

    assert!(is_read_only_command(&mut reader, &longest));
    assert!(reader.read(&too_long).is_whole());
    assert!(!is_read_only_command(&mut reader, &too_long));
}
