import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GitCode, GitFocus, IconStyle, RepoSnapshot, ViewMode } from '../types'
import { isSame, scan } from '../src/git'
import { EMPTY_TREE, LOG_FORMAT, WORKTREE, parseChanges, parseDiff, parseLog, withWorktree } from '../src/gitlog'
import type { Commit, DiffLine, FileChange, LogRow } from '../src/gitlog'
import { commitRow, detailRows, diffHeader, diffRows, diffRule, fileRow, graphWidth } from '../src/git-view'
import type { CommitDetail } from '../src/git-view'
import { search } from '../src/fuzzy'
import { fit, highlightLine, langOf } from '../src/highlight'
import type { HlState } from '../src/highlight'
import { GIT_COLORS, clip, fileIcon, width } from '../src/icons'
import { allDirs, ancestors, basename, buildIndex, dirStatuses, flatten } from '../src/tree'
import type { Index, Row } from '../src/tree'
import { BOLD, DIM, GUIDE_COLOR, MUTED_COLOR, STRIKE, formatRow } from '../src/view'
import type { PreviewView, Seg, ViewMessage, ViewProps, ViewRow } from '../src/view'

const PANE = 'project-tree'
const COMMAND = 'project-tree'
const TITLE = 'Explorer'
const ROW_LIMIT = 5000
const RESULT_LIMIT = 60
const POLL_MS = 5000
const PLAIN_POLL_MS = 60000
const SCAN_TIMEOUT_MS = 20000
const SLEPT_SCAN_MS = SCAN_TIMEOUT_MS * 3
const HEAD_ROWS = 2
const POPUP_BG = '#24272e'
const HIT_COLOR = '#18a3ff'
const BRANCH_COLOR = '#8fbcbb'
const PREVIEW_CHARS = 100000
const LOG_LIMIT = 500
const DIFF_LIMIT = 5000
const CACHE_LIMIT = 50
const FALLBACK_COMMITS = 200
const COMBINED_MIN_ROWS = 24

const EMPTY: RepoSnapshot = {
  root: '',
  name: '',
  isGit: false,
  branch: '',
  ahead: 0,
  behind: 0,
  files: [],
  status: {},
  isTruncated: false,
  rev: 0,
}

const repo = atom({ plugin: 'project-tree', key: 'repo' } as const, EMPTY, { shape: 'repo-1' })
const expanded = atom({ plugin: 'project-tree', key: 'expanded' } as const, [] as string[], { shape: 'expanded-1' })
const selected = atom({ plugin: 'project-tree', key: 'selected' } as const, '')
const active = atom({ plugin: 'project-tree', key: 'active' } as const, '')
const mode = atom({ plugin: 'project-tree', key: 'mode' } as const, 'tree' as ViewMode)
const query = atom({ plugin: 'project-tree', key: 'query' } as const, '')
const scrollTop = atom({ plugin: 'project-tree', key: 'scrollTop' } as const, 0)
const previewPath = atom({ plugin: 'project-tree', key: 'previewPath' } as const, '')
const previewTop = atom({ plugin: 'project-tree', key: 'previewTop' } as const, 0)
const gitCommit = atom({ plugin: 'project-tree', key: 'gitCommit' } as const, '')
const gitFile = atom({ plugin: 'project-tree', key: 'gitFile' } as const, '')
const gitFocus = atom({ plugin: 'project-tree', key: 'gitFocus' } as const, 'graph' as GitFocus)
const gitTop = atom({ plugin: 'project-tree', key: 'gitTop' } as const, 0)
const gitDiffTop = atom({ plugin: 'project-tree', key: 'gitDiffTop' } as const, 0)

let sessionCwd = ''
let isScanning = false
let isFailing = false
let lastPlainScanAt = 0
let pending: { cancel: () => void } | undefined
let cached: { rev: number; root: string; index: Index; dirCodes: Map<string, GitCode> } | undefined
let treeRows = 20
let previewRows = 20
let loaded: { path: string; mtimeMs: number; lines: string[]; states: HlState[]; error?: string } | undefined
let drawsOwnWindow = false
let logCache: { root: string; rev: number; rows: LogRow[] } | undefined
const details = new Map<string, CommitDetail>()
const diffs = new Map<string, DiffLine[]>()
let drawnDiff: { key: string; cols: number; rows: ViewRow[] } | undefined
let graphRows = 10
let diffBodyRows = 20
let fileRows = 5
let isSplit = false
let worktreeGen = 0
let worktreeDetail: { gen: number; detail: CommitDetail } | undefined

function indexOf(snap: RepoSnapshot) {
  if (!cached || cached.rev !== snap.rev || cached.root !== snap.root) {
    cached = { rev: snap.rev, root: snap.root, index: buildIndex(snap.files), dirCodes: dirStatuses(snap.status) }
  }

  return cached
}

async function visibleRows($: EngineInterface): Promise<Row[]> {
  const snap = await read($, repo)

  return flatten(indexOf(snap).index, new Set(await read($, expanded)), ROW_LIMIT)
}

async function refresh($: EngineInterface, isForced = true) {
  if (isScanning || sessionCwd === '') return
  const now = await $.clock.now()
  const current = await read($, repo)
  if (!isForced && current.root !== '' && !current.isGit && now - lastPlainScanAt < PLAIN_POLL_MS) return
  isScanning = true
  lastPlainScanAt = now
  try {
    const next = await scan((argv, cwd) => $.process.run(argv, { cwd, timeoutMs: SCAN_TIMEOUT_MS }), sessionCwd)
    if (isFailing) $.ui.log('project-tree: scan recovered')
    isFailing = false
    worktreeGen++
    if (isGitView(await read($, mode))) $.ui.invalidate('ui.render')
    const prev = await read($, repo)
    if (prev.root !== '' && isSame(prev, next)) return
    await update($, repo, (old) => ({ ...next, rev: old.rev + 1 }))
    if (prev.root !== next.root) {
      const saved = await $.store.get(`expanded:${next.root}`)
      if (Array.isArray(saved)) await update($, expanded, () => saved.filter((x) => typeof x === 'string'))
    }
  } catch (err) {
    const hasSlept = (await $.clock.now()) - now > SLEPT_SCAN_MS
    if (!hasSlept && !isFailing) $.ui.log(`project-tree: scan failed: ${String(err)}`)
    if (!hasSlept) isFailing = true
  } finally {
    isScanning = false
  }
}

function scheduleRefresh($: EngineInterface) {
  pending?.cancel()
  pending = $.clock.after(400, () => {
    pending = undefined
    void refresh($)
  })
}

async function setExpanded($: EngineInterface, fn: (list: string[]) => string[]) {
  const list = await update($, expanded, fn)
  const { root } = await read($, repo)
  if (root !== '') await $.store.set(`expanded:${root}`, list)
}

async function toggle($: EngineInterface, dir: string) {
  await setExpanded($, (list) => (list.includes(dir) ? list.filter((x) => x !== dir) : [...list, dir]))
}

async function scrollIntoView($: EngineInterface, path: string) {
  if (!drawsOwnWindow) {
    await $.ui.scroll({ in: PANE, to: { key: `n:${path}` }, block: 'nearest' })
    return
  }
  const rows = await visibleRows($)
  const at = rows.findIndex((r) => r.path === path)
  if (at < 0) return
  await update($, scrollTop, (top) => (at < top ? at : at >= top + treeRows ? at - treeRows + 1 : top))
}

const APP_LOOKUP =
  'ObjC.import("AppKit"); function run(a) { var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(a[0])); return u.isNil() ? "" : u.path.js }'
const appCache = new Map<string, string>()

async function defaultApp($: EngineInterface, abs: string): Promise<string> {
  const known = appCache.get(abs)
  if (known !== undefined) return known
  const found = await $.process
    .run(['osascript', '-l', 'JavaScript', '-e', APP_LOOKUP, abs], { timeoutMs: 5000 })
    .catch(() => undefined)
  const app = found?.exitCode === 0 ? basename(found.stdout.trim()).replace(/\.app$/, '') : ''
  appCache.set(abs, app)

  return app
}

async function select($: EngineInterface, path: string) {
  await update($, selected, () => path)
  await scrollIntoView($, path)
}

function absolute(root: string, rel: string): string {
  return rel === '' ? root : `${root}/${rel}`
}

async function mention($: EngineInterface, rel: string) {
  const { root } = await read($, repo)
  const abs = absolute(root, rel)
  const path = sessionCwd !== '' && abs.startsWith(sessionCwd + '/') ? abs.slice(sessionCwd.length + 1) : abs
  await $.prompt.fill({ text: `@${/\s/.test(path) ? `"${path}"` : path} `, mode: 'insert' })
}

async function copyPath($: EngineInterface, rel: string, isAbsolute: boolean) {
  const { root } = await read($, repo)
  const text = isAbsolute ? absolute(root, rel) : rel
  const copied = await $.ui.copy({ text })
  $.ui.toast(copied.isCopied ? `Copied ${text}` : `Copy failed: ${copied.reason ?? 'unknown'}`)
}

async function reveal($: EngineInterface, rel: string) {
  if (rel === '') {
    $.ui.toast('No file opened by Claude yet')
    return
  }
  await update($, mode, () => 'tree')
  await setExpanded($, (list) => [...new Set([...list, ...ancestors(rel)])])
  await update($, selected, () => rel)
  if (!drawsOwnWindow) await $.clock.sleep(120)
  const rows = await visibleRows($)
  const at = rows.findIndex((r) => r.path === rel)
  if (drawsOwnWindow && at >= 0) await update($, scrollTop, () => Math.max(0, at - Math.floor(treeRows / 2)))
  else await scrollIntoView($, rel)
}

async function openWithDefaultApp($: EngineInterface, rel: string) {
  if (rel === '') {
    $.ui.toast('ファイルを選択してください')
    return
  }
  const { root } = await read($, repo)
  const abs = absolute(root, rel)
  const opened = await $.process.run(['open', abs], { timeoutMs: 10000 }).catch(() => undefined)
  const app = (await defaultApp($, abs)) || '既定のアプリ'
  $.ui.toast(opened?.exitCode === 0 ? `${app} で開きました: ${basename(rel)}` : `開けませんでした: ${basename(rel)}`)
}

async function loadPreview($: EngineInterface, abs: string) {
  const info = await $.fs.stat(abs).catch(() => undefined)
  if (loaded?.path === abs && loaded.mtimeMs === info?.mtimeMs) return loaded
  const fail = (error: string) => (loaded = { path: abs, mtimeMs: info?.mtimeMs ?? 0, lines: [], states: [], error })
  if (!info) return fail('ファイルが見つかりません')
  const text = await $.fs.read(abs).catch((err: unknown) => err)
  if (typeof text !== 'string') return fail(`読み込めませんでした: ${String(text)}`)
  if (text.includes('\0')) return fail('バイナリファイルのため表示できません')
  loaded = {
    path: abs,
    mtimeMs: info.mtimeMs,
    states: [undefined],
    lines: text
      .replace(/\p{Cc}/gu, (c) => (c === '\t' || c === '\n' ? c : ''))
      .replace(/\n$/, '')
      .split('\n'),
  }

  return loaded
}

async function openPreview($: EngineInterface, rel: string) {
  const snap = await read($, repo)
  if (!snap.files.includes(rel)) {
    $.ui.toast(rel === '' ? 'ファイルを選択してください' : 'フォルダはプレビューできません')
    return
  }
  await update($, previewPath, () => rel)
  await update($, previewTop, () => 0)
  await update($, mode, () => 'preview')
}

async function scrollPreview($: EngineInterface, to: (top: number, total: number) => number) {
  const { root } = await read($, repo)
  const total = (await loadPreview($, absolute(root, await read($, previewPath)))).lines.length
  await update($, previewTop, (top) => Math.max(0, Math.min(to(top, total), total - previewRows)))
}

async function previewKey($: EngineInterface, k: Extract<ViewMessage, { t: 'key' }>['k']) {
  const half = Math.max(1, Math.floor(previewRows / 2))
  if (k === 'preview' || k === 'close') return update($, mode, () => 'tree')
  if (k === 'open') return openWithDefaultApp($, await read($, previewPath))
  if (k === 'down') return scrollPreview($, (top) => top + 1)
  if (k === 'up') return scrollPreview($, (top) => top - 1)
  if (k === 'pagedown') return scrollPreview($, (top) => top + half)
  if (k === 'pageup') return scrollPreview($, (top) => top - half)
  if (k === 'home') return scrollPreview($, () => 0)
  if (k === 'end') return scrollPreview($, (_, total) => total)
}

async function revealInFinder($: EngineInterface, rel: string) {
  const { root } = await read($, repo)
  await $.process.run(['open', '-R', absolute(root, rel)], { timeoutMs: 10000 }).catch(() => undefined)
}

async function click($: EngineInterface, path: string, isDouble: boolean) {
  const rows = await visibleRows($)
  const row = rows.find((r) => r.path === path)
  if (!row) return
  await update($, selected, () => path)
  if (row.kind === 'dir') {
    if (!isDouble) await toggle($, path)
    return
  }
  if (isDouble) await mention($, path)
}

async function key($: EngineInterface, k: Extract<ViewMessage, { t: 'key' }>['k']) {
  const view = await read($, mode)
  if (view === 'preview') return previewKey($, k)
  if (isGitView(view)) return gitKey($, k)
  if (k === 'git') return update($, mode, () => 'git')
  if (k === 'find') return openFind($, '')
  if (k === 'preview') return openPreview($, await read($, selected))
  if (k === 'open') return openWithDefaultApp($, await read($, selected))
  if (k === 'close') return
  if (k === 'collapse') return setExpanded($, () => [])
  if (k === 'refresh') return refresh($)
  if (k === 'expand') {
    const snap = await read($, repo)
    return setExpanded($, () => allDirs(indexOf(snap).index))
  }
  const rows = await visibleRows($)
  if (rows.length === 0) return
  const sel = await read($, selected)
  const at = rows.findIndex((r) => r.path === sel)
  const row = rows[at]
  if (k === 'up') return select($, rows[Math.max(0, at - 1)]?.path ?? '')
  if (k === 'down') return select($, rows[Math.min(rows.length - 1, at + 1)]?.path ?? '')
  if (k === 'home') return select($, rows[0]?.path ?? '')
  const half = Math.max(1, Math.floor(treeRows / 2))
  if (k === 'pagedown') return select($, rows[Math.min(rows.length - 1, at + half)]?.path ?? '')
  if (k === 'pageup') return select($, rows[Math.max(0, at - half)]?.path ?? '')
  if (k === 'end') return select($, rows[rows.length - 1]?.path ?? '')
  if (!row) return select($, rows[0]?.path ?? '')
  if (k === 'enter') return row.kind === 'dir' ? toggle($, row.path) : mention($, row.path)
  if (k === 'right' && row.kind === 'dir') {
    if (!row.isOpen) return toggle($, row.path)
    const child = rows[at + 1]
    if (child && child.depth > row.depth) return select($, child.path)
    return
  }
  if (k === 'left') {
    if (row.kind === 'dir' && row.isOpen) return toggle($, row.path)
    for (let i = at - 1; i >= 0; i--) {
      const up = rows[i]
      if (up && up.depth < row.depth) return select($, up.path)
    }
  }
}

async function pickResult($: EngineInterface, rel: string) {
  await update($, query, () => '')
  await reveal($, rel)
}

const isGitView = (view: ViewMode) => view === 'git' || view === 'git-diff'

function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.set(key, value)
  const oldest = map.keys().next().value
  if (map.size > CACHE_LIMIT && oldest !== undefined) map.delete(oldest)
}

async function git($: EngineInterface, root: string, args: string[]): Promise<string | undefined> {
  const r = await $.process.run(['git', ...args], { cwd: root, timeoutMs: SCAN_TIMEOUT_MS }).catch(() => undefined)

  return r?.exitCode === 0 ? r.stdout : undefined
}

async function loadLog($: EngineInterface): Promise<LogRow[]> {
  const snap = await read($, repo)
  if (!snap.isGit) return []
  if (logCache?.root === snap.root && logCache.rev === snap.rev) return logCache.rows
  const out = await git($, snap.root, [
    'log',
    '--graph',
    '--all',
    '--date-order',
    '--decorate=full',
    `-n${LOG_LIMIT}`,
    `--format=${LOG_FORMAT}`,
  ])
  const rows = out === undefined ? [] : withWorktree(parseLog(out), Object.keys(snap.status).length > 0)
  logCache = { root: snap.root, rev: snap.rev, rows }

  return rows
}

const commitsOf = (rows: LogRow[]) => rows.flatMap((r) => (r.commit ? [r.commit] : []))

async function currentCommit($: EngineInterface, rows: LogRow[]): Promise<Commit | undefined> {
  const list = commitsOf(rows)
  const hash = await read($, gitCommit)

  return list.find((c) => c.hash === hash) ?? list[0]
}

async function loadWorktreeDetail($: EngineInterface): Promise<CommitDetail> {
  if (worktreeDetail?.gen === worktreeGen) return worktreeDetail.detail
  const snap = await read($, repo)
  const [names, nums] = await Promise.all([
    git($, snap.root, ['diff', '-M', '--name-status', '-z', 'HEAD']),
    git($, snap.root, ['diff', '-M', '--numstat', '-z', 'HEAD']),
  ])
  const untracked = Object.entries(snap.status)
    .filter(([, code]) => code === 'U')
    .map(([path]): FileChange => ({ status: '?', path, added: 0, deleted: 0, isBinary: false }))
  const detail: CommitDetail = { date: '', body: [], files: [...parseChanges(names ?? '', nums ?? ''), ...untracked] }
  worktreeDetail = { gen: worktreeGen, detail }

  return detail
}

async function loadDetail($: EngineInterface, c: Commit): Promise<CommitDetail> {
  if (c.hash === WORKTREE) return loadWorktreeDetail($)
  const known = details.get(c.hash)
  if (known) return known
  const { root } = await read($, repo)
  const base = c.parents[0] ?? EMPTY_TREE
  const [meta, names, nums] = await Promise.all([
    git($, root, ['show', '-s', '--date=format:%Y-%m-%d %H:%M', '--format=%ad%x1f%b', c.hash]),
    git($, root, ['diff', '-M', '--name-status', '-z', base, c.hash]),
    git($, root, ['diff', '-M', '--numstat', '-z', base, c.hash]),
  ])
  const [date = '', body = ''] = (meta ?? '').split('\x1f')
  const detail: CommitDetail = {
    date: date.trim(),
    body: body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    files: parseChanges(names ?? '', nums ?? ''),
  }
  if (meta !== undefined && names !== undefined && nums !== undefined) remember(details, c.hash, detail)

  return detail
}

async function worktreeDiff($: EngineInterface, root: string, f: FileChange): Promise<string | undefined> {
  if (f.status !== '?') {
    return git($, root, [
      'diff',
      '-M',
      '--no-color',
      '--no-ext-diff',
      '-U3',
      'HEAD',
      '--',
      ...(f.from ? [f.from] : []),
      f.path,
    ])
  }
  const r = await $.process
    .run(['git', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', f.path], {
      cwd: root,
      timeoutMs: SCAN_TIMEOUT_MS,
    })
    .catch(() => undefined)

  return r && r.exitCode <= 1 ? r.stdout : undefined
}

const diffKey = (c: Commit, path: string) => `${c.hash}:${path}${c.hash === WORKTREE ? `@${worktreeGen}` : ''}`

async function loadDiff($: EngineInterface, c: Commit, f: FileChange): Promise<DiffLine[]> {
  const key = diffKey(c, f.path)
  const known = diffs.get(key)
  if (known) return known
  const { root } = await read($, repo)
  const out =
    c.hash === WORKTREE
      ? await worktreeDiff($, root, f)
      : await git($, root, [
          'diff',
          '-M',
          '--no-color',
          '--no-ext-diff',
          '-U3',
          c.parents[0] ?? EMPTY_TREE,
          c.hash,
          '--',
          ...(f.from ? [f.from] : []),
          f.path,
        ])
  if (out === undefined) return [{ kind: 'note', text: '差分を取得できませんでした' }]
  const lines = parseDiff(out, DIFF_LIMIT)
  const result: DiffLine[] = lines.length > 0 ? lines : [{ kind: 'note', text: '表示できる差分がありません' }]
  remember(diffs, key, result)

  return result
}

async function currentFile($: EngineInterface, files: FileChange[]): Promise<FileChange | undefined> {
  const path = await read($, gitFile)

  return files.find((f) => f.path === path) ?? files[0]
}

async function selectCommit($: EngineInterface, rows: LogRow[], c: Commit) {
  await update($, gitCommit, () => c.hash)
  await update($, gitFile, () => '')
  await update($, gitDiffTop, () => 0)
  const at = rows.findIndex((r) => r.commit?.hash === c.hash)
  await update($, gitTop, (top) => (at < top ? at : at >= top + graphRows ? at - graphRows + 1 : top))
}

async function moveCommit($: EngineInterface, by: number) {
  const rows = await loadLog($)
  const list = commitsOf(rows)
  const cur = await currentCommit($, rows)
  const at = list.findIndex((c) => c === cur)
  const next = list[Math.max(0, Math.min(list.length - 1, at + by))]
  if (next) await selectCommit($, rows, next)
}

async function moveFile($: EngineInterface, by: number) {
  const c = await currentCommit($, await loadLog($))
  if (!c) return
  const { files } = await loadDetail($, c)
  const cur = await currentFile($, files)
  const next = files[Math.max(0, Math.min(files.length - 1, (cur ? files.indexOf(cur) : 0) + by))]
  if (!next) return
  await update($, gitFile, () => next.path)
  await update($, gitDiffTop, () => 0)
}

async function zoomDiff($: EngineInterface) {
  await update($, gitFocus, () => 'diff')
  await update($, mode, () => 'git-diff')
}

async function scrollDiff($: EngineInterface, to: (top: number, total: number) => number) {
  const c = await currentCommit($, await loadLog($))
  if (!c) return
  const f = await currentFile($, (await loadDetail($, c)).files)
  if (!f) return
  const total = (await loadDiff($, c, f)).length
  await update($, gitDiffTop, (top) => Math.max(0, Math.min(to(top, total), total - diffBodyRows)))
}

const FOCUS_ORDER: GitFocus[] = ['graph', 'files', 'diff']

async function currentFocus($: EngineInterface): Promise<GitFocus> {
  const focus = await read($, gitFocus)

  return isSplit && focus === 'diff' ? 'files' : focus
}

async function gitKey($: EngineInterface, k: Extract<ViewMessage, { t: 'key' }>['k']) {
  const view = await read($, mode)
  if (k === 'git') return update($, mode, () => 'tree')
  if (k === 'refresh') {
    logCache = undefined
    await refresh($)
    return $.ui.invalidate('ui.render')
  }
  if (k === 'next') return moveFile($, 1)
  if (k === 'prev') return moveFile($, -1)
  if (k === 'next-commit') return moveCommit($, 1)
  if (k === 'prev-commit') return moveCommit($, -1)
  if (view === 'git-diff' && (k === 'close' || k === 'space' || k === 'left')) return update($, mode, () => 'git')
  if (k === 'close') return update($, mode, () => 'tree')
  const focus = view === 'git-diff' ? 'diff' : await currentFocus($)
  if (k === 'tab') {
    const order = isSplit ? FOCUS_ORDER.slice(0, 2) : FOCUS_ORDER
    return update($, gitFocus, () => order[(order.indexOf(focus) + 1) % order.length] ?? 'graph')
  }
  if (k === 'space') return focus === 'graph' ? update($, gitFocus, () => 'files') : zoomDiff($)
  const rows = focus === 'graph' ? graphRows : focus === 'diff' ? diffBodyRows : fileRows
  const half = Math.max(1, Math.floor(rows / 2))
  const step: Partial<Record<typeof k, number>> = {
    down: 1,
    up: -1,
    pagedown: half,
    pageup: -half,
    home: -DIFF_LIMIT,
    end: DIFF_LIMIT,
  }
  const by = step[k]
  if (by === undefined) return
  if (focus === 'graph') return moveCommit($, by)
  if (focus === 'files') return moveFile($, by)

  return scrollDiff($, (top) => top + by)
}

async function gitScroll($: EngineInterface, by: number) {
  const focus = (await read($, mode)) === 'git-diff' ? 'diff' : await currentFocus($)
  if (focus === 'graph') return moveCommit($, by)
  if (focus === 'files') return moveFile($, by)

  return scrollDiff($, (top) => top + by)
}

async function gitClick($: EngineInterface, p: string) {
  if (p === 'back') return update($, mode, () => 'git')
  if (p === 'zoom') return zoomDiff($)
  if (p.startsWith('f:')) {
    await update($, gitFocus, () => 'files')
    await update($, gitFile, () => p.slice(2))
    return update($, gitDiffTop, () => 0)
  }
  if (!p.startsWith('c:')) return
  const rows = await loadLog($)
  const c = commitsOf(rows).find((x) => x.hash === p.slice(2))
  if (!c) return
  await update($, gitFocus, () => 'graph')
  await selectCommit($, rows, c)
}

async function gitBody(
  $: EngineInterface,
  snap: RepoSnapshot,
  cols: number,
  height: number | undefined,
  split: boolean,
): Promise<ViewRow[]> {
  const note = (text: string): ViewRow[] => [{ p: '', s: [[' ' + text, MUTED_COLOR, 0]] }]
  if (!snap.isGit) return note('git リポジトリではありません')
  const rows = await loadLog($)
  const c = await currentCommit($, rows)
  if (!c) return note('コミットがありません')
  const detail = await loadDetail($, c)
  const file = await currentFile($, detail.files)
  const view = await read($, mode)
  const diffBody = async () => {
    if (!file) return []
    const key = diffKey(c, file.path)
    if (drawnDiff?.key !== key || drawnDiff.cols !== cols) {
      drawnDiff = { key, cols, rows: diffRows(await loadDiff($, c, file), langOf(file.path), cols) }
    }

    return drawnDiff.rows
  }
  const window = async (body: ViewRow[], room: number) => {
    diffBodyRows = room
    const top = Math.max(0, Math.min(await read($, gitDiffTop), body.length - room))
    const range = body.length === 0 ? '0/0' : `${top + 1}-${Math.min(body.length, top + room)}/${body.length}`

    return { shown: body.slice(top, top + room), range }
  }

  if (view === 'git-diff') {
    if (!file) return [{ p: 'back', s: [[' ‹ 変更ファイルがありません', MUTED_COLOR, 0]] }]
    const body = await diffBody()
    const { shown, range } = await window(body, height === undefined ? body.length : Math.max(1, height - 3))
    const header = diffHeader(c, file, {
      cols,
      index: detail.files.indexOf(file),
      total: detail.files.length,
      range,
    })

    return [...header, ...shown]
  }

  isSplit = split
  const focus = await currentFocus($)
  const now = await $.clock.now()
  const max = Math.max(1, ...detail.files.map((f) => f.added + f.deleted))
  const info = detailRows(c, detail, cols, height === undefined ? 2 : 0)
  const files = detail.files.map((f) => fileRow(f, { cols, max, isSelected: f === file, isFocused: focus === 'files' }))
  if (c.parents.length > 1)
    files.unshift({ p: '', s: [[`   first parent (${c.parents[0]?.slice(0, 7)}) との差分`, MUTED_COLOR, 0]] })
  if (files.length === 0) files.push(...note('変更ファイルがありません'))
  const shownCommits = height === undefined ? rows.slice(0, FALLBACK_COMMITS) : rows
  const graphW = graphWidth(shownCommits)
  const toRow = (r: LogRow) => commitRow(r, { cols, graphW, now, selected: c.hash, isFocused: focus === 'graph' })
  const body = await diffBody()

  if (height === undefined) {
    const { shown, range } = await window(body, body.length)
    const rule = file ? [diffRule(file, { cols, range, isFocused: false })] : []
    return [...shownCommits.map(toRow), ...info, ...files, ...rule, ...shown]
  }

  const graphH = Math.max(3, Math.floor(split ? (height - info.length) * 0.55 : height * 0.3))
  const fileRoom = split ? Math.max(2, height - graphH - info.length) : Math.max(2, Math.floor(height * 0.18))
  const diffRoom = Math.max(1, height - graphH - info.length - fileRoom - 1)
  graphRows = graphH
  fileRows = fileRoom
  const at = rows.findIndex((r) => r.commit?.hash === c.hash)
  const stored = await read($, gitTop)
  const top = Math.max(
    0,
    Math.min(at < stored ? at : at >= stored + graphH ? at - graphH + 1 : stored, rows.length - graphH),
  )
  const graph = rows.slice(top, top + graphH).map(toRow)
  while (graph.length < graphH) graph.push({ p: '', s: [] })
  const fileAt = file ? files.findIndex((r) => r.p === `f:${file.path}`) : 0
  const fileTop = Math.max(0, Math.min(fileAt - fileRoom + 1, files.length - fileRoom))
  const fileList = files.slice(fileTop, fileTop + fileRoom)
  while (fileList.length < fileRoom) fileList.push({ p: '', s: [] })
  if (split) return [...graph, ...info, ...fileList].slice(0, height)
  const { shown, range } = await window(body, diffRoom)
  const rule = file
    ? diffRule(file, { cols, range, isFocused: focus === 'diff' })
    : { p: '', s: [['─'.repeat(cols), GUIDE_COLOR, 0] as Seg] }

  return [...graph, ...info, ...fileList, rule, ...shown].slice(0, height)
}

function openPane($: EngineInterface, isFocused: boolean) {
  return $.ui.open({ id: PANE, title: TITLE, ...(isFocused ? { focus: true as const } : {}) })
}

async function openFind($: EngineInterface, initial: string) {
  await update($, query, () => initial)
  await update($, mode, () => 'find')
  await openPane($, true)
  const moved = await $.ui.focus({ requestId: PANE, key: 'q' }).catch((err: unknown) => ({ deny: String(err) }))
  if (moved.deny) $.ui.log(`project-tree: search focus refused: ${moved.deny}`)
}

export const register: Register = (on, options) => {
  const style: IconStyle = options.icons === 'nerd' ? 'nerd' : 'basic'
  const opensOnStart = options.autoOpen === true

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    await $.command.register({ name: COMMAND, description: '最寄りのgitリポジトリのExplorerペインを開く' })
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($, false))
    if (opensOnStart) void openPane($, false)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($) => {
    await update($, mode, () => 'tree')
    await update($, query, () => '')
    await update($, previewPath, () => '')
    await update($, previewTop, () => 0)
    await update($, selected, () => '')
    await update($, scrollTop, () => 0)
    await update($, gitCommit, () => '')
    await update($, gitFile, () => '')
    await update($, gitFocus, () => 'graph')
    await update($, gitTop, () => 0)
    await update($, gitDiffTop, () => 0)
    const opened = await openPane($, true)

    return { text: opened.isPlaced ? 'Explorer を開きました。' : `Explorer を開けませんでした: ${opened.reason}` }
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const args = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    const target =
      typeof args.file_path === 'string'
        ? args.file_path
        : typeof args.notebook_path === 'string'
          ? args.notebook_path
          : undefined
    if (target !== undefined && ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(e.tool)) {
      const { root } = await read($, repo)
      const abs = target.startsWith('/') ? target : `${sessionCwd}/${target}`
      if (root !== '' && abs.startsWith(root + '/')) await update($, active, () => abs.slice(root.length + 1))
    }
    if (['Edit', 'Write', 'NotebookEdit', 'Bash'].includes(e.tool)) scheduleRefresh($)
    if (e.tool !== 'Read' && (await read($, mode)) === 'preview') $.ui.invalidate('ui.render')

    return result
  })

  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const view = await read($, mode)
    if (!drawsOwnWindow || view === 'find') return next(e)
    if (isGitView(view)) {
      await gitScroll($, e.by)
      return {}
    }
    if (view === 'preview') {
      await scrollPreview($, (top) => top + e.by)
      return {}
    }
    const total = (await visibleRows($)).length
    await update($, scrollTop, (top) => Math.max(0, Math.min(top + e.by, total - treeRows)))

    return {}
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const m = e.data as ViewMessage
    if (m.t === 'click') await (isGitView(await read($, mode)) ? gitClick($, m.p) : click($, m.p, m.dbl))
    else if (m.t === 'menu') await update($, selected, () => m.p)
    else if (m.t === 'close-find') await update($, mode, () => 'tree')
    else if (m.t === 'copy-abs' || m.t === 'copy-rel') await copyPath($, m.p, m.t === 'copy-abs')
    else if (m.t === 'mention') await mention($, m.p)
    else if (m.t === 'preview') await openPreview($, m.p)
    else if (m.t === 'open') await openWithDefaultApp($, m.p)
    else if (m.t === 'finder') await revealInFinder($, m.p)
    else if (m.t === 'key') await key($, m.k)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input, Code } = els
    const cols = Math.max(24, e.props.bodyColumns ?? 40)
    const bodyRows = e.props.scroll?.bodyRows ?? 30
    const snap = await read($, repo)
    const view = await read($, mode)
    const sel = await read($, selected)
    const act = await read($, active)

    if (snap.root === '') return <Text dimColor> Scanning…</Text>

    const { index, dirCodes } = indexOf(snap)
    const changes = Object.keys(snap.status).length
    const sync = [snap.ahead > 0 ? `↑${snap.ahead}` : '', snap.behind > 0 ? `↓${snap.behind}` : '']
      .filter(Boolean)
      .join(' ')
    const segText = (segs: Seg[], bg?: string) =>
      segs.map(([text, color, flags, segBg]) => (
        <Text
          color={color ?? undefined}
          backgroundColor={segBg ?? bg}
          bold={(flags & BOLD) !== 0}
          dimColor={(flags & DIM) !== 0}
          strikethrough={(flags & STRIKE) !== 0}
        >
          {text}
        </Text>
      ))

    const isGit = isGitView(view)
    const header = (
      <Box flexDirection="column">
        <Text dimColor bold>
          {' EXPLORER'}
        </Text>
        <Text bold>{' ' + clip(snap.name.toUpperCase(), cols - 2)}</Text>
      </Box>
    )
    const gitHeader = async () => {
      const count = commitsOf(await loadLog($)).length
      const total = count >= LOG_LIMIT ? `${LOG_LIMIT}+` : String(count)

      return (
        <Box flexDirection="column">
          <Text dimColor bold>
            {' GIT'}
          </Text>
          <Text>
            <Text color={BRANCH_COLOR}>{' ⎇ ' + clip(snap.branch || 'no git', 24)}</Text>
            {sync ? <Text color={BRANCH_COLOR}>{' ' + sync}</Text> : ''}
            <Text dimColor>{snap.isGit ? `  · ${total} commits` : ''}</Text>
          </Text>
        </Box>
      )
    }
    const gitFooter = (
      <Box flexDirection="column">
        <Text dimColor>{'─'.repeat(cols)}</Text>
        {view === 'git-diff' ? (
          <Box flexDirection="row" columnGap={2} paddingLeft={1}>
            <Button key="git-back" plain hotkey="q" onPress={() => void update($, mode, () => 'git')}>
              戻る
            </Button>
            <Button key="git-close" plain hotkey="g" onPress={() => void update($, mode, () => 'tree')}>
              閉じる
            </Button>
            <Button key="git-next" plain hotkey="n" onPress={() => void moveFile($, 1)}>
              次のファイル
            </Button>
            <Button key="git-prev" plain hotkey="p" onPress={() => void moveFile($, -1)}>
              前のファイル
            </Button>
            <Text dimColor>j/k スクロール · Space 戻る</Text>
          </Box>
        ) : (
          <Box flexDirection="row" columnGap={2} paddingLeft={1}>
            <Button key="git-close" plain hotkey="q" onPress={() => void update($, mode, () => 'tree')}>
              閉じる
            </Button>
            <Button key="git-refresh" plain hotkey="r" onPress={() => void gitKey($, 'refresh')}>
              更新
            </Button>
            <Text dimColor>j/k 移動 · Tab 切替 · Space 開く</Text>
          </Box>
        )}
      </Box>
    )
    const status = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          {snap.isGit ? (
            <Text color={BRANCH_COLOR}>{' ⎇ ' + clip(snap.branch, 24)}</Text>
          ) : (
            <Text dimColor> no git</Text>
          )}
          {sync ? <Text color={BRANCH_COLOR}>{' ' + sync}</Text> : ''}
          {changes > 0 ? <Text color={GIT_COLORS.M}>{`  ● ${changes}`}</Text> : ''}
        </Text>
        <Text dimColor>{clip(sel, Math.max(8, cols - 30)) + ' '}</Text>
      </Box>
    )
    const tools: [string, string, string, () => void][] = [
      ['find', 'p', '検索', () => void openFind($, '')],
      ['preview', 'o', 'プレビュー', () => void openPreview($, sel)],
      ['open', 'O', 'アプリで開く', () => void openWithDefaultApp($, sel)],
      ['collapse', 'c', 'すべて閉じる', () => void setExpanded($, () => [])],
      ['expand', 'x', 'すべて開く', () => void setExpanded($, () => allDirs(index))],
      ['refresh', 'r', '更新', () => void refresh($)],
      ['git', 'g', 'Git', () => void update($, mode, () => 'git')],
    ]
    const toolLines: (typeof tools)[] = [[]]
    let used = 1
    for (const t of tools) {
      const w = width(`${t[1]}: ${t[2]}`) + 2
      const line = toolLines[toolLines.length - 1]
      if (line && line.length > 0 && used + w > cols) {
        toolLines.push([t])
        used = 1 + w
      } else {
        line?.push(t)
        used += w
      }
    }
    const footer = (
      <Box flexDirection="column">
        <Text dimColor>{'─'.repeat(cols)}</Text>
        {status}
        {toolLines.map((line) => (
          <Box flexDirection="row" columnGap={2} paddingLeft={1}>
            {line.map(([k, hotkey, label, onPress]) =>
              hotkey === hotkey.toLowerCase() ? (
                <Button key={k} plain hotkey={hotkey} onPress={onPress}>
                  {label}
                </Button>
              ) : (
                <Button key={k} plain onPress={onPress}>
                  {`${hotkey}: ${label}`}
                </Button>
              ),
            )}
          </Box>
        ))}
      </Box>
    )
    const treeRowsNow = Math.max(3, bodyRows - HEAD_ROWS - 2 - toolLines.length)
    const closeFind = () => void update($, mode, () => 'tree')

    const findPanel = async (limit: number) => {
      const q = await read($, query)
      const results = search(snap.files, q, Math.max(1, Math.min(RESULT_LIMIT, limit)))

      return (
        <Box flexDirection="column">
          <Input
            key="q"
            label=" ⌕"
            placeholder="ファイル名で検索（あいまい一致、/ でパス）"
            submitLabel="開く"
            value={q}
            autoFocus
            onInput={(v) => void update($, query, () => v)}
            onSubmit={(v) => {
              const top = search(snap.files, v, 1)[0]
              if (top) void pickResult($, top.path)
            }}
          />
          {results.map((m) => {
            const nameAt = m.path.lastIndexOf('/') + 1
            const hits = new Set(m.hits)
            const icon = fileIcon(basename(m.path), style)
            const code = snap.status[m.path]
            const runs = (from: number, to: number, color: string | undefined, isDim: boolean) => {
              const parts: { text: string; isHit: boolean }[] = []
              for (let i = from; i < to; i++) {
                const ch = m.path.charAt(i)
                const isHit = hits.has(i)
                const last = parts[parts.length - 1]
                if (last && last.isHit === isHit) last.text += ch
                else parts.push({ text: ch, isHit })
              }

              return parts.map((p) =>
                p.isHit ? (
                  <Text bold color={HIT_COLOR}>
                    {p.text}
                  </Text>
                ) : (
                  <Text color={color} dimColor={isDim}>
                    {p.text}
                  </Text>
                ),
              )
            }

            return (
              <Button key={`r:${m.path}`} plain onPress={() => void pickResult($, m.path)}>
                <Text> </Text>
                <Text color={icon.color}>{icon.glyph}</Text>
                <Text> </Text>
                {runs(nameAt, m.path.length, code ? GIT_COLORS[code] : undefined, false)}
                <Text> </Text>
                {runs(0, Math.max(0, nameAt - 1), undefined, true)}
              </Button>
            )
          })}
          {q && results.length === 0 && <Text dimColor> 一致するファイルがありません</Text>}
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>{' ↑↓ 選択 · Enter 開く'}</Text>
            <Button key="close-find" plain onPress={closeFind}>
              <Text dimColor>閉じる </Text>
            </Button>
          </Box>
        </Box>
      )
    }

    const previewPanel = async (height: number | undefined) => {
      const rel = await read($, previewPath)
      const file = await loadPreview($, absolute(snap.root, rel))
      const total = file.lines.length
      const top = height === undefined ? 0 : Math.max(0, Math.min(await read($, previewTop), total - height))
      let source = ''
      let shown = 0
      const lines: Seg[][] = []
      if (height === undefined) {
        for (const line of file.lines) {
          if (source.length + line.length + 1 > PREVIEW_CHARS) break
          source += (shown > 0 ? '\n' : '') + line
          shown++
        }
      } else {
        const lang = langOf(rel)
        const states = file.states
        const at = (n: number) => file.lines[n]?.replace(/\t/g, '  ') ?? ''
        for (let n = states.length - 1; n < top; n++) states.push(highlightLine(at(n), lang, states[n]).state)
        const gutter = String(total).length
        for (let n = top; n < Math.min(total, top + height); n++) {
          const { segs, state } = highlightLine(at(n), lang, states[n])
          if (states.length === n + 1) states.push(state)
          lines.push([[String(n + 1).padStart(gutter) + ' ', MUTED_COLOR, 0], ...fit(segs, cols - gutter - 1)])
        }
        shown = lines.length
      }
      const range = total === 0 ? '0/0' : `${top + 1}-${top + shown}/${total}`
      const title = (
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{' ' + clip(rel, Math.max(8, cols - width(range) - 3))}</Text>
          <Text dimColor>{range + ' '}</Text>
        </Box>
      )
      const data: PreviewView = { lines, ...(file.error ? { error: file.error } : {}) }
      const actions = (
        <Box flexDirection="row" columnGap={2} paddingLeft={1}>
          <Button key="close-preview" plain hotkey="q" onPress={() => void update($, mode, () => 'tree')}>
            閉じる
          </Button>
          <Button key="open-preview" plain onPress={() => void openWithDefaultApp($, rel)}>
            O: アプリで開く
          </Button>
          {height !== undefined && <Text dimColor>j/k スクロール</Text>}
        </Box>
      )

      return { title, data, actions, source, rel }
    }

    const rows = flatten(index, new Set(await read($, expanded)), ROW_LIMIT)
    const toView = (row: Row): ViewRow => ({
      p: row.path,
      s: formatRow(row, {
        code: row.kind === 'dir' ? dirCodes.get(row.path) : snap.status[row.path],
        style,
        cols,
        isActive: row.kind === 'file' && row.path === act,
      }),
      ...(row.path === sel ? { sel: true as const } : {}),
    })

    if (e.surface === 'terminal' && 'Client' in els) {
      const { Client } = els
      drawsOwnWindow = true
      treeRows = treeRowsNow
      const isFinding = view === 'find'
      const top = Math.max(0, Math.min(await read($, scrollTop), rows.length - treeRows))

      if (isGit) {
        const height = Math.max(3, bodyRows - HEAD_ROWS - 2)
        const split = e.props.placement !== 'dock' || height < COMBINED_MIN_ROWS
        const props: ViewProps = { rows: await gitBody($, snap, cols, height, split), cols, height, git: true }

        return (
          <Box flexDirection="column" height={bodyRows}>
            {await gitHeader()}
            <Box height={height} width={cols}>
              <Client key="tree" module="../src/tree-view.tsx" props={props} height={height} width={cols} />
            </Box>
            {gitFooter}
          </Box>
        )
      }

      if (view === 'preview') {
        previewRows = Math.max(1, bodyRows - 2)
        const { title, data, actions } = await previewPanel(previewRows)
        const props: ViewProps = { rows: [], cols, height: previewRows, preview: data }

        return (
          <Box flexDirection="column" height={bodyRows}>
            {title}
            <Box height={previewRows} width={cols}>
              <Client key="tree" module="../src/tree-view.tsx" props={props} height={previewRows} width={cols} />
            </Box>
            {actions}
          </Box>
        )
      }
      const props: ViewProps = {
        rows: rows.slice(top, top + treeRows).map(toView),
        cols,
        height: treeRows,
        ...(isFinding ? { dim: true as const } : {}),
      }

      return (
        <Box flexDirection="column" height={bodyRows}>
          {header}
          <Box height={treeRows} width={cols}>
            <Client key="tree" module="../src/tree-view.tsx" props={props} height={treeRows} width={cols} />
            {isFinding && (
              <Box
                position="absolute"
                top={0}
                left={1}
                width={Math.max(20, cols - 2)}
                flexDirection="column"
                borderStyle="round"
                borderColor={HIT_COLOR}
                backgroundColor={POPUP_BG}
              >
                {await findPanel(treeRows - 5)}
              </Box>
            )}
          </Box>
          {footer}
        </Box>
      )
    }

    drawsOwnWindow = false

    if (isGit) {
      return (
        <Box flexDirection="column">
          {await gitHeader()}
          {(await gitBody($, snap, cols, undefined, false)).map((row, i) =>
            row.p === '' ? (
              <Box flexDirection="row">{segText(row.s, row.bg)}</Box>
            ) : (
              <Button key={`${row.p}:${i}`} plain onPress={() => void gitClick($, row.p)}>
                {segText(row.s, row.bg)}
              </Button>
            ),
          )}
          {gitFooter}
        </Box>
      )
    }

    if (view === 'preview') {
      const { title, data, actions, source, rel } = await previewPanel(undefined)

      return (
        <Box flexDirection="column">
          {title}
          {data.error ? (
            <Text dimColor>{' ' + data.error}</Text>
          ) : (
            <Code source={source} path={rel} startLine={1} wrap="truncate-end" />
          )}
          {actions}
        </Box>
      )
    }

    if (view === 'find') {
      return (
        <Box flexDirection="column">
          {header}
          {await findPanel(RESULT_LIMIT)}
          {footer}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {rows.map((row) => {
          const v = toView(row)

          return (
            <Button key={`n:${row.path}`} plain onPress={() => void click($, row.path, false)}>
              {segText(v.s, v.sel ? '#04395e' : undefined)}
            </Button>
          )
        })}
        {rows.length >= ROW_LIMIT && <Text dimColor> … {ROW_LIMIT} 行で打ち切りました</Text>}
        {footer}
      </Box>
    )
  })
}
