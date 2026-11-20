import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Scan, SessionRow, SessionState } from '../types'

const PANE = 'session-board'
const TITLE = 'Sessions'
const HOURS = 24
const EVERY_MS = 5000
const RECENT_MS = 5 * 3600_000 // sessions active in the last 5 h always stay visible under "Recent"
const TITLE_MAX = 20 // upper bound; a narrow panel gets shorter titles (see titleMax)
const TITLE_MIN = 10
const BADGE_WIDTH = 4 // fits "49m", "10h"

const scan = atom({ plugin: 'session-board', key: 'scan' } as const, { at: 0, sessions: [] } as Scan, {
  shape: 'scan-1',
})
const showAllRecent = atom({ plugin: 'session-board', key: 'showAllRecent' } as const, false)
const showDone = atom({ plugin: 'session-board', key: 'showDone' } as const, false)

// 'fresh' (finished, not seen yet) is listed under 'waiting': either way you need to go in and react.
const ORDER: SessionState[] = ['working', 'stalled', 'waiting', 'done', 'archived', 'error']
const LABEL: Record<SessionState, string> = {
  waiting: 'Needs you',
  fresh: 'Finished, not seen',
  working: 'Working',
  stalled: 'Stalled mid-turn',
  done: 'Recent',
  archived: 'Done',
  error: 'Read error',
}
const COLOR: Record<SessionState, string> = {
  waiting: 'warning',
  fresh: 'success',
  working: 'suggestion',
  stalled: 'error',
  done: 'success',
  archived: 'inactive',
  error: 'error',
}

// The time badge next to the title; its color says how urgent it is.
function short(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

function badge(s: SessionRow, now: number): { text: string; color?: string } {
  const idle = now - s.lastActiveMs
  if (s.state === 'waiting' || s.state === 'fresh') {
    return { text: short(idle), color: idle < 15 * 60000 ? 'warning' : 'error' }
  }
  if (s.state === 'stalled') return { text: short(idle), color: 'error' }
  if (s.state === 'working') return { text: short(now - (s.turnStartedMs ?? s.lastActiveMs)), color: 'suggestion' }
  return { text: short(idle) }
}

// Progress bar from the session's task list, e.g. ▰▰▰▱▱▱
function bar(done: number, total: number): string {
  const width = Math.min(8, Math.max(4, total))
  const full = Math.round((done / total) * width)
  return '▰'.repeat(full) + '▱'.repeat(width - full)
}

function cut(text: string | undefined, n: number): string | undefined {
  if (!text) return text
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

// Sub-sessions go right under their parent when both are in the same list; `level` is the depth
// of that nesting. A sub-session whose parent is listed elsewhere stays at level 0.
function arrange(rows: SessionRow[]): { s: SessionRow; level: number }[] {
  const listed = new Set(rows.map(r => r.localId).filter(Boolean))
  const isNested = (r: SessionRow) => !!r.parentLocalId && listed.has(r.parentLocalId)
  const out: { s: SessionRow; level: number }[] = []
  const seen = new Set<string>()
  const add = (s: SessionRow, level: number) => {
    if (seen.has(s.id)) return
    seen.add(s.id)
    out.push({ s, level })
    if (s.localId) for (const child of rows) if (child.parentLocalId === s.localId) add(child, level + 1)
  }
  for (const r of rows) if (!isNested(r)) add(r, 0)
  // Rows left over can only be a parent loop; list them flat rather than drop them.
  for (const r of rows) add(r, 0)
  return out
}

let isScanning = false

async function refresh($: EngineInterface) {
  if (isScanning) return
  isScanning = true
  try {
    const script = `${$.plugin.root}/scripts/scan.mjs`
    const { exitCode, stdout, stderr } = await $.process.run(['node', script, String(HOURS)], {
      timeoutMs: 20000,
    })
    if (exitCode !== 0) {
      await update($, scan, old => ({ ...old, error: cut(stderr, 200) ?? `exit code ${exitCode}` }))
      return
    }
    const fresh = JSON.parse(stdout) as Scan
    await update($, scan, () => fresh)
  } catch (err) {
    await update($, scan, old => ({ ...old, error: cut(String(err), 200) }))
  } finally {
    isScanning = false
  }
}

async function setDone($: EngineInterface, s: SessionRow, isDone: boolean) {
  // The scanner reports where the marks file lives (~/.claude/session-board-done.json).
  const file = (await read($, scan)).marksFile
  if (!file) return
  const at = await $.clock.now()
  let marks: Record<string, number> = {}
  try {
    marks = JSON.parse(await $.fs.read(file)) as Record<string, number>
  } catch {}
  if (isDone) marks[s.id] = at
  else delete marks[s.id]
  // Marks older than two weeks belong to sessions long out of the scan window.
  for (const [id, when] of Object.entries(marks)) if (at - when > 14 * 86400_000) delete marks[id]
  await $.fs.write(file, JSON.stringify(marks))
  // Show it right away instead of waiting for the next scan.
  const next: SessionState = isDone ? 'archived' : 'done'
  await update($, scan, old => ({ ...old, sessions: old.sessions.map(x => (x.id === s.id ? { ...x, state: next } : x)) }))
}

// The app ignores links clicked inside a pane, so the OS opens the session's app link instead
// (the same as clicking it from outside the app). Windows only for now.
async function openSession($: EngineInterface, localId: string | undefined) {
  if (!localId || !/^local_[0-9a-f-]+$/.test(localId)) return
  try {
    await $.process.run(['explorer.exe', `claude://claude.ai/epitaxy/${localId}`], { timeoutMs: 10000 })
  } catch (err) {
    $.ui.toast(`Could not open the session: ${String(err).slice(0, 80)}`)
  }
}

async function start($: EngineInterface) {
  await $.command.register({
    name: 'sessions',
    description: 'Show the panel with the progress of all your sessions',
  })
  void refresh($)
  $.clock.every(EVERY_MS, () => refresh($))
  void $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await start($)
    return started
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    return { text: 'Sessions panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const data = await read($, scan)
    const isAllRecent = await read($, showAllRecent)
    const isDoneShown = await read($, showDone)
    const now = await $.clock.now()
    // The session this panel is open in (id = transcript name) gets a highlighted button.
    const selfId = await $.session.id().catch(() => '')
    // The desktop button never wraps its label, so the title is cut to what the panel's width
    // leaves after the badge and the ✓ button. Button text is wider than a cell, hence the 0.75.
    const columns = e.viewport?.columns ?? 40
    const titleMax = Math.max(TITLE_MIN, Math.min(TITLE_MAX, Math.floor((columns - BADGE_WIDTH - 10) * 0.75)))

    const groups = ORDER.map(state => ({
      state,
      rows: data.sessions.filter(s => s.state === state || (state === 'waiting' && s.state === 'fresh')),
    })).filter(g => g.rows.length > 0)

    const row = ({ s, level }: { s: SessionRow; level: number }) => {
      const isBusy = s.state === 'working' || s.state === 'stalled'
      // Nested under its parent: an arrow before the title. Parent listed in another section: a line naming it.
      const arrow = level > 0 ? `${' '.repeat((level - 1) * 2)}↳` : undefined
      const from = level === 0 && s.parentTitle ? cut(s.parentTitle, titleMax + 2) : undefined
      const max = Math.max(TITLE_MIN, titleMax - (arrow ? arrow.length + 1 : 0))
      const tag = badge(s, now)
      // ✓ marks the session done (it moves to "Done"), ↺ brings it back.
      const canMark = s.state === 'waiting' || s.state === 'fresh' || s.state === 'done' || s.state === 'archived'

      return (
        <Box key={s.id} flexDirection="column" width="100%">
          <Box flexDirection="row" alignItems="center" gap={1} width="100%">
            {/* Badge on the left with a fixed width, so the times form an even column. */}
            <Box width={BADGE_WIDTH} flexShrink={0} justifyContent="center" backgroundColor={tag.color}>
              <Text size="caption" weight="semibold" color={tag.color ? 'inverseText' : undefined} dimColor={!tag.color}>
                {tag.text}
              </Text>
            </Box>
            {arrow ? (
              <Box flexShrink={0}>
                <Text dimColor>{arrow}</Text>
              </Box>
            ) : null}
            {/* The desktop app draws only a Button's label; the box grows so the ✓ buttons line up on the right. */}
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Button
                key={`open-${s.id}`}
                label={cut(s.title, max) ?? s.title}
                variant={s.id === selfId ? 'primary' : undefined}
                dimColor={s.id !== selfId && (s.state === 'done' || s.state === 'archived')}
                onPress={() => openSession($, s.localId)}
              />
            </Box>
            {canMark ? (
              <Box flexShrink={0}>
                <Button
                  key={`mark-${s.id}`}
                  label={s.state === 'archived' ? '↺' : '✓'}
                  dimColor
                  onPress={() => setDone($, s, s.state !== 'archived')}
                />
              </Box>
            ) : null}
          </Box>
          {from ? (
            <Box flexDirection="row" paddingLeft={BADGE_WIDTH + 1}>
              <Text size="footnote" dimColor>
                ↳ from {from}
              </Text>
            </Box>
          ) : null}
          {isBusy && (s.progress?.total || s.background) ? (
            <Box flexDirection="row" gap={1} paddingLeft={BADGE_WIDTH + 1}>
              {s.progress && s.progress.total > 0 ? (
                <Text size="footnote" color="suggestion">
                  {bar(s.progress.done, s.progress.total)}{' '}
                  <Text dimColor>
                    {s.progress.done}/{s.progress.total}
                  </Text>
                </Text>
              ) : null}
              {s.background ? (
                <Text size="footnote" dimColor>
                  ⏳ background
                </Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
      )
    }

    // Counts sit in the section headers, so there is no totals bar above the list.
    return (
      <Box flexDirection="column" padding={1} gap={2}>
        {data.error && (
          <Text color="error" size="footnote">
            Scan failed: {data.error}
          </Text>
        )}
        {data.at === 0 && !data.error && <Text dimColor>Reading sessions…</Text>}
        {data.at > 0 && groups.length === 0 && <Text dimColor>No sessions in the last {HOURS} h.</Text>}
        {groups.map(g => {
          const isRecent = g.state === 'done'
          const isDone = g.state === 'archived'
          const recent = g.rows.filter(r => now - r.lastActiveMs < RECENT_MS)
          const shown = isDone ? (isDoneShown ? g.rows : []) : isRecent && !isAllRecent ? recent : g.rows
          const hidden = g.rows.length - shown.length
          return (
            <Box key={`g-${g.state}`} flexDirection="column" gap={1}>
              <Box flexDirection="row" gap={1} marginBottom={1}>
                <Text weight="bold" color={COLOR[g.state]}>
                  {LABEL[g.state]}
                </Text>
                <Text dimColor>{g.rows.length}</Text>
              </Box>
              {arrange(shown).map(row)}
              {isRecent && hidden > 0 && (
                <Button
                  key="more-recent"
                  label={`Show older (${hidden})`}
                  plain
                  dimColor
                  onPress={() => update($, showAllRecent, () => true)}
                />
              )}
              {isDone && (
                <Button
                  key="toggle-done"
                  label={isDoneShown ? 'Collapse' : `Show (${g.rows.length})`}
                  plain
                  dimColor
                  onPress={() => update($, showDone, v => !v)}
                />
              )}
              {isRecent && isAllRecent && g.rows.length > recent.length && (
                <Button
                  key="less-recent"
                  label="Collapse older"
                  plain
                  dimColor
                  onPress={() => update($, showAllRecent, () => false)}
                />
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
