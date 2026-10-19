//! Bun runtime command filters (test, run, install, add, remove, update, build, pm, create, init, bunx).
//!
//! Modeled after the Vitest / npm modules and the real-world fixtures
//! documented in rtk-ai/rtk#832 and rtk-ai/rtk#1374. Maximizes token savings
//! by stripping progress bars, passing test lines, package-download noise,
//! and redundant build status updates.

use crate::core::runner;
use crate::core::shell::display_args;
use crate::core::stream::{BlockHandler, BlockStreamFilter};
use crate::core::utils::{resolved_command, strip_ansi};
use anyhow::Result;

/// Run `bun test` and show only failures plus a compact summary.
pub fn run_bun_test(args: &[String], verbose: u8) -> Result<i32> {
    if runner::is_watch_mode(args) {
        return crate::cmds::js::bun_cmd::run_test(args, verbose);
    }
    let mut cmd = resolved_command("bun");
    cmd.arg("test");
    for arg in args {
        cmd.arg(arg);
    }

    if verbose > 0 {
        eprintln!("Running: bun test {}", args.join(" "));
    }

    runner::run_streamed(
        cmd,
        "bun test",
        &display_args(args),
        Box::new(BlockStreamFilter::new(BunTestHandler::new())),
        runner::RunOptions::with_tee("bun test"),
    )
}

/// Run `bun run` and strip lifecycle noise.
pub fn run_bun_run(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered("bun", &["run"], args, "bun run", filter_bun_run, verbose)
}

/// Run `bun install` and strip progress / download noise.
pub fn run_bun_install(args: &[String], verbose: u8) -> Result<i32> {
    crate::cmds::js::bun_cmd::run_pkg("install", args, verbose)
}

/// Run `bun add` and strip progress / download noise.
pub fn run_bun_add(args: &[String], verbose: u8) -> Result<i32> {
    crate::cmds::js::bun_cmd::run_pkg("add", args, verbose)
}

/// Run `bun remove` and strip progress noise.
pub fn run_bun_remove(args: &[String], verbose: u8) -> Result<i32> {
    crate::cmds::js::bun_cmd::run_pkg("remove", args, verbose)
}

/// Run `bun update` and strip progress / lockfile churn.
pub fn run_bun_update(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered(
        "bun",
        &["update"],
        args,
        "bun update",
        filter_bun_install,
        verbose,
    )
}

/// Run `bun pm` (package-manager subcommands like `ls`, `migrate`, `hash`).
pub fn run_bun_pm(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered("bun", &["pm"], args, "bun pm", filter_bun_pm, verbose)
}

/// Run `bun build` without changing bundled code or diagnostics.
pub fn run_bun_build(args: &[String], verbose: u8) -> Result<i32> {
    // A build without --outfile/--outdir writes the bundle itself to stdout.
    // Upstream's passthrough preserves that artifact instead of filtering it.
    crate::cmds::js::bun_cmd::run_build(args, verbose)
}

/// Run `bun create` and keep only the essential scaffold output.
pub fn run_bun_create(args: &[String], verbose: u8) -> Result<i32> {
    let mut cmd = resolved_command("bun");
    cmd.arg("create");
    for arg in args {
        cmd.arg(arg);
    }

    if verbose > 0 {
        eprintln!("Running: bun create {}", args.join(" "));
    }

    runner::run_filtered(
        cmd,
        "bun create",
        &display_args(args),
        filter_bun_create,
        runner::RunOptions::default(),
    )
}

/// Run `bun init` and keep only the essential init output.
pub fn run_bun_init(args: &[String], verbose: u8) -> Result<i32> {
    let mut cmd = resolved_command("bun");
    cmd.arg("init");
    for arg in args {
        cmd.arg(arg);
    }

    if verbose > 0 {
        eprintln!("Running: bun init {}", args.join(" "));
    }

    runner::run_filtered(
        cmd,
        "bun init",
        &display_args(args),
        filter_bun_create,
        runner::RunOptions::default(),
    )
}

/// Run `bunx`. Route known tools to their specialized rtk filters; otherwise passthrough.
pub fn run_bunx(args: &[String], verbose: u8, skip_env: bool) -> Result<i32> {
    if let Some(first) = args.first().map(|s| s.as_str()) {
        match first {
            "tsc" => return crate::cmds::js::tsc_cmd::run(Some("bunx"), &args[1..], verbose),
            "eslint" => return crate::cmds::js::lint_cmd::run(Some("bunx"), args, verbose),
            "prettier" => return crate::cmds::js::prettier_cmd::run(&args[1..], verbose),
            "vitest" => return crate::cmds::js::vitest_cmd::run_vitest(&args[1..], verbose),
            "jest" => return crate::cmds::js::vitest_cmd::run_jest(&args[1..], verbose),
            "prisma" => {
                // Prisma subcommands require a typed enum; passthrough is safest.
            }
            _ => {}
        }
    }

    crate::cmds::js::bun_cmd::run_bunx(args, verbose, skip_env)
}

fn run_filtered(
    base: &str,
    base_args: &[&str],
    args: &[String],
    label: &str,
    filter: fn(&str) -> String,
    verbose: u8,
) -> Result<i32> {
    let mut cmd = resolved_command(base);
    for a in base_args {
        cmd.arg(a);
    }
    for arg in args {
        cmd.arg(arg);
    }

    if verbose > 0 {
        eprintln!(
            "Running: {} {} {}",
            base,
            base_args.join(" "),
            args.join(" ")
        );
    }

    runner::run_filtered(
        cmd,
        label,
        &display_args(args),
        filter,
        runner::RunOptions::default(),
    )
}

/// Stream handler for `bun test`.
///
/// Bun emits passing lines as progress (`✓` or `(pass)`) and failing lines as
/// `(fail)` / `[E]`. Error context is printed *before* the fail marker, so we
/// buffer context lines and flush them when we hit a failure marker.
struct BunTestHandler {
    passed: usize,
    failed: usize,
    skipped: usize,
    current_file: String,
    failures: Vec<String>,
    context_buffer: Vec<String>,
}

impl BunTestHandler {
    fn new() -> Self {
        Self {
            passed: 0,
            failed: 0,
            skipped: 0,
            current_file: String::new(),
            failures: Vec::new(),
            context_buffer: Vec::new(),
        }
    }
}

impl BlockHandler for BunTestHandler {
    fn should_skip(&mut self, line: &str) -> bool {
        let clean = strip_ansi(line);
        clean.trim().is_empty()
            || clean.starts_with("Test Files ")
            || clean.starts_with("Tests ")
            || clean.starts_with("Duration ")
    }

    fn is_block_start(&mut self, line: &str) -> bool {
        let clean = strip_ansi(line);

        if clean.contains("(fail)") || clean.contains("[E]") || clean.contains("✗") {
            let mut block = Vec::new();
            block.extend(self.context_buffer.iter().rev().take(6).rev().cloned());
            block.push(clean.clone());
            if !self.current_file.is_empty() {
                block.push(format!("file: {}", self.current_file));
            }
            self.failures.push(block.join("\n"));
            self.failed += 1;
            self.context_buffer.clear();
            true
        } else if clean.contains("(pass)") || clean.contains('✓') {
            self.passed += 1;
            self.context_buffer.clear();
            false
        } else if clean.contains("(skip)")
            || clean.contains(" → skip")
            || clean.trim_start().starts_with("↓")
        {
            // Conservative skip detection: only count bun's own skip
            // markers. The previous `clean.contains("skip")` was a
            // substring match that fired on arbitrary words like
            // `skipped="0"` in JUnit XML, which made every non-default
            // reporter register as "1 skipped" and broke the no-output
            // fallback.
            self.skipped += 1;
            false
        } else {
            if !clean.trim().is_empty() {
                self.context_buffer.push(clean);
                if self.context_buffer.len() > 12 {
                    self.context_buffer.remove(0);
                }
            }
            false
        }
    }

    fn is_block_continuation(&mut self, line: &str, _block: &[String]) -> bool {
        let clean = strip_ansi(line);
        clean.starts_with("  ") || clean.starts_with('\t') || clean.starts_with("at ")
    }

    fn format_summary(&self, exit_code: i32, raw: &str) -> Option<String> {
        // If we saw no (pass)/(fail)/(skip) markers but the raw output is
        // non-empty, we are likely looking at a non-default reporter (TAP,
        // JUnit, dots) or a bun error (e.g. "no test files matched"). In
        // those cases our counters are zero but the user still needs to see
        // what bun actually said — return None so the runner can fall back
        // to the raw output instead of emitting a misleading "no output".
        let raw_trimmed = raw.trim();
        let counters_zero = self.failed == 0 && self.passed == 0 && self.skipped == 0;
        if counters_zero && !raw_trimmed.is_empty() {
            return None;
        }
        if counters_zero {
            // Raw output is also empty. Distinguish success (truly nothing
            // to test) from failure (e.g. missing bun binary, permission
            // error) via the exit code so the user can act.
            if exit_code != 0 {
                return Some(format!("bun test: no output (exit {})", exit_code));
            }
            return Some("bun test: no output".to_string());
        }
        let mut lines = vec![format!(
            "{} passed, {} failed, {} skipped",
            self.passed, self.failed, self.skipped
        )];
        for failure in &self.failures {
            lines.push("---".to_string());
            lines.push(failure.clone());
        }
        Some(lines.join("\n"))
    }

    /// Hint used by the runner to decide whether the streamed filter output
    /// is too low-information to be useful. When this is true, the runner
    /// falls back to the raw output instead of the filter's summary.
    fn low_info(&self, raw: &str) -> bool {
        // No markers matched AND raw output is non-empty → filter could not
        // classify anything; the raw output is the truth.
        let counters_zero = self.failed == 0 && self.passed == 0 && self.skipped == 0;
        counters_zero && !raw.trim().is_empty()
    }
}

/// Pure pipe filter for `bun test` default-reporter output where every test passed.
///
/// This is separate from `BunTestHandler` (the streaming runner filter) on
/// purpose: the handler drops passing lines as uninformative context while it
/// reconstructs failures, but a pipe filter must preserve every other
/// original byte and only elide literal `(pass) ` reporter lines. Runner
/// behavior is untouched — this function is only reachable via
/// `rtk pipe -f bun-test`.
///
/// Each maximal run of adjacent `(pass) ` lines (matched after ANSI
/// stripping) is replaced with one
/// `... ({k} passing bun-test lines elided; totals retained below)` marker.
/// Anything that is not exactly a green default-reporter run — unknown
/// reporters, failures, malformed or multi-report blobs, control characters,
/// or output where elision would not shrink the bytes — is returned unchanged.
pub(crate) fn filter_bun_test_output(output: &str) -> String {
    try_elide_bun_pass_lines(output).unwrap_or_else(|| output.to_string())
}

/// Measured admission guards for [`filter_bun_test_output`]; `None` means
/// "decline and pass the input through unchanged".
fn try_elide_bun_pass_lines(output: &str) -> Option<String> {
    // Line-oriented elision is only sound for LF-separated text.
    if output.contains('\r') || output.contains('\u{2028}') || output.contains('\u{2029}') {
        return None;
    }
    // Split on '\n' rather than `str::lines` so a trailing LF round-trips
    // byte-identically through the join below.
    let raw: Vec<&str> = output.split('\n').collect();
    let stripped: Vec<String> = raw.iter().map(|line| strip_ansi(line)).collect();
    let nonempty: Vec<&str> = stripped
        .iter()
        .map(String::as_str)
        .filter(|line| !line.trim().is_empty())
        .collect();

    // First nonempty line is the `bun test v...` banner, occurring exactly once.
    if !nonempty
        .first()
        .is_some_and(|line| line.starts_with("bun test v"))
    {
        return None;
    }
    if stripped
        .iter()
        .filter(|line| line.starts_with("bun test v"))
        .count()
        != 1
    {
        return None;
    }
    // Exactly one anchored `N pass` summary ...
    let pass_totals: Vec<usize> = stripped
        .iter()
        .filter_map(|line| parse_bun_count(line, "pass"))
        .collect();
    if pass_totals.len() != 1 {
        return None;
    }
    let expected = pass_totals[0];
    // ... and one anchored `0 fail` summary, with no nonzero fail count ...
    if stripped
        .iter()
        .filter(|line| is_bun_zero_fail(line))
        .count()
        != 1
    {
        return None;
    }
    if stripped.iter().any(|line| is_bun_nonzero_fail(line)) {
        return None;
    }
    // ... and no failure marker lines.
    if stripped.iter().any(|line| line.starts_with("(fail) ")) {
        return None;
    }
    // The last nonempty line is the exact `Ran N tests across M files. [duration]`
    // footer, with exactly one such footer overall, a matching N, and M >= 1.
    if stripped
        .iter()
        .filter_map(|line| parse_bun_footer(line))
        .count()
        != 1
    {
        return None;
    }
    let (foot_tests, foot_files) = parse_bun_footer(nonempty.last().copied()?)?;
    if foot_tests != expected || foot_files < 1 {
        return None;
    }
    // The `(pass) ` marker count agrees with the totals.
    let pass_idx: Vec<usize> = stripped
        .iter()
        .enumerate()
        .filter(|(_, line)| line.starts_with("(pass) "))
        .map(|(idx, _)| idx)
        .collect();
    if pass_idx.len() != expected {
        return None;
    }

    // Replace each maximal run of adjacent pass lines with one marker,
    // keeping every other original line byte-identical (including ANSI).
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    let mut cursor = 0usize;
    let mut next = 0usize;
    while cursor < raw.len() {
        if next < pass_idx.len() && pass_idx[next] == cursor {
            let mut end = cursor;
            while next < pass_idx.len() && pass_idx[next] == end {
                next += 1;
                end += 1;
            }
            out.push(format!(
                "... ({} passing bun-test lines elided; totals retained below)",
                end - cursor
            ));
            cursor = end;
        } else {
            out.push(raw[cursor].to_string());
            cursor += 1;
        }
    }
    let built = out.join("\n");
    // Never emit bytes that are not strictly smaller than the input.
    if built.len() >= output.len() {
        return None;
    }
    Some(built)
}

/// Parse an anchored `<N> <kind>` summary line (e.g. `3 pass`), returning N.
fn parse_bun_count(line: &str, kind: &str) -> Option<usize> {
    let mut parts = line.split_whitespace();
    let count = parts.next()?;
    if parts.next()? != kind || parts.next().is_some() {
        return None;
    }
    if count.is_empty() || !count.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    count.parse::<usize>().ok()
}

/// Anchored `0 fail` summary line.
fn is_bun_zero_fail(line: &str) -> bool {
    let mut parts = line.split_whitespace();
    matches!(parts.next(), Some("0"))
        && matches!(parts.next(), Some("fail"))
        && parts.next().is_none()
}

/// Anchored nonzero `<N> fail` summary line (`N >= 1`).
fn is_bun_nonzero_fail(line: &str) -> bool {
    let mut parts = line.split_whitespace();
    match (parts.next(), parts.next(), parts.next()) {
        (Some(n), Some("fail"), None) => {
            !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && n.as_bytes()[0] != b'0'
        }
        _ => false,
    }
}

/// Parse the exact `Ran N tests across M files. [duration]` footer, returning
/// (N, M). Accepts the singular/plural `test(s)` / `file(s)` spellings and the
/// duration units bun emits (`ms`, `s`, `us`, micro-s, `ns`, `m`, or bare
/// digits); the match is anchored: no leading or trailing characters.
fn parse_bun_footer(line: &str) -> Option<(usize, usize)> {
    let rest = line.strip_prefix("Ran ")?;
    let (tests, rest) = split_leading_digits(rest)?;
    let rest = rest
        .strip_prefix(" tests ")
        .or_else(|| rest.strip_prefix(" test "))?;
    let rest = rest.strip_prefix("across ")?;
    let (files, rest) = split_leading_digits(rest)?;
    let rest = rest
        .strip_prefix(" files. [")
        .or_else(|| rest.strip_prefix(" file. ["))?;
    let duration = rest.strip_suffix(']')?;
    let num_len = duration
        .bytes()
        .take_while(|b| b.is_ascii_digit() || *b == b'.')
        .count();
    if num_len == 0 {
        return None;
    }
    match duration[num_len..].trim_start() {
        "" | "ms" | "s" | "us" | "ns" | "m" | "\u{00b5}s" => {}
        _ => return None,
    }
    Some((tests.parse::<usize>().ok()?, files.parse::<usize>().ok()?))
}

/// Split leading ASCII digits off `s`, requiring at least one.
fn split_leading_digits(s: &str) -> Option<(&str, &str)> {
    let len = s.bytes().take_while(|b| b.is_ascii_digit()).count();
    if len == 0 {
        return None;
    }
    Some((&s[..len], &s[len..]))
}

fn filter_bun_install(output: &str) -> String {
    let mut result = Vec::new();
    for line in output.lines() {
        let clean = strip_ansi(line);
        if clean.trim().is_empty() {
            continue;
        }
        if clean.contains("saved ")
            || clean.contains("installed ")
            || clean.contains("removed ")
            || clean.contains("updated ")
            || clean.contains("packages")
            || clean.contains("lockfile")
            || clean.to_lowercase().contains("error")
            || clean.to_lowercase().contains("warn")
        {
            result.push(clean);
        }
    }
    if result.is_empty() {
        "ok".to_string()
    } else {
        result.join("\n")
    }
}

fn filter_bun_pm(output: &str) -> String {
    let mut result = Vec::new();
    for line in output.lines() {
        let clean = strip_ansi(line);
        if clean.trim().is_empty() {
            continue;
        }
        if clean.contains("package")
            || clean.contains("version")
            || clean.contains("hash")
            || clean.to_lowercase().contains("error")
        {
            result.push(clean);
        }
    }
    if result.is_empty() {
        "ok".to_string()
    } else {
        result.join("\n")
    }
}

fn filter_bun_run(output: &str) -> String {
    let command_echoes: Vec<String> = output
        .lines()
        .map(strip_ansi)
        .filter(|l| !l.trim().is_empty() && (l.starts_with('>') || l.starts_with('$')))
        .collect();
    let command_echoes_present = !command_echoes.is_empty();
    let mut status_lines: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut saw_done = false;
    for line in output.lines() {
        let clean = strip_ansi(line);
        if clean.trim().is_empty() {
            continue;
        }
        if clean.starts_with('>') || clean.starts_with('$') {
            continue;
        }
        let lower = clean.to_lowercase();
        if lower.contains("error") {
            errors.push(clean.clone());
        } else if lower.contains("warn") {
            warnings.push(clean.clone());
        } else if lower.contains("done")
            || lower.contains("finished")
            || lower.contains("success")
            || lower.contains("built")
        {
            saw_done = true;
            status_lines.push(clean.clone());
        }
    }

    let mut result = Vec::new();
    let has_problems = !errors.is_empty() || !warnings.is_empty();
    if has_problems {
        result.extend(command_echoes);
        result.extend(status_lines);
        if !errors.is_empty() {
            result.push("---".to_string());
            result.extend(errors);
        }
        if !warnings.is_empty() {
            result.push("---".to_string());
            result.extend(warnings);
        }
        result.join("\n")
    } else {
        // No errors or warnings: the script executed successfully.
        if saw_done || command_echoes_present {
            "finished".to_string()
        } else {
            "ok".to_string()
        }
    }
}

fn filter_bun_create(output: &str) -> String {
    let mut result = Vec::new();
    for line in output.lines() {
        let clean = strip_ansi(line);
        if clean.trim().is_empty() {
            continue;
        }
        if clean.contains("created")
            || clean.contains("scaffold")
            || clean.contains("project")
            || clean.to_lowercase().contains("error")
            || clean.starts_with("cd ")
            || clean.starts_with("bun ")
        {
            result.push(clean);
        }
    }
    if result.is_empty() {
        "ok".to_string()
    } else {
        result.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_filter_bun_install_empty() {
        assert_eq!(filter_bun_install(""), "ok");
    }

    #[test]
    fn test_filter_bun_install_keeps_summary() {
        let out = "Installing dependencies...\n+ pkg@1.0.0\nsaved 3 packages";
        let res = filter_bun_install(out);
        assert!(res.contains("saved"));
        assert!(!res.contains("Installing"));
    }

    #[test]
    fn test_filter_bun_run_keeps_errors() {
        let out = "Starting dev server...\nWARN: something\nError: failed";
        let res = filter_bun_run(out);
        assert!(res.contains("Error"));
        assert!(!res.contains("Starting"));
    }

    #[test]
    fn test_filter_bun_run_finished() {
        let out = "$ bun run --cwd packages/opencode-plugin build\n$ bun build ./src/index.ts --outdir ./dist --target bun";
        assert_eq!(filter_bun_run(out), "finished");
    }

    #[test]
    fn test_filter_bun_run_done_output() {
        let out = " Building...\n done";
        assert_eq!(filter_bun_run(out), "finished");
    }

    // ---- BunTestHandler regression tests for the "no output" bug ----
    //
    // Bug: when `bun test` runs against a non-default reporter (TAP, JUnit)
    // or an empty/unmatched directory, the handler never saw a `(pass)` /
    // `(fail)` marker so all counters stayed at zero. `format_summary`
    // then returned the literal string `"bun test: no output"`, hiding the
    // actual bun output. The fix returns `None` (and `low_info` returns
    // `true`) so the stream layer falls back to the raw output.

    fn drive_bun_test_handler(input: &str, exit_code: i32) -> (Option<String>, bool) {
        use crate::core::stream::{BlockStreamFilter, StreamFilter};
        let mut f = BlockStreamFilter::new(BunTestHandler::new());
        for line in input.lines() {
            let _ = f.feed_line(line);
        }
        let _ = f.flush();
        let raw = input.to_string();
        let summary = f.on_exit(exit_code, &raw);
        let low_info = f.low_info(&raw);
        (summary, low_info)
    }

    #[test]
    fn bun_test_handler_default_reporter_passes() {
        // Default reporter: every line contains "(pass)" so the handler
        // counts them. Summary should be a clean count.
        let input = "\
bun test v1.4.0

group a > adds 1+1:
(pass) adds 1+1
(pass) subtracts
(pass) concatenates

 3 pass
 0 fail
Ran 3 tests across 1 file. [10ms]";
        let (summary, low_info) = drive_bun_test_handler(input, 0);
        assert_eq!(summary.as_deref(), Some("3 passed, 0 failed, 0 skipped"));
        assert!(!low_info, "default-reporter output is informative");
    }

    #[test]
    fn bun_test_handler_tap_reporter_falls_back_to_raw() {
        // TAP reporter: lines like "ok 1 - test name" / "not ok 2 - other".
        // No "(pass)" or "(fail)" markers → counters stay at 0.
        let input = "\
TAP version 13
ok 1 - group a > adds 1+1
ok 2 - group a > subtracts
ok 3 - group a > concatenates
1..3
# tests 3
# pass  3
# fail  0";
        let (summary, low_info) = drive_bun_test_handler(input, 0);
        // format_summary returns None so the stream layer falls back.
        assert_eq!(summary, None, "TAP output must yield no synthetic summary");
        assert!(low_info, "TAP output must be flagged low-info");
    }

    #[test]
    fn bun_test_handler_junit_reporter_falls_back_to_raw() {
        // JUnit XML — no markers the handler recognizes.
        let input = "\
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<testsuites>
  <testsuite name=\"repro\" tests=\"2\" failures=\"0\" errors=\"0\" skipped=\"0\">
    <testcase name=\"adds 1+1\" time=\"0.001\"/>
    <testcase name=\"subtracts\" time=\"0.001\"/>
  </testsuite>
</testsuites>";
        let (summary, low_info) = drive_bun_test_handler(input, 0);
        assert_eq!(
            summary, None,
            "JUnit output must yield no synthetic summary"
        );
        assert!(low_info, "JUnit output must be flagged low-info");
    }

    #[test]
    fn bun_test_handler_no_matching_test_files_falls_back_to_raw() {
        // Empty/unmatched directory: bun prints a helpful error.
        let input = "\
The following filters did not match any test files:
 tests/fixtures/

note: Tests need \".test\", \"_test_\", \".spec\" or \"_spec_\" in the filename (ex: \"MyApp.test.ts\")

Learn more about bun test: https://bun.com/docs/cli/test";
        let (summary, low_info) = drive_bun_test_handler(input, 1);
        assert_eq!(
            summary, None,
            "empty-dir error must yield no synthetic summary"
        );
        assert!(low_info, "empty-dir error must be flagged low-info");
    }

    #[test]
    fn bun_test_handler_truly_empty_output_with_nonzero_exit_includes_code() {
        // Raw stdout is empty, but exit code is non-zero (e.g. missing
        // bun binary, permission error). We still want a summary line
        // that tells the user something went wrong.
        let (summary, low_info) = drive_bun_test_handler("", 127);
        assert_eq!(summary.as_deref(), Some("bun test: no output (exit 127)"));
        assert!(
            !low_info,
            "empty output + nonzero exit is itself informative"
        );
    }

    #[test]
    fn bun_test_handler_truly_empty_output_with_zero_exit() {
        let (summary, low_info) = drive_bun_test_handler("", 0);
        assert_eq!(summary.as_deref(), Some("bun test: no output"));
        assert!(!low_info);
    }

    #[test]
    fn bun_test_handler_mixed_pass_and_fail() {
        // Sanity: when both pass and fail markers are present we get a
        // full summary with the failure block attached.
        let input = "\
(pass) one
(fail) two
  Expected: 1
  Received: 2
(pass) three";
        let (summary, low_info) = drive_bun_test_handler(input, 1);
        let s = summary.expect("summary present");
        assert!(s.contains("2 passed"), "got: {s}");
        assert!(s.contains("1 failed"), "got: {s}");
        assert!(s.contains("(fail) two"), "failure block included: {s}");
        assert!(!low_info);
    }

    // ---- filter_bun_test_output: pure `rtk pipe -f bun-test` filter ----
    //
    // Unlike BunTestHandler (which drops passing lines as streaming context
    // noise while reconstructing failures), this filter elides only literal
    // `(pass) ` reporter lines behind measured guards and preserves every
    // other original byte. Anything else passes through unchanged.

    const BUN_PIPE_GREEN: &str = "bun test v1.2.3\n\
\n\
(pass) adds 1+1 [0.05ms]\n\
(pass) subtracts [0.02ms]\n\
(pass) concatenates [0.01ms]\n\
\n\
3 pass\n\
0 fail\n\
Ran 3 tests across 1 file. [25.00ms]\n";

    #[test]
    fn bun_pipe_filter_elides_pass_run_and_retains_totals() {
        let out = filter_bun_test_output(BUN_PIPE_GREEN);
        let expected = "bun test v1.2.3\n\
\n\
... (3 passing bun-test lines elided; totals retained below)\n\
\n\
3 pass\n\
0 fail\n\
Ran 3 tests across 1 file. [25.00ms]\n";
        assert_eq!(out, expected);
        assert!(out.len() < BUN_PIPE_GREEN.len(), "must shrink the bytes");
    }

    #[test]
    fn bun_pipe_filter_retains_diagnostics_and_splits_runs_byte_exact() {
        // Logs, warnings, file headers and skips interleave the pass lines,
        // so each maximal run gets its own marker with its own count.
        let input = "bun test v1.4.0 (bun)\n\
a.test.ts:\n\
(pass) math suite > adds two positive integers and returns sum [0.12ms]\n\
(pass) math suite > subtracts negative numbers and borrows [0.03ms]\n\
console.log: debug noise\n\
warn: flaky timing\n\
(pass) math suite > concatenates strings with unicode separators [0.01ms]\n\
(skip) pending thing\n\
3 pass\n\
0 fail\n\
Ran 3 tests across 1 file. [12.40ms]\n";
        let out = filter_bun_test_output(input);
        let expected = "bun test v1.4.0 (bun)\n\
a.test.ts:\n\
... (2 passing bun-test lines elided; totals retained below)\n\
console.log: debug noise\n\
warn: flaky timing\n\
... (1 passing bun-test lines elided; totals retained below)\n\
(skip) pending thing\n\
3 pass\n\
0 fail\n\
Ran 3 tests across 1 file. [12.40ms]\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn bun_pipe_filter_elides_ansi_colored_pass_lines_but_preserves_other_bytes() {
        // Matching is on the ANSI-stripped text, but retained lines keep
        // their original escape bytes untouched.
        let input = "bun test v1.4.0\n\
\n\
\x1b[32m(pass) math suite > adds two positive integers correctly [0.42ms]\x1b[0m\n\
\x1b[32m(pass) math suite > subtracts negative numbers and borrows [0.31ms]\x1b[0m\n\
\x1b[33mwarn: colored warning\x1b[0m\n\
2 pass\n\
0 fail\n\
Ran 2 tests across 1 file. [5ms]\n";
        let out = filter_bun_test_output(input);
        let expected = "bun test v1.4.0\n\
\n\
... (2 passing bun-test lines elided; totals retained below)\n\
\x1b[33mwarn: colored warning\x1b[0m\n\
2 pass\n\
0 fail\n\
Ran 2 tests across 1 file. [5ms]\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn bun_pipe_filter_preserves_trailing_newline_shape() {
        let with_lf = filter_bun_test_output(BUN_PIPE_GREEN);
        assert!(with_lf.ends_with('\n'), "trailing LF must survive");
        let no_lf = &BUN_PIPE_GREEN[..BUN_PIPE_GREEN.len() - 1];
        let out = filter_bun_test_output(no_lf);
        assert!(!out.ends_with('\n'), "no LF invented: {out:?}");
        assert!(out.contains("... (3 passing bun-test lines elided; totals retained below)"));
        assert!(out.contains("Ran 3 tests across 1 file. [25.00ms]"));
    }

    #[test]
    fn bun_pipe_filter_declines_fail_markers_even_when_summaries_look_green() {
        // A `(fail) ` line vetoes elision even though the counts are otherwise
        // consistent — passing lines may carry the failure's context.
        let input = "bun test v1.4.0\n\
(pass) one\n\
(fail) two\n\
1 pass\n\
0 fail\n\
Ran 1 tests across 1 file. [6ms]\n";
        assert_eq!(filter_bun_test_output(input), input);
    }

    #[test]
    fn bun_pipe_filter_declines_nonzero_fail_summary() {
        let input = "bun test v1.4.0\n\
(pass) one\n\
(pass) two\n\
(pass) three\n\
3 pass\n\
1 fail\n\
Ran 4 tests across 1 file. [5ms]\n";
        assert_eq!(filter_bun_test_output(input), input);
    }

    #[test]
    fn bun_pipe_filter_declines_malformed_output_missing_footer() {
        let input = "bun test v1.4.0\n(pass) one\n1 pass\n0 fail\n";
        assert_eq!(filter_bun_test_output(input), input);
    }

    #[test]
    fn bun_pipe_filter_declines_multiple_reports() {
        // Two banners / summaries / footers in one blob must not be folded.
        let input = "bun test v1.4.0\n\
(pass) one\n\
1 pass\n\
0 fail\n\
Ran 1 tests across 1 file. [3ms]\n\
bun test v1.4.0\n\
(pass) two\n\
1 pass\n\
0 fail\n\
Ran 1 tests across 1 file. [4ms]\n";
        assert_eq!(filter_bun_test_output(input), input);
    }

    #[test]
    fn bun_pipe_filter_declines_count_mismatch() {
        // Two `(pass) ` lines but the totals claim three.
        let input = "bun test v1.4.0\n\
(pass) one\n\
(pass) two\n\
3 pass\n\
0 fail\n\
Ran 3 tests across 1 file. [3ms]\n";
        assert_eq!(filter_bun_test_output(input), input);
    }

    #[test]
    fn bun_pipe_filter_passes_through_tap_and_junit_reporters() {
        let tap = "TAP version 13\n\
ok 1 - adds 1+1\n\
ok 2 - subtracts\n\
1..2\n\
# tests 2\n\
# pass  2\n\
# fail  0\n";
        assert_eq!(filter_bun_test_output(tap), tap);
        let junit = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<testsuites>\n\
  <testsuite name=\"repro\" tests=\"2\" failures=\"0\" errors=\"0\" skipped=\"0\">\n\
    <testcase name=\"adds\" time=\"0.001\"/>\n\
  </testsuite>\n\
</testsuites>\n";
        assert_eq!(filter_bun_test_output(junit), junit);
    }

    #[test]
    fn bun_pipe_filter_never_emits_more_bytes_than_raw() {
        assert!(filter_bun_test_output(BUN_PIPE_GREEN).len() < BUN_PIPE_GREEN.len());
        // CRLF line endings decline byte-identical.
        let crlf = BUN_PIPE_GREEN.replace('\n', "\r\n");
        assert_eq!(filter_bun_test_output(&crlf), crlf);
        // Unicode line/paragraph separators decline byte-identical too.
        let u2028 = BUN_PIPE_GREEN.replacen('\n', "\u{2028}", 1);
        assert_eq!(filter_bun_test_output(&u2028), u2028);
        let u2029 = BUN_PIPE_GREEN.replacen('\n', "\u{2029}", 1);
        assert_eq!(filter_bun_test_output(&u2029), u2029);
    }

    #[test]
    fn bun_pipe_filter_keeps_pass_lookalike_lines() {
        // Only lines whose stripped text starts with the literal `(pass) `
        // (with trailing space) are elided; lookalikes are diagnostics.
        let input = "bun test v1.4.0\n\
(passed) not a reporter line\n\
(pass) authentication > rejects expired tokens with a clear error [0.44ms]\n\
x (pass) mid-line mention\n\
(pass)no-space stays\n\
(pass) authentication > refreshes sessions before the deadline hits [0.38ms]\n\
2 pass\n\
0 fail\n\
Ran 2 tests across 1 file. [7ms]\n";
        let out = filter_bun_test_output(input);
        let expected = "bun test v1.4.0\n\
(passed) not a reporter line\n\
... (1 passing bun-test lines elided; totals retained below)\n\
x (pass) mid-line mention\n\
(pass)no-space stays\n\
... (1 passing bun-test lines elided; totals retained below)\n\
2 pass\n\
0 fail\n\
Ran 2 tests across 1 file. [7ms]\n";
        assert_eq!(out, expected);
    }
}
