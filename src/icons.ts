import type { GitCode, IconStyle } from '../types'

export type Glyph = { glyph: string; color: string }

type Kind = { tag: string; nerd: string; color: string }

const K = (tag: string, nerd: string, color: string): Kind => ({ tag, nerd, color })

const TS = K('TS', '', '#3178c6')
const JS = K('JS', '', '#f1e05a')
const REACT = K('⚛ ', '', '#61dafb')
const PY = K('PY', '', '#4b8bbe')
const GO = K('GO', '', '#00add8')
const RS = K('RS', '', '#dea584')
const JAVA = K('JV', '', '#e76f00')
const KT = K('KT', '', '#a97bff')
const RB = K('RB', '', '#cc342d')
const PHP = K('PH', '', '#8892bf')
const HTML = K('<>', '', '#e34c26')
const CSS = K('# ', '', '#42a5f5')
const SASS = K('# ', '', '#cd6799')
const JSON_ = K('{}', '', '#cbcb41')
const MD = K('M↓', '', '#519aba')
const CONF = K('⚙ ', '', '#a074c4')
const SH = K('$ ', '', '#89e051')
const SQL = K('DB', '', '#e38c00')
const IMG = K('▣ ', '', '#a074c4')
const LOCK = K('🔒', '', '#8a8a8a')
const DOCKER = K('◆ ', '', '#2496ed')
const GIT = K('± ', '', '#f54d27')
const ENV = K('≡ ', '', '#faf743')
const C = K('C ', '', '#599eff')
const CPP = K('C+', '', '#f34b7d')
const CS = K('C#', '', '#68217a')
const SWIFT = K('SW', '', '#f05138')
const VUE = K('V ', '', '#41b883')
const SVELTE = K('S ', '', '#ff3e00')
const XML = K('<>', '', '#e37933')
const PDF = K('PD', '', '#e2574c')
const ZIP = K('▤ ', '', '#d4a35b')
const TEXT = K('≣ ', '', '#a0a0a0')
const NPM = K('np', '', '#cb3837')
const TEST = K('✓ ', '', '#73c991')
const FILE = K('· ', '', '#8a8a8a')

const BY_NAME: Record<string, Kind> = {
  'package.json': NPM,
  'package-lock.json': LOCK,
  'yarn.lock': LOCK,
  'pnpm-lock.yaml': LOCK,
  'bun.lockb': LOCK,
  'cargo.lock': LOCK,
  'poetry.lock': LOCK,
  'uv.lock': LOCK,
  dockerfile: DOCKER,
  'docker-compose.yml': DOCKER,
  'docker-compose.yaml': DOCKER,
  makefile: SH,
  '.gitignore': GIT,
  '.gitattributes': GIT,
  '.gitmodules': GIT,
  license: TEXT,
  'claude.md': MD,
}

const BY_EXT: Record<string, Kind> = {
  ts: TS,
  mts: TS,
  cts: TS,
  'd.ts': TS,
  tsx: REACT,
  jsx: REACT,
  js: JS,
  mjs: JS,
  cjs: JS,
  py: PY,
  pyi: PY,
  ipynb: PY,
  go: GO,
  rs: RS,
  java: JAVA,
  kt: KT,
  kts: KT,
  rb: RB,
  php: PHP,
  html: HTML,
  htm: HTML,
  css: CSS,
  scss: SASS,
  sass: SASS,
  less: CSS,
  json: JSON_,
  jsonc: JSON_,
  json5: JSON_,
  md: MD,
  mdx: MD,
  yml: CONF,
  yaml: CONF,
  toml: CONF,
  ini: CONF,
  conf: CONF,
  cfg: CONF,
  properties: CONF,
  sh: SH,
  bash: SH,
  zsh: SH,
  fish: SH,
  sql: SQL,
  db: SQL,
  sqlite: SQL,
  png: IMG,
  jpg: IMG,
  jpeg: IMG,
  gif: IMG,
  webp: IMG,
  svg: IMG,
  ico: IMG,
  bmp: IMG,
  lock: LOCK,
  env: ENV,
  c: C,
  h: C,
  cpp: CPP,
  cc: CPP,
  hpp: CPP,
  cs: CS,
  swift: SWIFT,
  vue: VUE,
  svelte: SVELTE,
  xml: XML,
  xlsx: ZIP,
  pdf: PDF,
  zip: ZIP,
  gz: ZIP,
  tar: ZIP,
  tgz: ZIP,
  txt: TEXT,
  log: TEXT,
  csv: TEXT,
}

function kindOf(name: string): Kind {
  const lower = name.toLowerCase()
  const named = BY_NAME[lower]
  if (named) return named
  if (lower.startsWith('.env')) return ENV
  if (/\.(test|spec)\.[a-z]+$/.test(lower) || /^test_.*\.py$/.test(lower)) return TEST
  if (lower.startsWith('readme')) return MD
  if (lower.endsWith('.d.ts')) return TS
  const dot = lower.lastIndexOf('.')

  return (dot >= 0 && BY_EXT[lower.slice(dot + 1)]) || FILE
}

export function fileIcon(name: string, style: IconStyle): Glyph {
  const kind = kindOf(name)

  return { glyph: style === 'nerd' ? kind.nerd + ' ' : kind.tag, color: kind.color }
}

const FOLDER_COLORS: Record<string, string> = {
  src: '#42a5f5',
  lib: '#42a5f5',
  app: '#42a5f5',
  test: '#73c991',
  tests: '#73c991',
  __tests__: '#73c991',
  spec: '#73c991',
  docs: '#519aba',
  doc: '#519aba',
  scripts: '#89e051',
  bin: '#89e051',
  config: '#a074c4',
  '.github': '#8a8a8a',
  '.claude': '#d97757',
  '.claude-plugin': '#d97757',
  dist: '#8a8a8a',
  build: '#8a8a8a',
  node_modules: '#8a8a8a',
}

export function folderIcon(name: string, isOpen: boolean, style: IconStyle): Glyph {
  const color = FOLDER_COLORS[name.toLowerCase()] ?? '#dcb67a'
  if (style === 'nerd') return { glyph: (isOpen ? '' : '') + ' ', color }

  return { glyph: isOpen ? '▾ ' : '▸ ', color }
}

export const GIT_COLORS: Record<GitCode, string> = {
  M: '#e2c08d',
  A: '#81b88b',
  U: '#73c991',
  D: '#c74e39',
  R: '#73c991',
  '!': '#e4676b',
}

export function width(text: string): number {
  let n = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    n +=
      cp >= 0x1100 &&
      (cp <= 0x115f ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1faff))
        ? 2
        : 1
  }

  return n
}

export function clip(text: string, room: number): string {
  if (width(text) <= room) return text
  let out = ''
  let n = 0
  for (const ch of text) {
    const w = width(ch)
    if (n + w > room - 1) break
    out += ch
    n += w
  }

  return out + '…'
}
