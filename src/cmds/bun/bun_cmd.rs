//! Bun runtime command filters (test, run, install, add, remove, update, build, pm, create, init, bunx).
//!
//! Modeled after the Vitest / npm modules and the real-world fixtures
//! documented in rtk-ai/rtk#832 and rtk-ai/rtk#1374. Maximizes token savings
//! by stripping progress bars, passing test lines, package-download noise,
//! and redundant build status updates.

use crate::core::runner;
use crate::core::stream::{BlockHandler, BlockStreamFilter};
use crate::core::utils::{resolved_command, strip_ansi};
use anyhow::Result;
use lazy_static::lazy_static;
use regex::Regex;
use std::ffi::OsString;

/// Run `bun test` and show only failures plus a compact summary.
pub fn run_bun_test(args: &[String], verbose: u8) -> Result<i32> {
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
        &args.join(" "),
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
    run_filtered(
        "bun",
        &["install"],
        args,
        "bun install",
        filter_bun_install,
        verbose,
    )
}

/// Run `bun add` and strip progress / download noise.
pub fn run_bun_add(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered("bun", &["add"], args, "bun add", filter_bun_install, verbose)
}

/// Run `bun remove` and strip progress noise.
pub fn run_bun_remove(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered(
        "bun",
        &["remove"],
        args,
        "bun remove",
        filter_bun_install,
        verbose,
    )
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

/// Run `bun build` and strip per-file status spam.
pub fn run_bun_build(args: &[String], verbose: u8) -> Result<i32> {
    let mut cmd = resolved_command("bun");
    cmd.arg("build");
    for arg in args {
        cmd.arg(arg);
    }

    if verbose > 0 {
        eprintln!("Running: bun build {}", args.join(" "));
    }

    runner::run_filtered(
        cmd,
        "bun build",
        &args.join(" "),
        filter_bun_build,
        runner::RunOptions::default(),
    )
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
        &args.join(" "),
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
        &args.join(" "),
        filter_bun_create,
        runner::RunOptions::default(),
    )
}

/// Run `bunx`. Route known tools to their specialized rtk filters; otherwise passthrough.
pub fn run_bunx(args: &[String], verbose: u8) -> Result<i32> {
    if let Some(first) = args.first().map(|s| s.as_str()) {
        match first {
            "tsc" => return crate::cmds::js::tsc_cmd::run(&args[1..], verbose),
            "eslint" => return crate::cmds::js::lint_cmd::run(&args[1..], verbose),
            "prettier" => return crate::cmds::js::prettier_cmd::run(&args[1..], verbose),
            "vitest" | "jest" => {
                let command = crate::Commands::Vitest {
                    args: args[1..].to_vec(),
                };
                return crate::cmds::js::vitest_cmd::run_test(&command,
                    &args[1..],
                    verbose,
                );
            }
            "prisma" => {
                // Prisma subcommands require a typed enum; passthrough is safest.
            }
            _ => {}
        }
    }

    let mut os_args: Vec<OsString> = Vec::with_capacity(args.len());
    for arg in args {
        os_args.push(arg.as_str().into());
    }

    if verbose > 0 {
        eprintln!("Running: bunx {}", args.join(" "));
    }

    runner::run_passthrough("bunx", &os_args, verbose)
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
        eprintln!("Running: {} {} {}", base, base_args.join(" "), args.join(" "));
    }

    runner::run_filtered(
        cmd,
        label,
        &args.join(" "),
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
        } else if clean.contains("(skip)") || clean.contains("skip") {
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

    fn is_block_continuation(
        &mut self, line: &str, _block: &[String]) -> bool {
        let clean = strip_ansi(line);
        clean.starts_with("  ") || clean.starts_with('\t') || clean.starts_with("at ")
    }

    fn format_summary(&self, _exit_code: i32, _raw: &str) -> Option<String> {
        if self.failed == 0 && self.passed == 0 && self.skipped == 0 {
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

fn filter_bun_build(output: &str) -> String {
    lazy_static! {
        static ref BUNDLE_RE: Regex = Regex::new(
            r"^(.*)\s+(\d+(?:\.\d+)?\s*(?:B|KB|MB|GB))\s*$"
        ).unwrap();
    }
    let mut result = Vec::new();
    let mut errors = Vec::new();
    for line in output.lines() {
        let clean = strip_ansi(line);
        if clean.trim().is_empty() {
            continue;
        }
        if clean.to_lowercase().contains("error") {
            errors.push(clean.clone());
        } else if clean.contains("built") || clean.contains("done") || clean.contains("Build") || BUNDLE_RE.is_match(&clean) {
            result.push(clean);
        }
    }
    if !errors.is_empty() {
        result.push("---".to_string());
        result.extend(errors);
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
    fn test_filter_bun_build_keeps_errors() {
        let out = "Bundling...\nerror: Could not resolve \"missing\"\nBuild failed";
        let res = filter_bun_build(out);
        assert!(res.contains("error"));
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
}
