import type { GitCode, RepoSnapshot } from '../types'

export type Runner = (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>

export type Scan = Omit<RepoSnapshot, 'rev'>

export const MAX_FILES = 20000

const PRUNED = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', '.cache']

const PRIORITY: Record<GitCode, number> = { '!': 5, D: 4, M: 3, R: 2, A: 1, U: 1 }

export function stronger(a: GitCode | undefined, b: GitCode): GitCode {
  return a !== undefined && PRIORITY[a] >= PRIORITY[b] ? a : b
}

function classify(x: string, y: string): GitCode {
  const xy = x + y
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') return '!'
  if (xy === '??') return 'U'
  if (x === 'D' || y === 'D') return 'D'
  if (x === 'R' || x === 'C') return 'R'
  if (x === 'A') return 'A'
  return 'M'
}

export function parseStatus(out: string): Record<string, GitCode> {
  const status: Record<string, GitCode> = {}
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? ''
    if (p.length < 4) continue
    const x = p.charAt(0)
    if (x === 'R' || x === 'C') i++
    status[p.slice(3)] = classify(x, p.charAt(1))
  }

  return status
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '')

  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

async function scanPlain(run: Runner, cwd: string): Promise<Scan> {
  const found = await run(
    [
      'find',
      '.',
      '-maxdepth',
      '4',
      '(',
      ...PRUNED.flatMap((n, i) => (i === 0 ? ['-name', n] : ['-o', '-name', n])),
      ')',
      '-prune',
      '-o',
      '-type',
      'f',
      '-print',
    ],
    cwd,
  )
  const all = found.stdout
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^\.\//, ''))

  return {
    root: cwd,
    name: lastSegment(cwd),
    isGit: false,
    branch: '',
    ahead: 0,
    behind: 0,
    files: all.slice(0, MAX_FILES),
    status: {},
    isTruncated: all.length > MAX_FILES,
  }
}

export async function scan(run: Runner, cwd: string): Promise<Scan> {
  const top = await run(['git', 'rev-parse', '--show-toplevel'], cwd)
  if (top.exitCode !== 0) return scanPlain(run, cwd)

  const root = top.stdout.trim()
  const [ls, st, br, ab] = await Promise.all([
    run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], root),
    run(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], root),
    run(['git', 'branch', '--show-current'], root),
    run(['git', 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], root),
  ])
  const status = parseStatus(st.stdout)
  const set = new Set(ls.stdout.split('\0').filter(Boolean))
  for (const [path, code] of Object.entries(status)) {
    if (code === 'D') set.add(path)
  }
  const all = [...set]
  const [ahead, behind] = ab.exitCode === 0 ? ab.stdout.trim().split(/\s+/).map(Number) : [0, 0]

  return {
    root,
    name: lastSegment(root),
    isGit: true,
    branch: br.stdout.trim() || 'detached',
    ahead: ahead || 0,
    behind: behind || 0,
    files: all.slice(0, MAX_FILES),
    status,
    isTruncated: all.length > MAX_FILES,
  }
}

export function isSame(a: Scan, b: Scan): boolean {
  return (
    a.root === b.root &&
    a.branch === b.branch &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.files.length === b.files.length &&
    JSON.stringify(a.status) === JSON.stringify(b.status) &&
    a.files.join('\0') === b.files.join('\0')
  )
}
