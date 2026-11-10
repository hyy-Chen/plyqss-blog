// Interactive falling-particle background.
// Dots drift downward; when the pointer comes near, they are pulled toward it.

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  baseVy: number
  drift: number
  phase: number
  r: number
  alpha: number
  tint: number
}

const canvasId = "particle-field"
const attractRadius = 170
const maxSpeed = 3.2

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let width = 0
let height = 0
let dpr = 1
let particles: Particle[] = []
let colors: [string, string] = ["47, 111, 143", "79, 158, 152"]
let last = 0

const pointer = { x: -1000, y: -1000, active: false }

function readColors() {
  const dark = document.documentElement.getAttribute("saved-theme") === "dark"
  colors = dark ? ["126, 200, 227", "143, 216, 189"] : ["47, 111, 143", "79, 158, 152"]
}

function makeParticle(initial: boolean): Particle {
  const baseVy = 0.12 + Math.random() * 0.38
  return {
    x: Math.random() * width,
    y: initial ? Math.random() * height : -12 - Math.random() * 90,
    vx: (Math.random() - 0.5) * 0.16,
    vy: baseVy,
    baseVy,
    drift: 0.1 + Math.random() * 0.22,
    phase: Math.random() * Math.PI * 2,
    r: 1 + Math.random() * 2.1,
    alpha: 0.3 + Math.random() * 0.48,
    tint: Math.random() < 0.75 ? 0 : 1,
  }
}

function resize() {
  if (!canvas || !ctx) return
  width = window.innerWidth
  height = window.innerHeight
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const target = Math.min(130, Math.round((width * height) / 11000))
  const count = width < 800 ? Math.round(target * 0.55) : target
  if (particles.length > count) particles.length = count
  while (particles.length < count) particles.push(makeParticle(true))
}

function attach() {
  let el = document.getElementById(canvasId) as HTMLCanvasElement | null
  if (!el) {
    el = document.createElement("canvas")
    el.id = canvasId
    el.setAttribute("aria-hidden", "true")
    document.body.prepend(el)
  }
  canvas = el
  ctx = el.getContext("2d")
  resize()
}

function frame(ts: number) {
  window.requestAnimationFrame(frame)
  if (!ctx || document.hidden) {
    last = ts
    return
  }

  const dt = Math.min((ts - last) / 16.67, 2) || 1
  last = ts
  ctx.clearRect(0, 0, width, height)

  for (let i = 0; i < particles.length; i++) {
    let p = particles[i]

    if (pointer.active) {
      const dx = pointer.x - p.x
      const dy = pointer.y - p.y
      const distSq = dx * dx + dy * dy
      if (distSq < attractRadius * attractRadius && distSq > 144) {
        const dist = Math.sqrt(distSq)
        const pull = (1 - dist / attractRadius) * 0.55 * dt
        const swirl = pull * 0.18
        p.vx += (dx / dist) * pull - (dy / dist) * swirl
        p.vy += (dy / dist) * pull + (dx / dist) * swirl
      }
    }

    p.vx *= 0.985
    p.vy += (p.baseVy - p.vy) * 0.015 * dt
    p.phase += 0.01 * dt

    const speed = Math.hypot(p.vx, p.vy)
    if (speed > maxSpeed) {
      p.vx *= maxSpeed / speed
      p.vy *= maxSpeed / speed
    }

    p.x += (p.vx + Math.sin(p.phase) * p.drift) * dt
    p.y += p.vy * dt

    if (p.y > height + 14) {
      p = makeParticle(false)
      particles[i] = p
    } else if (p.x < -14) {
      p.x = width + 14
    } else if (p.x > width + 14) {
      p.x = -14
    }

    const near = pointer.active
      ? Math.max(0, 1 - Math.hypot(pointer.x - p.x, pointer.y - p.y) / attractRadius)
      : 0

    ctx.beginPath()
    ctx.fillStyle = `rgba(${colors[p.tint]}, ${Math.min(1, p.alpha + near * 0.45)})`
    ctx.arc(p.x, p.y, p.r + near * 0.9, 0, Math.PI * 2)
    ctx.fill()
  }
}

function onPointer(event: PointerEvent) {
  pointer.x = event.clientX
  pointer.y = event.clientY
  pointer.active = true
}

readColors()
attach()

window.addEventListener("pointermove", onPointer, { passive: true })
window.addEventListener("pointerdown", onPointer, { passive: true })
window.addEventListener("blur", () => (pointer.active = false))
document.addEventListener("pointerleave", () => (pointer.active = false))
document.addEventListener("themechange", readColors)
document.addEventListener("nav", attach)
window.addEventListener("resize", resize)

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  window.requestAnimationFrame(frame)
}

export {}
