# pnpm large-workspace performance reproduction

This repository provides a deterministic, synthetic large workspace for pnpm performance
work. It combines two independent characteristics that commonly occur in large monorepos:

- a deeply nested project layout with many precise workspace patterns, useful for workspace
  discovery measurements;
- a high-fan-in internal dependency graph, useful for workspace resolver and cache measurements.

The topology is anonymized and contains no source code or private package names.

The generated workspace has:

- 6,833 projects;
- 784 precise pnpm workspace patterns across 17 package groups;
- 87,630 `workspace:*` dependency edges;
- a most-shared package with 2,633 consumers;
- 75,152 non-project directories and 300,608 ordinary files beneath the projects.

All non-root projects live below `packages/package-00` through `packages/package-16`, and all package
names use the `@synth` scope. The noise consists of nested `docs`, `examples`, and `stories` trees
without additional package manifests. It makes recursive directory traversal expensive without
changing the project set or dependency graph.

Yarn intentionally uses the broad `packages/**` workspace declaration. pnpm uses the original 784
precise declarations; `pnpm-workspace.yaml` also shows the equivalent broad declaration as a
commented-out slow alternative.

## Generate the workspace

```sh
node generate-workspace.mjs
```

The script reads `blueprint.json` and generates the complete workspace directly in this repository.
There is only one generated workspace: the repository root. Generated manifests, workspace trees,
package-manager state, stores, and local binaries are ignored by Git; the lockfiles are checked in
to provide deterministic benchmark inputs. There is deliberately no `pnpmfile.cjs`, so Yarn and
pnpm resolve the same manifests without a package-manager-specific hook.

After generation, either package manager can be run directly from the repository root:

```sh
yarn install --mode update-lockfile
pnpm install --lockfile-only --trust-lockfile --offline --ignore-scripts
```

## Benchmark

This workspace is large enough to exercise both dependency resolution and the surrounding workspace
work: thousands of nested projects, hundreds of precise workspace patterns, and tens of thousands
of shared internal dependency edges. On the pinned baseline, Yarn is substantially faster than
pnpm for the same warm, non-noop lockfile update.

- Yarn: 4.18.0
- pnpm: main at `e972cb50126b2a60bd48b90278d5fbb8fbed32ae`
- Runs: five per tool in alternating order
- Machine: Apple M4 Pro, 14 logical CPUs, 48 GB memory, macOS 15.7.9

| Tool | Median resolution | vs pnpm | Median wall time | vs pnpm |
| --- | ---: | ---: | ---: | ---: |
| Yarn 4.18.0 | 497 ms | -33.29% | 4,789.65 ms | -51.25% |
| pnpm main | 745 ms | — | 9,824.19 ms | — |

To reproduce the comparison, place the pinned pnpm binary at `.bin/pnpm-baseline`, then run:

```sh
node benchmark-resolution.mjs --iterations 5
```

Before each timed run, the runner restores the original manifest and lockfile, performs an untimed
no-op install to warm filesystem caches, changes one dependency from `workspace:*` to
`workspace:^`, and updates the lockfile. It reports:

- Yarn's `Resolution step`;
- pnpm's `resolution_started` to `resolution_done` interval;
- process wall time;
- individual run values and medians.

The runner verifies that both package managers discover all 6,833 projects, every timed run changes
its lockfile, and repeated output is deterministic.

## Repository contents

- `blueprint.json`: canonical workspace paths, patterns, names, and dependency graph;
- `generate-workspace.mjs`: materializes the blueprint in the repository root;
- `benchmark-resolution.mjs`: runs the warm, non-noop Yarn/pnpm comparison.

The original workspace-discovery-specific runner and archived results remain available from the
[initial reproduction commit](https://github.com/jamenh/pnpm-workspace-performance-reproduction/tree/7861772127b1ed73433fac4929bb17753e2c3f2b).
