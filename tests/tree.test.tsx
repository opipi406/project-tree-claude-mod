import { expect, mock, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code'

import { search } from '../src/fuzzy'
import { highlightLine, langOf } from '../src/highlight'
import type { HlState } from '../src/highlight'
import { parseStatus } from '../src/git'
import { parseChanges, parseDiff, parseLog, withWorktree } from '../src/gitlog'
import { diffRows } from '../src/git-view'
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

test('the language comes from the path, and a block comment or triple-quoted string carries over lines', async () => {
  const cases: [string, string[], (string | null)[]][] = [
    ['a.ts', ['/* open', 'still */ let x'], ['#6a9955', '#6a9955']],
    ['c.py', ['"""doc', 'end""" + x'], ['#ce9178', '#ce9178']],
    ['Dockerfile', ['FROM node'], ['#569cd6']],
    ['x.unknown', ['const a'], [null]],
  ]
  for (const [path, lines, colors] of cases) {
    let state: HlState
    const got = lines.map((line) => {
      const r = highlightLine(line, langOf(path), state)
      state = r.state
      return r.segs[0]?.[1] ?? null
    })
    expect([path, ...got]).toEqual([path, ...colors])
  }
})

test('git log --graph: connector lines stay as rows, commit fields split, a remote HEAD ref is dropped', async () => {
  const f = (...x: string[]) => '\x1f' + x.join('\x1f')
  const out = [
    '*   ' + f('m1', 'm1', 'p1 s1', 'ann', '100', 'HEAD -> refs/heads/main, refs/remotes/origin/HEAD', 'Merge x'),
    '|\\  ',
    '| * ' + f('s1', 's1', 'p1', 'bob', '90', '', 'fix: a'),
    '',
  ].join('\n')
  const rows = parseLog(out)
  expect(rows.map((r) => [r.graph, r.commit?.hash ?? null])).toEqual([
    ['*', 'm1'],
    ['|\\', null],
    ['| *', 's1'],
  ])
  expect(rows[0]?.commit?.parents).toEqual(['p1', 's1'])
  expect(rows[0]?.commit?.refs).toEqual(['HEAD -> refs/heads/main'])
})

test('uncommitted changes sit above HEAD in its column, the gray edge drawn only through empty cells', async () => {
  const row = (graph: string, hash: string, refs: string[] = []) => ({
    graph,
    commit: { hash, short: hash, parents: [], author: '', time: 0, refs, subject: '' },
  })
  const rows = [row('*', 'tip'), row('| *', 'head', ['HEAD -> refs/heads/topic']), row('* |', 'base')]
  expect(withWorktree(rows, true).map((r) => [r.graph, r.commit?.hash])).toEqual([
    ['  *', 'WORKTREE'],
    ['* :', 'tip'],
    ['| *', 'head'],
    ['* |', 'base'],
  ])
  expect(withWorktree(rows, false)).toBe(rows)
})

test('changed files: a rename consumes two paths in both -z lists, and "-" counts mark a binary file', async () => {
  const names = ['R087', 'old.ts', 'new.ts', 'M', 'img.png', 'A', 'b.md', ''].join('\0')
  const nums = ['3\t1\t', 'old.ts', 'new.ts', '-\t-\timg.png', '5\t0\tb.md', ''].join('\0')
  expect(parseChanges(names, nums)).toEqual([
    { status: 'R', from: 'old.ts', path: 'new.ts', added: 3, deleted: 1, isBinary: false },
    { status: 'M', path: 'img.png', added: 0, deleted: 0, isBinary: true },
    { status: 'A', path: 'b.md', added: 5, deleted: 0, isBinary: false },
  ])
})

test('a diff numbers each side on its own and marks only the changed middle of a replaced line', async () => {
  const out = [
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -10,3 +10,3 @@ fn',
    ' keep',
    '-const a = 1',
    '+const a = 22',
    ' end',
  ].join('\n')
  const lines = parseDiff(out, 100)
  expect(lines.map((l) => [l.kind, l.old ?? null, l.new ?? null, l.range ?? null])).toEqual([
    ['hunk', null, null, null],
    ['ctx', 10, 10, null],
    ['del', 11, null, [10, 11]],
    ['add', null, 11, [10, 12]],
    ['ctx', 12, 12, null],
  ])
})

test('a diff line wider than the pane wraps onto gutter-indented rows instead of being cut', async () => {
  const text = 'abcdefghij'.repeat(4)
  const rows = diffRows(parseDiff(['@@ -1 +1 @@', '+' + text].join('\n'), 100), undefined, 20)
  const body = rows.slice(1).map((r) => r.s.map((x) => x[0]).join(''))
  expect(body.map((line) => line.slice(0, 5))).toEqual([' 1 + ', '     ', '     '])
  expect(body.map((line) => line.slice(5)).join('')).toBe(text)
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

test('pressing o previews the selected file over the tree: highlighted by its path, j scrolls, q closes from the tree or the pane', async ($, on) => {
  seed(on, { repo: REPO, selected: 'src/a.ts' })
  const lines = Array.from({ length: 40 }, (_, i) => `const v${i + 1} = ${i + 1}`)
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => ({ value: e.path === '/r/src/a.ts' ? lines.join('\n') + '\n' : '' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'o' })
  expect((await ui.find({ type: 'Text', text: 'const', in: 'tree' }))?.props.color).toBe('#569cd6')
  expect(await ui.find({ type: 'Text', text: /^1-28\/40 $/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: ' 1 ', in: 'tree' })).toBeTruthy()
  await ui.key({ key: 'j' })
  expect(await ui.find({ type: 'Text', text: ' 1 ', in: 'tree' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: ' 2 ', in: 'tree' })).toBeTruthy()
  await ui.key({ key: 'q' })
  expect(await ui.find({ type: 'Text', text: 'const', in: 'tree' })).toBeUndefined()
  await ui.key({ key: 'o' })
  expect((await ui.find({ key: 'close-preview' }))?.props.hotkey).toBe('q')
  await ui.press({ key: 'close-preview' })
  expect(await ui.find({ type: 'Text', text: 'const', in: 'tree' })).toBeUndefined()
  await ui.unmount()
})

test('running /project-tree again opens the plain tree, not the preview or selection left from before', async ($, on) => {
  seed(on, { repo: REPO })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: 'x' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'j' })
  await ui.key({ key: 'j' })
  await ui.key({ key: 'o' })
  expect(await ui.find({ type: 'Text', text: '1 ', in: 'tree' })).toBeTruthy()
  await $.command.run({
    command: 'project-tree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(await ui.find({ type: 'Text', text: '1 ', in: 'tree' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /b\.md/, in: 'tree' })).toBeTruthy()
  expect(JSON.stringify(await ui.drawn({ in: 'tree' }))).not.toContain('#04395e')
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

test('j/k move the selection, and g opens the Git view instead of jumping to the top', async ($, on) => {
  seed(on, { repo: REPO })
  const picks: unknown[] = []
  const modes: unknown[] = []
  on('state.set', (_, e, next) => {
    const { key, value } = e as { key: string; value: unknown }
    if (key === 'selected') picks.push(value)
    if (key === 'mode') modes.push(value)
    return next(e)
  })
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'j' })
  await ui.key({ key: 'j' })
  await ui.key({ key: 'k' })
  await ui.key({ key: 'G', shift: true })
  await ui.key({ key: 'g' })
  expect(picks).toEqual(['src', 'b.md', 'src'])
  expect(modes).toEqual(['git'])
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

const LOG = [
  '* ' + ['', 'c2', 'c2', 'c1', 'ann', '100', 'HEAD -> refs/heads/main', 'feat: two'].join('\x1f'),
  '* ' + ['', 'c1', 'c1', '', 'ann', '90', '', 'feat: one'].join('\x1f'),
  '',
].join('\n')

const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '@@ -1,2 +1,2 @@', '-const x = 1', '+const x = 2', ' end', ''].join(
  '\n',
)

function gitRepo(on: On) {
  mock.clock(on, { now: 200_000 })
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    const stdout = args.startsWith('git log')
      ? LOG
      : args.startsWith('git show')
        ? '2026-11-10 10:00\x1fbody line\n'
        : args.includes('--name-status')
          ? 'M\0src/a.ts\0'
          : args.includes('--numstat')
            ? '1\t1\tsrc/a.ts\0'
            : args.startsWith('git diff')
              ? DIFF
              : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test("g shows the graph, the changed files and the selected file's diff at once; Space zooms the diff, Space returns", async ($, on) => {
  seed(on, { repo: REPO })
  gitRepo(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'g' })
  expect(await ui.find({ type: 'Text', text: /^two$/, in: 'tree' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^a\.ts$/, in: 'tree' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^2$/, in: 'tree' }))?.props.backgroundColor).toBe('#22603a')
  await ui.key({ key: 'return' })
  expect(await ui.find({ type: 'Text', text: /^ ‹ $/, in: 'tree' })).toBeUndefined()
  await ui.key({ key: ' ' })
  await ui.key({ key: ' ' })
  expect(await ui.find({ type: 'Text', text: /^ ‹ $/, in: 'tree' })).toBeTruthy()
  await ui.key({ key: ' ' })
  expect(await ui.find({ type: 'Text', text: /^ ‹ $/, in: 'tree' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^two$/, in: 'tree' })).toBeTruthy()
  await ui.unmount()
})

test('placed inline above the prompt, the Git view leaves the diff out until Space on a file fills the pane with it', async ($, on) => {
  seed(on, { repo: REPO })
  gitRepo(on)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'inline' }, surface: 'terminal' })
  await ui.key({ key: 'g' })
  expect(await ui.find({ type: 'Text', text: /^a\.ts$/, in: 'tree' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^2$/, in: 'tree' })).toBeUndefined()
  await ui.key({ key: ' ' })
  await ui.key({ key: ' ' })
  expect(await ui.find({ type: 'Text', text: /^ ‹ $/, in: 'tree' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^2$/, in: 'tree' })).toBeTruthy()
  await ui.key({ key: 'q' })
  expect(await ui.find({ type: 'Text', text: /^2$/, in: 'tree' })).toBeUndefined()
  await ui.unmount()
})

test('a dirty working tree shows first as the selected "working" entry, its files diffed against HEAD', async ($, on) => {
  seed(on, { repo: REPO, mode: 'git' })
  gitRepo(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^◌$/, in: 'tree' }))?.props.color).toBe('#7f848e')
  const drawn = JSON.stringify(await ui.drawn({ in: 'tree' }))
  expect(drawn).toContain('未コミットの変更')
  expect(drawn).toContain('parent c2')
  expect((await ui.find({ type: 'Text', text: /^2$/, in: 'tree' }))?.props.backgroundColor).toBe('#22603a')
  await ui.unmount()
})

test('clicking a commit in the graph shows that commit in the detail below', async ($, on) => {
  seed(on, { repo: REPO, mode: 'git' })
  gitRepo(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'c2', in: 'tree' })).toBeTruthy()
  await ui.pointer({ type: 'down', x: 5, y: 2, button: 'left' })
  const drawn = JSON.stringify(await ui.drawn({ in: 'tree' }))
  expect(drawn).toContain('root commit')
  await ui.unmount()
})
