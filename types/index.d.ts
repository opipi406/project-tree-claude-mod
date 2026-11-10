export type GitCode = 'M' | 'A' | 'D' | 'U' | 'R' | '!'

export type RepoSnapshot = {
  root: string
  name: string
  isGit: boolean
  branch: string
  ahead: number
  behind: number
  files: string[]
  status: Record<string, GitCode>
  isTruncated: boolean
  rev: number
}

export type ViewMode = 'tree' | 'find' | 'preview' | 'git' | 'git-diff'

export type GitFocus = 'graph' | 'files' | 'diff'

export type IconStyle = 'basic' | 'nerd'

declare module 'claude-code' {
  interface PluginState {
    'project-tree': {
      repo: Shaped<RepoSnapshot>
      expanded: Shaped<string[]>
      selected: string
      active: string
      mode: ViewMode
      query: string
      scrollTop: number
      previewPath: string
      previewTop: number
      gitCommit: string
      gitFile: string
      gitFocus: GitFocus
      gitTop: number
      gitDiffTop: number
    }
  }
}
