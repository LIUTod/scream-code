import process from "node:process";
import { t } from '@scream-code/config';
import type { ResolvedTheme } from "#/tui/theme/colors";

const { stdout, stdin } = process;

const LOGO = [
  '███████╗ ██████╗██████╗ ███████╗ █████╗ ███╗   ███╗  ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔════╝██╔════╝██╔══██╗██╔════╝██╔══██╗████╗ ████║ ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '███████╗██║     ██████╔╝█████╗  ███████║██╔████╔██║ ██║     ██║   ██║██║  ██║█████╗  ',
  '╚════██║██║     ██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║ ██║     ██║   ██║██║  ██║██╔══╝  ',
  '███████║╚██████╗██║  ██║███████╗██║  ██║██║ ╚═╝ ██║ ╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
]

const SHADOW_CHARS = new Set(['╚','═','╝','║','╔','╗','╠','╣','╦','╩','╬'])
const SHEEN_STEP = 4
const SHEEN_INTERVAL_MS = 60
const LOADING_DURATION_MS = 1500

// Full SCREAM CODE art needs 85 columns; with side margins 87 is comfortable.
const FULL_LOGO_MIN_COLS = 87

// Compact logo face for narrow terminals.
const COMPACT_LOGO = ['██▄▄▄██', '▐█▄▀▄█▌']
const THEME_PRIMARY: Record<ResolvedTheme, [number, number, number]> = {
  dark: [204, 251, 35],    // #ccfb23
  light: [75, 122, 6],     // #4B7A06
}
const BLOCK_RGB: [number, number, number] = [255, 255, 255]
const LOGO_RGB: [number, number, number] = [136, 136, 136]
const DIM_RGB: [number, number, number] = [85, 85, 85]

// Breathing palette — mirrors WelcomeComponent so the loading splash and the
// welcome panel share the same hue-rotating colour (24 hues × 5 sub-steps
// = 120 frames, sat=90 lit=70). The logo's shadow characters keep the original
// flat grey base. A gradient sheen sweeps across them, then a grey sweep
// returns across the gradient, restoring the original ping-pong breathing
// cycle.
const HUE_STOPS = 24
const SUB_STEPS = 5
const BREATHE_STEPS = HUE_STOPS * SUB_STEPS

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6
  else if (max === gf) h = ((bf - rf) / d + 2) / 6
  else h = ((rf - gf) / d + 4) / 6
  return [h * 360, s * 100, l * 100]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hf = ((h % 360) + 360) % 360 / 360
  const sf = s / 100, lf = l / 100
  if (sf === 0) { const v = Math.round(lf * 255); return [v, v, v] }
  const q = lf < 0.5 ? lf * (1 + sf) : lf + sf - lf * sf
  const p = 2 * lf - q
  const hue = (t: number): number => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1/6) return p + (q-p)*6*t
    if (t < 1/2) return q
    if (t < 2/3) return p + (q-p)*(2/3-t)*6
    return p
  }
  return [Math.round(hue(hf+1/3)*255), Math.round(hue(hf)*255), Math.round(hue(hf-1/3)*255)]
}

function buildBreathingPalette(primary: [number, number, number]): [number, number, number][] {
  const [r, g, b] = primary
  const [baseHue] = rgbToHsl(r, g, b)
  const steps = HUE_STOPS * SUB_STEPS
  const palette: [number, number, number][] = []
  for (let i = 0; i < steps; i++) {
    const hueAngle = (baseHue + (i / steps) * 360) % 360
    palette.push(hslToRgb(hueAngle, 90, 70))
  }
  return palette
}

function fg(r: number, g: number, b: number) { return `\u001B[38;2;${r};${g};${b}m` }
const RESET = '\u001B[0m'
const BOLD = '\u001B[1m'
const DIM = '\u001B[2m'

function renderSheen(
  char: string,
  charIndex: number,
  sheenPos: number,
  isReversing: boolean,
  breatheColor: [number, number, number],
) {
  if (char === ' ') return ' '
  if (char === '█') return `${fg(...BLOCK_RGB)}█${RESET}`
  if (!SHADOW_CHARS.has(char)) return `${fg(...LOGO_RGB)}${char}${RESET}`
  // Ping-pong sheen: gradient wave sweeps across the grey base, then a grey
  // wave sweeps back across the gradient, matching the original breathing
  // cycle from git HEAD.
  const color = isReversing
    ? (charIndex <= sheenPos ? LOGO_RGB : breatheColor)
    : (charIndex <= sheenPos ? breatheColor : LOGO_RGB)
  return `${fg(...color)}${char}${RESET}`
}

function getLoadingText(): string { return t('loading.ai') }
function buildShimmerPalette(n: number, breatheColor: [number, number, number]) {
  const size = Math.max(8, Math.min(20, Math.ceil(n * 1.5)))
  const palette: [number, number, number][] = []
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1)
    palette.push([
      Math.round(breatheColor[0] - t * breatheColor[0] * 0.35),
      Math.round(breatheColor[1] - t * breatheColor[1] * 0.6),
      Math.round(breatheColor[2] - t * breatheColor[2] * 0.33),
    ])
  }
  return palette
}

function renderShimmer(pulse: number, breatheColor: [number, number, number]) {
  const chars = getLoadingText().split('')
  const n = chars.length
  const palette = buildShimmerPalette(n, breatheColor)
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
  for (const ch of s.replaceAll(/\u001B\[[0-9;]*[a-zA-Z]/g, '')) {
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

export function runLoadingAnimation(
  theme: ResolvedTheme = 'dark',
): Promise<void> {
  const ansi = supportsAnsi()

  if (!ansi) {
    const { cols } = getTerminalSize()
    if (cols >= FULL_LOGO_MIN_COLS) {
      for (const line of LOGO) stdout.write(`${fg(...LOGO_RGB)}${line}${RESET}\n`)
    } else {
      for (const line of COMPACT_LOGO) stdout.write(`${fg(...BLOCK_RGB)}${line}${RESET}\n`)
    }
    stdout.write(`${BOLD}${fg(...THEME_PRIMARY[theme])}${t('loading.waking')}${RESET}\n`)
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      stdout.write('\u001B[?1049h')
    }
    stdout.write('\u001B[2J')
    stdout.write('\u001B[?25l')

    const primary = THEME_PRIMARY[theme]
    const breathePalette = buildBreathingPalette(primary)
    let sheenPos = 0
    let isReversing = false
    let shimmerPulse = 0
    let breatheFrame = 0
    let phase: 'loading' | 'ready' = 'loading'

    function render() {
      const { cols, rows } = getTerminalSize()
      const lines: string[] = []
      const useFullLogo = cols >= FULL_LOGO_MIN_COLS

      const contentHeight = useFullLogo ? LOGO.length + 5 : COMPACT_LOGO.length + 5
      const topPad = Math.max(0, Math.floor((rows - contentHeight) / 2))
      for (let i = 0; i < topPad; i++) lines.push('')

      const breatheColor = breathePalette[breatheFrame] ?? primary
      if (useFullLogo) {
        for (const line of LOGO) {
          let colored = ''
          for (let ci = 0; ci < line.length; ci++) {
            colored += renderSheen(line[ci]!, ci, sheenPos, isReversing, breatheColor)
          }
          lines.push(centerPad(colored, cols))
        }
      } else {
        for (const line of COMPACT_LOGO) {
          const colored = `${fg(...BLOCK_RGB)}${line}${RESET}`
          lines.push(centerPad(colored, cols))
        }
      }
      lines.push('')

      if (phase === 'loading') {
        lines.push(centerPad(renderShimmer(shimmerPulse, breatheColor), cols))
      } else {
        lines.push(centerPad(`${BOLD}${fg(...breatheColor)}${t('loading.press_enter')}${RESET}`, cols))
      }

      lines.push('')
      lines.push('')
      lines.push(centerPad(`${fg(...DIM_RGB)}${t('loading.quit_hint')}${RESET}`, cols))

      while (lines.length < rows) lines.push('')

      stdout.write('\u001B[H')
      stdout.write(lines.join('\n'))
    }

    function tick() {
      sheenPos += SHEEN_STEP
      if (sheenPos >= 90) {
        isReversing = !isReversing
        sheenPos = 0
      }
      shimmerPulse = (shimmerPulse + 1) % getLoadingText().length
      breatheFrame = (breatheFrame + 1) % BREATHE_STEPS
      render()
    }

    function onData(data: Buffer) {
      const key = data.toString()
      if (key === '\u0003') {
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
      stdout.write('\u001B[?25h')
      if (process.platform !== 'win32') {
        stdout.write('\u001B[?1049l')
      } else {
        stdout.write('\u001B[2J\u001B[H')
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
      stdout.write('\u001B[?25h')
      if (process.platform !== 'win32') {
        stdout.write('\u001B[?1049l')
      }
      const { cols: fallbackCols } = getTerminalSize()
      if (fallbackCols >= FULL_LOGO_MIN_COLS) {
        for (const line of LOGO) stdout.write(`${fg(...LOGO_RGB)}${line}${RESET}\n`)
      } else {
        for (const line of COMPACT_LOGO) stdout.write(`${fg(...BLOCK_RGB)}${line}${RESET}\n`)
      }
      stdout.write(`${BOLD}${fg(...primary)}${t('loading.waking')}${RESET}\n`)
      resolve()
      return
    }

    stdin.on('data', onData)

    render()
    const timer = setInterval(tick, SHEEN_INTERVAL_MS)

    // The ready phase is gated only on the minimum animation duration. The
    // update-cache refresh runs detached in the background so a slow network
    // never blocks startup — next launch (or `/update`) picks up the result.
    const minDelay = new Promise<void>((resolve) => { setTimeout(resolve, LOADING_DURATION_MS); })
    void minDelay.then(() => {
      phase = 'ready'
      render()
    })
  })
}
