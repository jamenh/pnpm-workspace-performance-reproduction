# pnpm large-workspace performance reproduction

This repository provides a deterministic, synthetic large workspace for pnpm performance
work. It combines two independent characteristics that commonly occur in large monorepos:

- a deeply nested project layout with many precise workspace patterns, useful for workspace
  discovery measurements;
- a high-fan-in internal dependency graph, useful for workspace resolver and cache measurements.

The topology is anonymized and contains no source code or private package names.

The committed workspace has:

- 6,839 projects, six of which depend on registry packages;
- 785 precise pnpm workspace patterns: 784 across 17 package groups, plus one for the registry consumers;
- 87,630 `workspace:*` dependency edges;
- a most-shared package with 2,633 consumers;
- 75,152 non-project directories and 300,608 ordinary files beneath the projects.

All other non-root projects live below `packages/package-00` through `packages/package-16`, and
all package names use the `@synth` scope. The six registry consumers live in
`packages/registry-consumers/`. The noise consists of nested `docs`, `examples`, and `stories` trees
without additional package manifests. It makes recursive directory traversal expensive without
changing the project set or dependency graph.

Yarn intentionally uses the broad `packages/**` workspace declaration. pnpm uses the original 784
precise declarations plus `packages/registry-consumers/*`; `pnpm-workspace.yaml` also shows the equivalent broad declaration as a
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

## Registry revalidation during `autoDedupe`

Six projects under `packages/registry-consumers/` depend on 44 registry packages, including Babel,
webpack, ESLint, Storybook, Next.js, the AWS SDK v3, Azure SDKs and React Spectrum. The pnpm
lockfile resolves 1,446 registry package names, and 568 of them have more than one locked version
whose ranges overlap:

- the three `legacy-*` projects use plain caret ranges such as `^7.0.0` and were locked to the
  newest versions published before 2024-09-30;
- the three `current-*` projects use caret ranges that start at the newest version, so they lock
  current releases.

`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` and exempts the scopes that make up most of
this graph through `minimumReleaseAgeExclude`. This matches large workspaces that exempt their own
scopes. pnpm revalidates cached metadata for exempt packages on every range pick, and
`--auto-dedupe` re-picks every package that has more than one locked version.

These steps need network access to `https://registry.npmjs.org/`, which `.npmrc` names. Run one
untimed warm-up with each executable first, so the metadata cache is populated. Then, for each run:

1. Restore the original root `package.json` and `pnpm-lock.yaml`.
2. In the root `package.json`, change only `@synth/pkg-03426` from `workspace:*` to `workspace:^`.
3. Run the command below, substituting the path to the executable being measured.

```sh
time /path/to/pnpm install --lockfile-only --trust-lockfile --ignore-scripts --reporter=append-only --auto-dedupe
```

Every run should exit successfully. With `--auto-dedupe`, and separately without it, every
executable should produce the same lockfile.

Measured on 2026-09-30 on macOS arm64 with a warm metadata cache. Both executables were built with
the same profile. Base is pnpm `main` at `d162953a1`; the candidate is the same commit plus the
cached range metadata change. There were 20 alternating runs per row, after one warm-up.

| Command | Base median (p25–p75) | Candidate median (p25–p75) | Change | Registry requests (base / candidate) |
| --- | --- | --- | --- | --- |
| with `--auto-dedupe` | 2.67 s (2.53–2.94) | 2.25 s (2.20–2.44) | −16% | 223 / 0 |
| without `--auto-dedupe` | 2.88 s (2.76–2.99) | 2.13 s (2.10–2.16) | −26% | 184 / 0 |

Request counts came from temporary logging at the resolver's registry fetch and are not part of
either executable. The time saved per request is small on npmjs, which answers these
revalidations quickly. Registries that answer them slowly show a larger difference.

Other notes:

- The Yarn lockfile does not include these projects.
- The earlier measurements above were taken before these projects were added.
- The documented `--offline` commands still work once the metadata cache is warm.

### No-op updates

A no-op needs a lockfile that `--auto-dedupe` has already converged:

1. Restore the original root `package.json` and `pnpm-lock.yaml`.
2. Run the command above once, with `--auto-dedupe` and without the manifest edit.
3. Keep the resulting `pnpm-lock.yaml` as the no-op seed.

Running `--auto-dedupe` on that seed again leaves it byte-identical. For each timed run, restore
the seed and the original `package.json`, then run the same command without any manifest edit.

Measured on 2026-09-30 with the same executables and method as above, 20 alternating runs per row.
All 80 runs left the lockfile byte-identical.

| Command | Base median (p25–p75) | Candidate median (p25–p75) |
| --- | --- | --- |
| without `--auto-dedupe` | 0.62 s (0.62–0.64) | 0.62 s (0.61–0.64) |
| with `--auto-dedupe` | 2.74 s (2.52–2.84) | 2.31 s (2.24–2.46) |

Without `--auto-dedupe`, pnpm sees that the lockfile is up to date and returns without resolving.
With it, every run resolves the whole graph again, even when nothing changes, and costs about 3.7
times as much after the change. The change removes the registry revalidation from that resolution;
it does not skip the resolution itself.

### Skipping the resolution on a deduplicated lockfile

A second change lets pnpm skip that resolution. After an install with `--auto-dedupe` writes the
lockfile, it records a digest of the lockfile, every project manifest, the settings and the local
packages the lockfile resolves in pnpm's cache directory. A later `--lockfile-only` install whose
digests match takes the up-to-date path. Any other install resolves as before. The lockfile does not
change.

Measured on 2026-10-01 with three executables built from pnpm `main` at `a44e9079e` with the same
profile: `main` itself, `main` plus the cached range metadata change, and both plus the record. Each
row has 20 alternating runs after one warm-up, which also writes the record. The no-op rows use the
converged seed described above; the update rows use the README's edit on the committed lockfile.
Every row left one lockfile across all three executables.

| Command | `main` | + cached range metadata | + record |
| --- | --- | --- | --- |
| no-op, with `--auto-dedupe` | 2.56 s | 2.20 s | 0.75 s |
| no-op, without `--auto-dedupe` | 0.73 s | 0.73 s | 0.74 s |
| update, with `--auto-dedupe` | 2.78 s | 2.22 s | 2.31 s |
| update, without `--auto-dedupe` | 3.31 s | 2.30 s | 2.31 s |

With the record, a no-op with `--auto-dedupe` costs the same as one without it. Updates still
resolve, so the record does not change their cost beyond its digests, about 20 ms here. Another
build was running on the machine during these runs, so the absolute times are higher and more
spread out than on an idle machine; the executables alternated within each round.

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

- `packages/`: all 6,838 non-root projects and their non-project directory trees, including the six
  registry consumers in `packages/registry-consumers/`;
- `package.json`: the root project and Yarn's recursive workspace declaration;
- `pnpm-workspace.yaml`: pnpm's precise workspace declarations and the release-age settings;
- `pnpm-lock.yaml` and `yarn.lock`: deterministic package-manager inputs.
