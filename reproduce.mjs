#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const blueprintFile = join(root, 'blueprint.json')
const workRoot = join(root, '.work')
const sourceRoot = join(workRoot, 'pnpm')
const targetRoot = join(workRoot, 'target')
const binRoot = join(workRoot, 'bin')
const fixtureRoot = join(workRoot, 'fixtures')
const resultsRoot = join(workRoot, 'results')

const upstreamRepository = 'https://github.com/pnpm/pnpm.git'
const candidateRepository = 'https://github.com/jamenh/pnpm.git'
const baselineCommit = 'c4fdd5fbb4cccbcc2941323fe56e2670f1612911'
const candidateCommit = '12be1c29d9ea63b52a936ac7015adcccb001b203'
const iterations = parseArguments(process.argv.slice(2))

main()

function main() {
  resetWorkDirectory()
  const blueprint = readBlueprint()
  const binaries = buildBinaries()
  const fixtures = [
    generateFixture(blueprint, 'precise', 'blueprint', 'clean'),
    generateFixture(blueprint, 'recursive', 'recursive', 'clean'),
    generateFixture(blueprint, 'noisy-precise', 'blueprint', 'noisy'),
    generateFixture(blueprint, 'noisy-recursive', 'recursive', 'noisy'),
  ]

  const summaries = fixtures.map((fixture) =>
    benchmarkFixture(fixture, binaries, iterations, join(resultsRoot, fixture.name)),
  )
  const overview = renderOverview(summaries)
  writeFileSync(join(resultsRoot, 'SUMMARY.md'), overview)
  process.stdout.write(`\n${overview}\nResults: ${relative(root, resultsRoot)}\n`)
}

function parseArguments(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: node reproduce.mjs [--iterations <positive-integer>]')
    process.exit(0)
  }

  let value = '10'
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--iterations') {
      value = args[++index]
    } else if (argument.startsWith('--iterations=')) {
      value = argument.slice('--iterations='.length)
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`invalid iteration count: ${value}`)
  }
  return parsed
}

function resetWorkDirectory() {
  const expected = resolve(root, '.work')
  if (resolve(workRoot) !== expected || !expected.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error(`refusing to reset unexpected work directory: ${workRoot}`)
  }
  rmSync(workRoot, { recursive: true, force: true })
  mkdirSync(workRoot, { recursive: true })
}

function readBlueprint() {
  const blueprint = JSON.parse(readFileSync(blueprintFile, 'utf8'))
  const withoutHash = { ...blueprint }
  delete withoutHash.sha256
  const actualHash = digest(JSON.stringify(withoutHash))
  if (blueprint.sha256 !== actualHash) {
    throw new Error(`blueprint SHA-256 mismatch: ${actualHash} != ${blueprint.sha256}`)
  }
  return blueprint
}

function buildBinaries() {
  section('Preparing pnpm source')
  mkdirSync(sourceRoot, { recursive: true })
  run('git', ['init', '--quiet'], sourceRoot)
  run('git', ['remote', 'add', 'origin', upstreamRepository], sourceRoot)
  run('git', ['fetch', '--depth=1', 'origin', baselineCommit], sourceRoot)
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], sourceRoot)
  assertEqual(git(['rev-parse', 'HEAD']), baselineCommit, 'baseline checkout')

  mkdirSync(binRoot, { recursive: true })
  const cargoEnvironment = { ...process.env, CARGO_TARGET_DIR: targetRoot }
  const builtBinary = join(targetRoot, 'release-debug', executableName('pnpm'))
  const baselineBinary = join(binRoot, executableName('pnpm-baseline'))
  const candidateBinary = join(binRoot, executableName('pnpm-candidate'))

  section('Building frozen baseline')
  run(
    'cargo',
    ['build', '--locked', '--profile', 'release-debug', '-p', 'pnpm-cli'],
    sourceRoot,
    cargoEnvironment,
  )
  copyExecutable(builtBinary, baselineBinary)
  const baseline = binaryMetadata(baselineBinary, {
    commit: baselineCommit,
    status: '',
    diffSha256: digest(''),
  })

  section('Applying PR patch to the same frozen baseline')
  // Fetch the commit and its parent so `git show` emits only this PR's patch.
  run('git', ['fetch', '--depth=2', candidateRepository, candidateCommit], sourceRoot)
  assertEqual(git(['rev-parse', 'FETCH_HEAD']), candidateCommit, 'candidate fetch')
  const patch = execFileSync(
    'git',
    ['-C', sourceRoot, 'show', '--format=', '--binary', candidateCommit],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  const applied = spawnSync('git', ['-C', sourceRoot, 'apply', '--whitespace=nowarn', '-'], {
    input: patch,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (applied.error) throw applied.error
  if (applied.status !== 0) throw new Error(`git apply exited with ${applied.status}`)
  assertEqual(git(['rev-parse', 'HEAD']), baselineCommit, 'candidate base')

  section('Building candidate')
  run(
    'cargo',
    ['build', '--locked', '--profile', 'release-debug', '-p', 'pnpm-cli'],
    sourceRoot,
    cargoEnvironment,
  )
  copyExecutable(builtBinary, candidateBinary)
  const candidate = binaryMetadata(candidateBinary, {
    commit: git(['rev-parse', 'HEAD']),
    status: git(['status', '--short']),
    diffSha256: digest(git(['diff', '--no-ext-diff'])),
    sourceCommit: candidateCommit,
  })

  if (baseline.sha256 === candidate.sha256) {
    throw new Error('baseline and candidate binaries are byte-identical')
  }
  return { baseline, candidate }
}

function binaryMetadata(path, source) {
  return {
    path: relative(root, path),
    sha256: fileDigest(path),
    version: execFileSync(path, ['--version'], { encoding: 'utf8' }).trim(),
    ...source,
  }
}

function copyExecutable(from, to) {
  if (!existsSync(from)) throw new Error(`built binary not found: ${from}`)
  copyFileSync(from, to)
  chmodSync(to, 0o755)
}

function generateFixture(blueprint, name, declarationMode, filesystemProfile) {
  section(`Generating ${name} fixture`)
  const directory = join(fixtureRoot, name)
  mkdirSync(directory, { recursive: true })
  const patterns = declarationMode === 'recursive' ? ['**'] : blueprint.patterns
  const packageNames = new Set(blueprint.packages.map((pkg) => pkg.name))

  for (const pkg of blueprint.packages) {
    const packageDirectory = pkg.path === '.' ? directory : join(directory, pkg.path)
    mkdirSync(packageDirectory, { recursive: true })
    const dependencies = Object.fromEntries(
      pkg.dependencies.map((dependency) => {
        if (!packageNames.has(dependency)) throw new Error(`unknown dependency: ${dependency}`)
        return [dependency, 'workspace:*']
      }),
    )
    const manifest = {
      name: pkg.name,
      version: '1.0.0',
      private: true,
      ...(pkg.dependencies.length === 0 ? {} : { dependencies }),
    }
    writeFileSync(join(packageDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  const noise =
    filesystemProfile === 'noisy'
      ? generateNoise(directory, blueprint.packages.filter((pkg) => pkg.path !== '.'))
      : { workspaceRoots: 0, directoryCount: 0, dummyFileCount: 0 }

  writeFileSync(
    join(directory, 'pnpm-workspace.yaml'),
    `packages:\n${patterns.map((pattern) => `  - '${pattern}'`).join('\n')}\n`,
  )
  writeFileSync(
    join(directory, '.npmrc'),
    [
      'auto-install-peers=false',
      'dedupe-peer-dependents=false',
      'ignore-scripts=true',
      'link-workspace-packages=true',
      '',
    ].join('\n'),
  )
  const metadata = {
    blueprintSha256: blueprint.sha256,
    declarationMode,
    filesystemProfile,
    workspaceCount: blueprint.packages.length,
    patternCount: patterns.length,
    trailingStarPatternCount: patterns.filter((pattern) => pattern.endsWith('/*')).length,
    literalPatternCount: patterns.filter(
      (pattern) => !pattern.endsWith('/*') && pattern !== '**',
    ).length,
    recursivePatternCount: patterns.filter((pattern) => pattern === '**').length,
    dependencyEdges: blueprint.packages.reduce((total, pkg) => total + pkg.dependencies.length, 0),
    noise,
    workspaceFileSha256: fileDigest(join(directory, 'pnpm-workspace.yaml')),
  }
  writeFileSync(join(directory, 'fixture-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  console.log(
    `${name}: ${metadata.workspaceCount} projects, ${metadata.patternCount} patterns, ` +
      `${noise.dummyFileCount} noise files`,
  )
  return { name, directory, metadata }
}

function generateNoise(directory, packages) {
  let directoryCount = 0
  let dummyFileCount = 0
  for (const pkg of packages) {
    const packageDirectory = join(directory, pkg.path)
    const sourceDirectory = join(packageDirectory, 'src')
    mkdirSync(sourceDirectory)
    directoryCount++
    for (let feature = 0; feature < 4; feature++) {
      const featureDirectory = join(sourceDirectory, `feature-${pad(feature)}`)
      mkdirSync(featureDirectory)
      directoryCount++
      for (let file = 0; file < 8; file++) {
        writeFileSync(join(featureDirectory, `module-${pad(file)}.ts`), '')
        dummyFileCount++
      }
    }

    const testDirectory = join(packageDirectory, 'test')
    const fixturesDirectory = join(testDirectory, 'fixtures')
    mkdirSync(testDirectory)
    mkdirSync(fixturesDirectory)
    directoryCount += 2
    for (let fixtureCase = 0; fixtureCase < 2; fixtureCase++) {
      const caseDirectory = join(fixturesDirectory, `case-${pad(fixtureCase)}`)
      mkdirSync(caseDirectory)
      directoryCount++
      for (let file = 0; file < 4; file++) {
        writeFileSync(join(caseDirectory, `input-${pad(file)}.json`), '{}\n')
        dummyFileCount++
      }
    }

    const examplesDirectory = join(packageDirectory, 'examples')
    const demoDirectory = join(examplesDirectory, 'demo')
    mkdirSync(examplesDirectory)
    mkdirSync(demoDirectory)
    directoryCount += 2
    for (let file = 0; file < 4; file++) {
      writeFileSync(join(demoDirectory, `example-${pad(file)}.md`), '')
      dummyFileCount++
    }
  }
  return {
    profile: 'production-monorepo-shaped-non-project-noise-v2',
    workspaceRoots: packages.length,
    directoryCount,
    dummyFileCount,
    directoriesPerWorkspace: 11,
    dummyFilesPerWorkspace: 44,
  }
}

function benchmarkFixture(fixture, binaries, runCount, outputDirectory) {
  section(`Benchmarking ${fixture.name}`)
  mkdirSync(outputDirectory, { recursive: true })
  const logsDirectory = join(outputDirectory, 'logs')
  mkdirSync(logsDirectory)
  const expectedCount = fixture.metadata.workspaceCount
  const baselinePath = resolve(root, binaries.baseline.path)
  const candidatePath = resolve(root, binaries.candidate.path)

  const baselineProjects = enumerateProjects(baselinePath, fixture.directory)
  const candidateProjects = enumerateProjects(candidatePath, fixture.directory)
  assertProjectSet('baseline', baselineProjects.paths, expectedCount)
  assertProjectSet('candidate', candidateProjects.paths, expectedCount)
  assertSameSet(baselineProjects.paths, candidateProjects.paths)
  const projectSetSha256 = digest([...baselineProjects.paths].sort().join('\n'))

  const lockfile = join(fixture.directory, 'pnpm-lock.yaml')
  if (!existsSync(lockfile)) {
    runPnpm(baselinePath, fixture.directory, [
      'install',
      '--lockfile-only',
      '--offline',
      '--reporter=silent',
    ])
  }
  const lockfileSha256 = fileDigest(lockfile)
  const runs = []
  const warmups = [
    runInstall(
      'baseline',
      baselinePath,
      0,
      join(logsDirectory, 'warmup-baseline.ndjson'),
      fixture.directory,
      expectedCount,
      lockfile,
      lockfileSha256,
      runs,
      outputDirectory,
    ),
    runInstall(
      'candidate',
      candidatePath,
      0,
      join(logsDirectory, 'warmup-candidate.ndjson'),
      fixture.directory,
      expectedCount,
      lockfile,
      lockfileSha256,
      runs,
      outputDirectory,
    ),
  ]

  const rawFile = join(outputDirectory, 'runs.jsonl')
  writeFileSync(rawFile, '')
  for (let iteration = 1; iteration <= runCount; iteration++) {
    const order =
      iteration % 2 === 1
        ? [
            ['baseline', baselinePath],
            ['candidate', candidatePath],
          ]
        : [
            ['candidate', candidatePath],
            ['baseline', baselinePath],
          ]
    for (const [variant, binary] of order) {
      const logFile = join(logsDirectory, `${pad(iteration)}-${variant}.ndjson`)
      const result = runInstall(
        variant,
        binary,
        iteration,
        logFile,
        fixture.directory,
        expectedCount,
        lockfile,
        lockfileSha256,
        runs,
        outputDirectory,
      )
      runs.push(result)
      writeFileSync(rawFile, `${JSON.stringify(result)}\n`, { flag: 'a' })
      console.log(
        `${iteration}/${runCount} ${variant}: ` +
          `scope=${format(result.scopeMs)} ms wall=${format(result.wallMs)} ms`,
      )
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model ?? null,
      logicalCpus: os.cpus().length,
    },
    fixture: relative(root, fixture.directory),
    fixtureMetadata: fixture.metadata,
    iterations: runCount,
    command: 'pnpm install --lockfile-only --frozen-lockfile --offline --reporter=ndjson',
    cachePolicy:
      'Fresh pnpm process per run with warm OS filesystem cache; no persistent project-set cache.',
    binaries,
    validation: {
      projectCount: expectedCount,
      projectSetSha256,
      baselineEnumerationMs: baselineProjects.elapsedMs,
      candidateEnumerationMs: candidateProjects.elapsedMs,
      lockfileSha256,
    },
    warmups,
    metrics: {
      scopeMs: summarize(runs, 'scopeMs'),
      wallMs: summarize(runs, 'wallMs'),
    },
  }
  writeFileSync(join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(join(outputDirectory, 'SUMMARY.md'), renderFixtureSummary(fixture.name, summary))
  return { name: fixture.name, ...summary }
}

function runInstall(
  variant,
  binary,
  iteration,
  logFile,
  fixture,
  expectedCount,
  lockfile,
  lockfileSha256,
  runs,
  outputDirectory,
) {
  const beforeLockfile = fileDigest(lockfile)
  const startedEpochMs = Date.now()
  const started = process.hrtime.bigint()
  const result = spawnSync(
    binary,
    ['install', '--lockfile-only', '--frozen-lockfile', '--offline', '--reporter=ndjson'],
    {
      cwd: fixture,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      env: benchmarkEnvironment(fixture),
    },
  )
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6
  if (result.error) throw result.error
  const combined = [result.stderr, result.stdout].filter(Boolean).join('\n')
  writeFileSync(logFile, combined)
  if (result.status !== 0) {
    throw new Error(
      `${variant} iteration ${iteration} failed with ${result.status}: ${combined.slice(-4000)}`,
    )
  }
  const events = combined
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const scope = events.find((event) => event.name === 'pnpm:scope')
  if (!scope) throw new Error(`${variant} iteration ${iteration} emitted no pnpm:scope event`)
  const selected = scope.selected ?? scope.selectedProjectsGraph?.length ?? null
  const total = scope.total ?? null
  if (selected !== expectedCount || (total !== null && total !== expectedCount)) {
    throw new Error(
      `${variant} iteration ${iteration} selected ${selected}/${total}, expected ${expectedCount}`,
    )
  }
  const afterLockfile = fileDigest(lockfile)
  if (beforeLockfile !== lockfileSha256 || afterLockfile !== lockfileSha256) {
    throw new Error(`${variant} iteration ${iteration} changed the lockfile`)
  }
  return {
    variant,
    iteration,
    order: iteration === 0 ? 'warmup' : runs.length + 1,
    scopeMs: scope.time - startedEpochMs,
    wallMs,
    selected,
    total,
    eventCount: events.length,
    logFile: relative(outputDirectory, logFile),
    lockfileSha256: afterLockfile,
  }
}

function enumerateProjects(binary, fixture) {
  const started = process.hrtime.bigint()
  const stdout = execFileSync(
    binary,
    ['--pm-on-fail=ignore', 'ls', '-r', '--depth', '-1'],
    {
      cwd: fixture,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      env: benchmarkEnvironment(fixture),
    },
  )
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  const paths = new Set()
  for (const line of stdout.split('\n')) {
    const marker = ` ${fixture}`
    const markerIndex = line.indexOf(marker)
    if (markerIndex === -1) continue
    const absolutePath = line.slice(markerIndex + 1).replace(/ \(PRIVATE\)$/, '')
    paths.add(relative(fixture, absolutePath) || '.')
  }
  return { elapsedMs, paths }
}

function benchmarkEnvironment(fixture) {
  return {
    ...process.env,
    NO_COLOR: '1',
    NPM_CONFIG_USERCONFIG: join(fixture, '.npmrc'),
  }
}

function runPnpm(binary, fixture, args) {
  const result = spawnSync(binary, args, {
    cwd: fixture,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: 'inherit',
    env: benchmarkEnvironment(fixture),
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${binary} exited with ${result.status}`)
}

function assertProjectSet(label, paths, expected) {
  if (paths.size !== expected) throw new Error(`${label} found ${paths.size}, expected ${expected}`)
}

function assertSameSet(left, right) {
  const missing = [...left].filter((value) => !right.has(value))
  const unexpected = [...right].filter((value) => !left.has(value))
  if (missing.length || unexpected.length) {
    throw new Error(
      `project sets differ: missing=${JSON.stringify(missing.slice(0, 20))} ` +
        `unexpected=${JSON.stringify(unexpected.slice(0, 20))}`,
    )
  }
}

function summarize(records, field) {
  const result = {}
  for (const variant of ['baseline', 'candidate']) {
    const values = records.filter((run) => run.variant === variant).map((run) => run[field])
    const sorted = [...values].sort((left, right) => left - right)
    const mean = values.reduce((total, value) => total + value, 0) / values.length
    result[variant] = {
      chronological: values,
      median: median(sorted),
      mean,
      standardDeviation: Math.sqrt(
        values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length,
      ),
      min: sorted[0],
      max: sorted.at(-1),
    }
  }
  result.deltaPercent =
    ((result.candidate.median - result.baseline.median) / result.baseline.median) * 100
  return result
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function renderFixtureSummary(name, summary) {
  const scope = summary.metrics.scopeMs
  const wall = summary.metrics.wallMs
  return `# ${name} workspace-discovery benchmark

- Commit: \`${summary.binaries.baseline.commit}\`
- Fixture: ${summary.validation.projectCount.toLocaleString()} projects, ${summary.fixtureMetadata.patternCount} patterns, ${summary.fixtureMetadata.dependencyEdges.toLocaleString()} internal edges
- Runs: ${summary.iterations} per binary, alternating order after one warm-up each
- Command: \`${summary.command}\`
- Project-set SHA-256: \`${summary.validation.projectSetSha256}\`
- Lockfile SHA-256: \`${summary.validation.lockfileSha256}\`

| Metric | Frozen main | Candidate | Median delta |
| --- | ---: | ---: | ---: |
| Process start to \`pnpm:scope\` | ${format(scope.baseline.median)} ms | ${format(scope.candidate.median)} ms | ${format(scope.deltaPercent)}% |
| Process wall time | ${format(wall.baseline.median)} ms | ${format(wall.candidate.median)} ms | ${format(wall.deltaPercent)}% |
`
}

function renderOverview(summaries) {
  const rows = summaries
    .map((summary) => {
      const scope = summary.metrics.scopeMs
      const wall = summary.metrics.wallMs
      return `| ${summary.name} | ${summary.fixtureMetadata.patternCount} | ${format(scope.baseline.median)} ms | ${format(scope.candidate.median)} ms | ${format(scope.deltaPercent)}% | ${format(wall.baseline.median)} ms | ${format(wall.candidate.median)} ms | ${format(wall.deltaPercent)}% |`
    })
    .join('\n')
  return `# Reproduced workspace-discovery results

| Fixture | Patterns | Frozen main scope | Candidate scope | Scope delta | Frozen main wall | Candidate wall | Wall delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}
`
}

function run(command, args, cwd, env = process.env) {
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

function git(args) {
  return execFileSync('git', ['-C', sourceRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

function section(title) {
  console.log(`\n==> ${title}`)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: ${actual} != ${expected}`)
}

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function fileDigest(file) {
  return digest(readFileSync(file))
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function format(value) {
  return Number(value).toFixed(2)
}

function pad(value) {
  return String(value).padStart(2, '0')
}
