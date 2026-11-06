# Legacy Blog Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the old Hexo articles into the current Quartz blog, preserve LaTeX and assets, and keep the former memoir private inside a password-protected `培琳` directory.

**Architecture:** A one-off extractor reads the old generated HTML and writes Markdown plus referenced assets into Quartz content. Public articles are committed under `content/旧博客/`; private source is kept outside Git and injected by the Pages workflow from `MEMOIR_MARKDOWN_B64` and `MEMOIR_PASSWORD` secrets immediately before building. Quartz's LaTeX and encrypted-pages plugins render formulas and encrypt private output.

**Tech Stack:** Quartz v5, Markdown, YAML frontmatter, Node.js, GitHub Actions, `@quartz-community/latex`, `@quartz-community/encrypted-pages`.

## Global Constraints

- The old source is generated HTML; recover content from each article's `#articleContent` element.
- Migrate six public posts and the old `回忆录` content into private directory `培琳`.
- Use `$...$` for inline formulas and `$$...$$` for display formulas.
- Never commit private Markdown, the password, or a hash that is used as a password.
- Private pages use `stealth: true` and are absent from public listings.
- The build must fail when required private secrets are missing.
- Preserve old dated URLs for public posts with Quartz aliases and redirect output.

---

### Task 1: Build a deterministic legacy HTML extractor

**Files:**
- Create: `scripts/extract_legacy_blog.mjs`
- Create: `scripts/legacy-extract-map.json`
- Test: `scripts/fixtures/legacy-extractor-fixture.html`

**Interfaces:**
- Consumes: old repository path and JSON map of article source paths, titles, dates, and public/private status.
- Produces: Markdown files, copied referenced images, and a JSON extraction report containing title, URL, formula count, code block count, and asset list.

- [ ] **Step 1: Add a fixture containing one heading, one inline formula, one display formula, one code block, and one image.**
- [ ] **Step 2: Run the extractor against the fixture and verify the expected Markdown is not produced yet.**
- [ ] **Step 3: Implement HTML-to-Markdown conversion using the existing Node dependencies; strip theme widgets, share controls, comments, and generated metadata.**
- [ ] **Step 4: Convert MathJax source to `$...$` and `$$...$$` without altering TeX commands.**
- [ ] **Step 5: Copy only referenced files from `medias/` and rewrite image links to Quartz content-relative paths.**
- [ ] **Step 6: Run the fixture extraction and assert title, formula delimiters, fenced code, and asset path.**
- [ ] **Step 7: Commit the extractor and fixture with `git add scripts && git commit -m 'build: add legacy blog extractor'`.**

### Task 2: Recover and review the six public articles

**Files:**
- Create: `content/旧博客/` Markdown files for each recovered public post
- Create: `content/旧博客/assets/` files referenced by public posts
- Create: `scripts/legacy-extraction-report.json`

**Interfaces:**
- Consumes: `/tmp/hyy-chen.github.io` and Task 1 extractor.
- Produces: six public Markdown posts with `date`, `tags`, and original dated `aliases`.

- [ ] **Step 1: Populate the source map for `test`, `math--primes`, `扩展欧几里得算法`, `欧拉`, `排列组合`, and `Hello World`.**
- [ ] **Step 2: Run extraction into `content/旧博客/` and generate the report.**
- [ ] **Step 3: Inspect every generated file for malformed HTML, lost code, broken links, or unconverted MathJax.**
- [ ] **Step 4: Run `rg -n '\\\\(|\\\\\[|MathJax|CryptoJS|articleContent' content/旧博客` and resolve every generated-page artifact.**
- [ ] **Step 5: Build with `npm run quartz -- build` and confirm six public pages and their aliases appear in `public/`.**
- [ ] **Step 6: Commit public content and assets with `git add content/旧博客 scripts/legacy-extraction-report.json && git commit -m 'content: recover legacy public posts'`.**

### Task 3: Configure encrypted `培琳` content

**Files:**
- Modify: `quartz.config.yaml:116-118`
- Create: `scripts/private/build-memoir.mjs`
- Create: `content/培琳/.gitignore`
- Create: `private-content/README.md`

**Interfaces:**
- Consumes: `MEMOIR_MARKDOWN_B64` and `MEMOIR_PASSWORD` environment variables.
- Produces: temporary `content/培琳/index.md` with password frontmatter and private body; exits nonzero if either secret is empty.

- [ ] **Step 1: Add a test invocation with missing environment variables and verify it exits nonzero without creating a file.**
- [ ] **Step 2: Implement strict secret validation, base64 decoding, YAML frontmatter insertion (`title: 培琳`, `password`, `stealth: true`), and cleanup on process exit.**
- [ ] **Step 3: Enable `@quartz-community/encrypted-pages` with `iterations: 600000`, `passwordField: password`, `unlistWhenEncrypted: true`.**
- [ ] **Step 4: Add `.gitignore` rules for temporary `content/培琳/` source and document local secret creation without recording the password.**
- [ ] **Step 5: Run the helper with a temporary test secret and verify the generated source contains the password only in the untracked temporary file.**
- [ ] **Step 6: Commit configuration and helper documentation with `git add quartz.config.yaml scripts/private private-content && git commit -m 'feat: protect private peilin content'`.**

### Task 4: Migrate the private source without exposing it

**Files:**
- Modify: `scripts/legacy-extract-map.json`
- Create locally only: `private-content/培琳/index.md`
- Create locally only: `private-content/培琳/assets/`

**Interfaces:**
- Consumes: old `回忆录` HTML and Task 1 extractor.
- Produces: a local Markdown source encoded for the `MEMOIR_MARKDOWN_B64` secret; no private source is tracked.

- [ ] **Step 1: Extract the old memoir to a path outside the Git worktree.**
- [ ] **Step 2: Review the private extraction locally for formulas, code, links, and image references.**
- [ ] **Step 3: Add `title: 培琳` and directory-relative asset paths without adding the source to Git.**
- [ ] **Step 4: Generate the base64 value locally and configure `MEMOIR_MARKDOWN_B64` and `MEMOIR_PASSWORD` repository secrets without echoing their values.**
- [ ] **Step 5: Confirm `git status --short` and `git ls-files` contain no private source, password, or hash.**

### Task 5: Update GitHub Pages workflow for secret injection

**Files:**
- Modify: `.github/workflows/deploy-pages.yaml:30-42`

**Interfaces:**
- Consumes: repository secrets `MEMOIR_MARKDOWN_B64` and `MEMOIR_PASSWORD`.
- Produces: encrypted `public/` artifact and deployment; no private source remains after build.

- [ ] **Step 1: Add a shell step that fails when either secret is unset and runs `node scripts/private/build-memoir.mjs`.**
- [ ] **Step 2: Add a cleanup trap around the build so temporary private files are removed even when Quartz fails.**
- [ ] **Step 3: Keep secret values out of command arguments and logs.**
- [ ] **Step 4: Commit workflow changes with `git add .github/workflows/deploy-pages.yaml && git commit -m 'ci: inject private blog content during pages build'`.**

### Task 6: Verify local build and deployment outputs

**Files:**
- Modify: `scripts/legacy-extraction-report.json` only if verification finds a conversion defect

**Interfaces:**
- Consumes: public content, temporary private source, test password, and Quartz build output.
- Produces: verified `public/` output and a clean Git worktree.

- [ ] **Step 1: Build using a temporary private source and test password.**
- [ ] **Step 2: Assert six public article HTML files and old aliases exist.**
- [ ] **Step 3: Assert LaTeX delimiters and referenced assets are present in generated output.**
- [ ] **Step 4: Assert private plaintext, password, and private title are absent from content indexes, RSS, sitemap, and tracked files.**
- [ ] **Step 5: Open the generated private page, verify the password prompt, reject a wrong password, and unlock with the test password.**
- [ ] **Step 6: Run `git diff --check`, `npm run check`, and `git status --short`; record the exact results before claiming completion.**
