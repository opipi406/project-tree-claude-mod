import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GitCode, IconStyle, RepoSnapshot, ViewMode } from '../types'
import { isSame, scan } from '../src/git'
import { search } from '../src/fuzzy'
import { GIT_COLORS, clip, fileIcon, width } from '../src/icons'
import { allDirs, ancestors, basename, buildIndex, dirStatuses, flatten } from '../src/tree'
import type { Index, Row } from '../src/tree'
import { BOLD, DIM, STRIKE, formatRow } from '../src/view'
import type { Seg, ViewMessage, ViewProps, ViewRow } from '../src/view'

const PANE = 'project-tree'
const TITLE = 'Explorer'
const ROW_LIMIT = 5000
const RESULT_LIMIT = 60
const POLL_MS = 5000
const PLAIN_POLL_MS = 60000
const HEAD_ROWS = 2
const POPUP_BG = '#24272e'
const HIT_COLOR = '#18a3ff'
const BRANCH_COLOR = '#8fbcbb'

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
const icons = atom({ plugin: 'project-tree', key: 'icons' } as const, 'basic' as IconStyle)

let sessionCwd = ''
let isScanning = false
let lastPlainScanAt = 0
let pending: { cancel: () => void } | undefined
let cached: { rev: number; root: string; index: Index; dirCodes: Map<string, GitCode> } | undefined
let treeRows = 20
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
    const next = await scan((argv, cwd) => $.process.run(argv, { cwd, timeoutMs: 20000 }), sessionCwd)
    const prev = await read($, repo)
    if (prev.root !== '' && isSame(prev, next)) return
    await update($, repo, old => ({ ...next, rev: old.rev + 1 }))
    if (prev.root !== next.root) {
      const saved = await $.store.get(`expanded:${next.root}`)
      if (Array.isArray(saved)) await update($, expanded, () => saved.filter(x => typeof x === 'string'))
    }
  } catch (err) {
    $.ui.log(`project-tree: scan failed: ${String(err)}`)
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
  await setExpanded($, list => (list.includes(dir) ? list.filter(x => x !== dir) : [...list, dir]))
}

async function scrollIntoView($: EngineInterface, path: string) {
  if (!drawsOwnWindow) {
    await $.ui.scroll({ in: PANE, to: { key: `n:${path}` }, block: 'nearest' })
    return
  }
  const rows = await visibleRows($)
  const at = rows.findIndex(r => r.path === path)
  if (at < 0) return
  await update($, scrollTop, top => (at < top ? at : at >= top + treeRows ? at - treeRows + 1 : top))
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
  await setExpanded($, list => [...new Set([...list, ...ancestors(rel)])])
  await update($, selected, () => rel)
  if (!drawsOwnWindow) await $.clock.sleep(120)
  const rows = await visibleRows($)
  const at = rows.findIndex(r => r.path === rel)
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

async function revealInFinder($: EngineInterface, rel: string) {
  const { root } = await read($, repo)
  await $.process.run(['open', '-R', absolute(root, rel)], { timeoutMs: 10000 }).catch(() => undefined)
}

async function click($: EngineInterface, path: string, isDouble: boolean) {
  const rows = await visibleRows($)
  const row = rows.find(r => r.path === path)
  if (!row) return
  await update($, selected, () => path)
  if (row.kind === 'dir') {
    if (!isDouble) await toggle($, path)
    return
  }
  if (isDouble) await mention($, path)
}

async function key($: EngineInterface, k: Extract<ViewMessage, { t: 'key' }>['k']) {
  if (k === 'find') return openFind($, '')
  if (k === 'open') return openWithDefaultApp($, await read($, selected))
  if (k === 'collapse') return setExpanded($, () => [])
  if (k === 'refresh') return refresh($)
  if (k === 'expand') {
    const snap = await read($, repo)
    return setExpanded($, () => allDirs(indexOf(snap).index))
  }
  const rows = await visibleRows($)
  if (rows.length === 0) return
  const sel = await read($, selected)
  const at = rows.findIndex(r => r.path === sel)
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
  await mention($, rel)
}

async function openPane($: EngineInterface, isFocused: boolean) {
  const saved = await $.store.get('width')
  const columns = typeof saved === 'number' ? saved : undefined

  return $.ui.open({ id: PANE, title: TITLE, ...(isFocused ? { focus: true as const } : {}), ...(columns ? { columns } : {}) })
}

async function openFind($: EngineInterface, initial: string) {
  await update($, query, () => initial)
  await update($, mode, () => 'find')
  await openPane($, true)
  const moved = await $.ui.focus({ requestId: PANE, key: 'q' }).catch((err: unknown) => ({ deny: String(err) }))
  if (moved.deny) $.ui.log(`project-tree: search focus refused: ${moved.deny}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    const saved = await $.store.get('icons')
    if (saved === 'nerd' || saved === 'basic') await update($, icons, () => saved)
    await $.command.register({
      name: 'tree',
      description: 'Open the Explorer pane (args: refresh | collapse | reveal | width <cols> | icons nerd|basic)',
      argumentHint: '[refresh|collapse|reveal|width <cols>|icons nerd|basic]',
    })
    await $.command.register({ name: 'tree-find', description: 'Quick open a file in the Explorer', argumentHint: '[query]' })
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($, false))
    void openPane($, false)

    return next(e)
  })

  on('command.run', { command: 'tree' }, async ($, e) => {
    const [verb, arg] = e.args.trim().split(/\s+/)
    if (verb === 'refresh') {
      await refresh($)
      return { text: 'Explorer refreshed.' }
    }
    if (verb === 'collapse') {
      await setExpanded($, () => [])
      return { text: 'Collapsed all folders.' }
    }
    if (verb === 'reveal') {
      await reveal($, await read($, active))
      return { text: 'Revealed the active file.' }
    }
    if (verb === 'width') {
      const columns = Number(arg)
      if (!Number.isInteger(columns) || columns < 24) return { text: '使い方: /tree width <24以上の列数>' }
      await $.store.set('width', columns)
      const opened = await openPane($, true)
      return { text: opened.isPlaced ? `Explorer の幅を ${columns} 列に設定しました（上限はターミナル幅の45%）。` : `Explorer を開けませんでした: ${opened.reason}` }
    }
    if (verb === 'icons' && (arg === 'nerd' || arg === 'basic')) {
      await update($, icons, () => arg)
      await $.store.set('icons', arg)
      return { text: `Icons: ${arg}` }
    }
    const opened = await openPane($, true)

    return { text: opened.isPlaced ? 'Explorer opened.' : `Explorer could not open: ${opened.reason}` }
  })

  on('command.run', { command: 'tree-find' }, async ($, e) => {
    await openFind($, e.args.trim())

    return { text: 'Quick open.' }
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const args = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    const target = typeof args.file_path === 'string' ? args.file_path : typeof args.notebook_path === 'string' ? args.notebook_path : undefined
    if (target !== undefined && ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(e.tool)) {
      const { root } = await read($, repo)
      const abs = target.startsWith('/') ? target : `${sessionCwd}/${target}`
      if (root !== '' && abs.startsWith(root + '/')) await update($, active, () => abs.slice(root.length + 1))
    }
    if (['Edit', 'Write', 'NotebookEdit', 'Bash'].includes(e.tool)) scheduleRefresh($)

    return result
  })

  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (!drawsOwnWindow || (await read($, mode)) === 'find') return next(e)
    const total = (await visibleRows($)).length
    await update($, scrollTop, top => Math.max(0, Math.min(top + e.by, total - treeRows)))

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
    else if (m.t === 'open') await openWithDefaultApp($, m.p)
    else if (m.t === 'finder') await revealInFinder($, m.p)
    else if (m.t === 'key') await key($, m.k)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input } = els
    const cols = Math.max(24, e.props.bodyColumns ?? 40)
    const bodyRows = e.props.scroll?.bodyRows ?? 30
    const snap = await read($, repo)
    const view = await read($, mode)
    const sel = await read($, selected)
    const act = await read($, active)
    const style = await read($, icons)

    if (snap.root === '') return <Text dimColor> Scanning…</Text>

    const { index, dirCodes } = indexOf(snap)
    const changes = Object.keys(snap.status).length
    const sync = [snap.ahead > 0 ? `↑${snap.ahead}` : '', snap.behind > 0 ? `↓${snap.behind}` : ''].filter(Boolean).join(' ')
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
        <Text dimColor bold>{' EXPLORER'}</Text>
        <Text bold>{' ' + clip(snap.name.toUpperCase(), cols - 2)}</Text>
      </Box>
    )
    const status = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          {snap.isGit ? <Text color={BRANCH_COLOR}>{' ⎇ ' + clip(snap.branch, 24)}</Text> : <Text dimColor> no git</Text>}
          {sync ? <Text color={BRANCH_COLOR}>{' ' + sync}</Text> : ''}
          {changes > 0 ? <Text color={GIT_COLORS.M}>{`  ● ${changes}`}</Text> : ''}
        </Text>
        <Text dimColor>{clip(sel, Math.max(8, cols - 30)) + ' '}</Text>
      </Box>
    )
    const tools: [string, string, string, () => void][] = [
      ['find', 'p', '検索', () => void openFind($, '')],
      ['open', 'o', 'アプリで開く', () => void openWithDefaultApp($, sel)],
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
        {toolLines.map(line => (
          <Box flexDirection="row" columnGap={2} paddingLeft={1}>
            {line.map(([k, hotkey, label, onPress]) => (
              <Button key={k} plain hotkey={hotkey} onPress={onPress}>
                {label}
              </Button>
            ))}
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
            onInput={v => void update($, query, () => v)}
            onSubmit={v => {
              const top = search(snap.files, v, 1)[0]
              if (top) void pickResult($, top.path)
            }}
          />
          {results.map(m => {
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

              return parts.map(p =>
                p.isHit ? <Text bold color={HIT_COLOR}>{p.text}</Text> : <Text color={color} dimColor={isDim}>{p.text}</Text>,
              )
            }

            return (
              <Button key={`r:${m.path}`} plain onPress={() => void pickResult($, m.path)}>
                <Text> </Text>
                <Text color={icon.color}>{icon.glyph}</Text>
                <Text> </Text>
                {runs(nameAt, m.path.length, code ? GIT_COLORS[code] : undefined, false)}
                <Text>  </Text>
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
      const props: ViewProps = { rows: rows.slice(top, top + treeRows).map(toView), cols, height: treeRows, ...(isFinding ? { dim: true as const } : {}) }

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
        {rows.map(row => {
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
