import { expect, mock, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code'

import { search } from '../src/fuzzy'
import { parseStatus } from '../src/git'
import { buildIndex, flatten } from '../src/tree'
import { formatRow } from '../src/view'

test('porcelain -z: rename consumes its source path, codes map to badges', async () => {
  const out = ['R  new.ts', 'old.ts', ' M src/a.ts', '?? tmp/x.md', 'UU both.ts', ''].join('\0')
  expect(parseStatus(out)).toEqual({ 'new.ts': 'R', 'src/a.ts': 'M', 'tmp/x.md': 'U', 'both.ts': '!' })
})

test('single-child folders are compacted and folders sort before files', async () => {
  const index = buildIndex(['z.md', 'a/b/c/x.ts', 'a/b/c/y.ts', 'docs/readme.md'])
  const rows = flatten(index, new Set(['a/b/c']), 100)
  expect(rows.map((r) => `${r.depth}:${r.label}`)).toEqual(['0:a/b/c', '1:x.ts', '1:y.ts', '0:docs', '0:z.md'])
})

test('tree connectors continue a parent line only while the parent has later siblings', async () => {
  const rows = flatten(buildIndex(['src/a.ts', 'src/b.ts', 'z.md']), new Set(['src']), 100)
  const lead = rows.map((r) => formatRow(r, { code: undefined, style: 'basic', cols: 40, isActive: false })[0]?.[0])
  expect(lead).toEqual([' ├─ ', ' │  ├─ ', ' │  └─ ', ' └─ '])
})

test('a basename match outranks a match spread over the path', async () => {
  const hits = search(['src/regiser/tree.ts', 'hooks/register.tsx'], 'reg', 10)
  expect(hits[0]?.path).toBe('hooks/register.tsx')
})

const PANE = {
  plugin: 'project-tree',
  component: 'Pane',
  requestId: 'project-tree',
  props: {
    title: 'Explorer',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const REPO = {
  shape: 'repo-1',
  value: {
    root: '/r',
    name: 'r',
    isGit: true,
    branch: 'main',
    ahead: 1,
    behind: 0,
    files: ['src/a.ts', 'b.md'],
    status: { 'src/a.ts': 'M' },
    isTruncated: false,
    rev: 1,
  },
}

function seed(on: On, values: Record<string, unknown>) {
  on('state.get', (_, e, next) => {
    const value = values[(e as { key: string }).key]
    return value === undefined ? next(e) : { value: { value, version: 1 } }
  })
}

test('the pane draws a modified file with its git badge outside the terminal', async ($, on) => {
  seed(on, { repo: REPO, expanded: { shape: 'expanded-1', value: ['src'] } })

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^a\.ts$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^M / })).toBeTruthy()
    await ui.unmount()
  }
})

test('a double click on a folder in the terminal opens it once, not open-then-close', async ($, on) => {
  seed(on, { repo: REPO })
  const saved: unknown[] = []
  on('store.set', (_, e) => {
    saved.push((e as { value: unknown }).value)
    return { value: undefined }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'left' })
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'left' })
  expect(saved).toEqual([['src']])
  await ui.unmount()
})

test('right click then "Copy Relative Path" copies the project-relative path', async ($, on) => {
  seed(on, { repo: REPO })
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push((e as { text: string }).text)
    return { value: { isCopied: true } }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.pointer({ type: 'down', x: 3, y: 1, button: 'right' })
  await ui.pointer({ type: 'down', x: 3, y: 4, button: 'left' })
  await ui.pointer({ type: 'down', x: 3, y: 1, button: 'right' })
  await ui.pointer({ type: 'down', x: 3, y: 3, button: 'left' })
  expect(copied).toEqual(['b.md', '/r/b.md'])
  await ui.unmount()
})

test('quick open lists matches with the hit characters highlighted', async ($, on) => {
  const values: Record<string, unknown> = {
    repo: {
      shape: 'repo-1',
      value: {
        root: '/r',
        name: 'r',
        isGit: true,
        branch: 'main',
        ahead: 0,
        behind: 0,
        files: ['src/register.tsx', 'b.md'],
        status: {},
        isTruncated: false,
        rev: 1,
      },
    },
    mode: 'find',
    query: 'reg',
  }
  on('state.get', (_, e) => {
    const value = values[(e as { key: string }).key]
    return { value: value === undefined ? { value: undefined, version: 0 } : { value, version: 1 } }
  })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^reg$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /b\.md/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('picking a quick open result selects the file without inserting @path into the prompt', async ($, on) => {
  const store = new Map<string, { value: unknown; version: number }>()
  on('state.get', (_, e, next) => {
    const { key } = e as { key: string }
    if (key === 'repo') return { value: { value: REPO, version: 1 } }
    const held = store.get(key)
    return held ? { value: held } : next(e)
  })
  const picked: unknown[] = []
  on('state.set', (_, e) => {
    const { key, value, ifVersion } = e as { key: string; value: unknown; ifVersion?: number }
    const version = store.get(key)?.version ?? 0
    if (ifVersion !== undefined && ifVersion !== version) return { value: { isSet: false, version } }
    store.set(key, { value, version: version + 1 })
    if (key === 'selected') picked.push(value)
    return { value: { isSet: true, version: version + 1 } }
  })
  const fills: unknown[] = []
  on('prompt.fill', (_, e) => {
    fills.push(e)
    return { isFilled: true }
  })
  mock.store(on)
  store.set('mode', { value: 'find', version: 1 })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'q', text: 'b.md' })
  await ui.unmount()
  expect(picked).toEqual(['b.md'])
  expect(fills).toEqual([])
})

test('pressing p while the tree holds the keyboard opens quick open', async ($, on) => {
  seed(on, { repo: REPO })
  const modes: unknown[] = []
  on('state.set', (_, e, next) => {
    if ((e as { key: string }).key === 'mode') modes.push((e as { value: unknown }).value)
    return next(e)
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'p' })
  expect(modes).toEqual(['find'])
  await ui.unmount()
})

test('pressing o previews the selected file over the tree: highlighted by its path, j scrolls, q closes', async ($, on) => {
  seed(on, { repo: REPO, selected: 'src/a.ts' })
  const lines = Array.from({ length: 40 }, (_, i) => `const v${i + 1} = ${i + 1}`)
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => ({ value: e.path === '/r/src/a.ts' ? lines.join('\n') + '\n' : '' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'o' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.props).toMatchObject({ path: 'src/a.ts', startLine: 1 })
  expect(String(code?.props.source).split('\n')[0]).toBe('const v1 = 1')
  expect(await ui.find({ type: 'Text', text: /^1-28\/40 $/ })).toBeTruthy()
  await ui.key({ key: 'j' })
  expect((await ui.find({ type: 'Code' }))?.props.startLine).toBe(2)
  await ui.key({ key: 'q' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.unmount()
})

test('pressing O opens the selected file with its default app and names that app', async ($, on) => {
  seed(on, { repo: REPO, selected: 'b.md' })
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[0] === 'osascript' ? '/Applications/Cursor.app\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'O', shift: true })
  expect(runs).toContainEqual(['open', '/r/b.md'])
  expect(toasts.join()).toContain('Cursor で開きました: b.md')
  await ui.unmount()
})

test('vim keys move the selection: j down, G to the last row, gg back to the first', async ($, on) => {
  seed(on, { repo: REPO })
  const picks: unknown[] = []
  on('state.set', (_, e, next) => {
    if ((e as { key: string }).key === 'selected') picks.push((e as { value: unknown }).value)
    return next(e)
  })
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'j' })
  await ui.key({ key: 'j' })
  await ui.key({ key: 'g' })
  await ui.key({ key: 'g' })
  await ui.key({ key: 'G', shift: true })
  expect(picks).toEqual(['src', 'b.md', 'src', 'b.md'])
  await ui.unmount()
})

test(
  'the icons option set to nerd draws Nerd Font glyphs instead of letter tags',
  { options: { icons: 'nerd' } },
  async ($, on) => {
    seed(on, { repo: REPO, expanded: { shape: 'expanded-1', value: ['src'] } })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: ' ' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: 'TS' })).toBeUndefined()
    await ui.unmount()
  },
)

const GIT_TIMEOUT = '$.process.run(git) aborted: still running after 20000ms'

async function startSession($: Engine, on: On) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  const logs: string[] = []
  on('ui.log', (_, e) => {
    logs.push(JSON.stringify(e))
    return { value: undefined }
  })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })

  return logs
}

test('a scan that keeps timing out logs the failure once, then the recovery once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  let isDown = true
  on('process.run', () => {
    if (isDown) throw new Error(GIT_TIMEOUT)
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const logs = await startSession($, on)
  for (let i = 0; i < 3; i++) await clock.advance(5000)
  isDown = false
  await clock.advance(5000)
  await clock.advance(5000)
  expect(logs.length).toBe(2)
  expect(logs[0]).toContain('scan failed')
  expect(logs[1]).toContain('scan recovered')
})

test('a scan cut short by the machine sleeping logs nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('process.run', async () => {
    await clock.sleep(600_000)
    throw new Error(GIT_TIMEOUT)
  })
  const started = startSession($, on)
  await clock.settle()
  await clock.advance(600_000)
  expect(await started).toEqual([])
})
