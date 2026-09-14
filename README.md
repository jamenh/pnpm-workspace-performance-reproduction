# pnpm large-workspace performance reproduction

This repository provides a deterministic, synthetic large workspace for pnpm performance
work. It combines two independent characteristics that commonly occur in large monorepos:

- a deeply nested project layout with many precise workspace patterns, useful for workspace
  discovery measurements;
- a high-fan-in internal dependency graph, useful for workspace resolver and cache measurements.

The topology is anonymized and contains no source code or private package names.

The committed workspace has:

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

## Peer-check regression: pnpm 12.2.1 versus 12.3.0

The peer reproduction is already materialized. No generator, custom pnpm hook, registry
access, or package build is needed. There are 30 local packages in `fixtures/peer-consumer-*`,
each containing only a `package.json`. Thirty existing workspace projects depend on these
packages through `file:` references. Each fixture requires one of its consumer's existing
workspace dependencies at `^2.0.0`; the available workspace version is `1.0.0`.
These intentional mismatches trigger install-time peer diagnostics while the existing
shared workspace graph supplies the traversal workload. `autoInstallPeers: false` prevents
attempts to download a compatible peer, and `strictPeerDependencies: false` permits completion.

Use native pnpm 12.2.1 and 12.3.0 executables for your platform. Run the following steps
from this repository with each executable, restoring the same inputs between versions:

1. Save the original root `package.json` and `pnpm-lock.yaml` outside this checkout.
2. In the root `package.json`, change only `@synth/pkg-03426` from `workspace:*` to
   `workspace:^`. This forces a real lockfile update instead of a no-op.
3. Run the command below, substituting the path to the executable being measured.
4. Restore both saved files before repeating with the other version.

```sh
/path/to/pnpm --version
time /path/to/pnpm install --lockfile-only --trust-lockfile --offline --ignore-scripts --reporter=append-only
```

Both versions should exit successfully and print `Issues with peer dependencies found`.
The resulting lockfiles should be identical. There is no need to run `pnpm peers check`
to observe this regression. An unchanged or frozen lockfile install can skip the diagnostic
path, so the manifest edit is necessary for this comparison.

Measured on macOS 15.7.9 arm64 using native release binaries and a warm local store.
Each run restored the same seed lockfile and made the same root manifest edit. Execution
order was 12.2.1, 12.3.0, 12.3.0, 12.2.1, 12.2.1, 12.3.0.

| Version | Three wall times | Median |
| --- | --- | --- |
| 12.2.1 | 3.020 s, 2.750 s, 2.652 s | 2.750 s |
| 12.3.0 | 29.554 s, 29.679 s, 27.908 s | 29.554 s |

12.3.0 was **10.75 times slower**. All six commands exited successfully, changed the
lockfile, and produced byte-identical output lockfiles. Raw timings and hashes are in
[peer-regression-results.json](peer-regression-results.json).

The suspected traversal change is
[pnpm commit 291d374898](https://github.com/pnpm/pnpm/commit/291d374898559f01f218a2aac8e05c0d3d5fef3d),
which makes normalized linked-workspace paths resolve to importer IDs and enables deeper
peer-check traversal. Shared linked dependencies are traversed separately for each checked
importer. This repository's measurements compare the two releases; they do not independently
test a build reverting that commit.

The pnpm lockfile includes the peer fixtures. The existing Yarn lockfile and the resolver
benchmark below describe the earlier workspace without these added fixtures.

## Run the workspace

The repository contains the complete project tree, workspace declarations, and lockfiles. After
cloning, run either package manager from the repository root. There is deliberately no
`pnpmfile.cjs`, so Yarn and pnpm resolve the same manifests without a package-manager-specific hook.

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

To measure workspace discovery with any pnpm build, run it directly against the checked-in
workspace:

```sh
pnpm install --lockfile-only --frozen-lockfile --offline --ignore-scripts --reporter=ndjson
```

The published resolver comparison used warm, non-noop lockfile updates: before each timed run, the
original manifest and lockfile were restored, one root dependency was changed from `workspace:*`
to `workspace:^`, and the lockfile was updated. Both package managers discovered all 6,833
projects, every timed run changed its lockfile, and repeated output was deterministic.

## Repository contents

- `packages/`: all 6,832 non-root projects and their non-project directory trees;
- `package.json`: the root project and Yarn's recursive workspace declaration;
- `pnpm-workspace.yaml`: pnpm's 784 precise workspace declarations;
- `pnpm-lock.yaml` and `yarn.lock`: deterministic package-manager inputs.
