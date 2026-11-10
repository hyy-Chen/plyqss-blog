// Lightweight site companion: a little character in the bottom-right corner
// whose eyes follow the pointer, plus a small quick-navigation menu.

type Action = "home" | "notes" | "random" | "search" | "top" | "theme"

const containerId = "site-companion"
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches

let avatar: HTMLButtonElement | null = null
let head: SVGGElement | null = null
let eyes: SVGGElement | null = null
let pupils: SVGGElement[] = []
let bubble: HTMLElement | null = null
let menu: HTMLElement | null = null
let bubbleTimer = 0
let indexPromise: Promise<Record<string, unknown>> | null = null

const character = `
<svg class="companion-svg" viewBox="0 0 100 124" aria-hidden="true">
  <ellipse class="c-shadow" cx="50" cy="119" rx="26" ry="4" />
  <path class="c-body" d="M26 118 Q27 91 50 89 Q73 91 74 118 Z" />
  <path class="c-collar" d="M42 90 L50 98 L58 90 Z" />
  <path class="c-bow" d="M50 97 Q40 91 39 99 Q40 106 50 100 Q60 106 61 99 Q60 91 50 97 Z" />
  <rect class="c-skin" x="43" y="79" width="14" height="14" rx="6" />
  <g class="companion-head">
    <ellipse class="c-hair" cx="50" cy="47" rx="31" ry="33" />
    <path class="c-hair-side" d="M20 48 Q17 68 26 82 L31 78 Q24 64 27 50 Z" />
    <path class="c-hair-side" d="M80 48 Q83 68 74 82 L69 78 Q76 64 73 50 Z" />
    <ellipse class="c-skin" cx="50" cy="52" rx="24" ry="26" />
    <path class="c-hair" d="M26 44 Q27 19 50 19 Q73 19 74 44 Q66 33 57 36 Q50 29 43 36 Q34 33 26 44 Z" />
    <g class="companion-eyes">
      <ellipse class="c-eye" cx="40" cy="54" rx="5.2" ry="6.2" />
      <ellipse class="c-eye" cx="60" cy="54" rx="5.2" ry="6.2" />
      <g class="c-pupil">
        <circle class="c-pupil-dot" cx="40" cy="54" r="2.8" />
        <circle class="c-shine" cx="41" cy="52.7" r="0.9" />
      </g>
      <g class="c-pupil">
        <circle class="c-pupil-dot" cx="60" cy="54" r="2.8" />
        <circle class="c-shine" cx="61" cy="52.7" r="0.9" />
      </g>
    </g>
    <ellipse class="c-blush" cx="32" cy="63" rx="4.2" ry="2.2" />
    <ellipse class="c-blush" cx="68" cy="63" rx="4.2" ry="2.2" />
    <path class="c-mouth" d="M46 66 Q50 70 54 66" />
  </g>
</svg>`

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
<button class="companion-avatar" type="button" aria-label="打开快捷导航" aria-expanded="false">${character}</button>`

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
  head = el.querySelector(".companion-head")
  eyes = el.querySelector(".companion-eyes")
  pupils = Array.from(el.querySelectorAll(".c-pupil"))
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

window.addEventListener(
  "pointermove",
  (event) => {
    if (reduced || event.pointerType === "touch") return
    if (!avatar?.isConnected) attach()
    if (!avatar || pupils.length === 0) return
    const rect = avatar.getBoundingClientRect()
    const dx = event.clientX - (rect.left + rect.width / 2)
    const dy = event.clientY - (rect.top + rect.height * 0.44)
    const strength = Math.min(1, Math.hypot(dx, dy) / 240)
    const angle = Math.atan2(dy, dx)
    const px = Math.cos(angle) * 2.5 * strength
    const py = Math.sin(angle) * 1.9 * strength
    const shift = `translate(${px.toFixed(2)} ${py.toFixed(2)})`
    pupils.forEach((pupil) => pupil.setAttribute("transform", shift))
    if (head) {
      head.style.transform = `translate(${(px * 0.65).toFixed(2)}px, ${(py * 0.45).toFixed(2)}px)`
    }
  },
  { passive: true },
)

document.addEventListener("pointerleave", () => {
  pupils.forEach((pupil) => pupil.setAttribute("transform", "translate(0 0)"))
  if (head) head.style.transform = ""
})

document.addEventListener("nav", attach)

if (!reduced) {
  const blink = () => {
    if (eyes?.isConnected) {
      eyes.classList.add("blink")
      window.setTimeout(() => eyes?.classList.remove("blink"), 130)
    }
    window.setTimeout(blink, 3000 + Math.random() * 3500)
  }
  window.setTimeout(blink, 2600)
}

export {}
