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

- `reproduce.mjs`: the single self-contained generator, builder, validator, and benchmark runner;
- `blueprint.json`: the anonymized workspace topology and dependency graph;
- `results/`: the retained benchmark evidence used in the PR.
