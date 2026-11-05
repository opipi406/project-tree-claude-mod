import type { ClientModule } from 'claude-code'

import { BOLD, DIM, GUIDE_COLOR, MUTED_COLOR, STRIKE } from './view'
import type { ViewMessage, ViewProps } from './view'

type Menu = { x: number; y: number; p: string }

type Local = { hover?: number; menu?: Menu; menuHover?: number; last?: { p: string; at: number }; prefix?: 'g' | 'z' }

const ITEMS = [
  ['copy-abs', 'Copy Path'],
  ['copy-rel', 'Copy Relative Path'],
  ['-', ''],
  ['mention', 'Add to Prompt (@)'],
  ['open', 'Open with Default App'],
  ['finder', 'Reveal in Finder'],
] as const

const MENU_W = 24
const MENU_H = ITEMS.length + 2
const DOUBLE_MS = 400
const SELECTED_BG = '#04395e'
const HOVER_BG = '#2a2d2e'
const MENU_BG = '#252526'
const MENU_HOVER_BG = '#04395e'

const LETTERS: Record<string, 'find' | 'open' | 'collapse' | 'expand' | 'refresh'> = {
  p: 'find',
  '/': 'find',
  o: 'open',
  c: 'collapse',
  x: 'expand',
  r: 'refresh',
}

type Move = 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown'

const VIM: Record<string, Move> = { j: 'down', k: 'up', h: 'left', l: 'right', G: 'end' }

const VIM_CTRL: Record<string, Move> = { d: 'pagedown', u: 'pageup', f: 'pagedown', b: 'pageup', n: 'down' }

const VIM_Z: Record<string, 'collapse' | 'expand' | 'left' | 'right'> = { M: 'collapse', R: 'expand', c: 'left', o: 'right' }

const KEYS: Record<string, Move | 'enter'> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  return: 'enter',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
}

const TreeView: ClientModule<ViewProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  const st: Local = surface.state ?? {}
  const send = (m: ViewMessage) => surface.post(m)
  const menu = st.menu
  const pos = menu
    ? {
        left: Math.max(0, Math.min(menu.x, props.cols - MENU_W)),
        top: menu.y + 1 + MENU_H <= props.height ? menu.y + 1 : Math.max(0, menu.y - MENU_H),
      }
    : undefined
  const itemAt = (x: number, y: number): number =>
    pos && x >= pos.left && x < pos.left + MENU_W && y > pos.top && y < pos.top + MENU_H - 1 ? y - pos.top - 1 : -1

  surface.onPointer(ev => {
    if (ev.type === 'leave') {
      if (st.hover !== undefined || st.menuHover !== undefined) surface.setState({ ...st, hover: undefined, menuHover: undefined })
      return
    }
    if (ev.type === 'move' && ev.button === undefined) {
      if (menu) {
        const i = itemAt(ev.x, ev.y)
        if (i !== (st.menuHover ?? -1)) surface.setState({ ...st, menuHover: i })
      } else if (ev.y !== st.hover) {
        surface.setState({ ...st, hover: ev.y })
      }
      return
    }
    if (ev.type !== 'down') return
    if (props.dim) {
      send({ t: 'close-find' })
      return
    }
    if (menu) {
      const item = ITEMS[itemAt(ev.x, ev.y)]
      if (item && item[0] !== '-') send({ t: item[0], p: menu.p })
      surface.setState({ ...st, menu: undefined, menuHover: undefined })
      if (item || ev.button !== 'right') return
    }
    const row = props.rows[ev.y]
    if (!row) return
    if (ev.button === 'right') {
      surface.setState({ ...st, menu: { x: ev.x, y: ev.y, p: row.p }, menuHover: undefined })
      send({ t: 'menu', p: row.p })
      return
    }
    if (ev.button !== 'left') return
    const now = Date.now()
    const dbl = st.last?.p === row.p && now - st.last.at < DOUBLE_MS
    surface.setState({ ...st, last: dbl ? undefined : { p: row.p, at: now } })
    send({ t: 'click', p: row.p, dbl })
  })

  surface.onKey(ev => {
    if (menu) {
      surface.setState({ ...st, menu: undefined })
      return
    }
    const key = ev.shift && ev.key.length === 1 ? ev.key.toUpperCase() : ev.key
    if (st.prefix) {
      surface.setState({ ...st, prefix: undefined })
      const z = st.prefix === 'z' ? VIM_Z[key] : undefined
      if (st.prefix === 'g' && key === 'g') send({ t: 'key', k: 'home' })
      else if (z) send({ t: 'key', k: z })
      return
    }
    if (ev.key === 'p' && (ev.meta || ev.ctrl)) {
      send({ t: 'key', k: 'find' })
      return
    }
    const ctrlMove = ev.ctrl ? VIM_CTRL[ev.key] : undefined
    if (ctrlMove) {
      send({ t: 'key', k: ctrlMove })
      return
    }
    if (!ev.ctrl && !ev.meta && (key === 'g' || key === 'z')) {
      surface.setState({ ...st, prefix: key })
      return
    }
    const vim = !ev.ctrl && !ev.meta ? VIM[key] : undefined
    if (vim) {
      send({ t: 'key', k: vim })
      return
    }
    const letter = LETTERS[ev.key]
    if (letter && !ev.ctrl && !ev.meta) {
      send({ t: 'key', k: letter })
      return
    }
    const k = KEYS[ev.key]
    if (k) send({ t: 'key', k })
  })

  return (
    <Box flexDirection="column" width={props.cols} height={props.height}>
      {props.rows.map((row, y) => {
        const bg = row.sel ? SELECTED_BG : y === st.hover && !menu ? HOVER_BG : undefined

        return (
          <Box flexDirection="row">
            {row.s.map(([text, color, flags]) => (
              <Text
                color={props.dim && color !== GUIDE_COLOR ? MUTED_COLOR : (color ?? undefined)}
                backgroundColor={bg}
                bold={(flags & BOLD) !== 0}
                dimColor={!props.dim && (flags & DIM) !== 0}
                strikethrough={(flags & STRIKE) !== 0}
              >
                {text}
              </Text>
            ))}
          </Box>
        )
      })}
      {pos && (
        <Box
          position="absolute"
          top={pos.top}
          left={pos.left}
          width={MENU_W}
          flexDirection="column"
          borderStyle="round"
          borderDimColor
          backgroundColor={MENU_BG}
        >
          {ITEMS.map(([id, label], i) =>
            id === '-' ? (
              <Text dimColor backgroundColor={MENU_BG}>{'─'.repeat(MENU_W - 2)}</Text>
            ) : (
              <Text backgroundColor={i === st.menuHover ? MENU_HOVER_BG : MENU_BG}>
                {(' ' + label).padEnd(MENU_W - 2, ' ')}
              </Text>
            ),
          )}
        </Box>
      )}
    </Box>
  )
}

export default TreeView
