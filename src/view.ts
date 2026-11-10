import type { GitCode, IconStyle } from '../types'
import { GIT_COLORS, clip, fileIcon, folderIcon, width } from './icons'
import { basename } from './tree'
import type { Row } from './tree'

export const BOLD = 1
export const DIM = 2
export const STRIKE = 4

export const GUIDE_COLOR = '#3e4148'
export const MUTED_COLOR = '#5c6370'

export type Seg = [string, string | null, number]

export type ViewRow = { p: string; s: Seg[]; sel?: true }

export type PreviewView = { path: string; source: string; startLine: number; error?: string }

export type ViewProps = { rows: ViewRow[]; cols: number; height: number; dim?: true; preview?: PreviewView }

export type ViewMessage =
  | { t: 'click'; p: string; dbl: boolean }
  | { t: 'menu'; p: string }
  | { t: 'close-find' }
  | { t: 'copy-abs' | 'copy-rel' | 'mention' | 'preview' | 'open' | 'finder'; p: string }
  | {
      t: 'key'
      k:
        | 'up'
        | 'down'
        | 'left'
        | 'right'
        | 'enter'
        | 'find'
        | 'home'
        | 'end'
        | 'pageup'
        | 'pagedown'
        | 'preview'
        | 'open'
        | 'close'
        | 'collapse'
        | 'expand'
        | 'refresh'
    }

export function formatRow(
  row: Row,
  o: { code: GitCode | undefined; style: IconStyle; cols: number; isActive: boolean },
): Seg[] {
  const isDir = row.kind === 'dir'
  const color = o.code ? GIT_COLORS[o.code] : null
  const flags = (o.isActive ? BOLD : 0) | (o.code === 'D' ? STRIKE : 0)
  const segs: Seg[] = [[' ' + row.guide + (row.isLast ? '└─ ' : '├─ '), GUIDE_COLOR, 0]]
  if (isDir && o.style === 'nerd') {
    const icon = folderIcon(basename(row.path), row.isOpen, o.style)
    segs.push([icon.glyph, icon.color, 0])
  }
  if (!isDir) {
    const icon = fileIcon(row.label, o.style)
    segs.push([icon.glyph, icon.color, 0], [' ', null, 0])
  }
  const lead = segs.reduce((n, s) => n + width(s[0]), 0)
  const suffix = isDir ? '/' : ''
  const label = clip(row.label + suffix, Math.max(4, o.cols - lead - 3))
  segs.push([label, color, flags | (isDir ? BOLD : 0)])
  const badge = o.code ? (isDir ? '●' : o.code) : ''
  segs.push([' '.repeat(Math.max(1, o.cols - lead - width(label) - 2)), null, 0])
  segs.push([badge.padEnd(2, ' '), color, 0])

  return segs
}
