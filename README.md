# pnpm large-workspace performance fixture

This repository provides a deterministic, synthetic large-workspace fixture for pnpm performance
work. It combines two independent characteristics that commonly occur in large monorepos:

- a deeply nested project layout with many precise workspace patterns, useful for workspace
  discovery measurements;
- a high-fan-in internal dependency graph, useful for workspace resolver and cache measurements.

The topology is anonymized and contains no source code or private package names.

The generated workspace has:

- 6,833 projects;
- 784 workspace patterns across 17 product-shaped roots;
- 87,630 `workspace:*` dependency edges;
- a most-shared package with 2,633 consumers.

## Generate the workspace

```sh
node generate-workspace.mjs
```

The script reads `blueprint.json` and generates the complete workspace directly in this repository.
Generated manifests, lockfiles, package-manager state, stores, and local binaries are ignored by
Git. There is deliberately no `pnpmfile.cjs`, so Yarn and pnpm resolve the same manifests without a
package-manager-specific hook.

After generation, either package manager can be run directly from the repository root:

```sh
yarn install --mode update-lockfile
pnpm install --lockfile-only --trust-lockfile --offline --ignore-scripts
```

## Compare resolution performance

Place the pnpm binaries being compared at `.bin/pnpm-baseline` and `.bin/pnpm-candidate`, then run:

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
its lockfile, repeated output is deterministic, and the pnpm baseline and candidate lockfiles are
byte-identical.

## Repository contents

- `blueprint.json`: canonical workspace paths, patterns, names, and dependency graph;
- `generate-workspace.mjs`: materializes the blueprint in the repository root;
- `benchmark-resolution.mjs`: runs the warm, non-noop Yarn/baseline/candidate comparison.

The original workspace-discovery-specific runner and archived results remain available from the
[initial reproduction commit](https://github.com/jamenh/pnpm-workspace-performance-reproduction/tree/7861772127b1ed73433fac4929bb17753e2c3f2b).
