import { readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

const root = fileURLToPath(new URL("..", import.meta.url))
const publicDir = join(root, "public")
const configPath = join(root, "quartz.config.yaml")

const config = YAML.parse(await readFile(configPath, "utf8"))
const baseUrl = config?.configuration?.baseUrl
if (!baseUrl) {
  console.error("baseUrl is missing from quartz.config.yaml")
  process.exit(1)
}
const basePath = new URL(`https://${baseUrl}`).pathname.replace(/\/$/, "")

const katexCss = /https:\/\/cdn\.jsdelivr\.net\/npm\/katex@[^"'\s]+\/dist\/katex\.min\.css/g
const katexCopyTex =
  /https:\/\/cdn\.jsdelivr\.net\/npm\/katex@[^"'\s]+\/dist\/contrib\/copy-tex\.min\.js/g

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fp = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* htmlFiles(fp)
    } else if (entry.name.endsWith(".html")) {
      yield fp
    }
  }
}

let changed = 0
for await (const fp of htmlFiles(publicDir)) {
  const rel = relative(publicDir, fp)
  const relDir = dirname(rel)
  const depth = relDir === "." ? 0 : relDir.split("/").filter((p) => p && p !== ".").length
  // 404.html can be served from any URL depth, so it needs an absolute path.
  const prefix = rel === "404.html" ? `${basePath}/` : depth === 0 ? "./" : "../".repeat(depth)
  const original = await readFile(fp, "utf8")
  const next = original
    .replaceAll(katexCss, `${prefix}static/katex/katex.min.css`)
    .replaceAll(katexCopyTex, `${prefix}static/katex/copy-tex.min.js`)
  if (next !== original) {
    await writeFile(fp, next, "utf8")
    changed++
  }
}

console.log(`Localized KaTeX assets in ${changed} HTML file(s), base path: ${basePath || "/"}`)
