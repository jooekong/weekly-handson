import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, statfs, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const source = dirname(fileURLToPath(import.meta.url))
const runtime = resolve(process.env.W1_RUNTIME ?? join(homedir(), 'code/dsh-w1'))
const dshHome = resolve(process.env.W1_DSH_HOME ?? join(homedir(), 'code/dsh-w1-home'))
const workspace = resolve(process.env.W1_WORKSPACE ?? join(homedir(), 'code/dsh-w1-workspace'))
const target = join(runtime, 'w1-order')
const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const cases = JSON.parse(await readFile(join(source, 'cases.json'), 'utf8'))
const [mode = 'local', caseId] = process.argv.slice(2)
assert.ok(['local', 'config', 'probe', 'case', 'all'].includes(mode), 'Use: run.mjs local|config|probe|case <id>|all')
if (mode === 'case') assert.ok(cases.some(item => item.id === caseId), 'Unknown case ID')
const packageInfo = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
assert.equal(packageInfo.version, '0.2.1-rc.5', 'Unexpected DSH version')
if (mode !== 'local') {
  const [major, minor] = process.versions.node.split('.').map(Number)
  assert.ok(major > 24 || (major === 24 && minor >= 9), 'Use Node >=24.9 for the Harness runtime')
}
await mkdir(target, { recursive: true })
await mkdir(workspace, { recursive: true })
await mkdir(dshHome, { recursive: true })
for (const file of ['order-plugin.ts', 'w1.patch.yml', 'orders.json', 'cases.json', 'verify.mjs']) {
  await cp(join(source, file), join(target, file))
}
const runDirectory = join(source, 'logs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}`)
await mkdir(runDirectory, { recursive: true })
await cp(join(source, 'cases.json'), join(runDirectory, 'cases.json'))
await cp(join(source, 'order-plugin.ts'), join(runDirectory, 'order-plugin.ts'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const parseLines = text => text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : []
const environment = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: '1',
  DSH_TELEMETRY_MODE: 'DISABLED',
  W1_FIXTURE_PATH: join(target, 'orders.json'),
}
// Ignore unrelated permission/tool-mode overrides inherited from the parent shell.
delete environment.DSH_PERMISSION_MODE
delete environment.DSH_TOOLS_MODE

async function invoke(label, args, env = environment, monitor = false) {
  const disk = await statfs(runtime)
  assert.ok(disk.bavail * disk.bsize >= 5 * 1024 ** 3, 'Stop: runtime disk has less than 5 GiB free')
  const child = spawn(process.execPath, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let pending = ''
  let callCount = 0
  let stopReason = null
  let killTimer
  function stop(reason) {
    if (stopReason) return
    stopReason = reason
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
  }
  const interrupt = () => stop('PARENT_SIGINT')
  const terminate = () => stop('PARENT_SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  // This one-process harness is bounded to 3 minutes and 3 observed calls.
  const timer = setTimeout(() => stop('TIME_LIMIT_180S'), 180000)
  child.stdout.on('data', chunk => {
    const text = chunk.toString()
    stdout += text
    if (!monitor) return
    pending += text
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const line of lines) {
      let event
      try {
        event = JSON.parse(line)
      } catch (error) {
        stop(`INVALID_JSON_STREAM:${error.message}`)
        break
      }
      if (event.type === 'tool_call') {
        callCount += 1
        if (event.tool !== 'get_order') stop(`UNEXPECTED_TOOL:${event.tool}`)
        if (callCount > 3) stop('TOOL_CALL_LIMIT')
      }
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const result = await new Promise((resolveExit, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolveExit({ code, signal }))
  })
  clearTimeout(timer)
  clearTimeout(killTimer)
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', terminate)
  await writeFile(join(runDirectory, `${label}.stdout.log`), stdout)
  await writeFile(join(runDirectory, `${label}.stderr.log`), stderr)
  await writeFile(join(runDirectory, `${label}.run.json`), JSON.stringify({
    command: [process.execPath, ...args], cwd: workspace,
    node: process.version, dsh: packageInfo.version,
    dshHome, ...result, stopReason,
    pluginSha256: hash(await readFile(join(target, 'order-plugin.ts'))),
    fixtureSha256: hash(await readFile(env.W1_FIXTURE_PATH)),
  }, null, 2) + '\n')
  return { ...result, stdout, stderr, stopReason }
}

async function sessionEvents(sessionId, label) {
  const entries = await readdir(join(dshHome, 'sessions'), { recursive: true, withFileTypes: true })
  const matches = []
  // The isolated experiment has only a few sessions; index paths if this grows.
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl.zstd')) continue
    const file = join(entry.parentPath, entry.name)
    const raw = await readFile(file)
    const decoded = zstdDecompressSync(raw).toString('utf8')
    const events = parseLines(decoded)
    if (events[0]?.id === sessionId) matches.push({ file, raw, decoded, events })
  }
  assert.equal(matches.length, 1, 'Expected one durable log for this session')
  const match = matches[0]
  await writeFile(join(runDirectory, `${label}.session.jsonl.zstd`), match.raw)
  await writeFile(join(runDirectory, `${label}.session.jsonl`), match.decoded)
  return match.events
}

function checkEvidence(testCase, result, events, fixtureBytes) {
  assert.equal(result.code, 0, 'Harness process failed; see stderr and durable turn/end')
  assert.equal(result.stopReason, null)
  const headers = events.filter(event => event.type === 'request/header')
  assert.ok(headers.length > 0)
  for (const header of headers) assert.deepEqual(header.data.header.tools.map(tool => tool.name), ['get_order'])
  const calls = events.filter(event => event.type === 'tool/call')
  assert.equal(calls.length, 1, 'Acceptance requires exactly one tool call')
  const call = calls[0].data
  assert.equal(call.name, 'get_order')
  assert.deepEqual(typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments, { orderId: testCase.orderId })
  const results = events.filter(event => event.type === 'tool/result')
  assert.equal(results.length, 1)
  const message = results[0].data.message
  assert.equal(message.toolCallId, call.callId)
  assert.equal(message.isError === true, testCase.expected.isError)
  const audits = result.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).filter(item => item.event === 'order_audit')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].callId, call.callId)
  assert.equal(audits[0].dataVersion, hash(fixtureBytes).slice(0, 12))
  assert.equal(audits[0].status, testCase.expected.isError ? 'error' : 'success')
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (testCase.expected.isError) {
    assert.ok(text.includes(testCase.expected.errorIncludes))
  } else {
    const value = JSON.parse(text)
    assert.equal(value.found, testCase.expected.found)
    assert.deepEqual(value.order, testCase.expected.order)
    assert.equal(value.dataVersion, hash(fixtureBytes).slice(0, 12))
  }
  const final = parseLines(result.stdout).findLast(event => event.type === 'final')
  assert.ok(final?.text.trim(), 'Missing final answer')
  return { status: 'tool-evidence-passed', answerReview: 'pending-human-review', answer: final.text, callId: call.callId }
}

if (mode === 'local') {
  const result = await invoke('local', [join(target, 'verify.mjs')])
  process.stdout.write(result.stdout)
  assert.equal(result.code, 0, 'Local verification failed; see logs')
} else if (mode === 'config') {
  const result = await invoke('config', [cli, '--profile', 'headless', '--patch', join(target, 'w1.patch.yml'), '--dump-config'])
  assert.equal(result.code, 0, 'Configuration composition failed')
  console.log('PASS config composition; --dump-config does not execute the plugin or call a model.')
} else if (mode === 'probe') {
  // An exported empty value shadows every .env fallback; this probe never uses a key.
  const result = await invoke('probe', [cli, '--profile', 'headless', '--patch', join(target, 'w1.patch.yml'), '--json', '请调用 get_order 查询 O1001。'], { ...environment, DEEPSEEK_API_KEY: '' }, true)
  const stream = parseLines(result.stdout)
  const session = stream.find(event => event.type === 'session')
  if (session) await sessionEvents(session.sessionId, 'probe')
  console.log(`Keyless runtime probe exit=${result.code}; inspect logs for the exact failure. No model E2E claim.`)
  process.exitCode = result.code ?? 1
} else {
  const selected = mode === 'all' ? cases : cases.filter(item => item.id === caseId)
  for (const testCase of selected) {
    const fixtureBytes = await readFile(join(source, 'orders.json'))
    let activeBytes = fixtureBytes
    if (mode === 'all' && testCase.fixtureChange) {
      const changed = JSON.parse(fixtureBytes)
      changed[testCase.fixtureChange.orderId].status = testCase.fixtureChange.status
      activeBytes = Buffer.from(JSON.stringify(changed, null, 2) + '\n')
    }
    const fixturePath = join(runDirectory, `${testCase.id}.fixture.json`)
    await writeFile(fixturePath, activeBytes)
    const pluginBefore = hash(await readFile(join(target, 'order-plugin.ts')))
    const result = await invoke(testCase.id, [cli, '--profile', 'headless', '--patch', join(target, 'w1.patch.yml'), '--json', testCase.prompt], { ...environment, W1_FIXTURE_PATH: fixturePath }, true)
    const stream = parseLines(result.stdout)
    const session = stream.find(event => event.type === 'session')
    assert.ok(session, 'No session created; see stderr')
    const events = await sessionEvents(session.sessionId, testCase.id)
    assert.equal(hash(await readFile(join(target, 'order-plugin.ts'))), pluginBefore)
    const summary = checkEvidence(testCase, result, events, activeBytes)
    await writeFile(join(runDirectory, `${testCase.id}.review.json`), JSON.stringify(summary, null, 2) + '\n')
    console.log(`${testCase.id}: tool evidence passed; final answer needs semantic review.`)
  }
}
console.log(`Evidence: ${runDirectory}`)
