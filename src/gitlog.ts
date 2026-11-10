export type Commit = {
  hash: string
  short: string
  parents: string[]
  author: string
  time: number
  refs: string[]
  subject: string
}

export type LogRow = { graph: string; commit?: Commit }

export type FileChange = {
  status: string
  path: string
  from?: string
  added: number
  deleted: number
  isBinary: boolean
}

export type DiffLine = {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note'
  text: string
  context?: string
  old?: number
  new?: number
  range?: [number, number]
}

export const LOG_FORMAT = '%x1f%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s'

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export const WORKTREE = 'WORKTREE'

const REF_PREFIXES = ['refs/heads/', 'refs/remotes/', 'refs/tags/']

export function parseLog(out: string): LogRow[] {
  const rows: LogRow[] = []
  for (const line of out.split('\n')) {
    const at = line.indexOf('\x1f')
    if (at < 0) {
      if (line.trim() !== '') rows.push({ graph: line.trimEnd() })
      continue
    }
    const [hash = '', short = '', parents = '', author = '', time = '', refs = '', ...subject] = line
      .slice(at + 1)
      .split('\x1f')
    rows.push({
      graph: line.slice(0, at).trimEnd(),
      commit: {
        hash,
        short,
        parents: parents.split(' ').filter(Boolean),
        author,
        time: Number(time) || 0,
        refs: refs.split(', ').filter((r) => r !== '' && !/^refs\/remotes\/[^/]+\/HEAD$/.test(r)),
        subject: subject.join('\x1f'),
      },
    })
  }

  return rows
}

export type RefKind = 'head' | 'local' | 'remote' | 'tag'

export function refLabel(ref: string): { name: string; kind: RefKind } {
  const head = ref.startsWith('HEAD -> ')
  const raw = head ? ref.slice('HEAD -> '.length) : ref
  const tag = raw.startsWith('tag: ')
  const full = tag ? raw.slice('tag: '.length) : raw
  const prefix = REF_PREFIXES.find((p) => full.startsWith(p))
  const name = prefix ? full.slice(prefix.length) : full
  if (head) return { name: `HEAD → ${name}`, kind: 'head' }
  if (tag || prefix === 'refs/tags/') return { name, kind: 'tag' }
  if (prefix === 'refs/remotes/') return { name, kind: 'remote' }

  return { name, kind: name === 'HEAD' ? 'head' : 'local' }
}

export function parseChanges(nameStatus: string, numstat: string): FileChange[] {
  const files: FileChange[] = []
  const ns = nameStatus.split('\0')
  for (let i = 0; i < ns.length; i++) {
    const status = ns[i] ?? ''
    if (status === '') continue
    const code = status.charAt(0)
    if (code === 'R' || code === 'C') {
      files.push({ status: code, from: ns[i + 1] ?? '', path: ns[i + 2] ?? '', added: 0, deleted: 0, isBinary: false })
      i += 2
    } else {
      files.push({ status: code, path: ns[i + 1] ?? '', added: 0, deleted: 0, isBinary: false })
      i += 1
    }
  }
  const num = numstat.split('\0')
  let n = 0
  for (let i = 0; i < num.length; i++) {
    const t = num[i] ?? ''
    if (t === '') continue
    const [a = '', d = '', path = ''] = t.split('\t')
    if (path === '') i += 2
    const f = files[n++]
    if (!f) break
    f.isBinary = a === '-'
    f.added = Number(a) || 0
    f.deleted = Number(d) || 0
  }

  return files
}

function pairUp(del: DiffLine, add: DiffLine) {
  const a = del.text
  const b = add.text
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  if (Math.max(a.length, b.length) - p - s > 0.7 * Math.max(a.length, b.length)) return
  if (p === a.length - s && p === b.length - s) return
  del.range = [p, a.length - s]
  add.range = [p, b.length - s]
}

export function parseDiff(out: string, limit: number): DiffLine[] {
  const lines: DiffLine[] = []
  let old = 0
  let now = 0
  let inHunk = false
  for (const raw of out.split('\n')) {
    if (lines.length >= limit) {
      lines.push({ kind: 'note', text: `… ${limit} 行で打ち切りました` })
      break
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw)
      if (!m) continue
      old = Number(m[1])
      now = Number(m[2])
      inHunk = true
      lines.push({ kind: 'hunk', text: raw.slice(0, raw.length - (m[3] ?? '').length).trim(), context: m[3] ?? '' })
      continue
    }
    if (!inHunk) {
      if (raw.startsWith('Binary files'))
        lines.push({ kind: 'note', text: 'バイナリファイルのため差分を表示できません' })
      continue
    }
    if (raw.startsWith('\\')) continue
    const text = raw.slice(1).replace(/\t/g, '  ')
    const sign = raw.charAt(0)
    if (sign === '+') lines.push({ kind: 'add', text, new: now++ })
    else if (sign === '-') lines.push({ kind: 'del', text, old: old++ })
    else if (sign === ' ') lines.push({ kind: 'ctx', text, old: old++, new: now++ })
    else if (raw.startsWith('diff --git')) inHunk = false
  }
  for (let i = 0; i < lines.length; ) {
    if (lines[i]?.kind !== 'del') {
      i++
      continue
    }
    let j = i
    while (lines[j]?.kind === 'del') j++
    let k = j
    while (lines[k]?.kind === 'add') k++
    for (let x = 0; x < Math.min(j - i, k - j); x++) {
      const d = lines[i + x]
      const a = lines[j + x]
      if (d && a) pairUp(d, a)
    }
    i = k
  }

  return lines
}

export function relTime(sec: number, nowMs: number): string {
  const s = Math.max(0, Math.floor(nowMs / 1000) - sec)
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`
  if (s < 86400 * 60) return `${Math.floor(s / (86400 * 7))}w`
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`

  return `${Math.floor(s / (86400 * 365))}y`
}

const isHeadRef = (r: string) => r === 'HEAD' || r.startsWith('HEAD -> ')

export function withWorktree(rows: LogRow[], isDirty: boolean): LogRow[] {
  const at = rows.findIndex((r) => r.commit?.refs.some(isHeadRef))
  const row = rows[at]
  if (!isDirty || !row?.commit) return rows
  const col = Math.max(0, row.graph.indexOf('*'))
  const edge = (graph: string) => {
    const g = graph.padEnd(col + 1, ' ')
    return g.charAt(col) === ' ' ? (g.slice(0, col) + ':' + g.slice(col + 1)).trimEnd() : graph
  }
  const worktree: Commit = {
    hash: WORKTREE,
    short: 'working',
    parents: [row.commit.hash],
    author: 'working tree',
    time: 0,
    refs: [],
    subject: '未コミットの変更',
  }

  return [
    { graph: ' '.repeat(col) + '*', commit: worktree },
    ...rows.slice(0, at).map((r) => ({ ...r, graph: edge(r.graph) })),
    ...rows.slice(at),
  ]
}
