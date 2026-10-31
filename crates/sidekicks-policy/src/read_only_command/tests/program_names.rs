//! How the program is named, lines with no program, and bytes.

use rstest::rstest;

use super::reads_only;

#[rstest]
#[case::cat_a("./cat a", false)]
#[case::bin_cat_a("bin/cat a", false)]
#[case::full_path_bin_cat_a("/bin/cat a", false)]
#[case::tilde_bin_cat_a("~/bin/cat a", false)]
#[case::usr_bin_env_ls("/usr/bin/env ls", false)]
#[case::upper_ls_la("LS -la", false)]
#[case::upper_c_at_a("Cat a", false)]
#[case::full_width_ls_la("\u{FF4C}\u{FF53} -la", false)]
#[case::cyrillic_c_at_a("\u{441}at a", false)]
#[case::empty("", true)]
#[case::blanks("   ", true)]
#[case::hash_rm_rf_x("# rm -rf x", true)]
#[case::ls_hash_semicolon_rm_a("ls # ; rm a", true)]
#[case::ls_a_hash_b("ls a#b", true)]
#[case::upper_a_eq_1("A=1", false)]
#[case::upper_a_eq_1_upper_b_eq_2("A=1 B=2", false)]
#[case::upper_a_eq_1_ls("A=1 ls", false)]
#[case::upper_a_eq_dollar_paren_ls("A=$(ls)", false)]
#[case::export_upper_a_eq_1("export A=1", false)]
#[case::unset_upper_a("unset A", false)]
#[case::local_a("local a", false)]
#[case::then_ls("then ls", false)]
#[case::dquote_if_dquote_ls("\"if\" ls", false)]
#[case::function_f_brace_ls_semicolon("function f { ls; }", true)]
#[case::time_ls("time ls", true)]
#[case::time_p_ls("time -p ls", true)]
#[case::time_double_dash_ls("time -- ls", true)]
#[case::time("time", false)]
#[case::cat_a_replacement_b_txt("cat a\u{FFFD}b.txt", true)]
#[case::c_replacement_at_a("c\u{FFFD}at a", false)]
fn a_line_reads_only_with_a_listed_name_and_no_assignment(
    #[case] line: &str,
    #[case] is_read_only: bool,
) {
    assert_eq!(reads_only(line), is_read_only, "{line:?}");
}

#[test]
fn a_line_of_ten_thousand_characters_reads_only_and_one_more_does_not() {
    let line_of = |length: usize| format!("ls {}", "a".repeat(length - "ls ".len()));

    let too_long = line_of(super::MAX_LINE_CHARACTERS + 1);

    assert!(reads_only(&line_of(super::MAX_LINE_CHARACTERS)));
    assert!(
        super::ShellLineReader::new(super::LIMIT)
            .read(&too_long)
            .is_whole()
    );
    assert!(!reads_only(&too_long));
}
