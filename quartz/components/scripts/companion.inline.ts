// Site companion: a lightweight quick-navigation button in the bottom-right corner.
// The Live2D model was removed: its runtime and textures dominated page load time.

type Action = "home" | "notes" | "random" | "search" | "top" | "theme"

const containerId = "site-companion"
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches

let avatar: HTMLButtonElement | null = null
let bubble: HTMLElement | null = null
let menu: HTMLElement | null = null
let bubbleTimer = 0
let indexPromise: Promise<Record<string, unknown>> | null = null

const markup = `
<div class="companion-bubble" role="status">点我打开导航</div>
<nav class="companion-menu" aria-label="快捷导航">
  <button type="button" data-companion-action="home">首页</button>
  <button type="button" data-companion-action="notes">笔记</button>
  <button type="button" data-companion-action="random">随机</button>
  <button type="button" data-companion-action="search">搜索</button>
  <button type="button" data-companion-action="top">顶部</button>
  <button type="button" data-companion-action="theme">主题</button>
</nav>
<button class="companion-avatar" type="button" aria-label="打开快捷导航" aria-expanded="false">
  <span class="companion-label" aria-hidden="true">导航</span>
</button>`

function basePath(): string {
  return document.body.dataset.basepath || ""
}

function attach() {
  let el = document.getElementById(containerId)
  if (!el) {
    el = document.createElement("aside")
    el.id = containerId
    el.setAttribute("data-persist", "")
    el.setAttribute("aria-label", "站点导航助手")
    document.body.appendChild(el)
  }
  if (el.dataset.ready !== "true") {
    el.innerHTML = markup
    el.dataset.ready = "true"
  }
  avatar = el.querySelector(".companion-avatar")
  bubble = el.querySelector(".companion-bubble")
  menu = el.querySelector(".companion-menu")
}

function say(text: string, duration = 1800) {
  if (!bubble) return
  window.clearTimeout(bubbleTimer)
  bubble.textContent = text
  bubble.classList.add("visible")
  bubbleTimer = window.setTimeout(() => bubble?.classList.remove("visible"), duration)
}

function setMenu(open: boolean) {
  window.clearTimeout(bubbleTimer)
  menu?.classList.toggle("open", open)
  avatar?.setAttribute("aria-expanded", String(open))
  avatar?.setAttribute("aria-label", open ? "关闭快捷导航" : "打开快捷导航")
  if (bubble) bubble.textContent = open ? "想去哪儿？" : "点我打开导航"
  bubble?.classList.toggle("visible", open)
}

function closeMenu() {
  if (menu?.classList.contains("open")) setMenu(false)
}

function getIndex(): Promise<Record<string, unknown>> {
  if (!indexPromise) {
    const slug = document.body.dataset.slug || ""
    const depth = slug === "index" ? 0 : slug.split("/").length - 1
    const localUrl = `${depth > 0 ? "../".repeat(depth) : "./"}static/contentIndex.json`
    const urls = [localUrl, `${basePath()}/static/contentIndex.json`]
    indexPromise = (async () => {
      for (const url of urls) {
        try {
          const res = await fetch(url)
          if (res.ok) return (await res.json()) as Record<string, unknown>
        } catch {}
      }
      return {}
    })()
  }
  return indexPromise
}

async function runAction(action: Action) {
  const base = basePath()
  switch (action) {
    case "home":
      say("回到首页")
      window.location.assign(`${base}/`)
      break
    case "notes":
      say("打开学习笔记")
      window.location.assign(`${base}/学习笔记/总览`)
      break
    case "random": {
      const data = await getIndex()
      const slugs = Object.keys(data).filter(
        (slug) => slug !== "index" && !slug.startsWith("培琳/"),
      )
      if (slugs.length === 0) {
        say("暂时没有可跳转的页面")
        break
      }
      const slug = slugs[Math.floor(Math.random() * slugs.length)]
      say("带你随便逛逛")
      window.location.assign(`${base}/${encodeURI(slug)}`)
      break
    }
    case "search":
      document.querySelector<HTMLButtonElement>(".search-button")?.click()
      say("搜索一下")
      break
    case "top":
      window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" })
      say("回到顶部")
      break
    case "theme":
      document.querySelector<HTMLButtonElement>(".darkmode")?.click()
      say("换个心情")
      break
  }
}

attach()
say("点我打开导航", 4200)

document.addEventListener("pointerover", (event) => {
  const target = event.target as Element | null
  if (target?.closest(".companion-avatar") && !menu?.classList.contains("open")) {
    say("点我打开导航", 1600)
  }
})

document.addEventListener("click", (event) => {
  const target = event.target as Element | null
  if (!target) return
  const actionEl = target.closest("[data-companion-action]")
  if (actionEl) {
    event.preventDefault()
    closeMenu()
    void runAction(actionEl.getAttribute("data-companion-action") as Action)
    return
  }
  if (target.closest(".companion-avatar")) {
    event.preventDefault()
    setMenu(!menu?.classList.contains("open"))
    return
  }
  if (!target.closest(`#${containerId}`)) closeMenu()
})

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu()
})

document.addEventListener("nav", attach)

export {}
