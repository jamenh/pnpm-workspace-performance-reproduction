# pnpm workspace-discovery performance reproduction

This is the public benchmark reproduction for
[pnpm/pnpm#14262](https://github.com/pnpm/pnpm/pull/14262).

The reported numbers were not measured directly in a private production repository. They were
measured in deterministic synthetic projects generated from `blueprint.json`. The blueprint
preserves an anonymized production-monorepo-shaped workspace topology and internal dependency
graph while replacing all package names and paths and including no source code.

The generated project has:

- 6,833 workspace projects;
- 784 precise workspace declarations: 744 terminal `/*` patterns and 40 literals;
- 87,630 internal workspace dependency edges;
- 17 product-shaped roots.

Its noisy variants add 11 nested directories and 44 ordinary files beneath every non-root
workspace without adding any package manifests. The precise and recursive variants therefore
discover exactly the same project set while traversing very different search domains.

The blueprint also captures the resolver-cache workload: its 87,630 `workspace:*` edges repeatedly
target a much smaller set of shared workspace packages. The most widely shared package has 2,633
consumers.

## Resolver-cache benchmark

Generate the combined workspace directly in this repository:

```sh
node generate-workspace.mjs
```

After generation, Yarn and pnpm can be run directly from the repository root:

```sh
yarn install --mode update-lockfile
pnpm install --lockfile-only --trust-lockfile --offline --ignore-scripts
```

There is deliberately no `pnpmfile.cjs`: both package managers resolve the same manifests without
package-manager-specific hooks.

To run the warm, non-noop resolution comparison, place the frozen baseline and candidate pnpm
binaries in `.bin/pnpm-baseline` and `.bin/pnpm-candidate`, then run:

```sh
node benchmark-resolution.mjs --iterations 5
```

Before every timed run, the benchmark restores the original manifest and lockfile, performs an
untimed no-op install to warm filesystem caches, changes one `workspace:*` dependency to
`workspace:^`, and then measures the resulting lockfile update. It reports Yarn's `Resolution
step`, pnpm's `resolution_started` to `resolution_done` interval, and process wall time. The pnpm
baseline and candidate must produce byte-identical lockfiles.

### Pinned resolver-cache comparison

- pnpm baseline: `e972cb50126b2a60bd48b90278d5fbb8fbed32ae`
- pnpm candidate: `c11bbf0a426b1aa8e81b4588c019c69f406fe9f4`
- Yarn: 4.18.0
- Runs: five per engine in rotating order, each immediately preceded by its own no-op warm-up
- Mutation: one root dependency from `workspace:*` to `workspace:^`
- Machine: Apple M4 Pro, 14 logical CPUs, 48 GB memory, macOS 15.7.9

| Engine | Median resolution | vs pnpm baseline | Median wall | vs pnpm baseline |
| --- | ---: | ---: | ---: | ---: |
| Yarn 4.18.0 | 536 ms | -39.78% | 2,797.23 ms | -72.22% |
| pnpm baseline | 890 ms | — | 10,068.61 ms | — |
| pnpm candidate | 517 ms | -41.91% | 9,551.44 ms | -5.14% |

The resolution interval is the primary metric. Wall time additionally contains workspace
discovery and pnpm's post-resolution peer-dependency reporting. All candidate and baseline runs
produced byte-identical pnpm lockfiles.

## One-command reproduction

Prerequisites are Git, Node.js, and the Rust toolchain required by pnpm. Then run:

```sh
node reproduce.mjs
```

The script performs the complete experiment:

1. checks out pnpm at the frozen baseline commit;
2. builds the baseline binary;
3. fetches the exact PR commit and applies its patch to that same baseline checkout;
4. builds the candidate binary;
5. generates clean/noisy and precise/recursive fixtures, including their `.npmrc`,
   `pnpm-workspace.yaml`, package manifests, and lockfiles;
6. verifies that both binaries enumerate the same 6,833-project set;
7. performs one warm-up and ten alternating-order fresh-process runs per binary and fixture;
8. verifies the `pnpm:scope` count and unchanged lockfile hash after every run.

Generated pnpm sources, binaries, fixtures, logs, and new results are written below `.work/` and
are intentionally not committed. Expect a long Rust build and roughly 600,000 generated noise
files. To run a shorter smoke benchmark, use:

```sh
node reproduce.mjs --iterations 1
```

The timed command is an offline, frozen, lockfile-only no-op install:

```sh
pnpm install --lockfile-only --frozen-lockfile --offline --reporter=ndjson
```

## Pinned comparison

- Baseline: pnpm `main` at `c4fdd5fbb4cccbcc2941323fe56e2670f1612911`
- Candidate: commit `12be1c29d9ea63b52a936ac7015adcccb001b203` from
  [pnpm/pnpm#14262](https://github.com/pnpm/pnpm/pull/14262), applied as a patch to the frozen
  baseline
- Runs: ten per binary, alternating order, after one warm-up each
- Machine: Apple M4 Pro, 14 logical CPUs, macOS 15.6 (`darwin` 24.6.0)

| Fixture | Patterns | `main` scope | Candidate scope | Scope delta | `main` wall | Candidate wall | Wall delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Precise | 784 | 2,146.50 ms | 999.50 ms | -53.44% | 2,779.33 ms | 1,621.51 ms | -41.66% |
| Precise with non-project tree noise | 784 | 3,638.00 ms | 1,002.00 ms | -72.46% | 4,266.10 ms | 1,633.70 ms | -61.71% |
| Recursive with the same tree noise | 1 (`**`) | 9,104.00 ms | 9,090.00 ms | -0.15% | 9,682.07 ms | 9,665.90 ms | -0.17% |

Both binaries produced the same project-set SHA-256 and left the lockfile hash unchanged after
every run. Archived summaries, samples, raw NDJSON, and machine-readable results are retained in
[`results/`](results/).

## Repository contents

- `generate-workspace.mjs`: generates the combined fixture in the repository root;
- `benchmark-resolution.mjs`: runs the warm, non-noop Yarn/baseline/candidate comparison;
- `reproduce.mjs`: the single self-contained generator, builder, validator, and benchmark runner;
- `blueprint.json`: the anonymized workspace topology and dependency graph;
- `results/`: the retained benchmark evidence used in the PR.
