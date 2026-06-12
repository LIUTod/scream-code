import process from "node:process";
const { stdout, stdin } = process;

import type { ResolvedTheme } from "#/tui/theme/colors";

const LOGO = [
  '███████╗ ██████╗██████╗ ███████╗ █████╗ ███╗   ███╗  ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔════╝██╔════╝██╔══██╗██╔════╝██╔══██╗████╗ ████║ ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '███████╗██║     ██████╔╝█████╗  ███████║██╔████╔██║ ██║     ██║   ██║██║  ██║█████╗  ',
  '╚════██║██║     ██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║ ██║     ██║   ██║██║  ██║██╔══╝  ',
  '███████║╚██████╗██║  ██║███████╗██║  ██║██║ ╚═╝ ██║ ╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
]

const SHADOW_CHARS = new Set(['╚','═','╝','║','╔','╗','╠','╣','╦','╩','╬'])
const SHEEN_STEP = 2
const SHEEN_INTERVAL_MS = 150
const LOADING_DURATION_MS = 1500
const THEME_ACCENT: Record<ResolvedTheme, [number, number, number]> = {
  dark: [78, 200, 126],   // #4EC87E
  light: [14, 122, 56],  // #0E7A38
}
const BLOCK_RGB: [number, number, number] = [255, 255, 255]
const LOGO_RGB: [number, number, number] = [136, 136, 136]
const DIM_RGB: [number, number, number] = [85, 85, 85]

function fg(r: number, g: number, b: number) { return `\x1b[38;2;${r};${g};${b}m` }
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

function renderSheen(char: string, charIndex: number, sheenPos: number, isReversing: boolean, accent: [number, number, number]) {
  if (char === ' ') return ' '
  if (char === '█') return `${fg(...BLOCK_RGB)}█${RESET}`
  if (!SHADOW_CHARS.has(char)) return `${fg(...LOGO_RGB)}${char}${RESET}`
  let color: [number, number, number]
  if (isReversing) {
    color = charIndex <= sheenPos ? LOGO_RGB : accent
  } else {
    color = charIndex <= sheenPos ? accent : LOGO_RGB
  }
  return `${fg(...color)}${char}${RESET}`
}

const LOADING_TEXT = 'Ai正在加载中...'
function buildShimmerPalette(n: number, accent: [number, number, number]) {
  const size = Math.max(8, Math.min(20, Math.ceil(n * 1.5)))
  const palette: [number, number, number][] = []
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1)
    palette.push([
      Math.round(accent[0] - t * accent[0] * 0.35),
      Math.round(accent[1] - t * accent[1] * 0.6),
      Math.round(accent[2] - t * accent[2] * 0.33),
    ])
  }
  return palette
}

function renderShimmer(pulse: number, accent: [number, number, number]) {
  const chars = LOADING_TEXT.split('')
  const n = chars.length
  const palette = buildShimmerPalette(n, accent)
  let out = ''
  for (let i = 0; i < n; i++) {
    const phase = (pulse - i + n) % n
    const color = palette[phase]!
    const ratio = n <= 1 ? 0 : phase / (n - 1)
    const attr = ratio < 0.23 ? BOLD : ratio < 0.69 ? '' : DIM
    out += `${attr}${fg(...color)}${chars[i]}${RESET}`
  }
  return out
}

function getTerminalSize() {
  return { cols: stdout.columns || 80, rows: stdout.rows || 24 }
}

function visualWidth(s: string) {
  let w = 0
  for (const ch of s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')) {
    w += /[一-鿿　-〿＀-￯]/.test(ch) ? 2 : 1
  }
  return w
}

function centerPad(text: string, width: number) {
  const plainW = visualWidth(text)
  const pad = Math.max(0, Math.floor((width - plainW) / 2))
  return ' '.repeat(pad) + text
}

let ansiSupported: boolean | null = null

function supportsAnsi(): boolean {
  if (ansiSupported !== null) return ansiSupported
  if (!stdout.isTTY) { ansiSupported = false; return false }
  if (process.env['NO_COLOR']) { ansiSupported = false; return false }
  if (process.env['FORCE_COLOR']) { ansiSupported = true; return true }
  if (process.platform === 'win32') {
    const term = (process.env['TERM'] ?? '').toLowerCase()
    const session = (process.env['TERM_PROGRAM'] ?? '').toLowerCase()
    if (term.includes('xterm') || term.includes('vt100') || term.includes('256color')) { ansiSupported = true; return true }
    if (session.includes('terminal') || session.includes('vscode')) { ansiSupported = true; return true }
    if (process.env['CI']) { ansiSupported = true; return true }
    ansiSupported = true; return true
  }
  if (process.env['TERM'] && process.env['TERM'] !== 'dumb') { ansiSupported = true; return true }
  ansiSupported = false; return false
}

export function runLoadingAnimation(theme: ResolvedTheme = 'dark'): Promise<void> {
  const ansi = supportsAnsi()

  if (!ansi) {
    for (const line of LOGO) stdout.write(`${fg(...LOGO_RGB)}${line}${RESET}\n`)
    stdout.write(`${BOLD}${fg(...THEME_ACCENT[theme])}正在唤醒核心...${RESET}\n`)
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      stdout.write('\x1b[?1049h')
    }
    stdout.write('\x1b[2J')
    stdout.write('\x1b[?25l')

    const accent = THEME_ACCENT[theme]
    let sheenPos = 0
    let isReversing = false
    let shimmerPulse = 0
    let phase: 'loading' | 'ready' = 'loading'

    function render() {
      const { cols, rows } = getTerminalSize()
      const lines: string[] = []

      const contentHeight = LOGO.length + 4
      const topPad = Math.max(0, Math.floor((rows - contentHeight) / 2))
      for (let i = 0; i < topPad; i++) lines.push('')

      for (const line of LOGO) {
        let colored = ''
        for (let ci = 0; ci < line.length; ci++) {
          colored += renderSheen(line[ci]!, ci, sheenPos, isReversing, accent)
        }
        lines.push(centerPad(colored, cols))
      }

      if (phase === 'loading') {
        lines.push(centerPad(renderShimmer(shimmerPulse, accent), cols))
      } else {
        lines.push(centerPad(`${BOLD}${fg(...accent)}按下 ENTER 唤醒核心${RESET}`, cols))
      }

      lines.push('')
      lines.push('')
      lines.push(centerPad(`${fg(...DIM_RGB)}按住 Ctrl+C 即可退出 Scream Code${RESET}`, cols))

      while (lines.length < rows) lines.push('')

      stdout.write('\x1b[H')
      stdout.write(lines.join('\n'))
    }

    function tick() {
      sheenPos += SHEEN_STEP
      if (sheenPos >= 90) {
        isReversing = !isReversing
        sheenPos = 0
      }
      shimmerPulse = (shimmerPulse + 1) % LOADING_TEXT.length
      render()
    }

    function onData(data: Buffer) {
      const key = data.toString()
      if (key === '\x03') {
        interrupt()
        return
      }
      if ((key === '\r' || key === '\n') && phase === 'ready') {
        cleanup()
        resolve()
      }
    }

    function cleanup() {
      clearInterval(timer)
      stdin.off('data', onData)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', interrupt)
      try { stdin.setRawMode(false) } catch { /* ignore */ }
      stdout.write('\x1b[?25h')
      if (process.platform !== 'win32') {
        stdout.write('\x1b[?1049l')
      } else {
        stdout.write('\x1b[2J\x1b[H')
      }
    }

    function interrupt() {
      cleanup()
      process.exit(0)
    }

    process.on('SIGINT', interrupt)
    process.on('SIGTERM', interrupt)

    try {
      stdin.setRawMode(true)
    } catch {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', interrupt)
      stdout.write('\x1b[?25h')
      if (process.platform !== 'win32') {
        stdout.write('\x1b[?1049l')
      }
      for (const line of LOGO) stdout.write(`${fg(...LOGO_RGB)}${line}${RESET}\n`)
      stdout.write(`${BOLD}${fg(...accent)}正在唤醒核心...${RESET}\n`)
      resolve()
      return
    }

    stdin.on('data', onData)

    render()
    const timer = setInterval(tick, SHEEN_INTERVAL_MS)

    setTimeout(() => {
      phase = 'ready'
      render()
    }, LOADING_DURATION_MS)
  })
}
