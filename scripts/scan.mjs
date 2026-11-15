// Scans Claude Code session transcripts (~/.claude/projects/*/*.jsonl)
// and prints JSON with the state of every session active in the last N hours.
// Reads only the tail of each file (transcripts can be tens of MB).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOURS = Number(process.argv[2] ?? 24)
const TAIL = 3 * 1024 * 1024
const ROOT = path.join(os.homedir(), '.claude', 'projects')
const now = Date.now()
const since = now - HOURS * 3600_000

function readTail(file, size) {
  const fd = fs.openSync(file, 'r')
  try {
    const start = Math.max(0, size - TAIL)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { text, isCut: start > 0 }
  } finally {
    fs.closeSync(fd)
  }
}

// The title is sometimes only near the start of the file, when the tail lacks it.
function readTitleFromHead(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    let title
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"custom-title"')) continue
      try {
        title = JSON.parse(line).customTitle ?? title
      } catch {}
    }
    return title
  } finally {
    fs.closeSync(fd)
  }
}

function humanText(msg) {
  const c = msg?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return undefined
  if (c.some(b => b.type === 'tool_result')) return undefined
  const t = c.filter(b => b.type === 'text').map(b => b.text).join(' ')
  return t || undefined
}

const LONG_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'Monitor'])
// A dev server started in the background never ends and the session does not wait for it,
// so it must not count as work in progress (unlike a CI watch, a test run or a build).
const SERVER_RE =
  /--port\b|\buvicorn\b|http\.server|start:local|\b(vite|astro) (dev|preview)\b|\bpnpm (--filter \S+ )?(run )?(dev|preview|start)(:(?!push)[\w-]+)?(\s|$)/
function isServer(t) {
  return /^(Bash|PowerShell)$/.test(t.name) && SERVER_RE.test(String(t.input?.command ?? ''))
}

const TOOL_LABEL = {
  Bash: 'Terminal',
  PowerShell: 'PowerShell',
  Read: 'Reading',
  Edit: 'Editing',
  Write: 'Writing',
  Grep: 'Searching',
  Glob: 'Finding files',
  Agent: 'Subagent',
  WebSearch: 'Web search',
  WebFetch: 'Reading a page',
}

function toolSummary(name, input) {
  const base = s => String(s).replace(/^.*[\\/]/, '')
  const label = TOOL_LABEL[name] ?? name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^mcp__/, '')
  let what
  if (name === 'Bash' || name === 'PowerShell') what = input.description ?? input.command
  else if (input.file_path) what = base(input.file_path)
  else if (name === 'Grep' || name === 'Glob') what = input.pattern
  else if (name === 'Agent') what = input.description
  else what = input.description ?? input.query ?? input.url ?? input.title
  what = what ? String(what).replace(/\s+/g, ' ').trim() : ''
  if (what.length > 70) what = `${what.slice(0, 69)}…`
  return what ? `${label} · ${what}` : label
}

function applyPlan(plan, input) {
  if (Array.isArray(input.items)) {
    return input.items.map(i => ({ content: String(i.content ?? ''), status: i.status ?? 'pending' }))
  }
  if (!plan) return plan
  const next = plan.map(i => ({ ...i }))
  if (input.advance) {
    const cur = next.findIndex(i => i.status === 'in_progress')
    if (cur >= 0) next[cur].status = 'completed'
    const nx = next.findIndex((i, k) => k > cur && i.status === 'pending')
    if (nx >= 0) next[nx].status = 'in_progress'
  }
  for (const d of input.done ?? []) if (next[d - 1]) next[d - 1].status = 'completed'
  if (input.start && next[input.start - 1]) {
    for (const i of next) if (i.status === 'in_progress') i.status = 'pending'
    next[input.start - 1].status = 'in_progress'
  }
  return next
}

function scanFile(file, stat, project) {
  const { text } = readTail(file, stat.size)
  let title
  let plan
  let wrap // { recap, ask, at }
  let lastPrompt // { text, at }
  let lastAssistant // { stop, toolNames, at }
  let pendingTools = new Map()
  let lastTool // { name, summary, at }
  const background = new Map() // id → { summary, at }
  let cwd
  let lastAt = 0

  for (const line of text.split('\n')) {
    if (!line) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type === 'custom-title') title = o.customTitle ?? title
    // A background task's end arrives as a <task-notification> (in a message or in the queue).
    if (line.includes('task-notification')) {
      for (const m of line.matchAll(/<task-id>([A-Za-z0-9_-]+)<\/task-id>[\s\S]{0,600}?<status>(\w+)<\/status>/g)) {
        if (m[2] !== 'running') background.delete(m[1])
      }
    }
    if (o.cwd) cwd = o.cwd
    if (o.type !== 'user' && o.type !== 'assistant') continue
    if (o.isSidechain) continue
    const at = o.timestamp ? Date.parse(o.timestamp) : 0
    if (at) lastAt = Math.max(lastAt, at)

    if (o.type === 'user') {
      const content = o.message?.content
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type !== 'tool_result') continue
          // Background shell commands report backgroundTaskId; background subagents report isAsync + agentId.
          // Both end with a <task-notification> carrying that id.
          const r = o.toolUseResult
          const bgId = r?.backgroundTaskId ?? (r?.isAsync && r?.agentId ? r.agentId : undefined)
          const started = pendingTools.get(b.tool_use_id)
          if (bgId && started && !isServer(started)) {
            background.set(bgId, { summary: toolSummary(started.name, started.input), at })
          }
          pendingTools.delete(b.tool_use_id)
        }
      }
      const t = !o.isMeta && humanText(o.message)
      if (t && !t.startsWith('<') && !t.startsWith('[Request interrupted')) {
        lastPrompt = { text: t, at }
        wrap = undefined
        // A task list belongs to one turn: your new message starts a turn with no list.
        plan = undefined
        lastTool = undefined
        pendingTools = new Map()
      }
      lastAssistant = undefined
      continue
    }

    const blocks = Array.isArray(o.message?.content) ? o.message.content : []
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue
      pendingTools.set(b.id, { name: b.name, input: b.input ?? {}, at })
      if (!b.name.startsWith('mcp__ccd_')) lastTool = { name: b.name, summary: toolSummary(b.name, b.input ?? {}), at }
      if (b.name === 'mcp__ccd_turn__update_plan') plan = applyPlan(plan, b.input ?? {})
      if (b.name === 'mcp__ccd_turn__wrap_up') {
        wrap = { recap: b.input?.recap, ask: b.input?.ask, at }
        // wrap_up ticks off the task list
        if (plan) plan = plan.map(i => ({ ...i, status: 'completed' }))
      }
    }
    lastAssistant = { stop: o.message?.stop_reason, at }
  }

  if (!title) title = readTitleFromHead(file)
  const mtime = stat.mtimeMs
  const idleMs = now - Math.max(mtime, lastAt)
  const pendingList = [...pendingTools.values()]
  const pending = pendingList.map(p => p.name)
  // Tools that run long by themselves: silence while they run is work, not a permission prompt.
  const isLongRunning = p =>
    LONG_TOOLS.has(p.name) ||
    (/^(Bash|PowerShell)$/.test(p.name) && (p.input.run_in_background || now - p.at < (p.input.timeout ?? 120_000)))

  // Background tasks the session waits on; ones older than 2 h are usually dev servers, so skip them.
  const bg = [...background.values()].filter(b => now - b.at < 2 * 3600_000).sort((a, b) => b.at - a.at)

  let state
  if (pending.includes('AskUserQuestion') || pending.includes('ExitPlanMode')) state = 'waiting'
  else if (lastAssistant?.stop === 'end_turn' && wrap?.ask) state = 'waiting'
  else if (lastAssistant?.stop === 'end_turn' && bg.length > 0) state = 'working'
  else if (lastAssistant?.stop === 'end_turn') state = 'done'
  else if (pendingList.length > 0 && pendingList.every(isLongRunning)) state = 'working'
  else if (pendingList.length > 0 && idleMs > 90_000) state = 'waiting' // most likely a permission prompt
  else if (idleMs < 5 * 60_000) state = 'working'
  else state = 'stalled'

  const current = plan?.find(i => i.status === 'in_progress')
  const doneCount = plan?.filter(i => i.status === 'completed').length ?? 0

  return {
    id: path.basename(file, '.jsonl'),
    title: title ?? (lastPrompt?.text ?? '(untitled)').slice(0, 60),
    project: (cwd ?? project).replace(/^.*[\\/]/, ''),
    state,
    step: current?.content,
    // A finished list (e.g. after wrap_up) says nothing about work in progress.
    progress: plan && doneCount < plan.length ? { done: doneCount, total: plan.length } : undefined,
    recap: wrap?.recap,
    ask: wrap?.ask,
    pendingTool: state === 'waiting' && pending.length ? pending[pending.length - 1] : undefined,
    prompt: lastPrompt?.text?.slice(0, 120),
    turnStartedMs: lastPrompt?.at || undefined,
    lastTool: lastTool && state !== 'done' ? lastTool.summary : undefined,
    lastToolMs: lastTool?.at || undefined,
    background: bg.length ? { summary: bg[0].summary, count: bg.length, sinceMs: bg[0].at } : undefined,
    lastActiveMs: Math.max(mtime, lastAt),
    // Last real message (yours or the session's), not app bookkeeping like titles; used by "done" marks.
    lastMessageMs: lastAt || undefined,
  }
}

// Sessions you marked done in the panel: transcript id → when. The mod writes this file.
const MARKS_FILE = path.join(os.homedir(), '.claude', 'session-board-done.json')
function loadMarks() {
  try {
    return JSON.parse(fs.readFileSync(MARKS_FILE, 'utf8'))
  } catch {
    return {}
  }
}
const marks = loadMarks()

// Desktop app session metadata: cliSessionId (= transcript name) → local_… id, title, archived.
function loadDesktop() {
  const map = new Map()
  const base = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Claude-Data')
  if (!base || !fs.existsSync(base)) return map
  const walk = (dir, depth) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory() && depth > 0) walk(p, depth - 1)
      else if (e.isFile() && e.name.startsWith('local_') && e.name.endsWith('.json')) {
        try {
          if (fs.statSync(p).mtimeMs < since) continue
          const o = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (o.cliSessionId) {
            map.set(o.cliSessionId, {
              localId: o.sessionId,
              title: o.title,
              isArchived: !!o.isArchived,
              focusedAt: o.lastFocusedAt ?? 0,
              turnEdgeAt: o.lastTurnEdgeAt ?? 0,
            })
          }
        } catch {}
      }
    }
  }
  for (const acc of fs.readdirSync(base, { withFileTypes: true })) {
    if (!acc.isDirectory()) continue
    const root = path.join(base, acc.name, 'claude-code-sessions')
    if (fs.existsSync(root)) walk(root, 2)
  }
  return map
}
const desktop = loadDesktop()

const out = []
for (const dir of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const p = path.join(ROOT, dir.name)
  let names
  try {
    names = fs.readdirSync(p)
  } catch {
    continue
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const file = path.join(p, name)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    if (stat.mtimeMs < since) continue
    const d = desktop.get(path.basename(name, '.jsonl'))
    if (d?.isArchived) continue
    try {
      const row = scanFile(file, stat, dir.name)
      if (d) {
        row.localId = d.localId
        if (d.title) row.title = d.title
        // Finished after you last opened the session = not seen yet.
        if (row.state === 'done' && d.turnEdgeAt > d.focusedAt) row.state = 'fresh'
      }
      // A done session comes back by itself when a new message appears after the mark.
      const markedAt = marks[row.id]
      const isQuiet = row.state !== 'working' && row.state !== 'stalled'
      if (markedAt && isQuiet && markedAt >= (row.lastMessageMs ?? 0)) row.state = 'archived'
      out.push(row)
    } catch (err) {
      out.push({ id: name, title: name, state: 'error', error: String(err), lastActiveMs: stat.mtimeMs })
    }
  }
}
out.sort((a, b) => b.lastActiveMs - a.lastActiveMs)

process.stdout.write(JSON.stringify({ at: now, sessions: out, marksFile: MARKS_FILE }))
