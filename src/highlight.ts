import { width } from './icons'
import type { Seg } from './view'

export type HlState = { end: string; color: string } | undefined

type Lang = {
  line?: string[]
  block?: [string, string]
  quotes: string[]
  multi?: string[]
  keywords?: Set<string>
  ci?: boolean
  vars?: boolean
  tags?: boolean
  quotedKeys?: boolean
  key?: RegExp
  markdown?: boolean
}

const C = {
  keyword: '#569cd6',
  control: '#c586c0',
  string: '#ce9178',
  comment: '#6a9955',
  number: '#b5cea8',
  type: '#4ec9b0',
  prop: '#9cdcfe',
  fn: '#dcdcaa',
  heading: '#569cd6',
} as const

const words = (s: string) => new Set(s.split(' '))

const CONTROL = words(
  'if else for while do switch case default break continue return throw try catch finally await yield import export from as with in of elif except raise pass match loop then fi done esac',
)

const JS = words(
  'const let var function class extends new this super typeof instanceof delete void async static get set true false null undefined interface type enum implements private public protected readonly declare namespace module keyof infer satisfies abstract',
)
const PY = words('def class lambda global nonlocal and or not is None True False self async del assert print')
const GO = words(
  'package func var const type struct interface map chan go defer select range nil true false string int int64 bool error byte rune float64',
)
const RS = words(
  'fn let mut pub struct enum impl trait use mod crate self Self super where move ref static const unsafe dyn true false Some None Ok Err',
)
const CLIKE = words(
  'class struct enum interface public private protected static final void int long float double char bool boolean byte short new this true false null nil val var fun object package namespace using virtual override const auto unsigned signed extern typedef sizeof',
)
const SH = words('function local export echo cd set unset source alias readonly declare true false')
const DOCKER = words(
  'FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS',
)
const SQL = words(
  'select from where insert into values update set delete create table alter drop index view join left right inner outer on and or not null is in as group by order having limit offset distinct union all primary key foreign references default case when then else end begin commit rollback',
)
const CSS = words('important media import keyframes from to and not only screen root')

const cLike = (keywords: Set<string>, quotes = ['"', "'", '`'], multi = ['`']): Lang => ({
  line: ['//'],
  block: ['/*', '*/'],
  quotes,
  multi,
  keywords,
})

const LANGS: Record<string, Lang> = {
  js: cLike(JS),
  go: cLike(GO, ['"', "'", '`']),
  rs: cLike(RS, ['"'], []),
  c: cLike(CLIKE, ['"', "'"], []),
  py: { line: ['#'], quotes: ['"""', "'''", '"', "'"], multi: ['"""', "'''"], keywords: PY },
  rb: { line: ['#'], quotes: ['"', "'"], keywords: words('def end class module do if unless nil true false self') },
  sh: { line: ['#'], quotes: ['"', "'"], keywords: SH, vars: true },
  docker: { line: ['#'], quotes: ['"', "'"], keywords: DOCKER, vars: true },
  make: { line: ['#'], quotes: ['"', "'"], vars: true, key: /^([\w.%/-]+)(?=\s*:)/ },
  yaml: {
    line: ['#'],
    quotes: ['"', "'"],
    keywords: words('true false null yes no'),
    key: /^(\s*(?:- )?)([^\s:#][^:#]*?)(?=:(\s|$))/,
  },
  toml: { line: ['#'], quotes: ['"""', '"', "'"], keywords: words('true false'), key: /^(\s*)([\w.-]+|\[[^\]]*\])/ },
  json: { line: ['//'], block: ['/*', '*/'], quotes: ['"'], keywords: words('true false null'), quotedKeys: true },
  css: { block: ['/*', '*/'], quotes: ['"', "'"], keywords: CSS },
  html: { block: ['<!--', '-->'], quotes: ['"', "'"], tags: true },
  sql: { line: ['--'], block: ['/*', '*/'], quotes: ["'", '"'], keywords: SQL, ci: true },
  lua: {
    line: ['--'],
    quotes: ['"', "'"],
    keywords: words('local function end if then else elseif for while do return nil true false and or not'),
  },
  md: { quotes: [], markdown: true },
}

const EXT: Record<string, string> = {
  ts: 'js',
  tsx: 'js',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  mts: 'js',
  cts: 'js',
  go: 'go',
  rs: 'rs',
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  hpp: 'c',
  cs: 'c',
  java: 'c',
  kt: 'c',
  kts: 'c',
  swift: 'c',
  scala: 'c',
  dart: 'c',
  php: 'c',
  py: 'py',
  rb: 'rb',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  fish: 'sh',
  envrc: 'sh',
  zshrc: 'sh',
  bashrc: 'sh',
  profile: 'sh',
  env: 'sh',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'toml',
  cfg: 'toml',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  svelte: 'html',
  sql: 'sql',
  lua: 'lua',
  md: 'md',
  markdown: 'md',
  mdx: 'md',
}

const NAMES: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
  gnumakefile: 'make',
  '.gitignore': 'sh',
  '.dockerignore': 'sh',
  '.editorconfig': 'toml',
}

export function langOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (NAMES[name]) return NAMES[name]
  if (name.startsWith('dockerfile')) return 'docker'
  const dot = name.lastIndexOf('.')

  return dot >= 0 ? EXT[name.slice(dot + 1)] : undefined
}

const NUMBER = /0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?/iy
const IDENT = /[A-Za-z_$][\w$-]*/y
const IDENT_STRICT = /[A-Za-z_$][\w$]*/y

function closeAt(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text.startsWith(quote, i)) return i + quote.length
  }

  return -1
}

function markdown(text: string, state: HlState): { segs: Seg[]; state: HlState } {
  const fence = /^\s*(```|~~~)/.exec(text)
  if (state) return { segs: [[text, state.color, 0]], state: fence ? undefined : state }
  if (fence) return { segs: [[text, C.string, 0]], state: { end: fence[1] ?? '```', color: C.string } }
  if (/^#{1,6}\s/.test(text)) return { segs: [[text, C.heading, 1]], state }
  const segs: Seg[] = []
  const bullet = /^(\s*)([-*+]|\d+\.)(\s)/.exec(text)
  let rest = text
  if (bullet) {
    segs.push([bullet[1] ?? '', null, 0], [bullet[2] ?? '', C.keyword, 0], [bullet[3] ?? '', null, 0])
    rest = text.slice(bullet[0].length)
  }
  for (const part of rest.split(/(`[^`]*`)/)) if (part) segs.push([part, part.startsWith('`') ? C.string : null, 0])

  return { segs, state }
}

export function highlightLine(text: string, lang: string | undefined, state: HlState): { segs: Seg[]; state: HlState } {
  const L = lang ? LANGS[lang] : undefined
  if (!L) return { segs: [[text, null, 0]], state: undefined }
  if (L.markdown) return markdown(text, state)
  const segs: Seg[] = []
  let plain = ''
  const push = (s: string, color: string | null, flags = 0) => {
    if (plain) segs.push([plain, null, 0])
    plain = ''
    if (s) segs.push([s, color, flags])
  }
  let i = 0
  if (state) {
    const at = state.color === C.comment ? text.indexOf(state.end) : closeAt(text, 0, state.end)
    if (at < 0) return { segs: [[text, state.color, 0]], state }
    const stop = state.color === C.comment ? at + state.end.length : at
    push(text.slice(0, stop), state.color)
    i = stop
    state = undefined
  } else if (L.key) {
    const m = L.key.exec(text)
    if (m && m[0]) {
      const lead = m.length > 2 ? (m[1] ?? '') : ''
      push(lead, null)
      push(m[0].slice(lead.length), C.prop)
      i = m[0].length
    }
  }
  let tagOpen = false
  while (i < text.length) {
    const ch = text.charAt(i)
    const prev = i > 0 ? text.charAt(i - 1) : ' '
    const lineMark = L.line?.find((m) => text.startsWith(m, i) && (m !== '#' || /\s/.test(prev)))
    if (lineMark) {
      push(text.slice(i), C.comment)
      return { segs, state }
    }
    if (L.block && text.startsWith(L.block[0], i)) {
      const end = text.indexOf(L.block[1], i + L.block[0].length)
      if (end < 0) {
        push(text.slice(i), C.comment)
        return { segs, state: { end: L.block[1], color: C.comment } }
      }
      push(text.slice(i, end + L.block[1].length), C.comment)
      i = end + L.block[1].length
      continue
    }
    const quote = L.quotes.find((q) => text.startsWith(q, i))
    if (quote) {
      const end = closeAt(text, i + quote.length, quote)
      if (end < 0) {
        push(text.slice(i), C.string)
        return { segs, state: L.multi?.includes(quote) ? { end: quote, color: C.string } : undefined }
      }
      const isKey = L.quotedKeys && /^\s*:/.test(text.slice(end))
      push(text.slice(i, end), isKey ? C.prop : C.string)
      i = end
      continue
    }
    if (L.vars && ch === '$') {
      const m = /\$(\{[^}]*\}|\(\w+\)|[\w@#?*!$-])[\w]*/y
      m.lastIndex = i
      const hit = m.exec(text)
      if (hit) {
        push(hit[0], C.prop)
        i += hit[0].length
        continue
      }
    }
    if (L.tags && ch === '<') {
      const m = /<\/?[A-Za-z][\w:.-]*/y
      m.lastIndex = i
      const hit = m.exec(text)
      if (hit) {
        const slash = hit[0].startsWith('</') ? 2 : 1
        push(hit[0].slice(0, slash), null)
        push(hit[0].slice(slash), C.keyword)
        i += hit[0].length
        tagOpen = true
        continue
      }
    }
    if (L.tags && ch === '>') tagOpen = false
    if (/\d/.test(ch) && !/[\w$]/.test(prev)) {
      NUMBER.lastIndex = i
      const hit = NUMBER.exec(text)
      if (hit) {
        push(hit[0], C.number)
        i += hit[0].length
        continue
      }
    }
    if (/[A-Za-z_$]/.test(ch) && !/[\w$]/.test(prev)) {
      const re = L.tags || lang === 'css' ? IDENT : IDENT_STRICT
      re.lastIndex = i
      const word = re.exec(text)?.[0] ?? ch
      const key = L.ci ? word.toLowerCase() : word
      const next = text
        .slice(i + word.length)
        .trimStart()
        .charAt(0)
      if (L.tags) push(word, tagOpen ? C.prop : null)
      else if (L.keywords?.has(key)) push(word, CONTROL.has(key) ? C.control : C.keyword)
      else if (CONTROL.has(key) && lang !== 'css' && lang !== 'yaml' && lang !== 'toml' && lang !== 'json')
        push(word, C.control)
      else if (next === '(' && lang !== 'css') push(word, C.fn)
      else if (/^[A-Z][a-z]/.test(word) && L.block) push(word, C.type)
      else plain += word
      i += word.length
      continue
    }
    plain += ch
    i++
  }
  push('', null)

  return { segs, state }
}

export function fit(segs: Seg[], room: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const seg of segs) {
    const [text, color, flags, bg] = seg
    const w = width(text)
    if (used + w <= room) {
      out.push(seg)
      used += w
      continue
    }
    let cut = ''
    for (const ch of text) {
      const cw = width(ch)
      if (used + cw > room - 1) break
      cut += ch
      used += cw
    }
    out.push(bg === undefined ? [cut + '…', color, flags] : [cut + '…', color, flags, bg])
    break
  }

  return out
}
