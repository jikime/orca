// R5 s2b/R5 audit (IDN-008): regenerates execution-context-signed.golden.json deterministically.
// The signing keypair is derived from a FIXED 32-byte test seed (never a real installation key), so
// re-running this reproduces byte-identical canonicalBytes + signature. Run after any change to the
// canonical field order so BOTH workspace golden tests keep verifying:
//   node contracts/golden/generate-execution-context-signed-golden.mjs
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Fixed Ed25519 test seed (32 bytes). PKCS8 DER = the 16-byte Ed25519 prefix + raw seed.
const SEED = Buffer.alloc(32, 0x2b)
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, SEED]),
  format: 'der',
  type: 'pkcs8'
})
const publicKey = createPublicKey(privateKey)
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const publicKeyId = createHash('sha256')
  .update(publicKey.export({ format: 'der', type: 'spki' }))
  .digest('base64url')

const context = {
  schemaVersion: 1,
  installationId: '11111111-1111-4111-8111-111111111111',
  hostType: 'native',
  hostId: '22222222-2222-4222-8222-222222222222',
  workspacePath: '/Users/dev/projects/orca',
  osUser: 'dev',
  launchId: '33333333-3333-4333-8333-333333333333',
  agentSessionId: '44444444-4444-4444-8444-444444444444',
  provider: 'claude_code',
  notBefore: 1750000000000,
  notAfter: 1750000900000
}

// Byte-identical to canonicalizeExecutionContext in BOTH serializers — keep the field order in sync.
const canonicalFields = [
  `"schemaVersion":${JSON.stringify(context.schemaVersion)}`,
  `"installationId":${JSON.stringify(context.installationId)}`,
  `"hostType":${JSON.stringify(context.hostType)}`,
  `"hostId":${JSON.stringify(context.hostId)}`,
  `"workspacePath":${JSON.stringify(context.workspacePath)}`,
  `"osUser":${JSON.stringify(context.osUser)}`,
  `"launchId":${JSON.stringify(context.launchId)}`,
  `"agentSessionId":${JSON.stringify(context.agentSessionId)}`,
  `"provider":${JSON.stringify(context.provider)}`,
  `"notBefore":${JSON.stringify(context.notBefore)}`,
  `"notAfter":${JSON.stringify(context.notAfter)}`
].join(',')
const canonicalBytes = `{${canonicalFields}}`

const signature = sign(null, Buffer.from(canonicalBytes, 'utf-8'), privateKey).toString('base64')

const golden = {
  description:
    'R5 s2b golden signed ExecutionContext. BOTH workspaces must reproduce canonicalBytes byte-for-byte and verify signature against publicKeyPem. Keypair is a fixed test seed — never a real installation key. Regenerate with contracts/golden/generate-execution-context-signed-golden.mjs.',
  canonicalBytes,
  publicKeyPem,
  signed: {
    context,
    installationId: context.installationId,
    signature,
    publicKeyId
  }
}

const out = join(import.meta.dirname, 'execution-context-signed.golden.json')
writeFileSync(out, `${JSON.stringify(golden, null, 2)}\n`)
console.log(`wrote ${out}`)
console.log(`publicKeyId=${publicKeyId}`)
