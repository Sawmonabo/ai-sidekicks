//! zsh and bash 5.3 forms, and the expansions and subscripts that evaluate arithmetic.

use rstest::rstest;

use super::reads_only;

#[rstest]
#[case::rg_foo_caret_x("rg foo ^x", false)]
#[case::ls_star_paren_e_colon_squote_touch_f_squote("ls *(e:'touch f':)", false)]
#[case::cat_eq_paren_ls("cat =(ls)", false)]
#[case::cat_eq_ls("cat =ls", true)]
#[case::echo_dollar_x_bracket_1("echo $x[1]", false)]
#[case::echo_dollar_hash_x_bracket_1("echo $#x[1]", false)]
#[case::echo_dollar_brace_x_hash_a("echo ${x#a}", true)]
#[case::echo_dollar_brace_x_colon_eq_a("echo ${x:=a}", false)]
#[case::echo_dollar_brace_bang_x("echo ${!x}", false)]
#[case::echo_dollar_brace_x_at_upper_p("echo ${x@P}", false)]
#[case::echo_dollar_brace_x_a_dollar_paren_touch_f("echo ${x/a/$(touch f)}", false)]
#[case::bracket_bracket_a_eq_tilde_backquote_touch("[[ a =~ `touch${IFS}f` ]]", false)]
#[case::bracket_bracket_a_eq_tilde_dollar_paren("[[ a =~ $(touch f) ]]", false)]
#[case::echo_dollar_brace_make_newline("echo ${ make\n}", false)]
// Bash evaluates a number comparison's operands and an array subscript as arithmetic, which runs
// a `$(…)` even inside quotes and can set a variable.
#[case::arithmetic_test_operand("[[ 'a[$(touch f)]' -eq 0 ]]", false)]
#[case::substitution_in_a_subscript("echo ${a['$(touch f)']}", false)]
#[case::assignment_in_a_subscript("echo ${a[PATH=0]}; ls", false)]
#[case::variable_test_in_a_subscript("[[ -v 'a[$(touch f)]' ]]", false)]
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
// zsh evaluates `[…]` right after `$name` as a subscript, in a word or a string, and `$#name[…]`
// as the length of a subscripted name.
#[case::zsh_subscript_assignment("echo $a[PATH=0]; ls", false)]
#[case::zsh_subscript_substitution("echo $a['$(touch f)']", false)]
#[case::zsh_subscript_in_a_string("echo \"$a[PATH=0]\"; ls", false)]
#[case::zsh_length_of_a_subscript("echo $#a[PATH=0]; ls", false)]
#[case::zsh_length_of_a_subscript_in_a_string("echo \"$#a[PATH=0]\"; ls", false)]
fn an_expansion_reads_only_when_it_runs_nothing(#[case] line: &str, #[case] is_read_only: bool) {
    assert_eq!(reads_only(line), is_read_only, "{line:?}");
}
