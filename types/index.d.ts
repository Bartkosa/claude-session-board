// fresh: finished after you last opened it (not seen yet). archived: you marked it done.
export type SessionState = 'waiting' | 'working' | 'fresh' | 'done' | 'archived' | 'stalled' | 'error'

export type SessionRow = {
  id: string
  localId?: string
  // Set only for a sub-session whose parent (the session that started or forked it) is on the board.
  parentLocalId?: string
  parentTitle?: string
  title: string
  project?: string
  state: SessionState
  step?: string
  progress?: { done: number; total: number }
  recap?: string
  ask?: string
  pendingTool?: string
  prompt?: string
  error?: string
  turnStartedMs?: number
  lastTool?: string
  lastToolMs?: number
  background?: { summary: string; count: number; sinceMs: number }
  lastActiveMs: number
  lastMessageMs?: number
}

// marksFile: where "done" marks live; the scanner owns the path so the mod writes the same file.
export type Scan = { at: number; sessions: SessionRow[]; error?: string; marksFile?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-board': { scan: Shaped<Scan>; showAllRecent: boolean; showDone: boolean }
  }
}
