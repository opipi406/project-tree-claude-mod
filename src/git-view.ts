import { highlightLine, fit } from './highlight'
import type { HlState } from './highlight'
import { GIT_COLORS, clip, width } from './icons'
import { WORKTREE, refLabel, relTime } from './gitlog'
import type { Commit, DiffLine, FileChange, LogRow, RefKind } from './gitlog'
import { BOLD, GUIDE_COLOR, MUTED_COLOR } from './view'
import type { Seg, ViewRow } from './view'

export type CommitDetail = { date: string; body: string[]; files: FileChange[] }

export const SELECTED_BG = '#04395e'
export const UNFOCUSED_BG = '#2a2d2e'

const LANES = ['#61afef', '#c678dd', '#e5c07b', '#56b6c2', '#e06c75', '#98c379']
const HASH_COLOR = '#d7ba7d'
const WORKTREE_COLOR = '#7f848e'
const SOFT_COLOR = '#9da5b4'
const ACCENT = '#61afef'
const ADD_COLOR = '#81b88b'
const DEL_COLOR = '#e06c75'
const AUTHOR_COLOR = '#9cdcfe'
const MAX_GRAPH = 20
const BAR = 10
const DATE_MIN_COLS = 60
const REFS_MIN_COLS = 48
const WRAP_LIMIT = 10

const TYPE_COLORS: Record<string, string> = { feat: ADD_COLOR, fix: DEL_COLOR, docs: ACCENT, refactor: '#c678dd' }

const REF_COLORS: Record<RefKind, [string, string]> = {
  head: ['#e8f2ff', '#1f4a6e'],
  local: ['#b5e8c0', '#2d4a35'],
  remote: ['#dcc2ff', '#3a2d4d'],
  tag: ['#f0d890', '#4a3f1f'],
}

export const DIFF_BG = {
  add: { line: '#14301f', word: '#22603a', gutter: '#1a3d26', sign: ADD_COLOR },
  del: { line: '#35181b', word: '#71292e', gutter: '#45201f', sign: DEL_COLOR },
  hunk: { line: '#1a2130', fg: '#7aa2f7' },
}

const STATUS_COLORS: Record<string, string> = {
  M: GIT_COLORS.M,
  A: GIT_COLORS.A,
  D: GIT_COLORS.D,
  R: GIT_COLORS.R,
  C: GIT_COLORS.R,
  T: GIT_COLORS.M,
  '?': GIT_COLORS.U,
}

const pad = (n: number): Seg => [' '.repeat(Math.max(0, n)), null, 0]

const segsWidth = (segs: Seg[]) => segs.reduce((n, s) => n + width(s[0]), 0)

function spread(left: Seg[], right: Seg[], cols: number): Seg[] {
  const room = cols - segsWidth(right)
  const l = fit(left, Math.max(1, room - 1))

  return [...l, pad(cols - segsWidth(l) - segsWidth(right)), ...right]
}

export function graphWidth(rows: LogRow[]): number {
  return Math.min(MAX_GRAPH, Math.max(1, ...rows.map((r) => width(r.graph))))
}

export function graphSegs(row: LogRow, room: number): Seg[] {
  const c = row.commit
  const isHead = c?.refs.some((r) => r.startsWith('HEAD -> ') || r === 'HEAD') ?? false
  const node = !c ? '●' : isHead ? '◉' : c.parents.length > 1 ? '○' : '●'
  const segs: Seg[] = []
  const text = row.graph.slice(0, room)
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    const lane = LANES[Math.ceil(i / 2) % LANES.length] ?? null
    if (ch === ' ') segs.push([' ', null, 0])
    else if (ch === ':') segs.push(['┊', WORKTREE_COLOR, 0])
    else if (ch === '*' && c?.hash === WORKTREE) segs.push(['◌', WORKTREE_COLOR, 0])
    else if (ch === '*') segs.push([node, lane, isHead ? BOLD : 0])
    else if (ch === '|') segs.push(['│', lane, 0])
    else if (ch === '-') segs.push(['─', lane, 0])
    else segs.push([ch, lane, 0])
  }
  segs.push(pad(room - text.length))

  return segs
}

function refSegs(refs: string[]): Seg[] {
  return refs.flatMap((r): Seg[] => {
    const { name, kind } = refLabel(r)
    const [fg, bg] = REF_COLORS[kind]

    return [[` ${clip(name, 28)} `, fg, BOLD, bg], pad(1)]
  })
}

export function subjectSegs(c: Commit, isBold: boolean): Seg[] {
  const flags = isBold ? BOLD : 0
  if (c.hash === WORKTREE) return [[c.subject, WORKTREE_COLOR, flags]]
  const m = /^(\w+)(\([^)]*\))?!?:\s/.exec(c.subject)
  if (c.parents.length > 1 || !m) return [[c.subject, c.parents.length > 1 ? SOFT_COLOR : null, flags]]

  return [
    [m[0], TYPE_COLORS[m[1] ?? ''] ?? '#7f848e', flags],
    [c.subject.slice(m[0].length), null, flags],
  ]
}

export function commitRow(
  row: LogRow,
  o: { cols: number; graphW: number; now: number; selected: string; isFocused: boolean },
): ViewRow {
  const c = row.commit
  const lead: Seg[] = [pad(1), ...graphSegs(row, o.graphW), pad(1)]
  if (!c) return { p: '', s: fit(lead, o.cols) }
  const isSel = c.hash === o.selected
  const segs: Seg[] = [
    ...lead,
    [c.short, c.hash === WORKTREE ? WORKTREE_COLOR : HASH_COLOR, isSel ? BOLD : 0],
    c.hash === WORKTREE
      ? pad(2)
      : o.cols >= DATE_MIN_COLS
        ? [' ' + relTime(c.time, o.now).padStart(3) + '  ', MUTED_COLOR, 0]
        : pad(1),
    ...(o.cols >= REFS_MIN_COLS ? refSegs(c.refs) : []),
    ...subjectSegs(c, isSel),
  ]

  return {
    p: `c:${c.hash}`,
    s: fit(segs, o.cols),
    ...(isSel ? { bg: o.isFocused ? SELECTED_BG : UNFOCUSED_BG } : {}),
  }
}

function counts(f: { added: number; deleted: number; isBinary?: boolean }): Seg[] {
  if (f.isBinary) return [['bin', MUTED_COLOR, 0]]
  const out: Seg[] = []
  if (f.added > 0) out.push(['+' + f.added, ADD_COLOR, 0])
  if (f.added > 0 && f.deleted > 0) out.push(pad(1))
  if (f.deleted > 0) out.push(['-' + f.deleted, DEL_COLOR, 0])

  return out
}

function pathSegs(path: string, room: number, isBold: boolean): Seg[] {
  const p = width(path) <= room ? path : '…' + path.slice(path.length - Math.max(1, room - 1))
  const cut = p.lastIndexOf('/') + 1

  return [
    [p.slice(0, cut), SOFT_COLOR, 0],
    [p.slice(cut), null, isBold ? BOLD : 0],
  ]
}

export function detailRows(c: Commit, d: CommitDetail | undefined, cols: number, bodyLines: number): ViewRow[] {
  const total = (d?.files ?? []).reduce((t, f) => ({ added: t.added + f.added, deleted: t.deleted + f.deleted }), {
    added: 0,
    deleted: 0,
  })
  const head: Seg[] = [
    ['─ ', GUIDE_COLOR, 0],
    [c.short, HASH_COLOR, BOLD],
    [' ', null, 0],
  ]
  const tail: Seg[] = d
    ? [[` ${d.files.length} files  `, MUTED_COLOR, 0], ...counts(total), [' ─', GUIDE_COLOR, 0]]
    : [[' ─', GUIDE_COLOR, 0]]
  const rule: Seg[] = [
    ...head,
    ['─'.repeat(Math.max(1, cols - segsWidth(head) - segsWidth(tail))), GUIDE_COLOR, 0],
    ...tail,
  ]
  const parents =
    c.parents.length === 0
      ? 'root commit'
      : `${c.parents.length > 1 ? 'parents' : 'parent'} ${c.parents.map((p) => p.slice(0, 7)).join(' ')}`
  const rows: ViewRow[] = [
    { p: '', s: fit(rule, cols) },
    { p: '', s: fit([pad(1), ...subjectSegs(c, true)], cols) },
    {
      p: '',
      s: fit(
        [
          [' ' + c.author, AUTHOR_COLOR, 0],
          [`  ${d?.date ?? ''}  ${parents}`, MUTED_COLOR, 0],
        ],
        cols,
      ),
    },
  ]
  for (const line of (d?.body ?? []).slice(0, bodyLines))
    rows.push({ p: '', s: fit([[' ' + line, SOFT_COLOR, 0]], cols) })

  return rows
}

export function fileRow(
  f: FileChange,
  o: { cols: number; max: number; isSelected: boolean; isFocused: boolean },
): ViewRow {
  const bar = o.cols >= 56 ? BAR : 0
  const nameW = Math.max(8, o.cols - 4 - 10 - (bar ? bar + 1 : 0) - 1)
  const name = pathSegs(f.from ? `${f.from} → ${f.path}` : f.path, nameW, o.isSelected)
  const cnt = counts(f)
  const segs: Seg[] = [
    [o.isSelected && o.isFocused ? '▌' : ' ', ACCENT, 0],
    [f.status, STATUS_COLORS[f.status] ?? null, BOLD],
    pad(2),
    ...name,
    pad(nameW - segsWidth(name) + 10 - segsWidth(cnt)),
    ...cnt,
  ]
  const tot = f.added + f.deleted
  if (bar && tot > 0 && !f.isBinary) {
    const n = Math.max(1, Math.round((tot / Math.max(1, o.max)) * bar))
    let na = Math.round((n * f.added) / tot)
    if (f.added > 0 && na === 0) na = 1
    if (f.deleted > 0 && na === n && n > 1) na = n - 1
    segs.push(pad(1), ['■'.repeat(na), ADD_COLOR, 0], ['■'.repeat(n - na), DEL_COLOR, 0])
  }

  return {
    p: `f:${f.path}`,
    s: fit(segs, o.cols),
    ...(o.isSelected && o.isFocused ? { bg: SELECTED_BG } : {}),
  }
}

function markRange(segs: Seg[], range: [number, number] | undefined, bg: string): Seg[] {
  if (!range) return segs
  const out: Seg[] = []
  let pos = 0
  for (const seg of segs) {
    const [text, color, flags] = seg
    const a = pos
    const b = pos + text.length
    pos = b
    const s = Math.max(a, range[0])
    const e = Math.min(b, range[1])
    if (s >= e) {
      out.push(seg)
      continue
    }
    if (s > a) out.push([text.slice(0, s - a), color, flags])
    out.push([text.slice(s - a, e - a), color, flags, bg])
    if (e < b) out.push([text.slice(e - a), color, flags])
  }

  return out
}

function wrap(segs: Seg[], room: number, limit: number): Seg[][] {
  const lines: Seg[][] = [[]]
  let used = 0
  for (const seg of segs) {
    let chunk = ''
    for (const ch of seg[0]) {
      const w = width(ch)
      if (used + w > room) {
        if (chunk !== '') lines[lines.length - 1]?.push([chunk, ...seg.slice(1)] as Seg)
        if (lines.length === limit) {
          lines[lines.length - 1]?.push(['…', MUTED_COLOR, 0])
          return lines
        }
        lines.push([])
        used = 0
        chunk = ''
      }
      chunk += ch
      used += w
    }
    if (chunk !== '') lines[lines.length - 1]?.push([chunk, ...seg.slice(1)] as Seg)
  }

  return lines
}

export function diffRows(lines: DiffLine[], lang: string | undefined, cols: number): ViewRow[] {
  const gutter = Math.max(2, ...lines.map((l) => String(l.new ?? l.old ?? 0).length))
  const room = Math.max(8, cols - gutter - 3)
  let state: HlState

  return lines.flatMap((l): ViewRow[] => {
    if (l.kind === 'note') return [{ p: '', s: fit([[' ' + l.text, MUTED_COLOR, 0]], cols) }]
    if (l.kind === 'hunk') {
      state = undefined
      return [
        {
          p: '',
          s: fit(
            [
              [' ' + l.text, DIFF_BG.hunk.fg, BOLD],
              [' ' + (l.context ?? ''), MUTED_COLOR, 0],
            ],
            cols,
          ),
          bg: DIFF_BG.hunk.line,
        },
      ]
    }
    const hl = highlightLine(l.text, lang, state)
    state = hl.state
    const tone = l.kind === 'add' ? DIFF_BG.add : l.kind === 'del' ? DIFF_BG.del : undefined
    const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
    const code = tone ? markRange(hl.segs, l.range, tone.word) : hl.segs
    const gut = (text: string): Seg => (tone ? [text, MUTED_COLOR, 0, tone.gutter] : [text, MUTED_COLOR, 0])

    return wrap(code, room, WRAP_LIMIT).map((part, i) => ({
      p: '',
      s: [
        gut(i === 0 ? String(l.new ?? l.old).padStart(gutter) + ' ' : ' '.repeat(gutter + 1)),
        [i === 0 ? sign + ' ' : '  ', tone?.sign ?? MUTED_COLOR, BOLD],
        ...part,
      ],
      ...(tone ? { bg: tone.line } : {}),
    }))
  })
}

export function diffHeader(
  c: Commit,
  f: FileChange,
  o: { cols: number; index: number; total: number; range: string },
): ViewRow[] {
  const crumbs: Seg[] = [
    [' ‹ ', ACCENT, BOLD],
    [c.short, HASH_COLOR, BOLD],
    [' › ', GUIDE_COLOR, 0],
    ...pathSegs(f.path, Math.max(8, o.cols - 24), true),
  ]
  const info: Seg[] = [
    pad(1),
    [f.status, STATUS_COLORS[f.status] ?? null, BOLD],
    pad(2),
    ...counts(f),
    pad(3),
    ...subjectSegs(c, false).map((s): Seg => [s[0], s[1] ?? MUTED_COLOR, 0]),
  ]

  return [
    { p: 'back', s: spread(crumbs, [[`${o.index + 1}/${o.total} `, MUTED_COLOR, 0]], o.cols) },
    { p: '', s: spread(info, [[o.range + ' ', MUTED_COLOR, 0]], o.cols) },
    { p: '', s: [['─'.repeat(o.cols), GUIDE_COLOR, 0]] },
  ]
}

export function diffRule(f: FileChange, o: { cols: number; range: string; isFocused: boolean }): ViewRow {
  const line = o.isFocused ? ACCENT : GUIDE_COLOR
  const left: Seg[] = [['─ ', line, 0], ...pathSegs(f.path, Math.max(8, o.cols - 20), true), [' ', null, 0]]
  const right: Seg[] = [
    [' ' + o.range + ' ', MUTED_COLOR, 0],
    ['─', line, 0],
  ]

  return {
    p: 'zoom',
    s: fit(
      [...left, ['─'.repeat(Math.max(1, o.cols - segsWidth(left) - segsWidth(right))), line, 0], ...right],
      o.cols,
    ),
  }
}
