import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'w1-order'
export const inject = ['tools']

export interface Config {
  fixturePath: string
  testMode: boolean
}

export const Config: Schema<Config> = Schema.object({
  fixturePath: Schema.string().required(),
  testMode: Schema.boolean().default(false),
})

const orderSchema = Schema.object({
  status: Schema.string().pattern(/\S/).required(),
  amount_cent: Schema.number().min(0).max(Number.MAX_SAFE_INTEGER).step(1).required(),
  currency: Schema.string().pattern(/^[A-Z]{3}$/).required(),
})
const fixtureSchema = Schema.dict(orderSchema)

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'get_order',
    description: 'Read one synthetic order from the current fixture. found=false means no order; an error means the lookup failed. Amounts are integer minor currency units (cents).',
    parameters: {
      orderId: { type: 'string', required: true, description: 'Order ID, e.g. O1001. OERR triggers a simulated failure only in test mode.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          dataVersion: { type: 'string', required: true },
          order: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              amount_cent: { type: 'integer', required: true },
              currency: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute({ orderId }, exec) {
      const started = performance.now()
      let dataVersion: string | null = null
      let status = 'error'
      let errorMessage: string | null = null
      try {
        if (!/^O(?:\d+|ERR)$/.test(orderId)) throw new Error('INVALID_ORDER_ID: use O followed by digits, or OERR')
        // Read on every invocation so fixture changes never require a code change.
        const bytes = await readFile(config.fixturePath)
        dataVersion = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
        const orders = fixtureSchema(JSON.parse(bytes.toString('utf8')))
        if (config.testMode && orderId === 'OERR') {
          throw new Error(`SIMULATED_TIMEOUT: order lookup failed; callId=${exec.callId}`)
        }
        const result = Object.hasOwn(orders, orderId)
          ? { found: true, order: orders[orderId], dataVersion }
          : { found: false, dataVersion }
        status = 'success'
        return result
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        // Body audit only: schema rejection and policy denial happen outside execute().
        console.error(JSON.stringify({
          event: 'order_audit', callId: exec.callId, orderId, dataVersion,
          durationMs: Math.round((performance.now() - started) * 1000) / 1000,
          status, error: errorMessage,
        }))
      }
    },
  }))
}
