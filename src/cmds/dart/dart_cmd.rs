//! Dart SDK command filters (analyze, pub, run, test).
//!
//! Complements the Flutter filters; `dart analyze` and `dart pub` share output
//! formats with their `flutter` counterparts.

use crate::core::runner;
use crate::core::utils::{resolved_command, strip_ansi};
use anyhow::Result;
use std::collections::HashMap;

pub fn run_dart_pub(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered("dart", &["pub"], args, "dart pub", filter_dart_pub, verbose)
}

pub fn run_dart_analyze(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered(
        "dart",
        &["analyze"],
        args,
        "dart analyze",
        filter_dart_analyze,
        verbose,
    )
}

pub fn run_dart_test(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered("dart", &["test"], args, "dart test", filter_dart_test, verbose)
}

pub fn run_dart_run(args: &[String], verbose: u8) -> Result<i32> {
    run_filtered("dart", &["run"], args, "dart run", filter_dart_run, verbose)
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

fn filter_dart_pub(output: &str) -> String {
    let mut result = Vec::new();
    let mut changed = None;
    let mut outdated = Vec::new();

    for line in output.lines() {
        let clean = strip_ansi(line);
        if clean.trim().is_empty() {
            continue;
        }
        if clean.starts_with("Changed ") && clean.contains("dependencies") {
            changed = Some(clean);
        } else if clean.contains("newer versions") || clean.contains("incompatible") {
            outdated.push(clean);
        } else if clean.to_lowercase().contains("error") || clean.to_lowercase().contains("warn") {
            result.push(clean);
        }
    }

    if let Some(c) = changed {
        result.push(c);
    }
    result.extend(outdated);

    if result.is_empty() {
        "ok".to_string()
    } else {
        result.join("\n")
    }
}

fn filter_dart_analyze(output: &str) -> String {
    let mut by_file: HashMap<String, Vec<(Sev, String)>> = HashMap::new();
    let mut summary = String::new();

    for line in output.lines() {
        let clean = strip_ansi(line);
        let trimmed = clean.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains("issues found") || trimmed.contains("No issues found") {
            summary = trimmed.to_string();
            continue;
        }

        // dart analyze format:  error - message at path:line:column - (rule)
        if let Some(at_pos) = trimmed.find(" at ") {
            let before = &trimmed[..at_pos];
            let after = &trimmed[at_pos + 4..];
            let sev = if before.starts_with("error") {
                Sev::Error
            } else if before.starts_with("warning") {
                Sev::Warning
            } else {
                Sev::Info
            };
            let message = before.split_once(' ').map(|x| x.1).unwrap_or(before).trim().to_string();
            let file = after.split(" - ").next().unwrap_or(after).trim().to_string();
            let rule = after.rsplit(" - ").next().unwrap_or("").trim().to_string();
            by_file.entry(file).or_default().push((sev, format!("{}: {}", rule, message)));
        }
    }

    if by_file.is_empty() {
        return if summary.is_empty() { "ok".to_string() } else { summary };
    }

    let mut lines = Vec::new();
    if !summary.is_empty() {
        lines.push(summary);
    }

    let mut files: Vec<_> = by_file.into_iter().collect();
    files.sort_by_key(|(_, issues)| {
        let errors = issues.iter().filter(|(s, _)| *s == Sev::Error).count();
        std::cmp::Reverse(errors)
    });

    for (file, issues) in files {
        lines.push(format!("{} ({} issues)", file, issues.len()));
        let mut dedup: HashMap<String, usize> = HashMap::new();
        for (_, text) in &issues {
            *dedup.entry(text.clone()).or_insert(0) += 1;
        }
        let mut sorted: Vec<_> = dedup.into_iter().collect();
        sorted.sort_by_key(|(k, _)| k.clone());
        for (text, count) in sorted {
            if count > 1 {
                lines.push(format!("  {} (x{})", text, count));
            } else {
                lines.push(format!("  {}", text));
            }
        }
    }

    lines.join("\n")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sev {
    Error,
    Warning,
    Info,
}

fn filter_dart_test(output: &str) -> String {
    let mut passed = 0;
    let mut failed = 0;
    let mut failures: Vec<String> = Vec::new();
    let mut current = Vec::new();
    let mut in_failure = false;

    for line in output.lines() {
        let clean = strip_ansi(line);
        let trimmed = clean.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Dart test compact reporter progress: 00:01 +N -M: Some tests failed.
        if trimmed.starts_with("+") {
            let marker_end = trimmed.find(':').unwrap_or(trimmed.len());
            let marker = &trimmed[..marker_end];
            let pass_fail: Vec<&str> = marker.split_whitespace().collect();
            for token in pass_fail {
                if let Some(n) = token.strip_prefix('+') {
                    passed += n.parse::<usize>().unwrap_or(0);
                } else if let Some(n) = token.strip_prefix('-') {
                    failed += n.parse::<usize>().unwrap_or(0);
                }
            }
            if trimmed.contains("failed") || trimmed.contains("Some tests failed") {
                failures.push(trimmed.to_string());
            }
            continue;
        }

        if trimmed.starts_with("✓") {
            passed += 1;
            continue;
        }
        if trimmed.starts_with("✗") || trimmed.contains(" [E]") {
            if in_failure && !current.is_empty() {
                failures.push(current.join("\n"));
                current.clear();
            }
            in_failure = true;
            failed += 1;
            current.push(trimmed.to_string());
            continue;
        }

        if in_failure {
            if trimmed.starts_with("All tests passed") || trimmed.starts_with("Some tests passed") {
                in_failure = false;
                if !current.is_empty() {
                    failures.push(current.join("\n"));
                    current.clear();
                }
                continue;
            }
            current.push(trimmed.to_string());
        }
    }

    if in_failure && !current.is_empty() {
        failures.push(current.join("\n"));
    }

    let mut lines = vec![format!("{} passed, {} failed", passed, failed)];
    for failure in failures {
        lines.push("---".to_string());
        lines.push(failure);
    }
    lines.join("\n")
}

fn filter_dart_run(output: &str) -> String {
    let mut result = Vec::new();
    for line in output.lines() {
        let clean = strip_ansi(line);
        if clean.trim().is_empty() {
            continue;
        }
        let lower = clean.to_lowercase();
        if lower.contains("error") || lower.contains("warn") || lower.contains("exception") {
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
    fn test_filter_dart_pub_summary() {
        let out = "Resolving dependencies...\n+ pkg 1.0.0\nChanged 12 dependencies!";
        let res = filter_dart_pub(out);
        assert!(res.contains("Changed 12"));
        assert!(!res.contains("+ pkg"));
    }

    #[test]
    fn test_filter_dart_test_counts() {
        let out = "+3 -1: Some tests failed.\n - test foo\nExpected: 1\nActual: 2";
        let res = filter_dart_test(out);
        assert!(res.contains("3 passed, 1 failed"));
    }

    #[test]
    fn test_filter_dart_run_empty() {
        assert_eq!(filter_dart_run("Hello\nWorld"), "ok");
    }
}
