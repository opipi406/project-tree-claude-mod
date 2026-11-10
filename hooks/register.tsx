import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GitCode, IconStyle, RepoSnapshot, ViewMode } from '../types'
import { isSame, scan } from '../src/git'
import { search } from '../src/fuzzy'
import { GIT_COLORS, clip, fileIcon, width } from '../src/icons'
import { allDirs, ancestors, basename, buildIndex, dirStatuses, flatten } from '../src/tree'
import type { Index, Row } from '../src/tree'
import { BOLD, DIM, STRIKE, formatRow } from '../src/view'
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

let sessionCwd = ''
let isScanning = false
let isFailing = false
let lastPlainScanAt = 0
let pending: { cancel: () => void } | undefined
let cached: { rev: number; root: string; index: Index; dirCodes: Map<string, GitCode> } | undefined
let treeRows = 20
let previewRows = 20
let loaded: { path: string; mtimeMs: number; lines: string[]; error?: string } | undefined
let drawsOwnWindow = false

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
  const fail = (error: string) => (loaded = { path: abs, mtimeMs: info?.mtimeMs ?? 0, lines: [], error })
  if (!info) return fail('ファイルが見つかりません')
  const text = await $.fs.read(abs).catch((err: unknown) => err)
  if (typeof text !== 'string') return fail(`読み込めませんでした: ${String(text)}`)
  if (text.includes('\0')) return fail('バイナリファイルのため表示できません')
  loaded = {
    path: abs,
    mtimeMs: info.mtimeMs,
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
  if ((await read($, mode)) === 'preview') return previewKey($, k)
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
    if (m.t === 'click') await click($, m.p, m.dbl)
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
      segs.map(([text, color, flags]) => (
        <Text
          color={color ?? undefined}
          backgroundColor={bg}
          bold={(flags & BOLD) !== 0}
          dimColor={(flags & DIM) !== 0}
          strikethrough={(flags & STRIKE) !== 0}
        >
          {text}
        </Text>
      ))

    const header = (
      <Box flexDirection="column">
        <Text dimColor bold>
          {' EXPLORER'}
        </Text>
        <Text bold>{' ' + clip(snap.name.toUpperCase(), cols - 2)}</Text>
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
      for (const line of file.lines.slice(top, height === undefined ? undefined : top + height)) {
        if (source.length + line.length + 1 > PREVIEW_CHARS) break
        source += (shown > 0 ? '\n' : '') + line
        shown++
      }
      const range = total === 0 ? '0/0' : `${top + 1}-${top + shown}/${total}`
      const title = (
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{' ' + clip(rel, Math.max(8, cols - width(range) - 3))}</Text>
          <Text dimColor>{range + ' '}</Text>
        </Box>
      )
      const data: PreviewView = { path: rel, source, startLine: top + 1, ...(file.error ? { error: file.error } : {}) }
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

      return { title, data, actions }
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

    if (view === 'preview') {
      const { title, data, actions } = await previewPanel(undefined)

      return (
        <Box flexDirection="column">
          {title}
          {data.error ? (
            <Text dimColor>{' ' + data.error}</Text>
          ) : (
            <Code source={data.source} path={data.path} startLine={1} wrap="truncate-end" />
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
