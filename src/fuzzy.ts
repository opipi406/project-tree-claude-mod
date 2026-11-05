export type Match = { path: string; score: number; hits: number[] }

const SEPARATORS = '/._- '

function subsequence(text: string, lower: string, query: string, from: number): { score: number; hits: number[] } | undefined {
  const hits: number[] = []
  let score = 0
  let at = from
  for (const ch of query) {
    const found = lower.indexOf(ch, at)
    if (found < 0) return undefined
    const prev = hits[hits.length - 1]
    if (prev !== undefined && found === prev + 1) score += 6
    const before = text[found - 1]
    if (found === from || (before !== undefined && SEPARATORS.includes(before))) score += 8
    else if (before !== undefined && before === before.toLowerCase() && text.charAt(found) !== text.charAt(found).toLowerCase()) score += 6
    score -= Math.min(found - at, 10) * 0.2
    hits.push(found)
    at = found + 1
  }

  return { score, hits }
}

export function search(files: string[], raw: string, limit: number): Match[] {
  const query = raw.toLowerCase().replace(/\s+/g, '')
  if (query === '') return []
  const usePath = query.includes('/')
  const out: Match[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    const nameAt = path.lastIndexOf('/') + 1
    const inName = usePath ? undefined : subsequence(path, lower, query, nameAt)
    const hit = inName ? { score: inName.score + 100, hits: inName.hits } : subsequence(path, lower, query, 0)
    if (!hit) continue
    const exact = lower.slice(nameAt) === query ? 50 : lower.slice(nameAt).startsWith(query) ? 20 : 0
    out.push({ path, score: hit.score + exact - path.length * 0.05, hits: hit.hits })
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length)

  return out.slice(0, limit)
}
