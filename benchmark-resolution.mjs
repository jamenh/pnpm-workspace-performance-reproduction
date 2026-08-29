#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const options = parseArguments(process.argv.slice(2))
const engines = [
  { name: 'yarn', command: options.yarn, kind: 'yarn' },
  { name: 'pnpm-baseline', command: options.baseline, kind: 'pnpm' },
  { name: 'pnpm-candidate', command: options.candidate, kind: 'pnpm' },
]
const manifestPath = join(root, 'package.json')
const pnpmLockfilePath = join(root, 'pnpm-lock.yaml')
const yarnLockfilePath = join(root, 'yarn.lock')

main()

function main() {
  assertFixture()
  for (const engine of engines) assertCommand(engine.command)
  const fixture = JSON.parse(readFileSync(join(root, 'fixture-metadata.json'), 'utf8'))
  assertYarnWorkspaceCount(fixture.workspaceCount)

  const originalManifest = readFileSync(manifestPath)
  const mutatedManifest = mutateManifest(originalManifest)
  let originalPnpmLockfile
  let originalYarnLockfile

  try {
    writeFileSync(manifestPath, originalManifest)
    run(engines[1], false, 'create pnpm lockfile')
    run(engines[0], false, 'create yarn lockfile')
    originalPnpmLockfile = readFileSync(pnpmLockfilePath)
    originalYarnLockfile = readFileSync(yarnLockfilePath)

    const results = []
    const lockfileHashes = new Map()
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      for (const engine of rotatedEngines(iteration)) {
        const lockfilePath = engine.kind === 'pnpm' ? pnpmLockfilePath : yarnLockfilePath
        const lockfile = engine.kind === 'pnpm' ? originalPnpmLockfile : originalYarnLockfile

        writeFileSync(manifestPath, originalManifest)
        writeFileSync(lockfilePath, lockfile)
        run(engine, false, `${engine.name} warm-up`)

        writeFileSync(manifestPath, mutatedManifest)
        writeFileSync(lockfilePath, lockfile)
        const result = run(engine, true, `${engine.name} ${iteration + 1}/${options.iterations}`)
        const changedHash = digest(readFileSync(lockfilePath))
        if (changedHash === digest(lockfile)) {
          throw new Error(`${engine.name} timed run did not update its lockfile`)
        }
        const previousHash = lockfileHashes.get(engine.name)
        if (previousHash && previousHash !== changedHash) {
          throw new Error(`${engine.name} produced a non-deterministic lockfile`)
        }
        lockfileHashes.set(engine.name, changedHash)
        results.push({ engine: engine.name, iteration: iteration + 1, ...result })
        console.log(
          `${engine.name.padEnd(15)} resolution=${format(result.resolutionMs)} ms  ` +
            `wall=${format(result.wallMs)} ms`,
        )
      }
    }

    const baselineHash = lockfileHashes.get('pnpm-baseline')
    const candidateHash = lockfileHashes.get('pnpm-candidate')
    if (baselineHash !== candidateHash) {
      throw new Error('pnpm baseline and candidate lockfiles are not byte-identical')
    }
    renderSummary(results)
  } finally {
    writeFileSync(manifestPath, originalManifest)
    if (originalPnpmLockfile) writeFileSync(pnpmLockfilePath, originalPnpmLockfile)
    if (originalYarnLockfile) writeFileSync(yarnLockfilePath, originalYarnLockfile)
  }
}

function parseArguments(args) {
  const values = {
    iterations: 5,
    baseline: join(root, '.bin', executableName('pnpm-baseline')),
    candidate: join(root, '.bin', executableName('pnpm-candidate')),
    yarn: 'yarn',
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--iterations') values.iterations = Number(args[++index])
    else if (argument === '--pnpm-baseline') values.baseline = absoluteCommand(args[++index])
    else if (argument === '--pnpm-candidate') values.candidate = absoluteCommand(args[++index])
    else if (argument === '--yarn') values.yarn = absoluteCommand(args[++index])
    else if (argument === '--help' || argument === '-h') {
      console.log(
        'usage: node benchmark-resolution.mjs [--iterations N] ' +
          '[--pnpm-baseline PATH] [--pnpm-candidate PATH] [--yarn PATH]',
      )
      process.exit(0)
    } else throw new Error(`unknown argument: ${argument}`)
  }
  if (!Number.isSafeInteger(values.iterations) || values.iterations < 1) {
    throw new Error('--iterations must be a positive integer')
  }
  return values
}

function absoluteCommand(command) {
  if (!command) throw new Error('missing command path')
  return command.includes('/') ? resolve(command) : command
}

function assertFixture() {
  if (!existsSync(join(root, '.resolver-cache-benchmark-fixture'))) {
    throw new Error('run node generate-workspace.mjs first')
  }
}

function assertCommand(command) {
  if ((isAbsolute(command) || command.includes('/')) && !existsSync(command)) {
    throw new Error(`command not found: ${command}`)
  }
}

function mutateManifest(original) {
  const manifest = JSON.parse(original)
  const dependency = Object.keys(manifest.dependencies ?? {}).sort()[0]
  if (!dependency || manifest.dependencies[dependency] !== 'workspace:*') {
    throw new Error('root fixture must have at least one workspace:* dependency')
  }
  manifest.dependencies[dependency] = 'workspace:^'
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
}

function rotatedEngines(iteration) {
  const offset = iteration % engines.length
  return [...engines.slice(offset), ...engines.slice(0, offset)]
}

function run(engine, timed, label) {
  const args =
    engine.kind === 'pnpm'
      ? [
          'install',
          '--lockfile-only',
          '--trust-lockfile',
          '--offline',
          '--ignore-scripts',
          timed ? '--reporter=ndjson' : '--reporter=silent',
        ]
      : ['install', '--mode', 'update-lockfile', '--json']
  const started = process.hrtime.bigint()
  const child = spawnSync(engine.command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: benchmarkEnvironment(),
  })
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6
  if (child.error) throw child.error
  const output = [child.stdout, child.stderr].filter(Boolean).join('\n')
  if (child.status !== 0) {
    throw new Error(`${label} failed with ${child.status}:\n${output.slice(-8000)}`)
  }
  if (!timed) return { wallMs }
  const parsed =
    engine.kind === 'pnpm' ? parsePnpmResolution(output) : { resolutionMs: parseYarnResolution(output) }
  return { ...parsed, wallMs }
}

function assertYarnWorkspaceCount(expected) {
  const child = spawnSync(options.yarn, ['workspaces', 'list', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: benchmarkEnvironment(),
  })
  if (child.error) throw child.error
  if (child.status !== 0) {
    throw new Error(`Yarn workspace enumeration failed:\n${child.stderr || child.stdout}`)
  }
  const actual = parseJsonLines(child.stdout).length
  if (actual !== expected) throw new Error(`Yarn found ${actual} workspaces; expected ${expected}`)
}

function benchmarkEnvironment() {
  const environment = {
    ...process.env,
    NO_COLOR: '1',
    NPM_CONFIG_USERCONFIG: join(root, '.npmrc'),
    YARN_ENABLE_COLORS: '0',
    YARN_ENABLE_NETWORK: '0',
    YARN_ENABLE_TELEMETRY: '0',
    YARN_ENABLE_TIMERS: '1',
  }
  // Yarn treats npm's no-proxy environment aliases as unsupported Yarn settings. Network access
  // is disabled for this all-workspace fixture, so omit them from both package managers' runs.
  for (const key of [
    'NO_PROXY',
    'no_proxy',
    'NPM_CONFIG_NOPROXY',
    'npm_config_noproxy',
    'NPM_CONFIG_NO_PROXY',
    'npm_config_no_proxy',
    'YARN_NO_PROXY',
  ]) {
    delete environment[key]
  }
  return environment
}

function parsePnpmResolution(output) {
  const events = parseJsonLines(output)
  const started = events.find(
    (event) => event.name === 'pnpm:stage' && event.stage === 'resolution_started',
  )
  const done = events.find(
    (event) => event.name === 'pnpm:stage' && event.stage === 'resolution_done',
  )
  if (!started || !done) throw new Error('pnpm emitted no complete resolution phase')
  const scope = events.find((event) => event.name === 'pnpm:scope')
  const expected = JSON.parse(readFileSync(join(root, 'fixture-metadata.json'), 'utf8')).workspaceCount
  if (scope?.selected !== expected || scope?.total !== expected) {
    throw new Error(`pnpm selected ${scope?.selected}/${scope?.total}; expected ${expected}`)
  }
  return { resolutionMs: done.time - started.time, selected: scope.selected, total: scope.total }
}

function parseYarnResolution(output) {
  let inResolution = false
  for (const event of parseJsonLines(output)) {
    const data = String(event.data ?? '')
    if (data.includes('Resolution step')) {
      inResolution = true
      continue
    }
    if (!inResolution || !data.includes('Completed')) continue
    const match = data.match(/Completed in (?:(\d+)s )?(\d+)ms/)
    if (match) return Number(match[1] ?? 0) * 1000 + Number(match[2])
  }
  throw new Error(`Yarn emitted no timed Resolution step:\n${output.slice(-8000)}`)
}

function parseJsonLines(output) {
  return output.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

function renderSummary(results) {
  const summaries = Object.fromEntries(
    engines.map((engine) => {
      const rows = results.filter((result) => result.engine === engine.name)
      return [
        engine.name,
        {
          resolutionMs: median(rows.map((row) => row.resolutionMs)),
          wallMs: median(rows.map((row) => row.wallMs)),
        },
      ]
    }),
  )
  const baseline = summaries['pnpm-baseline']
  console.log('\nMedian of warm, non-noop runs')
  console.log('| Engine | Resolution | vs pnpm baseline | Wall | vs pnpm baseline |')
  console.log('| --- | ---: | ---: | ---: | ---: |')
  for (const engine of engines) {
    const value = summaries[engine.name]
    console.log(
      `| ${engine.name} | ${format(value.resolutionMs)} ms | ` +
        `${percent(value.resolutionMs, baseline.resolutionMs)} | ${format(value.wallMs)} ms | ` +
        `${percent(value.wallMs, baseline.wallMs)} |`,
    )
  }
  console.log('\nRaw runs (resolution ms / wall ms)')
  for (const engine of engines) {
    const rows = results.filter((result) => result.engine === engine.name)
    console.log(
      `${engine.name.padEnd(15)} ${rows
        .map((row) => `${format(row.resolutionMs)} / ${format(row.wallMs)}`)
        .join(', ')}`,
    )
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function percent(value, baseline) {
  const delta = ((value - baseline) / baseline) * 100
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function format(value) {
  return value.toFixed(2)
}

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name
}
