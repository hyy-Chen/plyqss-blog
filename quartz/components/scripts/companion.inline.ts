// Site companion: a real Live2D model in the bottom-right corner.
// The model follows the pointer on its own, so we only keep the quick-navigation menu.

type Action = "home" | "notes" | "random" | "search" | "top" | "theme"

type Live2DWidget = {
  init: (config: Record<string, unknown>) => void
}

const containerId = "site-companion"
const widgetDivId = "companion-live2d"
const widgetCanvasId = "companion-live2d-canvas"
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches

let avatar: HTMLButtonElement | null = null
let bubble: HTMLElement | null = null
let menu: HTMLElement | null = null
let bubbleTimer = 0
let indexPromise: Promise<Record<string, unknown>> | null = null
let live2dStarted = false
let widgetObserver: MutationObserver | null = null

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
<div class="companion-hit" aria-hidden="true"></div>
<button class="companion-avatar" type="button" aria-label="打开快捷导航" aria-expanded="false">
  <span class="companion-label" aria-hidden="true">导航</span>
</button>`

function basePath(): string {
  return document.body.dataset.basepath || ""
}

function asset(file: string): string {
  return `${basePath()}/static/live2d/${file}`
}

function mountWidget(): boolean {
  const widget = document.getElementById(widgetDivId)
  const container = document.getElementById(containerId)
  if (!widget || !container) return false
  if (widget.parentElement !== container) container.appendChild(widget)
  widget.style.position = "absolute"
  widget.style.right = "0"
  widget.style.bottom = "0"
  widget.style.zIndex = "0"
  return true
}

function markFallback() {
  document.getElementById(containerId)?.setAttribute("data-live2d", "off")
}

function startLive2D() {
  if (reduced || live2dStarted) return
  live2dStarted = true
  const script = document.createElement("script")
  script.src = asset("L2Dwidget.min.js")
  script.async = true
  script.onerror = markFallback
  script.onload = () => {
    const api = (window as Window & { L2Dwidget?: Live2DWidget }).L2Dwidget
    if (!api?.init) {
      markFallback()
      return
    }
    api.init({
      model: { jsonPath: asset("models/rem/rem.model.json"), scale: 1.1 },
      display: {
        superSample: 2,
        width: 200,
        height: 300,
        position: "right",
        hOffset: 0,
        vOffset: 0,
      },
      mobile: { show: true, scale: 1, motion: true },
      name: { div: widgetDivId, canvas: widgetCanvasId },
      react: { opacity: 1 },
      dialog: { enable: false },
    })
    if (mountWidget()) return
    widgetObserver = new MutationObserver(() => {
      if (mountWidget()) widgetObserver?.disconnect()
    })
    widgetObserver.observe(document.body, { childList: true })
    window.setTimeout(() => widgetObserver?.disconnect(), 10000)
  }
  document.head.appendChild(script)
  window.setTimeout(() => {
    if (!mountWidget()) markFallback()
  }, 12000)
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
    if (reduced) el.dataset.live2d = "off"
  }
  avatar = el.querySelector(".companion-avatar")
  bubble = el.querySelector(".companion-bubble")
  menu = el.querySelector(".companion-menu")
  mountWidget()
  startLive2D()
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
  if (target?.closest(".companion-avatar, .companion-hit") && !menu?.classList.contains("open")) {
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
  if (target.closest(".companion-avatar, .companion-hit")) {
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
