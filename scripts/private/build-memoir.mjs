import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const encoded = process.env.MEMOIR_MARKDOWN_B64?.trim()
const password = process.env.MEMOIR_PASSWORD?.trim()
if (!encoded || !password) {
  console.error('MEMOIR_MARKDOWN_B64 and MEMOIR_PASSWORD are required')
  process.exit(1)
}
let body
try { body = Buffer.from(encoded, 'base64').toString('utf8') } catch { console.error('MEMOIR_MARKDOWN_B64 is invalid'); process.exit(1) }
if (!body.trim()) { console.error('MEMOIR_MARKDOWN_B64 decoded to empty content'); process.exit(1) }
const targetDir = resolve('content/培琳')
const target = join(targetDir, '回忆录.md')
await mkdir(targetDir, { recursive: true })
const frontmatter = `---\ntitle: 培琳\nstealth: true\npassword: ${JSON.stringify(password)}\n---\n\n`
await writeFile(target, frontmatter + body.replace(/^---[\s\S]*?---\s*/, ''), 'utf8')
const cleanup = async () => { await rm(targetDir, { recursive: true, force: true }) }
process.on('exit', () => {})
process.on('SIGINT', async () => { await cleanup(); process.exit(130) })
process.on('SIGTERM', async () => { await cleanup(); process.exit(143) })
console.log('Private memoir source prepared')
