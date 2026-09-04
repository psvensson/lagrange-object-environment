//! Hermetic regression oracle for the QuickJS-NG module-linker crash found by
//! Bead 0fg and protected by Bead 25v.
//!
//! These are the exact minimized sources preserved by the 0fg investigation.
//! The trigger is order-sensitive: entry `p` first imports `X` from `ps`, then
//! imports cycle-mate `iv`, and finally re-exports the imported binding locally.
//! `iv` closes the cycle by importing `X` from `p`. Released rquickjs 0.12.2's
//! bundled QuickJS-NG 0.15.1 terminates with SIGSEGV while linking this graph;
//! the currently pinned engine evaluates it successfully.
//!
//! The production `EmbeddedLoader` and `JsEnvActor` are intentional parts of
//! the oracle. The parent test isolates the engine in a child process so a
//! linker regression is reported as a signal instead of killing this test
//! binary.

use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::process::ExitStatusExt;

use lagrange_host_linux::js_env::actor::{JsEnvActor, ShutdownOutcome};
use lagrange_host_linux::js_env::EmbeddedLoader;

const P_SOURCE: &str = include_str!("fixtures/quickjs-linker-oracle/p.js");
const PS_SOURCE: &str = include_str!("fixtures/quickjs-linker-oracle/ps.js");
const IV_SOURCE: &str = include_str!("fixtures/quickjs-linker-oracle/iv.js");
const CHILD_ENV: &str = "QUICKJS_LINKER_ORACLE_CHILD";
const CHILD_TEST: &str = "cyclic_indirect_reexport_links_without_crashing";

const EXACT_P_SOURCE: &str = "import {X} from './ps.js';\nimport './iv.js';\nexport {X};\n";
const EXACT_PS_SOURCE: &str = "export const X = 'x';\n";
const EXACT_IV_SOURCE: &str = "import {X} from './p.js';\nconsole.log('iv resolved X =', X);\n";

#[derive(Debug, Default, PartialEq, Eq)]
struct ModuleShape {
    ordered_dependencies: Vec<String>,
    named_imports: Vec<(String, String)>,
    local_exports: Vec<String>,
    concrete_exports: Vec<String>,
}

fn fixture_target(specifier: &str) -> String {
    specifier
        .strip_prefix("./")
        .unwrap_or(specifier)
        .strip_suffix(".js")
        .unwrap_or(specifier.strip_prefix("./").unwrap_or(specifier))
        .to_string()
}

fn quoted_specifier(text: &str) -> Result<&str, String> {
    let text = text.trim().trim_end_matches(';').trim();
    if text.len() < 2 {
        return Err(format!("missing quoted module specifier in {text:?}"));
    }
    let quote = text.as_bytes()[0];
    if (quote != b'\'' && quote != b'\"') || text.as_bytes()[text.len() - 1] != quote {
        return Err(format!("invalid quoted module specifier {text:?}"));
    }
    Ok(&text[1..text.len() - 1])
}

fn parse_shape(source: &str) -> Result<ModuleShape, String> {
    let mut shape = ModuleShape::default();
    for line in source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(import) = line.strip_prefix("import ") {
            if let Some((bindings, specifier)) = import.split_once(" from ") {
                let target = fixture_target(quoted_specifier(specifier)?);
                shape.ordered_dependencies.push(target.clone());
                let bindings = bindings
                    .strip_prefix('{')
                    .and_then(|value| value.strip_suffix('}'))
                    .ok_or_else(|| format!("expected named import in {line:?}"))?;
                for binding in bindings
                    .split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                {
                    shape
                        .named_imports
                        .push((binding.to_string(), target.clone()));
                }
            } else {
                shape
                    .ordered_dependencies
                    .push(fixture_target(quoted_specifier(import)?));
            }
        } else if let Some(exports) = line
            .strip_prefix("export {")
            .and_then(|value| value.strip_suffix("};"))
        {
            shape.local_exports.extend(
                exports
                    .split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string),
            );
        } else if let Some(declaration) = line.strip_prefix("export const ") {
            let name = declaration
                .split(|character: char| character.is_whitespace() || character == '=')
                .next()
                .filter(|name| !name.is_empty())
                .ok_or_else(|| format!("missing exported binding in {line:?}"))?;
            shape.concrete_exports.push(name.to_string());
        }
    }
    Ok(shape)
}

fn reachable(graph: &BTreeMap<String, Vec<String>>, start: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut pending = vec![start.to_string()];
    while let Some(module) = pending.pop() {
        if !seen.insert(module.clone()) {
            continue;
        }
        if let Some(dependencies) = graph.get(&module) {
            pending.extend(dependencies.iter().cloned());
        }
    }
    seen
}

fn validate_trigger_topology(modules: &[(&str, &str)], entry: &str) -> Result<(), String> {
    let names: BTreeSet<_> = modules.iter().map(|(name, _)| *name).collect();
    if modules.len() != 3 || names != BTreeSet::from(["iv", "p", "ps"]) {
        return Err(format!(
            "fixture must contain exactly p, ps, and iv; got {names:?}"
        ));
    }
    if entry != "p" {
        return Err(format!("the order-sensitive entry must be p, got {entry}"));
    }

    let shapes: BTreeMap<_, _> = modules
        .iter()
        .map(|(name, source)| parse_shape(source).map(|shape| ((*name).to_string(), shape)))
        .collect::<Result<_, _>>()?;
    let graph: BTreeMap<_, _> = shapes
        .iter()
        .map(|(name, shape)| (name.clone(), shape.ordered_dependencies.clone()))
        .collect();

    if graph.get("p") != Some(&vec!["ps".to_string(), "iv".to_string()]) {
        return Err(format!(
            "p must import ps before iv; got {:?}",
            graph.get("p")
        ));
    }
    if graph.get("iv") != Some(&vec!["p".to_string()]) || graph.get("ps") != Some(&Vec::new()) {
        return Err(format!(
            "expected iv -> p and no ps dependencies; got {graph:?}"
        ));
    }

    let cycle: BTreeSet<_> = names
        .iter()
        .filter(|candidate| {
            reachable(&graph, "p").contains(**candidate)
                && reachable(&graph, candidate).contains("p")
        })
        .copied()
        .collect();
    if cycle != BTreeSet::from(["iv", "p"]) {
        return Err(format!(
            "the strongly connected component must be exactly p + iv; got {cycle:?}"
        ));
    }

    let p = &shapes["p"];
    if !p
        .named_imports
        .contains(&("X".to_string(), "ps".to_string()))
        || !p.local_exports.contains(&"X".to_string())
    {
        return Err(format!(
            "p must import X from ps and separately re-export that imported binding; got {p:?}"
        ));
    }
    if !shapes["ps"].concrete_exports.contains(&"X".to_string()) {
        return Err(format!(
            "ps must be the concrete source of X; got {:?}",
            shapes["ps"]
        ));
    }
    Ok(())
}

#[test]
fn checked_in_fixture_preserves_exact_historical_trigger_topology() {
    assert_eq!(
        P_SOURCE, EXACT_P_SOURCE,
        "p.js drifted from the recovered 0fg reproducer"
    );
    assert_eq!(
        PS_SOURCE, EXACT_PS_SOURCE,
        "ps.js drifted from the recovered 0fg reproducer"
    );
    assert_eq!(
        IV_SOURCE, EXACT_IV_SOURCE,
        "iv.js drifted from the recovered 0fg reproducer"
    );
    validate_trigger_topology(
        &[("p", P_SOURCE), ("ps", PS_SOURCE), ("iv", IV_SOURCE)],
        "p",
    )
    .expect("checked-in sources retain the linker-crash topology");
}

#[test]
fn topology_proof_rejects_trigger_erasing_perturbations() {
    let no_reexport = P_SOURCE.replace("export {X};\n", "");
    assert!(
        validate_trigger_topology(
            &[("p", &no_reexport), ("ps", PS_SOURCE), ("iv", IV_SOURCE)],
            "p"
        )
        .is_err(),
        "removing the imported-binding re-export must invalidate the oracle"
    );

    let reversed_entry_order = P_SOURCE.replace(
        "import {X} from './ps.js';\nimport './iv.js';",
        "import './iv.js';\nimport {X} from './ps.js';",
    );
    assert!(
        validate_trigger_topology(
            &[
                ("p", &reversed_entry_order),
                ("ps", PS_SOURCE),
                ("iv", IV_SOURCE)
            ],
            "p"
        )
        .is_err(),
        "reversing the order-sensitive p imports must invalidate the oracle"
    );

    let no_back_edge = IV_SOURCE.replace("./p.js", "./ps.js");
    assert!(
        validate_trigger_topology(
            &[("p", P_SOURCE), ("ps", PS_SOURCE), ("iv", &no_back_edge)],
            "p"
        )
        .is_err(),
        "removing the iv -> p cycle edge must invalidate the oracle"
    );
}

fn spawn_fixture_actor() -> JsEnvActor {
    let loader = EmbeddedLoader::new()
        .with_module("p", P_SOURCE)
        .with_module("ps", PS_SOURCE)
        .with_module("iv", IV_SOURCE);
    JsEnvActor::spawn(loader).expect("spawn production actor with exact linker fixture")
}

#[test]
fn cyclic_indirect_reexport_links_without_crashing() {
    if std::env::var_os(CHILD_ENV).is_some() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build child runtime");
        runtime.block_on(async {
            let actor = spawn_fixture_actor();
            // The exact recovered fixture logs after linking. The production
            // embedded host intentionally has no Node/browser console surface,
            // so provide only the fixture's test-local sink without changing a
            // byte of the historical reproducer.
            actor
                .eval("globalThis.console = { log() {} };")
                .await
                .expect("install the fixture-local console sink");
            let result = actor
                .eval_async("(async () => { const ns = await import('p'); return { X: ns.X }; })()")
                .await
                .expect("link and evaluate exact historical trigger through the production actor");
            let value: serde_json::Value =
                serde_json::from_str(&result).expect("oracle result is JSON");
            assert_eq!(
                value["X"], "x",
                "the indirect re-export resolves semantically"
            );
            assert_eq!(actor.shutdown().await, ShutdownOutcome::Clean);
        });
        return;
    }

    let executable = std::env::current_exe().expect("locate this test executable");
    let listing = std::process::Command::new(&executable)
        .arg("--list")
        .output()
        .expect("list child tests");
    assert!(
        listing.status.success(),
        "child --list failed: {:?}",
        listing.status
    );
    let listed = String::from_utf8_lossy(&listing.stdout);
    assert!(
        listed.lines().any(|line| line.trim_start().starts_with(CHILD_TEST)),
        "child test {CHILD_TEST:?} is absent from --list; an --exact child run would pass vacuously: {listed}"
    );

    let status = std::process::Command::new(&executable)
        .arg(CHILD_TEST)
        .arg("--exact")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env(CHILD_ENV, "1")
        .status()
        .expect("spawn isolated linker-oracle child");

    if let Some(signal) = status.signal() {
        panic!(
            "linker-oracle child terminated by signal {signal}; signal 11 is the historical QuickJS-NG linker crash"
        );
    }
    assert!(
        status.success(),
        "linker-oracle child exited {status}; the engine did not satisfy the semantic oracle"
    );
}
