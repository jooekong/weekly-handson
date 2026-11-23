// Client config: Mac talks to the self-hosted E2B on ubuntu-e2b over Tailscale.
// The API key is fetched over ssh at run time and never written to disk.
import { execFileSync } from 'node:child_process'

export const HOST = process.env.W3_E2B_HOST ?? '100.111.51.1'
export const SSH = process.env.W3_SSH ?? 'e2b'

process.env.E2B_API_URL = `http://${HOST}:3000`
process.env.E2B_SANDBOX_URL = `http://${HOST}:3002`
process.env.E2B_API_KEY ??= execFileSync('ssh', [SSH, '. ~/.config/e2b/sdk.env && printf %s "$E2B_API_KEY"'], { encoding: 'utf8' })

export const ssh = cmd => execFileSync('ssh', [SSH, cmd], { encoding: 'utf8' })
