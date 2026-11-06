# Legacy Blog Migration Design

## Goal

Recover the seven posts published by the old Hexo site in
`hyy-Chen/hyy-Chen.github.io` and publish them through the current Quartz site
without exposing the private memoir.

## Source and scope

The old repository contains generated HTML rather than the original Markdown.
The migration extracts each article from its `#articleContent` element and
reconstructs Markdown frontmatter and body content. It preserves titles,
publication dates, tags, headings, links, code blocks, images, and mathematical
expressions where those values remain in the generated HTML.

Six articles are public. The old `回忆录` post becomes a private directory named
`培琳`. Its entry page is `content/培琳/index.md`; recovered private content is
kept under that directory. The directory and all of its content must not appear
in public listings.

## Public article conversion

Each public article becomes one Markdown file under `content/旧博客/`. File
names use readable titles. Frontmatter records the original publication date,
tags, and aliases for the old dated URL. HTML constructs with no useful Quartz
equivalent, such as theme controls and sharing widgets, are discarded.

Images referenced by article bodies are copied into a content asset directory.
Only assets actually referenced by migrated articles are copied.

Inline formulas use `$...$` and display formulas use `$$...$$`. The existing
Quartz LaTeX transformer renders them. Conversion must preserve TeX commands
and must not treat currency or ordinary dollar signs as formulas.

## Private `培琳` directory

The recovered private source is kept outside the Git working tree while the
migration is prepared. Its Markdown body and its new password are supplied to
GitHub Actions through encrypted repository secrets. The deployment job writes
the temporary Markdown file immediately before the Quartz build and removes it
afterward.

The encrypted pages plugin is enabled with 600,000 PBKDF2 iterations. Every
page under `培琳` uses encryption and `stealth: true`, so its title, tags, and
URLs do not appear in search, RSS, sitemap, explorer, graph, backlinks, or
folder listings. The user reaches it only through a known URL.

The old SHA-256 password hash is retained only as recovery evidence. It is not
used as the new password and is not committed with the private content.

## Deployment secrets

The workflow expects two repository secrets:

- `MEMOIR_MARKDOWN_B64`: base64 encoded complete Markdown source for `培琳`
- `MEMOIR_PASSWORD`: the new password

At build time the workflow decodes the Markdown, injects the password into
frontmatter without printing either value, builds Quartz, and deletes the
temporary source through a shell trap. A missing secret fails the deployment
instead of publishing an unprotected page.

## URL compatibility

Public posts include aliases for their original Hexo paths, such as
`/2021/10/26/math-primes/`. Redirect pages preserve old bookmarks. The private
directory has no public alias whose metadata could reveal it; its private URL
is documented only in local setup instructions.

## Verification

Verification consists of:

1. comparing the seven extracted titles, dates, tags, code blocks, images, and
   formulas with the old HTML;
2. building the site with a temporary test password and private source;
3. checking that all six public posts and their old aliases are emitted;
4. checking that formulas render and referenced assets resolve;
5. checking that private plaintext and password are absent from `public/`, the
   content index, sitemap, RSS, and Git tracked files; and
6. opening a generated private page and confirming that a wrong password fails
   while the test password reveals the article.

