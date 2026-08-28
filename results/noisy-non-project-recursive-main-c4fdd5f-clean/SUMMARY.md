# Latest-main workspace discovery benchmark

- Commit: `c4fdd5fbb4cccbcc2941323fe56e2670f1612911`
- Fixture: 6,833 projects, 1 patterns, 87,630 internal edges
- Runs: 10 per binary, interleaved after one warm-up each
- Command: `pnpm install --lockfile-only --frozen-lockfile --offline --reporter=ndjson`
- Project-set SHA256: `75208ec77c45cccfe2da8eb30991b615b3359a2ae4d36bef1a45441a69797570`
- Lockfile SHA256: `1ac33b9511f13d144ff1c89fc197bc258feb311d0cf82d10ccfac57c1fa367e9`

| Metric | Latest main | Candidate | Median delta |
| --- | ---: | ---: | ---: |
| Process start → `pnpm:scope` | 9104.00 ms | 9090.00 ms | -0.15% |
| Process wall time | 9682.07 ms | 9665.90 ms | -0.17% |

Standard deviation for scope was 647.30 ms on latest main and 300.78 ms on the candidate.
