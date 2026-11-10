import { execFileSync } from 'node:child_process'
import process from 'node:process'

const MARKETPLACE = '.claude-plugin/marketplace.json'
const PLUGIN_JSON = '.claude-plugin/plugin.json'
const SHIPPED = /^(hooks|src|types)\/|^\.claude-plugin\/plugin\.json$/

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

const versionAt = (rev) => {
  const text = git('show', `${rev}:${MARKETPLACE}`)
  if (text === undefined) return ''
  const plugin = JSON.parse(text).plugins?.find((p) => p.source === './')

  return plugin?.version ?? ''
}

const parts = (v) => v.split('.').filter(Boolean).map(Number)

const isNewer = (a, b) => {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }

  return false
}

const expected = (committed) => {
  const d = new Date()
  const today = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
  const nn = committed.startsWith(today + '.') ? Number(committed.split('.').at(-1)) + 1 : 1

  return `${today}.${String(nn).padStart(2, '0')}`
}

const errors = []

const staged = (git('diff', '--cached', '--name-only') ?? '').split('\n').filter(Boolean)
if (staged.some((p) => SHIPPED.test(p))) {
  const working = versionAt('')
  const committed = versionAt('HEAD')
  if (!isNewer(working, committed)) {
    errors.push(
      'プラグインが変更されていますが、marketplace.json のバージョンが未更新です:',
      `  project-tree: ${working || '(なし)'} → ${expected(committed)}`,
    )
  }
}

const pluginJson = git('show', `:${PLUGIN_JSON}`)
if (pluginJson !== undefined && 'version' in JSON.parse(pluginJson)) {
  errors.push(
    'plugin.json に version が定義されています。version は marketplace.json に一本化してください' +
      '（plugin.json の version が優先され、marketplace.json の bump が配布されなくなるため）:',
    `  ${PLUGIN_JSON}: "version" を削除してください`,
  )
}

if (errors.length > 0) {
  process.stderr.write(errors.join('\n') + '\n')
  process.exit(1)
}
