// W3 acceptance runner: self-hosted E2B (Firecracker on ubuntu-e2b), client on Mac over Tailscale.
// Usage: node run.mjs [csv|cmd-timeout|sbx-timeout|network|destroy|all]
// Every case writes raw observations to logs/<ts>/<case>.json; pass/fail is computed only
// against expected.json (frozen, hand-computed) — never against the implementation's own output.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST, ssh } from './env.mjs'
import { Sandbox } from 'e2b'

const here = dirname(fileURLToPath(import.meta.url))
const expected = JSON.parse(await readFile(join(here, 'expected.json'), 'utf8'))
const TEMPLATE = 'base'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const now = () => new Date().toISOString()
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '')

const which = process.argv[2] ?? 'all'
const runDir = join(here, 'logs', `${now().replace(/[:.]/g, '-')}-${which}`)
await mkdir(runDir, { recursive: true })

// ---- host-side observation helpers (executor side, read-only) ----
const hostFirecracker = () => ssh('pgrep -a firecracker || true').trim().split('\n').filter(Boolean)
const hostHas = (lines, id) => lines.some(l => l.includes(`fc-${id}-`))
const apiIds = async () => (await Sandbox.list().nextItems()).map(s => s.sandboxId)
const orchestratorLog = id => stripAnsi(ssh(
  `docker logs --since 15m e2b-orchestrator-1 2>&1 | grep '${id}' | grep -E 'SandboxService/(Create|Delete)|marking sandbox as stopping|lifecycle stopped|network map entry removed|timeout' || true`,
)).split('\n').filter(Boolean).map(l => l.slice(0, 220))
async function snapshot(id) {
  const fc = hostFirecracker()
  const ids = await apiIds()
  return { at: now(), apiListed: ids.includes(id), hostFirecracker: hostHas(fc, id), hostFirecrackerCount: fc.length }
}

// run a shell command inside the sandbox, never throw on non-zero exit (we record it)
async function sh(sbx, cmd, opts = {}) {
  const started = Date.now()
  try {
    const r = await sbx.commands.run(cmd, opts)
    return { cmd, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started }
  } catch (e) {
    return { cmd, error: e.constructor.name, message: String(e.message).slice(0, 300), exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr, ms: Date.now() - started }
  }
}

async function psLoop(sbx, name) {
  const r = await sh(sbx, `ps -eo pid,pcpu,etimes,args | grep '[p]ython3 /home/user/${name}' || true; cat /proc/loadavg`)
  return { ...r, running: r.stdout.includes(`python3 /home/user/${name}`) }
}

async function withSandbox(opts, fn) {
  const sbx = await Sandbox.create(TEMPLATE, opts)
  try { return await fn(sbx) } finally { await sbx.kill() }
}

// ---- cases ----
const cases = {
  async csv() {
    const csv = await readFile(join(here, 'data/orders.csv'), 'utf8')
    const py = await readFile(join(here, 'scripts/aggregate.py'), 'utf8')
    const awk = execFileSync('awk', ['-F,', 'NR>1{c[$2]++; s[$2]+=$3; n++; t+=$3} END{for(k in c) print k, c[k], s[k]; print "total", n, t}', join(here, 'data/orders.csv')], { encoding: 'utf8' })
    return withSandbox({ timeoutMs: 120_000 }, async sbx => {
      const env = await sh(sbx, 'uname -r; nproc; free -m | sed -n 2p; id; python3 --version; df -h / | tail -1')
      await sbx.files.write('/home/user/orders.csv', csv)
      await sbx.files.write('/home/user/aggregate.py', py)
      const run = await sh(sbx, 'python3 /home/user/aggregate.py /home/user/orders.csv /home/user/out.json')
      const out = JSON.parse(await sbx.files.read('/home/user/out.json'))
      const pass = run.exitCode === 0 && isDeepStrictEqual(out, expected.aggregate)
      return { pass, sandboxId: sbx.sandboxId, env, run, out, expected: expected.aggregate, awkCrossCheck: awk.trim().split('\n').sort() }
    })
  },

  // Command-level timeout: envd inside the VM should kill the process, not just the client giving up.
  async 'cmd-timeout'() {
    const loop = await readFile(join(here, 'scripts/loop.py'), 'utf8')
    return withSandbox({ timeoutMs: 120_000 }, async sbx => {
      await sbx.files.write('/home/user/loop_cmd.py', loop)
      const timedP = sh(sbx, 'python3 /home/user/loop_cmd.py', { timeoutMs: expected.timeouts.commandTimeoutMs })
      await sleep(2000)
      const during = await psLoop(sbx, 'loop_cmd.py') // positive control: the loop really runs
      const timed = await timedP
      await sleep(2000)
      const after = await psLoop(sbx, 'loop_cmd.py')
      const pass = during.running && timed.error === 'TimeoutError' && !after.running
      return { pass, sandboxId: sbx.sandboxId, during, timed, after }
    })
  },

  // Sandbox-level timeout: orchestrator (host side) must tear down the whole VM even with a busy loop inside.
  async 'sbx-timeout'() {
    const { sandboxTimeoutMs, sandboxGoneWithinMs } = expected.timeouts
    const loop = await readFile(join(here, 'scripts/loop.py'), 'utf8')
    const sbx = await Sandbox.create(TEMPLATE, { timeoutMs: sandboxTimeoutMs, lifecycle: { onTimeout: 'kill' } })
    const id = sbx.sandboxId
    const createdAt = Date.now()
    await sbx.files.write('/home/user/loop_bg.py', loop)
    await sbx.commands.run('python3 /home/user/loop_bg.py', { background: true })
    const inside = await psLoop(sbx, 'loop_bg.py')
    const timeline = [{ t: 0, ...(await snapshot(id)) }]
    // deliberately no kill(): wait for the executor to enforce the timeout
    while (Date.now() - createdAt < sandboxGoneWithinMs + 30_000) {
      await sleep(5000)
      const s = { t: Date.now() - createdAt, ...(await snapshot(id)) }
      timeline.push(s)
      if (!s.apiListed && !s.hostFirecracker) break
    }
    const gone = timeline.at(-1)
    let reconnect
    try { await Sandbox.connect(id); reconnect = 'CONNECTED' } catch (e) { reconnect = `${e.constructor.name}: ${String(e.message).slice(0, 200)}` }
    const pass = inside.running && timeline[0].hostFirecracker
      && !gone.apiListed && !gone.hostFirecracker && gone.t <= sandboxGoneWithinMs && reconnect !== 'CONNECTED'
    return { pass, sandboxId: id, inside, timeline, goneAtMs: gone.t, reconnect, orchestratorLog: orchestratorLog(id) }
  },

  async network() {
    const { allowedTarget: A, deniedTarget: B } = expected.network
    const probe = async (sbx, ip) => {
      const r = await sh(sbx, `curl -s -m 5 -o /dev/null -w '%{http_code}' http://${ip}/; echo " curl_exit=$?"`)
      const code = r.stdout.trim().split(' ')[0]
      return { ip, raw: r.stdout.trim(), result: code !== '000' ? 'reachable' : 'blocked' }
    }
    const run = (label, opts, extra) => withSandbox({ timeoutMs: 120_000, ...opts }, async sbx => {
      const probes = [await probe(sbx, A), await probe(sbx, B)]
      const info = (await Sandbox.getInfo(sbx.sandboxId)).network
      const observed = Object.fromEntries(probes.map(p => [p.ip, p.result]))
      return { label, sandboxId: sbx.sandboxId, networkOpts: opts.network ?? null, apiNetworkInfo: info, probes, observed,
        pass: isDeepStrictEqual(observed, expected.network[label]), ...(extra ? await extra(sbx) : {}) }
    })

    // Extra observations (not acceptance): private ranges and in-guest file permissions.
    const baselineExtra = async sbx => {
      const privateProbes = [
        await sh(sbx, `curl -s -m 5 -o /dev/null -w '%{http_code}' http://192.168.1.201:3000/health; echo " curl_exit=$?"`),
        await sh(sbx, `curl -s -m 5 -o /dev/null -w '%{http_code}' http://${HOST}:3000/health; echo " curl_exit=$?"`),
      ]
      await sh(sbx, 'mkdir -p /home/user/forbidden && echo synthetic-secret > /home/user/forbidden/f && chown -R root:root /home/user/forbidden && chmod 700 /home/user/forbidden && echo ok > /home/user/allowed.txt', { user: 'root' })
      const filePerm = {
        allowedRead: await sh(sbx, 'cat /home/user/allowed.txt; echo " exit=$?"'),
        forbiddenRead: await sh(sbx, 'cat /home/user/forbidden/f 2>&1; echo " exit=$?"'),
        forbiddenViaSudo: await sh(sbx, 'sudo -n cat /home/user/forbidden/f 2>&1; echo " exit=$?"'),
      }
      return { privateProbes, filePerm }
    }
    // Resolve the slot actually used by this sandbox: firecracker pid -> netns ns-N -> host veth e2b-N.
    const hostRules = id => stripAnsi(ssh([
      `pid=$(pgrep -f '[f]c-${id}-'); ns=$(sudo ip netns identify $pid); n=\${ns#ns-}; echo "firecracker_pid=$pid netns=$ns host_veth=e2b-$n"`,
      `sudo iptables -t nat -S PREROUTING | grep -- "-i e2b-$n "`,
      'for set in filtered_always_denylist filtered_denylist filtered_allowlist; do sudo ip netns exec $ns nft list set inet slot-firewall $set; done',
      'sudo ip netns exec $ns nft list chain inet slot-firewall PREROUTE_FILTER',
    ].join('; ')))

    const baseline = await run('baseline', {}, baselineExtra)
    const policy = await run('policy', { network: { denyOut: ['0.0.0.0/0'], allowOut: [A] } }, async sbx => ({ hostRules: hostRules(sbx.sandboxId) }))
    // user-chosen change: tighten by removing the only allowed entry, then retest
    const tightened = await run('tightened', { network: { denyOut: ['0.0.0.0/0'], allowOut: [] } })
    return { pass: baseline.pass && policy.pass && tightened.pass, baseline, policy, tightened }
  },

  async destroy() {
    const loop = await readFile(join(here, 'scripts/loop.py'), 'utf8')
    const sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 120_000 })
    const id = sbx.sandboxId
    await sbx.files.write('/home/user/loop_bg.py', loop)
    await sbx.commands.run('python3 /home/user/loop_bg.py', { background: true })
    const inside = await psLoop(sbx, 'loop_bg.py')
    const before = await snapshot(id)
    const killed = await sbx.kill()
    const right = await snapshot(id)
    await sleep(5000)
    const later = await snapshot(id)
    let reconnect
    try { await Sandbox.connect(id); reconnect = 'CONNECTED' } catch (e) { reconnect = `${e.constructor.name}: ${String(e.message).slice(0, 200)}` }
    const pass = inside.running && before.apiListed && before.hostFirecracker
      && !later.apiListed && !later.hostFirecracker && reconnect !== 'CONNECTED'
    return { pass, sandboxId: id, inside, before, killed, right, later, reconnect, orchestratorLog: orchestratorLog(id) }
  },
}

// ---- main ----
const selected = which === 'all' ? Object.keys(cases) : [which]
if (!selected.every(n => n in cases)) throw new Error(`Use: node run.mjs [${Object.keys(cases).join('|')}|all]`)

const meta = {
  startedAt: now(), host: HOST, template: TEMPLATE, node: process.version,
  sdk: JSON.parse(await readFile(join(here, 'node_modules/e2b/package.json'), 'utf8')).version,
  server: stripAnsi(ssh("cat /opt/e2b/SOURCE_COMMIT; docker inspect e2b-orchestrator-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(E2B_ORCHESTRATOR_VERSION|DEFAULT_FIRECRACKER_VERSION|DEFAULT_KERNEL_VERSION|MAX_SANDBOXES_PER_NODE)='; uname -r")).trim().split('\n'),
}
await writeFile(join(runDir, 'run.json'), JSON.stringify(meta, null, 2))

const summary = {}
for (const name of selected) {
  const started = Date.now()
  let result
  try { result = await cases[name]() } catch (e) { result = { pass: false, crash: `${e.constructor.name}: ${e.message}` } }
  result.durationMs = Date.now() - started
  await writeFile(join(runDir, `${name}.json`), JSON.stringify(result, null, 2))
  summary[name] = result.pass ? 'PASS' : 'FAIL'
  console.log(`${summary[name]}  ${name}  (${result.durationMs} ms)`)
}
// Leak check after all cases: no sandbox left in the API, no firecracker process on the host.
summary.leftover = { apiSandboxes: await apiIds(), hostFirecracker: hostFirecracker() }
await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary.leftover), '\nlogs:', runDir)
