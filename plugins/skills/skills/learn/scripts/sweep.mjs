#!/usr/bin/env node
// Hold a learn pass to the whole session.
//
// Recall favours the end of a long session, so a pass written from memory
// records its last stretch. This script makes the pass work from the
// transcript instead:
//
//   start       cut the session transcript, up to the latest learn invocation,
//               into fixed-size chunks, each carrying its own extraction
//               instructions
//   ledger      an extractor's way to file its chunk's ledger (JSON on stdin);
//               refuses a ledger that skipped part of the chunk
//   show        print one transcript entry in full, for text a chunk cut short
//   candidates  list every candidate the extractors found
//   dispose     record a candidate's disposition: recorded / covered / rejected
//   check       fail on any chunk without a ledger, any candidate without a
//               disposition, and any disposition the files do not bear out
//   report      print the learnings that landed, from a passing check
//   release     close the run because the user called it off, quoting them
//   hook        Stop hook: block the turn while the latest learn run has no
//               passing check
//
// The ledger lives beside the transcript, in <session>/learn/<invocation>/, so
// the Stop hook finds it from its own transcript_path input. See ../SKILL.md
// and docs/learn-sweep.md in the ~/.agents repo. Node 18+, no dependencies.

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUDGET = 80000 // condensed characters of transcript per chunk
const CONTEXT_CHARS = 4000 // tail of the previous chunk shown for continuity only
const PROMPTS_CHARS = 4000 // the span's human prompts, shown so a mid-session chunk knows the task
const COVER_WINDOW = 5 // lines either side of a cited line searched for a quote
const MIN_QUOTE = 12
const RELEASE_SHARE = 0.6 // a release quote is a whole message or most of one
const NO_PROGRESS_BLOCKS = 3 // pushes per user turn before the hook stops repeating itself

// The bars a candidate can be rejected under. SKILL.md defines each one; a
// test keeps the two in step.
export const BARS = {
  'repo-only': 'belongs in a global or user file, a memory, or another repo',
  overfit: 'only true of the one artifact or incident; no claim transfers',
  overgeneral: 'a platitude any agent already follows',
  transient: 'true only during this session',
  superseded: 'reversed or corrected later in the session',
  'not-a-learning': 'routine work with nothing to know before acting',
  'user-declined': 'the user said not to record it',
}

const LEARN_SKILL = /^(?:[\w.-]+:)?learn$/
const LEARN_COMMAND = /<command-name>\/(?:[\w.-]+:)?learn<\/command-name>/
const CODEX_LEARN = /\[\$learn\]\(|(?:^|\s)\$learn(?:\s|$)/
const BLOCK_LEAD = 'Learn sweep incomplete.'
const WAIT_TASK_TYPES = new Set(['subagent', 'agent', 'workflow', 'local_agent', 'local_workflow'])

const SR = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const HANDBACK_FRAME = /^[\s\S]*?The report follows:\n/
const HANDBACK_TAIL = /\n\s*(?:<\/agent-message>|This message came from another Claude session)[\s\S]*$/
const NON_HUMAN_PREFIXES = ['<task-notification>', '<local-command-', '<command-name>/model',
  '<ci-monitor-event>', 'The app was quit', '[Request interrupted']

export class SweepError extends Error {}

// ---------- small helpers ----------

/** Cut s to head + tail characters, naming where the full text is. */
const trunc = (s, head, tail = 0, n = null) => {
  if (s.length <= head + tail) return s
  const where = n ? `; full text: sweep show ${n}` : ''
  return s.slice(0, head) + `\n…[${s.length - head - tail} chars cut${where}]…\n` + (tail ? s.slice(-tail) : '')
}
const norm = s => String(s ?? '').split(/\s+/).filter(Boolean).join(' ')
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
const short = text => hash(text).slice(0, 16)
const token = () => randomBytes(6).toString('hex')
const real = p => { try { return realpathSync(p) } catch { return p } }
const expand = p => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p)
const isDir = p => { try { return statSync(p).isDirectory() } catch { return false } }
const isFile = p => { try { return statSync(p).isFile() } catch { return false } }
const listDir = p => { try { return readdirSync(p) } catch { return [] } }
const within = (p, root) => p === root || p.startsWith(root + sep)
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x)

export const readJson = p => JSON.parse(readFileSync(p, 'utf8'))
export function writeJson (p, data) {
  writeFileSync(p + '.tmp', JSON.stringify(data, null, 1) + '\n')
  renameSync(p + '.tmp', p)
}

function git (repo, args, env = {}) {
  const r = spawnSync('git', ['--literal-pathspecs', '-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, ...env } })
  if (r.status !== 0) throw new SweepError(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`)
  return r.stdout
}
const gitOk = (repo, args) => spawnSync('git', ['--literal-pathspecs', '-C', repo, ...args], { encoding: 'utf8' }).status === 0

function stringify (c) {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map(b => {
      if (b && ['text', 'input_text', 'output_text'].includes(b.type)) return b.text ?? ''
      if (b && ['image', 'input_image'].includes(b.type)) return '[image]'
      return JSON.stringify(b)
    }).join('\n')
  }
  return JSON.stringify(c)
}

function userText (content) {
  if (typeof content === 'string') return content.replace(SR, '').trim()
  const parts = []
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === 'text') parts.push(String(b.text ?? ''))
    else if (b?.type === 'image') parts.push('[image]')
  }
  return parts.join('\n').replace(SR, '').trim()
}

// ---------- locating the transcript ----------

/** Parsed JSONL entries, each tagged with its 1-based line number in _n. */
export function load (path) {
  const entries = []
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue
    let e
    try { e = JSON.parse(lines[i]) } catch { continue }
    if (isObj(e)) {
      e._n = i + 1
      entries.push(e)
    }
  }
  return entries
}

export function detectFormat (entries) {
  return entries.slice(0, 50).some(e => ['session_meta', 'response_item', 'event_msg', 'turn_context'].includes(e.type))
    ? 'codex'
    : 'claude'
}

function claudeDirs (env) {
  const dirs = [env.CLAUDE_CONFIG_DIR, '~/.claude'].filter(Boolean).map(expand)
  for (const name of listDir(homedir()).sort()) {
    if (name.startsWith('.claude.')) dirs.push(join(homedir(), name))
  }
  return dirs.filter(d => isDir(join(d, 'projects')))
}

const codexHome = env => expand(env.CODEX_HOME || '~/.codex')

// A value the host did not fill in: empty, or a placeholder such as "${CLAUDE_SESSION_ID}".
const envValue = v => (v && !v.startsWith('${') ? v : null)

const newest = (paths, key) => paths.reduce((best, p) => (best === null || key(p) > key(best) ? p : best), null)

export function findTranscript ({ session, thread, env }) {
  session = envValue(session) || envValue(env.CLAUDE_CODE_SESSION_ID)
  if (session) {
    const hits = []
    for (const d of claudeDirs(env)) {
      for (const proj of listDir(join(d, 'projects'))) {
        const p = join(d, 'projects', proj, session + '.jsonl')
        if (isFile(p)) hits.push(p)
      }
    }
    if (hits.length) return real(newest(hits, p => statSync(p).mtimeMs))
  }
  thread = envValue(thread) || envValue(env.CODEX_THREAD_ID)
  if (thread) {
    const home = codexHome(env)
    const hits = []
    const walk = (dir, depth) => {
      for (const name of listDir(dir)) {
        const p = join(dir, name)
        if (depth > 0 && isDir(p)) walk(p, depth - 1)
        else if (name.startsWith('rollout-') && name.includes(thread) && name.endsWith('.jsonl')) hits.push(p)
      }
    }
    walk(join(home, 'sessions'), 3)
    walk(join(home, 'archived_sessions'), 0)
    if (hits.length) return real(newest(hits, p => statSync(p).size))
  }
  throw new SweepError('cannot find this session\'s transcript: pass --transcript, or --session ' +
    '(Claude Code session id) / --thread (Codex thread id)')
}

/** <session>/learn for a Claude transcript; $CODEX_HOME/learn/<rollout> for Codex. */
export function ledgerRoot (transcript, fmt, env = process.env) {
  transcript = real(expand(transcript))
  if (fmt === 'codex') return join(codexHome(env), 'learn', basename(transcript).replace(/\.jsonl$/, ''))
  return join(transcript.endsWith('.jsonl') ? transcript.slice(0, -'.jsonl'.length) : transcript + '.d', 'learn')
}

export const ledgerDirFor = (transcript, fmt, inv, env = process.env) =>
  join(ledgerRoot(transcript, fmt, env), inv.id.replace(/[^\w.-]/g, '_'))

// ---------- learn invocations ----------

/** {kind, toolId} when this entry invokes the learn skill, else null. */
export function invocationOf (e) {
  if (e.type === 'assistant' && !e.isSidechain) {
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (b?.type === 'tool_use' && b.name === 'Skill' && LEARN_SKILL.test(String(b.input?.skill ?? ''))) {
        return { kind: 'skill_tool', toolId: b.id }
      }
    }
  } else if (e.type === 'user' && !e.isMeta && !e.isSidechain) {
    const text = userText(e.message?.content)
    if ((text.startsWith('<command-message>') || text.startsWith('<command-name>')) && LEARN_COMMAND.test(text)) {
      return { kind: 'slash_command' }
    }
  } else if (e.type === 'event_msg') {
    const p = e.payload || {}
    if (p.type === 'item_completed' && p.item?.type === 'UserMessage' && CODEX_LEARN.test(stringify(p.item.content))) {
      return { kind: 'codex' }
    }
  }
  return null
}

const record = (e, hit) => ({ id: e.uuid || `L${e._n}`, line: e._n, kind: hit.kind })

/** Whether a Skill call's tool_result reports an error (a denied or failed launch). */
function failedCall (lines, from, toolId) {
  const needle = `"tool_use_id":"${toolId}"`
  for (let i = from; i < lines.length && i < from + 400; i++) {
    if (!lines[i].includes(needle)) continue
    try {
      const e = JSON.parse(lines[i])
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type === 'tool_result' && b.tool_use_id === toolId) return Boolean(b.is_error)
      }
    } catch {}
  }
  return false
}

/** Every learn invocation, oldest first. Lines is the raw JSONL split by line. */
function scanInvocations (lines, onlyCandidates) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (onlyCandidates && !lines[i].includes('learn')) continue
    let e
    let hit
    try {
      e = JSON.parse(lines[i])
      if (!isObj(e)) continue
      e._n = i + 1
      hit = invocationOf(e)
    } catch { continue }
    if (!hit) continue
    if (hit.toolId && failedCall(lines, i + 1, hit.toolId)) continue
    out.push(record(e, hit))
  }
  return out
}

export const invocationsIn = path => scanInvocations(readFileSync(path, 'utf8').split('\n'), true)

/** The latest learn invocation, parsing only lines that could hold one. */
export function latestInvocationFast (path) {
  return invocationsIn(path).at(-1) ?? null
}

const anchorFile = (path, fmt, env) => join(ledgerRoot(path, fmt, env), 'active.json')

function readAnchor (path, fmt, env) {
  try {
    const a = readJson(anchorFile(path, fmt, env))
    return isObj(a) && typeof a.id === 'string' && Number.isInteger(a.line) ? a : null
  } catch { return null }
}

/**
 * The run every command but start acts on: the invocation start anchored, unless
 * a newer learn invocation has appeared since.
 */
function currentInvocation (path, entries, fmt, env) {
  const found = invocationsIn(path).at(-1) ?? null
  const anchor = readAnchor(path, fmt, env)
  const inv = anchor && (!found || anchor.line >= found.line) ? anchor : found
  if (inv) return inv
  throw new SweepError(`no learn invocation in ${path}`)
}

/**
 * The invocation a new start anchors. Learn asked for in plain words leaves no
 * invocation entry (always so in Codex, sometimes in Claude Code when a pass is
 * re-run from the skill already in context). When the latest invocation has
 * already passed, or there is none, and the user has written since, the newest
 * user message stands in for a new one.
 */
function startInvocation (path, entries, fmt, env) {
  let found = null
  try { found = currentInvocation(path, entries, fmt, env) } catch {}
  const d = found && ledgerDirFor(path, fmt, found, env)
  const closed = found && (verdictOk(d) === true || releasedOk(d, path, found))
  if (found && !closed) return found
  // a request typed mid-turn counts as much as one that opens a turn
  const last = condense(entries, fmt).filter(u => u.human || u.kind === 'human_midturn').at(-1)
  if (last && (!found || last.n > found.line)) return { id: last.uuid || `L${last.n}`, line: last.n, kind: 'prompt' }
  return found
}

// ---------- condensing ----------

function isHumanPrompt (e, text) {
  if (e.isMeta || e.isCompactSummary || e.isSidechain || !text) return false
  // platform text (CI events, notifications) can carry origin.kind "human"
  if (NON_HUMAN_PREFIXES.some(p => text.startsWith(p))) return false
  const kind = e.origin?.kind
  return kind == null || kind === 'human' // older versions carry no origin
}

const cleanHandback = s => s.replace(HANDBACK_FRAME, '').replace(HANDBACK_TAIL, '').replace(/^ {2}/gm, '').trim()

function notificationText (text, n) {
  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)
  const status = text.match(/<status>([\s\S]*?)<\/status>/)
  const result = text.match(/<result>([\s\S]*?)<\/result>/)
  let out = `[task ${status ? status[1] : '?'}] ${summary ? summary[1].trim() : ''}`
  if (result && !result[1].includes('it is not repeated here')) out += '\n' + trunc(result[1].trim(), 8000, 1500, n)
  return out
}

const isDoc = p => /\.(md|mdx|txt)$/i.test(String(p ?? ''))

function toolInputText (name, inp, n) {
  if (!isObj(inp)) return trunc(stringify(inp), 1500, 0, n)
  if (name === 'Edit' || name === 'MultiEdit') {
    const s = { file_path: inp.file_path }
    if ('old_string' in inp) {
      s.old = trunc(inp.old_string || '', 400, 0, n)
      s.new = trunc(inp.new_string || '', isDoc(inp.file_path) ? 3000 : 800, 0, n)
    }
    if ('edits' in inp) s.edits = inp.edits?.length
    return JSON.stringify(s)
  }
  if (name === 'Write') return JSON.stringify({ file_path: inp.file_path, content: trunc(inp.content || '', isDoc(inp.file_path) ? 6000 : 800, 0, n) })
  if (name === 'Agent' || name === 'Task') {
    return JSON.stringify({ description: inp.description, subagent_type: inp.subagent_type, prompt: trunc(inp.prompt || '', 2000, 0, n) })
  }
  if (name === 'Bash') return JSON.stringify({ command: trunc(inp.command || '', 4000, 0, n), description: inp.description })
  if (name === 'Skill') return JSON.stringify({ skill: inp.skill, args: trunc(String(inp.args ?? ''), 4000, 0, n) })
  if (name === 'Workflow') {
    return JSON.stringify({ scriptPath: inp.scriptPath, script: trunc(inp.script || '', 1500, 0, n), args: trunc(JSON.stringify(inp.args ?? ''), 800, 0, n) })
  }
  return trunc(JSON.stringify(inp), 1500, 0, n)
}

function toolResultText (name, s, err, n) {
  if (err) return trunc(s, 4000, 1000, n) // errors, denials, user rejections: keep nearly whole
  if (name === 'Agent' || name === 'Task') {
    if (s.startsWith('Async agent launched')) return '[async agent launched; its report arrives later as a hand-back]'
    return trunc(s, 8000, 1500, n)
  }
  if (name === 'AskUserQuestion') return s // the human's answers
  return trunc(s, 1500, 500, n)
}

/** Units {n, uuid, ts, kind, text, human, msg}: what carries learning signal. */
export function condenseClaude (entries) {
  const units = []
  const uuids = new Set(entries.map(e => e.uuid).filter(Boolean))
  const toolNames = new Map()
  const seen = new Set() // reports already kept, by body or task id
  let lastBoundary = null
  const add = (e, kind, text, human = false, msg = null, tool = null) => {
    if (text) units.push({ n: e._n, uuid: e.uuid ?? null, ts: e.timestamp ?? null, kind, text, human, msg, tool })
  }
  const once = (key, fn) => {
    if (key && seen.has(key)) return
    if (key) seen.add(key)
    fn()
  }
  const handback = (e, body) => {
    body = cleanHandback(body)
    if (body) once(body, () => add(e, 'handback', trunc(body, 8000, 1500, e._n)))
  }
  const notification = (e, text) => {
    const id = text.match(/<task-id>([\s\S]*?)<\/task-id>/)?.[1]
    once(id ? `task:${id}` : null, () => add(e, 'task_report', notificationText(text, e._n)))
  }

  for (const e of entries) {
    if (e.isSidechain) continue
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      lastBoundary = e
      continue
    }
    if (e.type === 'assistant') {
      const m = e.message || {}
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === 'text') add(e, 'assistant', String(b.text ?? '').trim(), false, m.id)
        else if (b?.type === 'tool_use') {
          toolNames.set(b.id, b.name)
          add(e, 'tool_use', `${b.name} ${toolInputText(b.name, b.input, e._n)}`, false, m.id)
        }
      }
      continue
    }
    if (e.type === 'user') {
      const content = e.message?.content
      if (e.isCompactSummary) {
        if (lastBoundary && uuids.has(lastBoundary.logicalParentUuid)) {
          add(e, 'compact_summary', '[compaction summary omitted: the entries it summarises are above]')
        } else add(e, 'compact_summary', userText(content))
        continue
      }
      if (e.isMeta) {
        const text = userText(content)
        if (e.origin?.kind === 'peer') handback(e, e.origin.body || text)
        else if (text.startsWith('Base directory for this skill:')) {
          add(e, 'skill_loaded', `[skill loaded: ${basename(text.split('\n', 1)[0].replace(/\/+$/, ''))}]`)
        } else if (text.startsWith('Stop hook feedback:')) add(e, 'hook_feedback', trunc(text, 1500))
        continue
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_result') {
            const err = Boolean(b.is_error)
            const tool = toolNames.get(b.tool_use_id) || ''
            add(e, err ? 'tool_error' : 'tool_result', toolResultText(tool, stringify(b.content), err, e._n), false, null, tool)
          }
        }
        if (content.every(b => b?.type === 'tool_result')) continue
      }
      const text = userText(content)
      if (text.startsWith('<task-notification>')) {
        notification(e, text)
        continue
      }
      const human = isHumanPrompt(e, text)
      add(e, human ? 'human' : 'user_other', text, human)
      continue
    }
    if (e.type === 'attachment') {
      const a = e.attachment || {}
      if (a.type === 'queued_command') {
        const p = typeof a.prompt === 'string' ? a.prompt : stringify(a.prompt)
        // each of these exists only as this attachment, never as a user entry
        if (a.origin?.kind === 'human') add(e, 'human_midturn', p.replace(SR, '').trim())
        else if (a.origin?.kind === 'peer') handback(e, a.origin.body || p)
        else if (a.commandMode === 'task-notification' || a.origin?.kind === 'task-notification' || p.trimStart().startsWith('<task-notification>')) {
          notification(e, p)
        }
      } else if (a.type === 'hook_blocking_error') {
        const be = a.blockingError
        add(e, 'hook_block', trunc(String(isObj(be) ? be.blockingError : be), 1500))
      } else if (a.type === 'hook_non_blocking_error') {
        add(e, 'hook_error', trunc(JSON.stringify(a), 800))
      } else if (a.type === 'edited_text_file') {
        add(e, 'user_edit', `[file changed outside the agent: ${a.filename}] ${trunc(a.snippet || '', 800)}`)
      }
    }
    // everything else (system prompt snapshots, listings, reminders, titles,
    // queue operations, file history, cost) carries no learning signal
  }
  return units
}

export function condenseCodex (entries) {
  const units = []
  const names = new Map()
  const add = (e, kind, text, human = false, msg = null) => {
    if (text) units.push({ n: e._n, uuid: null, ts: e.timestamp ?? null, kind, text, human, msg })
  }
  for (const e of entries) {
    const p = e.payload || {}
    if (e.type === 'event_msg' && p.type === 'item_completed') {
      const item = p.item || {}
      if (item.type === 'UserMessage') add(e, 'human', stringify(item.content).trim(), true)
      else if (item.type === 'FileChange') add(e, 'file_change', trunc(Object.keys(item.changes || {}).sort().join(', '), 600))
    } else if (e.type === 'response_item') {
      if (p.type === 'message' && p.role === 'assistant') add(e, 'assistant', stringify(p.content).trim(), false, p.id)
      else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        names.set(p.call_id, p.name)
        const inp = p.type === 'function_call' ? p.arguments : p.input
        add(e, 'tool_use', `${p.name} ${trunc(stringify(inp), 4000, 0, e._n)}`, false, p.id)
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const out = isObj(p.output) ? p.output.content : p.output
        const s = stringify(out)
        const err = /Exit code [1-9]|exited with code [1-9]|\bError\b/.test(s.slice(0, 400))
        add(e, err ? 'tool_error' : 'tool_result', toolResultText(names.get(p.call_id), s, err, e._n))
      }
    }
  }
  return units
}

export const condense = (entries, fmt) => (fmt === 'codex' ? condenseCodex(entries) : condenseClaude(entries))

/** The full text of one transcript entry, for `show`. */
function fullText (e) {
  if (e.type === 'assistant') {
    return (e.message?.content || []).map(b => (b?.type === 'text' ? b.text : b?.type === 'tool_use' ? `${b.name} ${JSON.stringify(b.input, null, 1)}` : '')).filter(Boolean).join('\n')
  }
  if (e.type === 'user') {
    const c = e.message?.content
    if (Array.isArray(c)) return c.map(b => (b?.type === 'tool_result' ? stringify(b.content) : b?.type === 'text' ? b.text : '')).join('\n')
    return userText(c)
  }
  if (e.type === 'attachment') return stringify(e.attachment?.prompt ?? e.attachment)
  if (e.payload) return stringify(e.payload.item?.content ?? e.payload.content ?? e.payload.output ?? e.payload.input ?? e.payload.arguments ?? e.payload)
  return JSON.stringify(e)
}

// ---------- chunking ----------

export const size = units => units.reduce((n, u) => n + u.text.length, 0)

function turnsOf (units) {
  const turns = []
  let cur = []
  for (const u of units) {
    if (u.human && cur.length) {
      turns.push(cur)
      cur = []
    }
    cur.push(u)
  }
  if (cur.length) turns.push(cur)
  return turns
}

// Split an oversize turn within budget, never mid-message. A cut prefers the
// last phase boundary (a skill launch, or a message the human typed mid-turn)
// that leaves the piece at least half full, then the last assistant-message
// boundary. A skill launch inside a message that opened with text cuts before
// that text, so the message stays whole.
function splitTurn (turn, budget) {
  const pieces = []
  let cur = []
  let n = 0
  let lastMsg = null
  let msgStartIdx = 0
  let weak = []
  let strong = []
  for (const u of turn) {
    const assistantish = u.kind === 'assistant' || u.kind === 'tool_use'
    const msgStart = assistantish && u.msg !== lastMsg
    if (msgStart) msgStartIdx = cur.length
    if (assistantish) lastMsg = u.msg
    const skill = u.kind === 'tool_use' && u.text.startsWith('Skill ')
    const phase = skill || u.kind === 'human_midturn'
    const boundary = skill && !msgStart ? msgStartIdx : cur.length
    if (cur.length && n + u.text.length > budget) {
      const w = weak.concat(msgStart || phase ? [boundary] : [])
      const st = strong.concat(phase ? [boundary] : [])
      let c = st.filter(k => k > 0 && size(cur.slice(0, k)) >= budget / 2)
      let cut = c.length ? c[c.length - 1] : null
      if (cut === null) {
        c = w.filter(k => k > 0)
        cut = c.length ? c[c.length - 1] : cur.length
      }
      pieces.push(cur.slice(0, cut))
      cur = cur.slice(cut)
      weak = weak.filter(k => k > cut).map(k => k - cut)
      strong = strong.filter(k => k > cut).map(k => k - cut)
      msgStartIdx = Math.max(0, msgStartIdx - cut)
      n = size(cur)
    }
    const at = skill && !msgStart ? msgStartIdx : cur.length
    if (msgStart || phase) weak.push(at)
    if (phase) strong.push(at)
    cur.push(u)
    n += u.text.length
  }
  if (cur.length) pieces.push(cur)
  return pieces
}

export function chunkUnits (units, budget = BUDGET) {
  const chunks = []
  let cur = []
  for (const turn of turnsOf(units)) {
    const n = size(turn)
    if (n > budget) {
      if (cur.length) chunks.push(cur)
      const pieces = splitTurn(turn, budget)
      chunks.push(...pieces.slice(0, -1))
      cur = [...pieces[pieces.length - 1]]
      continue
    }
    if (cur.length && size(cur) + n > budget) {
      chunks.push(cur)
      cur = []
    }
    cur.push(...turn)
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/** A unit's citation in the chunk text: @<transcript line>, or a caller's label. */
const defaultLabel = u => `@${u.n}`
export const render = (units, label = defaultLabel) =>
  units.map(u => `[${u.kind} ${label(u)}]\n${u.text}\n`).join('\n')

function tailContext (units, chars = CONTEXT_CHARS) {
  const out = []
  let n = 0
  for (let i = units.length - 1; i >= 0 && n < chars; i--) {
    out.unshift(units[i])
    n += units[i].text.length
  }
  return out
}

/** A prompt as a person would recognise it: "/command args" for a slash command, cut to n characters. */
function snippet (text, n = 80) {
  const cmd = text.match(/<command-name>([\s\S]*?)<\/command-name>/)
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)
  const s = norm(cmd ? `${cmd[1]} ${args ? args[1] : ''}` : text.replace(/<[^>]+>/g, ' '))
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/**
 * The user's prompts a chunk needs to know its task: the session's earliest
 * prompts as space allows, the middle elided, then the one that opened the turn
 * the chunk starts in. Prompts inside the slice are in the slice already.
 */
function promptDigest (prompts, firstLine, label = defaultLabel) {
  const before = prompts.filter(u => (u.human || u.kind === 'human_midturn') && u.n < firstLine)
  let open = before.length - 1
  while (open > 0 && !before[open].human) open--
  // the prompt that opened the chunk's turn, with the last few messages typed into that turn
  const turn = open < 0 ? [] : [before[open], ...before.slice(open + 1).slice(-3)]
  const line = u => `- ${label(u)}: ${snippet(u.text, 300)}`
  const out = []
  let n = 0
  for (const u of before.slice(0, Math.max(0, open))) {
    const l = line(u)
    if (n + l.length > PROMPTS_CHARS / 2) {
      out.push('- …')
      break
    }
    out.push(l)
    n += l.length
  }
  for (const u of turn) out.push(line(u))
  return out.join('\n')
}

export const KINDS = `- correction: the user corrected, redirected or rejected something the agent did or proposed. Keep the user's
  words, and say what in the agent's framing allowed the misreading and what would have prevented it.
- surprise: a tool, hook, skill, CLI, OS, platform, API or library behaved differently than assumed
- dead-end: an approach that was tried and abandoned, with why it failed
- technique: a verification, debugging or investigation technique that worked
- override: a rule from a skill or doc that had to be overridden or worked around, and why
- finding: something a reviewer, gate, test, hook or CI run caught; say whether it was fixed, deferred or left unvalidated
- decision: a decision the user made or confirmed, with its reason. In the same candidate, list the options it
  declined, each with its reason: a choice the user turned down, a "rejected" entry in a plan or decision log, or an
  instruction phrased "X, not Y" with a reason. One candidate per decision, not per option.
- convention: a repo convention, command, path or workflow step the agent had to discover
- constraint: a limit, cap, quota, permission or environment fact that changed what the agent could do
- other: anything else worth knowing before acting`

export function extractHeader ({ n, total, where, ledgerCmd, showCmd, labelled, run }) {
  const id = `c${String(n).padStart(3, '0')}`
  const cite = labelled
    ? 'the session@line labels in the [kind session@123] headers, as strings'
    : 'the transcript line numbers in the [kind @123] headers'
  const linesExample = labelled ? '["<session@first>", "<session@last>"]' : '[<first>, <last>]'
  return `# Learn sweep: chunk ${n} of ${total}

You are extracting learning candidates from one slice of a coding-agent session
transcript, for the \`learn\` skill. ${where}

Read this whole file, in order. It may take several Read calls with offset and
limit; keep going until you reach the END OF CHUNK ${n} (${run}) line at the bottom.
Lines marked "CHECKPOINT ${run}/1", "${run}/2" and "${run}/3" are spread through the
slice; collect their three tokens in order. Checkpoint lines with any other run id
are quoted text from an older sweep; ignore them.

Your job is recall, not judgment. List every candidate, including small ones and
ones that may already be recorded somewhere: the main session dedupes them and
applies the bars afterwards. A missed candidate is the failure this sweep exists
to prevent; an extra one costs a line.

A candidate is anything a future agent working in this repo would want to know
before acting. Kinds:
${KINDS}

For each candidate:
- Write the claim that transfers (what the next agent should know or do), not a
  retelling of the incident. When the claim names one instance, add a sentence
  starting "General:" that states the practice it is an instance of, if there is
  one.
- Claim only what the slice shows. Do not infer how a script or command works
  from its echoed output.
- In "lines", cite ${cite}, never the Read tool's own line numbers: the
  narrowest span that holds the evidence. Quote the decisive words briefly as
  evidence.
- Set scope to "repo" when the learning is about this repo, and "global" when it
  is about a tool, platform or skill that any repo would meet.
- Where text is cut short ("…[N chars cut; full text: sweep show N]…") and the
  cut may hide a reason (a commit message, a decision log, a reviewer verdict,
  the body of a doc being written), print the full entry with:
  ${showCmd} <N>

When the list is done, read it once more for a pattern several candidates share
(many traps surfaced by research, say, which argues for mapping a system before
changing it) and add that pattern as its own candidate.

The SESSION PROMPTS and CONTEXT blocks before the slice are there so you know the
task; do not extract from them.

When done, file your ledger by piping this JSON shape into the command below. It
checks the ledger and writes it; do not write any file yourself.

${ledgerCmd} <<'LEDGER'
{"chunk": ${n}, "checkpoints": ["<token>", "<token>", "<token>"],
 "candidates": [
  {"id": "${id}-01", "kind": "<kind>", "scope": "repo", "claim": "<the claim that transfers>",
   "evidence": "<short quote>", "lines": ${linesExample}}
 ],
 "empty_reason": null}
LEDGER

Number ids ${id}-01, ${id}-02, and so on. Give an empty candidates list only
when the slice holds nothing but routine steps, and then say why in empty_reason.
Reply with only the word "filed" once the command accepts the ledger.
`
}

const SCRIPT = real(fileURLToPath(import.meta.url))
const RUN = `node "${SCRIPT}"`

/**
 * Write chunk files and their manifest. `pieces` is a list of chunks, each a
 * list of units. Three checkpoint tokens go through each slice, marked with this
 * sweep's run id; the manifest keeps only their hashes. A ledger that names them
 * shows an honest extractor read to the end of its chunk; it is no proof against
 * one that greps for them.
 */
export function writeChunks ({ dir, pieces, prompts: promptUnits, repoRoot, base, baseError, cwd, span, transcript, format, invocation, label, where, extra = {} }) {
  mkdirSync(dir, { recursive: true })
  const meta = []
  let prev = []
  if (!pieces.length) pieces = [[]]
  const all = pieces.flat()
  const run = token().slice(0, 6)
  pieces.forEach((c, i) => {
    const n = i + 1
    const name = `chunk-${String(n).padStart(3, '0')}`
    const tokens = [token(), token(), token()]
    const body = c.map(u => render([u], label))
    // insert the later checkpoint first so the earlier index still holds
    body.splice(Math.floor((2 * c.length) / 3), 0, `----- CHECKPOINT ${run}/2: ${tokens[1]} -----\n`)
    body.splice(Math.floor(c.length / 3), 0, `----- CHECKPOINT ${run}/1: ${tokens[0]} -----\n`)
    const first = c.length ? c[0].n : span.start_line
    const last = c.length ? c[c.length - 1].n : span.end_line
    const chunkPath = join(dir, name + '.md')
    const parts = [extractHeader({
      n,
      total: pieces.length,
      where: where || `The session ran in: ${repoRoot || cwd || '(not a git repo)'}`,
      ledgerCmd: `${RUN} ledger "${chunkPath}"`,
      showCmd: label ? `${RUN} show --transcript <that session's transcript> --line` : `${RUN} show --transcript "${transcript}" --line`,
      labelled: Boolean(label),
      run,
    })]
    const prompts = promptDigest(promptUnits || all, c.length ? c[0].n : span.start_line, label)
    if (prompts) parts.push('----- SESSION PROMPTS: what the user asked, for context; do not extract from it -----\n', prompts, '')
    const ctx = tailContext(prev)
    if (ctx.length) parts.push('----- CONTEXT: end of the previous chunk; do not extract from it -----\n', render(ctx, label))
    parts.push(`----- SLICE: chunk ${n} of ${pieces.length} -----\n`, ...body,
      `----- END OF CHUNK ${n} (${run}): CHECKPOINT ${run}/3: ${tokens[2]} -----\n`)
    writeFileSync(chunkPath, parts.join('\n'))
    meta.push({ n, file: name + '.md', ledger: name + '.ledger.json', chars: size(c), first_line: first, last_line: last, proofs: tokens.map(hash), ...(label ? { labelled: true } : {}) })
    prev = c
  })
  const humans = all.filter(u => u.human)
  const manifest = {
    version: 2,
    transcript,
    format,
    invocation,
    created_at: Date.now() / 1000,
    repo: { root: repoRoot, base, cwd, ...(baseError ? { base_error: baseError } : {}) },
    span: {
      ...span,
      first_ts: all[0]?.ts ?? null,
      last_ts: all.at(-1)?.ts ?? null,
      first_prompt: humans[0] ? snippet(humans[0].text) : null,
    },
    chunks: meta,
    ...extra,
  }
  writeJson(join(dir, 'manifest.json'), manifest)
  return manifest
}

// ---------- repo state ----------

/**
 * {root, base} for the repo the pass edits. base is a tree of the whole working
 * tree, untracked files included, built in a throwaway index: it touches neither
 * the stash list, the real index, nor the working tree.
 */
export function repoState (cwd) {
  let root
  try { root = git(cwd, ['rev-parse', '--show-toplevel']).trim() } catch { return { root: null, base: null } }
  const tmp = mkdtempSync(join(tmpdir(), 'learn-index-'))
  try {
    const index = join(tmp, 'index')
    const env = { GIT_INDEX_FILE: index }
    // seeding from the real index keeps its stat data, so tracked files are not re-hashed
    const realIndex = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim()
    if (isFile(realIndex)) writeFileSync(index, readFileSync(realIndex))
    // add -A never re-hashes a skip-worktree or assume-unchanged entry, so such a seed would hide local edits
    const flagged = isFile(index) && /^[a-zS] /m.test(git(root, ['ls-files', '-v'], env))
    if (!isFile(index) || flagged) {
      rmSync(index, { force: true })
      if (gitOk(root, ['rev-parse', '--verify', '-q', 'HEAD'])) git(root, ['read-tree', 'HEAD'], env)
    }
    // an unreadable file fails add -A; the tree of everything else still holds
    spawnSync('git', ['-C', root, 'add', '-A', '--ignore-errors'], { env: { ...process.env, ...env }, encoding: 'utf8' })
    return { root, base: git(root, ['write-tree'], env).trim() }
  } catch (ex) {
    return { root, base: null, base_error: ex.message }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Line through which an earlier passing ledger of this session swept, or 0. */
function previousEnd (rootDir, beforeLine) {
  let best = 0
  for (const name of listDir(rootDir)) {
    const d = join(rootDir, name)
    const m = join(d, 'manifest.json')
    if (!isFile(m) || verdictOk(d) !== true) continue
    const end = readJson(m).span.end_line
    if (end < beforeLine) best = Math.max(best, end)
  }
  return best
}

// ---------- ledgers ----------

/** Problems with a ledger's shape and proof against its chunk; [] when it holds. */
function ledgerProblems (led, c) {
  if (!isObj(led)) return ['ledger is not a JSON object']
  const out = []
  if (led.chunk !== c.n) out.push(`ledger names chunk ${JSON.stringify(led.chunk)}`)
  // the run's tokens in order; quoted tokens from an older sweep may sit between them
  const given = Array.isArray(led.checkpoints) ? led.checkpoints.map(x => hash(String(x))) : []
  const proofs = Array.isArray(c.proofs) ? c.proofs : []
  let found = 0
  for (const h of given) if (found < proofs.length && h === proofs[found]) found++
  if (found < proofs.length) {
    out.push(`${found} of ${proofs.length} checkpoint tokens found, in order; read the whole chunk and give every token marked with this sweep's run id`)
  }
  if (!Array.isArray(led.candidates)) return [...out, 'candidates is not a list']
  if (!led.candidates.length && !norm(led.empty_reason)) out.push('no candidates and no empty_reason')
  const prefix = `c${String(c.n).padStart(3, '0')}-`
  const seen = new Set()
  for (const [k, cand] of led.candidates.entries()) {
    if (!isObj(cand)) {
      out.push(`candidate ${k + 1} is not an object`)
      continue
    }
    const tag = typeof cand.id === 'string' && cand.id ? cand.id : `candidate ${k + 1}`
    if (typeof cand.id !== 'string' || !cand.id.startsWith(prefix)) out.push(`${tag}: ids in this chunk are ${prefix}01, ${prefix}02, …`)
    else if (seen.has(cand.id)) out.push(`${tag}: duplicate id`)
    seen.add(cand.id)
    if (!norm(cand.claim)) out.push(`${tag}: no claim`)
    const lines = Array.isArray(cand.lines) ? cand.lines : []
    if (!lines.length) out.push(`${tag}: lines must be a list such as [first, last]`)
    else if (!c.labelled) {
      // a single-session chunk cites transcript lines; a backfill chunk cites session@line labels
      const nums = lines.map(x => Number(String(x).replace(/^@/, '')))
      if (nums.some(x => !Number.isInteger(x) || x < c.first_line || x > c.last_line)) {
        out.push(`${tag}: lines ${JSON.stringify(cand.lines)} are not in this slice (${c.first_line}-${c.last_line}); use the numbers from the [kind @123] headers as plain integers, not the Read tool's line numbers`)
      }
    }
  }
  return out
}

/** [{chunk, ledger, error}], a ledger with any problem counting as not filed. */
function ledgers (d, man) {
  return man.chunks.map(c => {
    const p = join(d, c.ledger)
    if (!existsSync(p)) return { chunk: c, ledger: null, error: 'no ledger' }
    let led
    try { led = readJson(p) } catch (ex) { return { chunk: c, ledger: null, error: `unreadable ledger: ${ex.message}` } }
    const problems = ledgerProblems(led, c)
    return problems.length ? { chunk: c, ledger: null, error: problems.join('; ') } : { chunk: c, ledger: led, error: null }
  })
}

export function digestOf (d) {
  const h = createHash('sha256')
  for (const name of listDir(d).sort()) {
    if (name === 'manifest.json' || name.endsWith('.ledger.json') || name === 'released.json') {
      h.update(name + '\0')
      h.update(readFileSync(join(d, name)))
    }
  }
  return h.digest('hex')
}

/** true when a passing check still matches the ledger, false when stale, null when absent. */
export function verdictOk (d) {
  const p = join(d, 'verdict.json')
  if (!existsSync(p)) return null
  try {
    const v = readJson(p)
    return Boolean(v.pass) && v.digest === digestOf(d)
  } catch { return false }
}

// ---------- dispositions ----------

/** A disposition's file: absolute, or relative to the directory start ran in, else to the repo root. */
function resolvePath (path, man) {
  const p = expand(String(path ?? ''))
  if (isAbsolute(p)) return real(p)
  const { root, cwd } = man.repo || {}
  const fromCwd = cwd ? join(cwd, p) : null
  if (fromCwd && isFile(fromCwd)) return real(fromCwd)
  return real(root ? join(root, p) : p)
}

const toplevel = dir => {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  return r.status === 0 ? real(r.stdout.trim()) : null
}

/** The path as the filesystem spells it, or null when a component differs only in case. */
function exactCase (p) {
  let cur = p.startsWith(sep) ? sep : ''
  for (const part of p.split(sep).filter(Boolean)) {
    const names = listDir(cur || '.')
    if (!names.includes(part)) return names.some(x => x.toLowerCase() === part.toLowerCase()) ? null : p
    cur = join(cur, part)
  }
  return cur
}

function parseLoc (loc) {
  const m = String(loc ?? '').match(/^(.+):(\d+)$/)
  if (!m) throw new SweepError(`expected FILE:LINE, got ${JSON.stringify(loc)}`)
  return [m[1], Number(m[2])]
}

/**
 * Line numbers of the file that differ from the start snapshot, or 'all' for a
 * file new since then. Compares the snapshot's blob with the file's content
 * directly, so a file outside the real index (untracked, or a repo with no
 * commits) is compared like any other.
 */
function addedLines (repo, base, rel) {
  if (!gitOk(repo, ['cat-file', '-e', `${base}:${rel}`])) return 'all'
  const old = spawnSync('git', ['-C', repo, 'cat-file', 'blob', `${base}:${rel}`], { maxBuffer: 256 << 20 })
  if (old.status !== 0) throw new SweepError(`git cat-file ${base}:${rel} failed`)
  const tmp = mkdtempSync(join(tmpdir(), 'learn-blob-'))
  let out
  try {
    writeFileSync(join(tmp, 'base'), old.stdout)
    // run inside the repo so its eol attributes and config apply
    const r = spawnSync('git', ['-C', repo, 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--inter-hunk-context=0',
      join(tmp, 'base'), join(repo, rel)], { encoding: 'utf8', maxBuffer: 64 << 20 })
    if (r.status !== 0 && r.status !== 1) throw new SweepError(`git diff failed: ${(r.stderr || '').trim()}`)
    out = r.stdout
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  // credit an added line unless its hunk removed the same text: a line re-added only because a
  // newline was appended after it, or because its line ending changed, is not one the pass wrote
  const lines = new Set()
  let next = 0
  let removed = new Set()
  for (const l of out.split('\n')) {
    const h = l.match(/^@@ -\S+ \+(\d+)(?:,\d+)? @@/)
    if (h) {
      next = Number(h[1])
      removed = new Set()
    } else if (l.startsWith('-') && !l.startsWith('---')) removed.add(l.slice(1).replace(/\r$/, ''))
    else if (l.startsWith('+') && !l.startsWith('+++')) {
      if (!removed.has(l.slice(1).replace(/\r$/, ''))) lines.add(next)
      next++
    }
  }
  return lines
}

/** Whether this exact line was anywhere in the repo at start: moved or renamed text is not new. */
function inBase (repo, base, text) {
  const want = text.replace(/\r$/, '')
  // git grep has no whole-line flag: match the fixed string, then compare each hit's line exactly
  const r = spawnSync('git', ['-C', repo, 'grep', '-F', '-h', '-I', '-e', want, base], { encoding: 'utf8', maxBuffer: 64 << 20 })
  return r.status === 0 && r.stdout.split('\n').some(l => l.replace(/\r$/, '') === want)
}

/** Directories a disposition may never cite: the sweep's own files and transcripts. */
function forbiddenRoots (man) {
  const roots = isAbsolute(String(man.transcript ?? '')) ? [dirname(real(man.transcript))] : []
  for (const d of claudeDirs(process.env)) roots.push(real(join(d, 'projects')))
  roots.push(real(join(codexHome(process.env), 'sessions')), real(join(codexHome(process.env), 'learn')))
  return roots.filter(Boolean)
}

/** Problems with one candidate's disposition; [] when it holds. */
export function dispositionErrors (c, man, cache) {
  const d = c.disposition
  if (!isObj(d) || !['recorded', 'covered', 'rejected'].includes(d.type)) return ['no disposition']
  const { root: repo, base, cwd, base_error: baseError } = man.repo || {}
  if (d.type === 'rejected') {
    if (!Object.hasOwn(BARS, d.bar)) return [`rejected under unknown bar ${JSON.stringify(d.bar)} (bars: ${Object.keys(BARS).join(', ')})`]
    if (!norm(d.reason)) return ['rejected without a reason']
    return []
  }
  const path = resolvePath(d.file, man)
  const line = d.line
  if (!Number.isInteger(line) || line < 1) return ['no line number']
  if (!isFile(path)) return [`${d.file} does not exist (looked for ${path})`]
  if (exactCase(path) === null) return [`${d.file} differs in case from the file on disk; cite its exact name`]
  if (forbiddenRoots(man).some(r => within(path, r))) return [`${d.file} is a transcript or sweep file, not where a learning lives`]
  const text = readFileSync(path, 'utf8').split('\n')
  if (text.length && text[text.length - 1] === '') text.pop()
  if (line > text.length) return [`${d.file} has ${text.length} lines, cited line ${line}`]
  if (d.type === 'covered') {
    const q = norm(d.quote)
    if (q.length < MIN_QUOTE) return [`covered needs a quote of at least ${MIN_QUOTE} characters from the cited line`]
    const window = norm(text.slice(Math.max(0, line - 1 - COVER_WINDOW), line + COVER_WINDOW).join(' '))
    if (!window.includes(q)) return [`quote not found within ${COVER_WINDOW} lines of ${d.file}:${line}`]
    return []
  }
  // recorded: a line this pass wrote, inside the repo (or the start directory when there is none)
  if (!norm(text[line - 1])) return [`${d.file}:${line} is blank; cite the line that states the learning`]
  const home = repo ? real(repo) : cwd ? real(cwd) : null
  if (!home || !within(path, home) || (repo && toplevel(dirname(path)) !== home)) {
    return [`recorded outside the ${repo ? 'repo' : 'start directory'} (${path}); a learning for another file or repo is covered or rejected under repo-only`]
  }
  if (repo && !base) return [`the start snapshot failed (${baseError || 'unknown'}), so no line can be credited; fix it and run start --force`]
  if (repo) {
    const rel = relative(home, path)
    // check-ignore takes plain paths and refuses --literal-pathspecs
    if (spawnSync('git', ['-C', home, 'check-ignore', '-q', '--', rel]).status === 0) return [`${d.file} is ignored by git, so the learning would never land`]
    const key = `${home}\0${rel}`
    if (!cache.has(key)) {
      try { cache.set(key, addedLines(home, base, rel)) } catch (ex) { cache.set(key, ex) }
    }
    const changed = cache.get(key)
    if (changed instanceof Error) return [changed.message]
    if (changed === 'all') {
      if (inBase(home, base, text[line - 1])) return [`${path}:${line} was already in the repo when the sweep started (moved or renamed?); cite it as covered`]
      return []
    }
    if (changed && changed.has(line)) return []
    if (changed) return [`${path}:${line} was not written by this pass (unchanged since the sweep started)`]
  }
  if (statSync(path).mtimeMs / 1000 < (man.created_at || 0)) return [`${d.file} was not modified after the sweep started`]
  return []
}

/** The resolved file:line a recorded disposition claims, or null. */
const recordedAt = (cand, man) => (cand.disposition?.type === 'recorded' ? `${resolvePath(cand.disposition.file, man)}:${cand.disposition.line}` : null)
const twinProblem = (owner, line) => `${line} is already recorded by ${owner}; one learning per line, so cite this one as covered by it`

function applyDisposition (c, spec) {
  if ('recorded' in spec) {
    const [file, line] = parseLoc(spec.recorded)
    // the report line is printed as it is, so it is written for the reader, not taken from an extractor's claim
    if (!norm(spec.report)) throw new SweepError(`${spec.id}: a recorded learning needs "report": the one line the report prints for it`)
    c.disposition = { type: 'recorded', file, line, report: norm(spec.report) }
  } else if ('covered' in spec) {
    const [file, line] = parseLoc(spec.covered)
    c.disposition = { type: 'covered', file, line, quote: spec.quote ?? '' }
  } else if ('rejected' in spec) {
    c.disposition = { type: 'rejected', bar: spec.rejected, reason: spec.reason ?? '' }
  } else throw new SweepError(`${spec.id}: give one of recorded, covered, rejected`)
}

export function checkLedger (d, man) {
  const problems = []
  const counts = { recorded: 0, covered: 0, rejected: 0 }
  const ids = new Set()
  const cache = new Map()
  const owner = new Map()
  for (const { chunk: c, ledger: led, error } of ledgers(d, man)) {
    if (error) {
      problems.push(`chunk ${c.n}: ${error} (extract it again: Read ${join(d, c.file)} and follow the instructions at its top)`)
      continue
    }
    for (const cand of led.candidates) {
      if (ids.has(cand.id)) problems.push(`chunk ${c.n}: duplicate id ${cand.id}`)
      ids.add(cand.id)
      for (const p of dispositionErrors(cand, man, cache)) problems.push(`${cand.id}: ${p}`)
      const at = recordedAt(cand, man)
      if (at && owner.has(at)) problems.push(`${cand.id}: ${twinProblem(owner.get(at), `${cand.disposition.file}:${cand.disposition.line}`)}`)
      else if (at) owner.set(at, cand.id)
      const t = cand.disposition?.type
      if (t in counts) counts[t]++
    }
  }
  return { problems, counts }
}

// ---------- the active ledger ----------

function transcriptOf (a, io) {
  return a.transcript ? real(expand(a.transcript)) : findTranscript({ session: a.session, thread: a.thread, env: io.env })
}

/** {d, man} for --ledger, or this session's latest learn run. */
function active (a, io) {
  let d
  if (a.ledger) d = real(expand(a.ledger))
  else {
    const transcript = transcriptOf(a, io)
    const entries = load(transcript)
    const fmt = detectFormat(entries)
    d = ledgerDirFor(transcript, fmt, currentInvocation(transcript, entries, fmt, io.env), io.env)
  }
  const m = join(d, 'manifest.json')
  if (!existsSync(m)) throw new SweepError(`no sweep started for this learn run (${d}); run start`)
  return { d, man: readJson(m) }
}

// ---------- subcommands ----------

function cmdStart (a, io) {
  const transcript = transcriptOf(a, io)
  const entries = load(transcript)
  const format = detectFormat(entries)
  const inv = startInvocation(transcript, entries, format, io.env)
  if (!inv) throw new SweepError(`no learn invocation and no user message in ${transcript}`)
  const d = a.out ? real(expand(a.out)) : ledgerDirFor(transcript, format, inv, io.env)
  if (!a.out) {
    mkdirSync(ledgerRoot(transcript, format, io.env), { recursive: true })
    writeJson(anchorFile(transcript, format, io.env), inv)
  }
  let man
  if (existsSync(join(d, 'manifest.json')) && !a.force) {
    man = readJson(join(d, 'manifest.json'))
    if (verdictOk(d) === true) {
      io.out('This learn run already passed its check, and the user has written nothing since. If learn was invoked ' +
        'again from a subagent, invoke it from the main session instead.')
      return
    }
    io.out('Sweep already started for this learn run; resuming it (pass --force to recut).')
  } else {
    for (const name of listDir(d)) {
      if (/^chunk-\d+\.(md|ledger\.json)$|^verdict\.json$|^manifest\.json$/.test(name)) rmSync(join(d, name))
    }
    const start = a.full ? 1 : previousEnd(ledgerRoot(transcript, format, io.env), inv.line) + 1
    const upTo = condense(entries.filter(e => e._n <= inv.line), format)
    const units = upTo.filter(u => u.n >= start)
    const cwd = a.repo ? real(expand(a.repo)) : io.cwd
    const { root, base, base_error: baseError } = repoState(cwd)
    if (root && !base) io.err(`warning: the start snapshot of ${root} failed (${baseError}); no line can be recorded until start --force succeeds`)
    man = writeChunks({
      dir: d,
      pieces: chunkUnits(units, Number(a.budget) || BUDGET),
      // prompts from before the span too, so a later run's first chunk still knows its task
      prompts: upTo,
      repoRoot: root,
      base,
      baseError,
      cwd,
      span: { start_line: start, end_line: inv.line },
      transcript,
      format,
      invocation: inv,
    })
  }
  printPlan(d, man, io)
}

function printPlan (d, man, io) {
  const todo = ledgers(d, man).filter(x => x.error).map(x => x.chunk)
  io.out(`Ledger: ${d}`)
  if (!todo.length) {
    io.out(`All ${man.chunks.length} chunk(s) are filed. Next: ${RUN} candidates`)
    return
  }
  const filed = man.chunks.length - todo.length
  io.out(`${todo.length} of ${man.chunks.length} chunk(s) to extract${filed ? ` (${filed} already filed; leave those alone)` : ''}. ` +
    'Launch one subagent per chunk below, all in one message, in the foreground, each with only this prompt:')
  for (const c of todo) io.out(`  Read ${join(d, c.file)} and follow the instructions at its top.`)
  io.out(`Then: ${RUN} candidates`)
}

function cmdLedger (a, io) {
  if (!a._[0]) throw new SweepError('ledger CHUNK.md, with the ledger JSON on stdin')
  const chunkPath = real(expand(a._[0]))
  const d = dirname(chunkPath)
  if (!isFile(join(d, 'manifest.json'))) throw new SweepError(`${chunkPath} is not a chunk of a sweep (no manifest.json beside it)`)
  const man = readJson(join(d, 'manifest.json'))
  const c = man.chunks.find(x => join(d, x.file) === chunkPath)
  if (!c) throw new SweepError(`${chunkPath} is not a chunk of this sweep`)
  let led
  try { led = JSON.parse(io.stdin || '') } catch (ex) { throw new SweepError(`the ledger is not valid JSON: ${ex.message}`) }
  const problems = ledgerProblems(led, c)
  if (problems.length) {
    io.out(`Not filed:\n${problems.map(p => `  - ${p}`).join('\n')}`)
    return 1
  }
  const prior = ledgers(d, man).find(x => x.chunk.n === c.n)?.ledger
  if (prior?.candidates.some(x => x.disposition) && !a.force) {
    throw new SweepError(`chunk ${c.n} is already filed and judged; refiling would discard its dispositions (pass --force to replace it)`)
  }
  // dispositions are the main session's to give, after the bars
  for (const cand of led.candidates) delete cand.disposition
  writeJson(join(d, c.ledger), led)
  io.out(`filed: chunk ${c.n}, ${led.candidates.length} candidate(s)`)
}

function cmdShow (a, io) {
  const transcript = transcriptOf(a, io)
  const n = Number(a.line ?? a._[0])
  const e = load(transcript).find(x => x._n === n)
  if (!e) throw new SweepError(`no entry at line ${n}`)
  io.out(fullText(e))
}

function cmdCandidates (a, io) {
  const { d, man } = active(a, io)
  let total = 0
  let undisposed = 0
  const cache = new Map()
  for (const { chunk: c, ledger: led, error } of ledgers(d, man)) {
    io.out(`## chunk ${c.n} (@${c.first_line}-@${c.last_line})${error ? ': ' + error : ''}`)
    if (!led) continue
    if (!led.candidates.length) io.out(`  (empty: ${led.empty_reason})`)
    for (const cand of led.candidates) {
      total++
      const disp = cand.disposition
      const bad = disp ? dispositionErrors(cand, man, cache) : []
      if (!disp || bad.length) undisposed++
      if (a.undisposed && disp && !bad.length) continue
      const tag = !disp ? '-' : (disp.type === 'rejected' ? `rejected ${disp.bar}` : `${disp.type} ${disp.file}:${disp.line}`) + (bad.length ? ` (invalid: ${bad.join('; ')})` : '')
      io.out(`- ${cand.id} [${cand.kind}${cand.scope ? ', ' + cand.scope : ''}] ${cand.claim}\n    evidence (@${[].concat(cand.lines ?? []).join('-')}):${cand.evidence}\n    disposition: ${tag}`)
    }
  }
  io.out(`\n${total} candidate(s), ${undisposed} without a valid disposition.`)
}

function cmdDispose (a, io) {
  const { d, man } = active(a, io)
  const specs = []
  if (a.batch) {
    const src = a.batch === '-' ? io.stdin ?? '' : readFileSync(a.batch, 'utf8')
    for (const line of src.split('\n')) {
      if (!line.trim()) continue
      try { specs.push(JSON.parse(line)) } catch { throw new SweepError(`not a JSON line: ${line}`) }
    }
  } else {
    const [id, type, target] = a._
    if (!id || !['recorded', 'covered', 'rejected'].includes(type) || target == null) {
      throw new SweepError('dispose ID recorded|covered|rejected TARGET, or --batch FILE')
    }
    const spec = { id, [type]: target }
    for (const k of ['quote', 'reason', 'report']) if (a[k]) spec[k] = a[k]
    specs.push(spec)
  }
  const index = new Map()
  const owner = new Map() // file:line -> the candidate recorded there
  for (const { chunk: c, ledger: led } of ledgers(d, man)) {
    if (!led) continue
    for (const cand of led.candidates) {
      index.set(cand.id, { cand, ledger: c.ledger, led })
      const at = recordedAt(cand, man)
      if (at) owner.set(at, cand.id)
    }
  }
  const changed = new Map()
  const problems = []
  const cache = new Map()
  let done = 0
  for (const spec of specs) {
    const { cand, ledger, led } = index.get(spec?.id) ?? {}
    if (!cand) {
      problems.push(`${spec?.id}: no such candidate`)
      continue
    }
    const trial = { ...cand }
    try { applyDisposition(trial, spec) } catch (ex) {
      problems.push(ex.message)
      continue
    }
    const bad = dispositionErrors(trial, man, cache)
    const at = recordedAt(trial, man)
    if (at && owner.has(at) && owner.get(at) !== cand.id) bad.push(twinProblem(owner.get(at), `${trial.disposition.file}:${trial.disposition.line}`))
    if (bad.length) {
      for (const p of bad) problems.push(`${spec.id}: ${p}`)
      continue
    }
    const was = recordedAt(cand, man)
    if (was && owner.get(was) === cand.id) owner.delete(was)
    if (at) owner.set(at, cand.id)
    cand.disposition = trial.disposition
    changed.set(ledger, led)
    done++
  }
  // only the ledgers this call changed are written back
  for (const [name, led] of changed) writeJson(join(d, name), led)
  io.out(`${done} disposition(s) written.`)
  for (const p of problems) io.out(`  ! ${p}`)
  return problems.length ? 1 : 0
}

function cmdCheck (a, io) {
  const { d, man } = active(a, io)
  const { problems, counts } = checkLedger(d, man)
  const vp = join(d, 'verdict.json')
  if (problems.length) {
    rmSync(vp, { force: true })
    const kinds = new Map()
    for (const p of problems) {
      const k = p.replace(/^[^:]+: /, '').replace(/\d+|`[^`]*`|"[^"]*"|\S+\.\w+(:\d+)?/g, '…').slice(0, 60)
      kinds.set(k, (kinds.get(k) || 0) + 1)
    }
    io.out(`FAIL: ${problems.length} problem(s): ${[...kinds].map(([k, v]) => `${v} × ${k}`).join('; ')}`)
    for (const p of problems.slice(0, 60)) io.out(`  - ${p}`)
    if (problems.length > 60) io.out(`  … and ${problems.length - 60} more`)
    return 1
  }
  writeJson(vp, { pass: true, checked_at: Date.now() / 1000, counts, digest: digestOf(d) })
  io.out(`PASS: ${man.chunks.length} chunk(s); ${counts.recorded} recorded, ${counts.covered} covered, ${counts.rejected} rejected.`)
  return 0
}

const when = ts => (ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null)

function cmdReport (a, io) {
  const { d, man } = active(a, io)
  if (verdictOk(d) !== true) throw new SweepError('no passing check for the current ledger; run check first')
  const seen = new Set()
  const lines = []
  for (const { ledger: led } of ledgers(d, man)) {
    for (const cand of led?.candidates || []) {
      const disp = cand.disposition || {}
      if (disp.type !== 'recorded') continue
      const key = `${disp.file}:${disp.line}`
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(`📚 ${disp.report || cand.claim} (\`${key}\`)`)
    }
  }
  const s = man.span
  const from = s.start_line <= 1 ? 'the start of the session' : `where the last learn run stopped${s.first_ts ? ` (${when(s.first_ts)})` : ''}`
  const opening = s.first_prompt && s.start_line <= 1 ? ` ("${s.first_prompt}")` : ''
  io.out(`Swept from ${from}${opening} to this learn run${s.last_ts ? ` (${when(s.last_ts)})` : ''}: ${lines.length} learning(s) recorded.`)
  for (const line of lines) io.out(line)
}

const REJECTION = "The user doesn't want to proceed"
const DISMISSED = '[User dismissed'

/**
 * What the user typed after the invocation: prompts, mid-turn messages, answers
 * to AskUserQuestion, the note on a rejected tool call, and /learn's own
 * arguments. Never tool output, which the agent can write.
 */
function humanTextsAfter (entries, inv) {
  const fmt = detectFormat(entries)
  const out = []
  for (const u of condense(entries, fmt)) {
    if (u.n === inv.line && u.human) {
      const args = u.text.match(/<command-args>([\s\S]*?)<\/command-args>/)
      if (args) out.push(args[1])
    }
    if (u.n <= inv.line) continue
    if (u.human || u.kind === 'human_midturn') out.push(u.text)
    else if (u.kind === 'tool_result' && u.tool === 'AskUserQuestion') {
      // an answer runs to the quote that closes it: before ', "' (the next question), '. ' or the end
      for (const m of u.text.matchAll(/"="([\s\S]*?)"(?=, "|\.\s|\.?\s*$)/g)) if (!m[1].startsWith(DISMISSED)) out.push(m[1].replace(/\\"/g, '"'))
    } else if (u.kind === 'tool_error' && u.text.startsWith(REJECTION)) {
      const said = u.text.match(/the user said:\s*([\s\S]*)$/)
      if (said) out.push(said[1])
    }
  }
  return out
}

/** A quote releases only as a whole message, or most of one. */
function quoteMatches (q, texts) {
  q = norm(q)
  if (!q) return false
  return texts.some(t => {
    const s = norm(t)
    return s === q || (s.includes(q) && q.length >= 8 && q.length >= RELEASE_SHARE * s.length)
  })
}

function cmdRelease (a, io) {
  const transcript = transcriptOf(a, io)
  const entries = load(transcript)
  const fmt = detectFormat(entries)
  const inv = currentInvocation(transcript, entries, fmt, io.env)
  if (!quoteMatches(a.quote, humanTextsAfter(entries, inv))) {
    throw new SweepError('the quote must be the user\'s own words calling the run off, typed after it began: a whole message, or most of one')
  }
  const d = ledgerDirFor(transcript, fmt, inv, io.env)
  mkdirSync(d, { recursive: true })
  writeJson(join(d, 'released.json'), { quote: a.quote, released_at: Date.now() / 1000 })
  io.out('Released: this learn run is closed without a sweep.')
}

function releasedOk (d, transcript, inv) {
  const p = join(d, 'released.json')
  if (!existsSync(p)) return false
  try { return quoteMatches(readJson(p).quote, humanTextsAfter(load(transcript), inv)) } catch { return false }
}

/** [reason, progress fingerprint] for an incomplete run. */
function blockState (d, inv) {
  const lead = `${BLOCK_LEAD} learn ran at transcript line ${inv.line}, `
  const tail = ` If the user called off this learn run, run \`${RUN} release --quote "<their words>"\` instead.`
  const m = join(d, 'manifest.json')
  if (!existsSync(m)) {
    return [lead + `but the transcript was never cut into chunks. Run \`${RUN} start\`, extract every chunk with its own ` +
      `subagent, dispose every candidate, and run \`${RUN} check\` until it passes; report from \`${RUN} report\`.` + tail, 'unstarted']
  }
  const man = readJson(m)
  const all = ledgers(d, man)
  const missing = all.filter(x => x.error)
  const undisposed = all.flatMap(x => x.ledger?.candidates || []).filter(c => !c.disposition).length
  const fingerprint = `${missing.length}/${undisposed}/${verdictOk(d)}/${digestOf(d).slice(0, 12)}`
  if (missing.length) {
    return [lead + `and ${missing.length} of ${man.chunks.length} chunk(s) have no valid ledger. Launch one subagent per ` +
      'chunk, each with the prompt "Read <chunk> and follow the instructions at its top.": ' +
      `${missing.map(x => join(d, x.chunk.file)).join(', ')}. Then dispose every candidate and run \`${RUN} check\` until it passes.` + tail, fingerprint]
  }
  if (undisposed) {
    return [lead + `and ${undisposed} candidate(s) have no disposition. List them with \`${RUN} candidates --undisposed\`, ` +
      `record, cover or reject each with \`${RUN} dispose\`, then run \`${RUN} check\` until it passes.` + tail, fingerprint]
  }
  return [lead + `but its ledger has no passing check (or changed since). Run \`${RUN} check\`, fix what it lists, ` +
    `and report from \`${RUN} report\`.` + tail, fingerprint]
}

/**
 * Count pushes that made no progress within one user turn. A block that keeps
 * meeting the same state (a denied command, a model that will not sweep) stops
 * after NO_PROGRESS_BLOCKS and tells the user instead; the next turn starts over.
 */
function pushAllowed (root, inv, data, fingerprint) {
  const p = join(root, 'hook-state.json')
  let s = {}
  try { s = readJson(p) } catch {}
  const turn = data.prompt_id ?? null
  const fresh = !data.stop_hook_active || s.invocation !== inv.id || s.turn !== turn || s.fingerprint !== fingerprint
  s = fresh ? { invocation: inv.id, turn, fingerprint, blocks: 0 } : s
  s.blocks++
  try {
    mkdirSync(root, { recursive: true })
    writeJson(p, s)
  } catch {}
  return s.blocks <= NO_PROGRESS_BLOCKS
}

function cmdHook (a, io) {
  let data
  try { data = JSON.parse(io.stdin || '') } catch { return 0 }
  if (!isObj(data) || !data.transcript_path) return 0
  // a turn waiting on subagents (the chunk extractors) resumes when they report
  if (Array.isArray(data.background_tasks) && data.background_tasks.some(t => WAIT_TASK_TYPES.has(String(t?.type ?? t?.taskType ?? '')))) return 0
  const transcript = real(expand(data.transcript_path))
  if (!isFile(transcript)) return 0
  // the latest learn invocation, or a run start anchored on a later plain-words request
  const found = latestInvocationFast(transcript)
  const anchor = readAnchor(transcript, 'claude', io.env)
  const inv = anchor && (!found || anchor.line >= found.line) ? anchor : found
  if (!inv) return 0
  const root = ledgerRoot(transcript, 'claude', io.env)
  const d = ledgerDirFor(transcript, 'claude', inv, io.env)
  let reason, fingerprint
  try {
    if (verdictOk(d) === true || releasedOk(d, transcript, inv)) return 0
    ;[reason, fingerprint] = blockState(d, inv)
  } catch (ex) {
    // fail closed once learn has run: a ledger the hook cannot read is not a pass
    reason = `${BLOCK_LEAD} learn ran at transcript line ${inv.line}, and its ledger could not be read (${ex.message}). ` +
      `Run \`${RUN} check\` and fix what it reports.`
    fingerprint = `error:${ex.message}`
  }
  if (!pushAllowed(root, inv, data, fingerprint)) {
    io.out(JSON.stringify({ systemMessage: `${BLOCK_LEAD} The learn run at transcript line ${inv.line} still has no passing check after ${NO_PROGRESS_BLOCKS} pushes this turn without progress; it will be raised again next turn.` }))
    return 0
  }
  io.out(JSON.stringify({ decision: 'block', reason }))
  return 0
}

// ---------- CLI ----------

const FLAGS = new Set(['undisposed', 'full', 'force'])

function parse (argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const k = eq < 0 ? t.slice(2) : t.slice(2, eq)
      if (FLAGS.has(k)) a[k] = true
      else a[k] = eq >= 0 ? t.slice(eq + 1) : argv[++i]
    } else a._.push(t)
  }
  return a
}

const USAGE = `usage: sweep.mjs <command> [options]
  start       [--session ID | --thread ID | --transcript PATH] [--repo DIR] [--full] [--force] [--budget N] [--out DIR]
  ledger      CHUNK.md                 (the extractor's ledger JSON on stdin)
  show        --line N                 (one transcript entry in full)
  candidates  [--undisposed]
  dispose     ID recorded FILE:LINE [--report TEXT] | ID covered FILE:LINE --quote TEXT | ID rejected BAR --reason TEXT | --batch FILE|-
  check
  report
  release     --quote "<the user's words>"
  hook        (Stop hook input on stdin)
Commands that act on a run also take --ledger DIR, --transcript PATH, --session ID, --thread ID.`

const COMMANDS = { start: cmdStart, ledger: cmdLedger, show: cmdShow, candidates: cmdCandidates, dispose: cmdDispose, check: cmdCheck, report: cmdReport, release: cmdRelease, hook: cmdHook }

/** Run a subcommand; returns its exit code. io: {stdin, env, cwd, out(line), err(line)}. */
export function run (argv, io) {
  const [cmd, ...rest] = argv
  if (!Object.hasOwn(COMMANDS, cmd)) {
    io.err(USAGE)
    return 2
  }
  try {
    return COMMANDS[cmd](parse(rest), io) ?? 0
  } catch (ex) {
    if (cmd === 'hook') {
      // never exit 2 from the hook: that would block on a crash before learn ran
      io.err(`learn sweep hook: ${ex.message}`)
      return 1
    }
    if (ex instanceof SweepError) {
      io.err(`sweep: ${ex.message}`)
      return 2
    }
    throw ex
  }
}

if (process.argv[1] && real(process.argv[1]) === SCRIPT) {
  const cmd = process.argv[2]
  const batch = process.argv.findIndex(x => x === '--batch')
  const needsStdin = cmd === 'hook' || cmd === 'ledger' ||
    (cmd === 'dispose' && (process.argv.includes('--batch=-') || (batch > 0 && process.argv[batch + 1] === '-')))
  const stdin = needsStdin ? readFileSync(0, 'utf8') : undefined
  process.exitCode = run(process.argv.slice(2), {
    stdin,
    env: process.env,
    cwd: process.cwd(),
    out: s => process.stdout.write(s + '\n'),
    err: s => process.stderr.write(s + '\n'),
  })
}
