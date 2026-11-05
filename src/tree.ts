import type { GitCode } from '../types'
import { stronger } from './git'

export type DirNode = { dirs: string[]; files: string[] }

export type Index = Map<string, DirNode>

export type Row = {
  kind: 'dir' | 'file'
  path: string
  label: string
  depth: number
  isOpen: boolean
  guide: string
  isLast: boolean
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function dirname(path: string): string {
  const at = path.lastIndexOf('/')

  return at < 0 ? '' : path.slice(0, at)
}

export function ancestors(path: string): string[] {
  const out: string[] = []
  for (let dir = dirname(path); dir !== ''; dir = dirname(dir)) out.push(dir)

  return out
}

function byName(a: string, b: string): number {
  const x = basename(a).toLowerCase()
  const y = basename(b).toLowerCase()

  return x < y ? -1 : x > y ? 1 : 0
}

export function buildIndex(files: string[]): Index {
  const dirs = new Map<string, Set<string>>([['', new Set()]])
  const leaves = new Map<string, string[]>()
  for (const file of files) {
    let child = file
    let parent = dirname(file)
    const list = leaves.get(parent)
    if (list) list.push(file)
    else leaves.set(parent, [file])
    while (true) {
      const known = dirs.get(parent)
      if (child !== file) {
        if (known?.has(child)) break
        if (known) known.add(child)
        else dirs.set(parent, new Set([child]))
      } else if (!known) {
        dirs.set(parent, new Set())
      }
      if (parent === '') break
      child = parent
      parent = dirname(parent)
    }
  }
  const index: Index = new Map()
  for (const [dir, children] of dirs) {
    index.set(dir, {
      dirs: [...children].sort(byName),
      files: (leaves.get(dir) ?? []).sort(byName),
    })
  }

  return index
}

export function dirStatuses(status: Record<string, GitCode>): Map<string, GitCode> {
  const out = new Map<string, GitCode>()
  for (const [path, code] of Object.entries(status)) {
    for (const dir of ancestors(path)) out.set(dir, stronger(out.get(dir), code))
  }

  return out
}

function compact(index: Index, dir: string): { path: string; label: string } {
  let path = dir
  let label = basename(dir)
  for (let node = index.get(path); node && node.dirs.length === 1 && node.files.length === 0; node = index.get(path)) {
    path = node.dirs[0] ?? path
    label += '/' + basename(path)
  }

  return { path, label }
}

export function flatten(index: Index, expanded: Set<string>, limit: number): Row[] {
  const rows: Row[] = []
  const walk = (dir: string, depth: number, guide: string) => {
    const node = index.get(dir)
    if (!node) return
    const total = node.dirs.length + node.files.length
    node.dirs.forEach((child, i) => {
      if (rows.length >= limit) return
      const { path, label } = compact(index, child)
      const isOpen = expanded.has(path)
      const isLast = i === total - 1
      rows.push({ kind: 'dir', path, label, depth, isOpen, guide, isLast })
      if (isOpen) walk(path, depth + 1, guide + (isLast ? '   ' : '│  '))
    })
    node.files.forEach((file, i) => {
      if (rows.length >= limit) return
      const isLast = node.dirs.length + i === total - 1
      rows.push({ kind: 'file', path: file, label: basename(file), depth, isOpen: false, guide, isLast })
    })
  }
  walk('', 0, '')

  return rows
}

export function allDirs(index: Index): string[] {
  return [...index.keys()].filter((dir) => dir !== '')
}
