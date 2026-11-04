import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, Config } from './order-plugin.ts'

const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'))
const directory = await mkdtemp(join(tmpdir(), 'w1-order-'))
const fixturePath = join(directory, 'orders.json')
const bytes = await readFile(new URL('./orders.json', import.meta.url))
await writeFile(fixturePath, bytes)
let tool
const ctx = { tools: { register(value) { tool = value } } }
const call = orderId => tool.execute({ orderId }, { callId: `local-${orderId}` })
const hash = data => createHash('sha256').update(data).digest('hex').slice(0, 12)

try {
  apply(ctx, Config({ fixturePath, testMode: true }))
  assert.equal(tool.name, 'get_order')
  for (const testCase of cases.slice(0, 3)) {
    if (testCase.expected.isError) {
      await assert.rejects(call(testCase.orderId), /SIMULATED_TIMEOUT.*callId=local-OERR/)
    } else {
      const value = await call(testCase.orderId)
      assert.deepEqual(value, {
        found: testCase.expected.found,
        ...(testCase.expected.order ? { order: testCase.expected.order } : {}),
        dataVersion: hash(bytes),
      })
      assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, ''), [])
      assert.equal(tool.output.render({ orderId: testCase.orderId }, value)[0].text, JSON.stringify(value))
    }
    console.log(`PASS ${testCase.id} (direct tool execution only)`)
  }

  const changed = JSON.parse(bytes)
  changed.O1001.status = 'refunded'
  const changedBytes = JSON.stringify(changed)
  await writeFile(fixturePath, changedBytes)
  const value = await call('O1001')
  assert.deepEqual(value.order, cases[3].expected.order)
  assert.equal(value.dataVersion, hash(changedBytes))
  assert.notEqual(value.dataVersion, hash(bytes))
  console.log('PASS 04-refunded (same tool instance rereads changed fixture)')

  apply(ctx, Config({ fixturePath, testMode: false }))
  assert.equal((await call('OERR')).found, false)
  await assert.rejects(tool.execute({ orderId: 1001 }, {}), /orderId/)
  await writeFile(fixturePath, '{broken')
  await assert.rejects(call('O1001'), SyntaxError)
  await writeFile(fixturePath, JSON.stringify({ O1001: { status: 'paid', amount_cent: -1, currency: 'CNY' } }))
  await assert.rejects(call('O1001'))
  console.log('PASS testMode=false, invalid arguments, corrupt fixture, invalid amount')
  console.log('LOCAL_ONLY: no Agent Loop, model, or durable tool/result was tested here.')
} finally {
  await rm(directory, { recursive: true })
}
