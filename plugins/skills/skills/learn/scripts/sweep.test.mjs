// Tests for sweep.mjs: node --test skills/learn/scripts/sweep.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  BARS, chunkUnits, condenseClaude, condenseCodex, detectFormat, invocationOf, invocationsIn,
  latestInvocationFast, ledgerDirFor, readJson, run, size, writeJson,
} from './sweep.mjs'

const SCRIPT = fileURLToPath(new URL('./sweep.mjs', import.meta.url))
const temps = []
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }) })

const human = (text, uuid) => ({ type: 'user', uuid, origin: { kind: 'human' }, message: { role: 'user', content: text } })
const assistant = (text, uuid, msg) => ({ type: 'assistant', uuid, message: { id: msg, role: 'assistant', content: [{ type: 'text', text }] } })
const toolUse = (name, input, uuid, msg, id) => ({ type: 'assistant', uuid, message: { id: msg, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const toolResult = (id, text, uuid, error = false) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: error }] } })
const skillBody = (name, uuid) => ({ type: 'user', uuid, isMeta: true, message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: /x/skills/${name}\n\nbody` }] } })
const midturn = (text, uuid) => ({ type: 'attachment', uuid, attachment: { type: 'queued_command', prompt: text, origin: { kind: 'human' } } })
const learnCall = (uuid, msg, id, skill = 'learn') => toolUse('Skill', { skill }, uuid, msg, id)
const slashLearn = (uuid, args) => human(`<command-message>learn</command-message>\n<command-name>/learn</command-name>${args ? `\n<command-args>${args}</command-args>` : ''}`, uuid)

/** A small session: work, a correction, a dead end, then learn at line 10. */
const session = () => [
  { type: 'attachment', uuid: 'a0', attachment: { type: 'prompt_snapshot', systemPrompt: ['x'.repeat(5000)] } },
  human('Fix the flaky export test', 'u1'),
  assistant('Retrying the export in a loop should settle it.', 'a1', 'm1'),
  toolUse('Bash', { command: 'npm test -- export' }, 'a2', 'm1', 't1'),
  toolResult('t1', 'Exit code 1\nTimeoutError: export never resolved', 'r1', true),
  midturn('No, never retry in a loop. Fix the race instead.', 'q1'),
  assistant('The race is in the writer; awaiting flush fixes it.', 'a3', 'm2'),
  learnCall('a4', 'm3', 't2', 'learn-organize'),
  skillBody('learn-organize', 's0'),
  slashLearn('u2'),
  skillBody('learn', 's1'),
]

const CANDS = [
  { id: 'c001-01', kind: 'correction', claim: 'Never retry a flaky test in a loop; fix the race.', evidence: 'No, never retry in a loop', lines: [6, 6] },
  { id: 'c001-02', kind: 'convention', claim: 'Run npm test before shipping.', evidence: 'npm test', lines: [4, 4] },
  { id: 'c001-03', kind: 'other', claim: 'The export test was flaky on this machine today.', evidence: 'TimeoutError', lines: [5, 5] },
]

/** The checkpoint tokens an extractor collects by reading a chunk file to the end. */
const tokensOf = file => [...readFileSync(file, 'utf8').matchAll(/CHECKPOINT [0-9a-f]{6}\/\d: ([0-9a-f]{12})/g)].map(m => m[1])

/** A fake config dir holding one session transcript, and a git repo. */
function makeEnv (entries) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-')))
  temps.push(root)
  const sid = '11111111-2222-3333-4444-555555555555'
  const config = join(root, 'config')
  mkdirSync(join(config, 'projects', '-repo'), { recursive: true })
  const transcript = join(config, 'projects', '-repo', sid + '.jsonl')
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  const env = {
    transcript,
    repo,
    git,
    write: list => writeFileSync(transcript, list.map(e => JSON.stringify(e) + '\n').join('')),
    append: list => appendFileSync(transcript, list.map(e => JSON.stringify(e) + '\n').join('')),
    run (argv, stdin) {
      const out = []
      const err = []
      const code = run(argv, {
        stdin,
        env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: sid },
        cwd: repo,
        out: s => out.push(s),
        err: s => err.push(s),
      })
      return { code, out: out.join('\n'), err: err.join('\n') }
    },
    hook (extra = {}) {
      const { out } = env.run(['hook'], JSON.stringify({ session_id: sid, transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [], prompt_id: 'p1', ...extra }))
      return out.trim() ? JSON.parse(out) : null
    },
    dir: () => ledgerDirFor(transcript, 'claude', invocationsIn(transcript).at(-1)),
    manifest: () => readJson(join(env.dir(), 'manifest.json')),
    chunk: n => join(env.dir(), `chunk-${String(n).padStart(3, '0')}.md`),
    /** File each chunk's ledger the way an extraction subagent does: through `ledger`. */
    extract (byChunk) {
      for (const c of env.manifest().chunks) {
        const candidates = (byChunk[c.n] || []).map(x => ({ ...x }))
        const r = env.file(c.n, { chunk: c.n, checkpoints: tokensOf(env.chunk(c.n)), candidates, empty_reason: candidates.length ? null : 'routine edits only' })
        assert.equal(r.code, 0, r.out + r.err)
      }
    },
    file: (n, led) => env.run(['ledger', env.chunk(n)], JSON.stringify(led)),
    edit (fn) {
      const p = join(env.dir(), 'chunk-001.ledger.json')
      const led = readJson(p)
      fn(led)
      writeJson(p, led)
    },
    dispose: lines => env.run(['dispose', '--batch', '-'], lines.map(l => JSON.stringify(l)).join('\n')),
  }
  env.write(entries)
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  writeFileSync(join(repo, 'AGENTS.md'), '# Repo\n\n- Run `npm test` before shipping.\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return env
}

const withLines = list => list.map((e, i) => ({ ...e, _n: i + 1 }))

// ---------- invocations ----------

test('learn invocation signatures', () => {
  const kind = e => invocationOf({ ...e, _n: 1 })?.kind ?? null
  assert.equal(kind(learnCall('a', 'm', 't')), 'skill_tool')
  assert.equal(kind(learnCall('a', 'm', 't', 'skills:learn')), 'skill_tool')
  assert.equal(kind(learnCall('a', 'm', 't', 'learn-organize')), null)
  assert.equal(kind(learnCall('a', 'm', 't', 'caveman:caveman-learn')), null)
  assert.equal(kind(slashLearn('u')), 'slash_command')
  assert.equal(kind(human('<command-message>skills:learn</command-message>\n<command-name>/skills:learn</command-name>', 'u')), 'slash_command')
  assert.equal(kind(human('the tag <command-name>/learn</command-name> in prose', 'u')), null)
  assert.equal(kind(human('<command-name>/learn-organize</command-name>', 'u')), null)
  const codex = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '[$learn](/x/learn/SKILL.md) ' }] } } }
  assert.equal(kind(codex), 'codex')
})

test('the hook\'s scan finds the latest invocation', () => {
  const env = makeEnv(session())
  const inv = latestInvocationFast(env.transcript)
  assert.equal(inv.kind, 'slash_command')
  assert.equal(inv.line, 10)
})

test('a denied Skill(learn) call is not an invocation', () => {
  const env = makeEnv([...session(), learnCall('a9', 'm9', 't9'), toolResult('t9', "The user doesn't want to proceed with this tool use.", 'r9', true)])
  assert.equal(latestInvocationFast(env.transcript).line, 10)
})

test('the ledger lives under <session>/learn/<invocation>', () => {
  const env = makeEnv(session())
  assert.equal(env.dir(), join(env.transcript.replace(/\.jsonl$/, ''), 'learn', 'u2'))
})

// ---------- condensing and chunking ----------

test('condensing keeps the signal and drops the noise', () => {
  const units = condenseClaude(withLines(session()))
  const kinds = units.map(u => u.kind)
  const text = units.map(u => u.text).join('\n')
  assert.ok(kinds.includes('human_midturn'), 'the mid-turn correction survives')
  assert.ok(kinds.includes('tool_error'))
  assert.match(text, /TimeoutError/)
  assert.doesNotMatch(text, /x{100}/, 'the system prompt snapshot is dropped')
  assert.doesNotMatch(text, /\bbody\b/, 'skill bodies become stubs')
  assert.match(text, /\[skill loaded: learn\]/)
})

test('a background report absorbed mid-turn is kept once', () => {
  const report = '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n<summary>Code reuse review</summary>\n<result>FINDING-XYZ: the helper duplicates parseDate.</result>\n</task-notification>'
  const units = condenseClaude(withLines([
    human('Review it', 'u1'),
    { type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: report } },
    { type: 'user', uuid: 'n1', origin: { kind: 'task-notification' }, message: { role: 'user', content: report } },
  ]))
  const reports = units.filter(u => u.text.includes('FINDING-XYZ'))
  assert.equal(reports.length, 1)
})

test('long text is cut with a pointer to its full entry', () => {
  const units = condenseClaude(withLines([human('go', 'u1'), toolUse('Bash', { command: 'x'.repeat(9000) }, 'a1', 'm1', 't1')]))
  assert.match(units[1].text, /chars cut; full text: sweep show 2/)
})

test('chunks respect the budget and never split a message', () => {
  const units = []
  for (let k = 0; k < 40; k++) {
    units.push({ n: k * 2 + 1, kind: 'assistant', text: 'a'.repeat(1000), human: false, msg: `m${k}` })
    units.push({ n: k * 2 + 2, kind: 'tool_use', text: 'b'.repeat(1000), human: false, msg: `m${k}` })
  }
  const chunks = chunkUnits(units, 10000)
  assert.equal(chunks.flat().length, units.length)
  for (const c of chunks) {
    assert.ok(size(c) <= 10000)
    assert.equal(c[0].kind, 'assistant')
  }
})

test('a cut at a skill launch keeps the message that opened with text', () => {
  const units = [{ n: 1, kind: 'human', text: 'go', human: true, msg: null }]
  for (let k = 0; k < 8; k++) units.push({ n: 2 + k, kind: 'assistant', text: 'a'.repeat(1000), human: false, msg: `m${k}` })
  units.push({ n: 20, kind: 'assistant', text: 'Now the review.', human: false, msg: 'mx' })
  units.push({ n: 21, kind: 'tool_use', text: 'Skill {"skill":"review"}', human: false, msg: 'mx' })
  for (let k = 0; k < 8; k++) units.push({ n: 30 + k, kind: 'assistant', text: 'b'.repeat(1000), human: false, msg: `n${k}` })
  for (const c of chunkUnits(units, 9500)) {
    const msgs = new Set(c.map(u => u.msg))
    if (msgs.has('mx')) assert.ok(c.some(u => u.n === 20) && c.some(u => u.n === 21), 'text and launch stay together')
  }
})

// ---------- the hook ----------

test('the hook is quiet in a session that never ran learn', () => {
  assert.equal(makeEnv(session().slice(0, 7)).hook(), null)
})

test('the hook blocks until the transcript is cut', () => {
  const v = makeEnv(session()).hook()
  assert.equal(v.decision, 'block')
  assert.match(v.reason, /never cut into chunks/)
  assert.doesNotMatch(v.reason, /Decision pass on this report\./)
})

test('the hook waits on subagents, not on shells or monitors', () => {
  const env = makeEnv(session())
  assert.equal(env.hook({ background_tasks: [{ id: 'a1', type: 'subagent' }] }), null)
  assert.equal(env.hook({ background_tasks: [{ id: 's1', type: 'shell' }, { id: 'm1', type: 'monitor' }] }).decision, 'block')
})

test('the hook stops pushing after three blocks without progress, until the next turn', () => {
  const env = makeEnv(session())
  assert.equal(env.hook().decision, 'block')
  assert.equal(env.hook({ stop_hook_active: true }).decision, 'block')
  assert.equal(env.hook({ stop_hook_active: true }).decision, 'block')
  const fourth = env.hook({ stop_hook_active: true })
  assert.equal(fourth.decision, undefined)
  assert.match(fourth.systemMessage, /still has no passing check/)
  assert.equal(env.hook({ prompt_id: 'p2' }).decision, 'block', 'a new turn pushes again')
})

test('progress resets the push count', () => {
  const env = makeEnv(session())
  env.hook()
  env.hook({ stop_hook_active: true })
  env.hook({ stop_hook_active: true })
  env.run(['start'])
  assert.equal(env.hook({ stop_hook_active: true }).decision, 'block')
})

test('a malformed ledger blocks rather than letting the turn through', () => {
  const env = makeEnv(session())
  env.run(['start'])
  writeFileSync(join(env.dir(), 'chunk-001.ledger.json'), JSON.stringify({ chunk: 1, candidates: ['Never retry'] }))
  const v = env.hook()
  assert.equal(v.decision, 'block')
  assert.match(v.reason, /no valid ledger/)
})

test('the hook runs as a command with input on stdin', () => {
  const env = makeEnv(session())
  const r = spawnSync(process.execPath, [SCRIPT, 'hook'], { input: JSON.stringify({ transcript_path: env.transcript, background_tasks: [] }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).decision, 'block')
})

test('a hook crash before learn ran never blocks', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'hook'], { input: 'null', encoding: 'utf8' })
  assert.notEqual(r.status, 2)
  assert.equal(r.stdout, '')
})

// ---------- start and ledgers ----------

test('start cuts up to the invocation and gives each chunk its instructions', () => {
  const env = makeEnv(session())
  const r = env.run(['start'])
  assert.equal(r.code, 0, r.err)
  const man = env.manifest()
  assert.deepEqual([man.span.start_line, man.span.end_line], [1, 10])
  assert.equal(man.repo.root, env.repo)
  assert.ok(r.out.includes(`Read ${env.chunk(1)}`))
  const chunk = readFileSync(env.chunk(1), 'utf8')
  assert.ok(chunk.includes(`ledger "${env.chunk(1)}"`))
  assert.match(chunk, /never retry in a loop/)
  assert.equal(tokensOf(env.chunk(1)).length, 3)
  assert.doesNotMatch(JSON.stringify(man), new RegExp(tokensOf(env.chunk(1))[0]), 'the manifest holds no token')
  assert.match(env.hook().reason, /have no valid ledger/)
})

test('a ledger that missed a checkpoint is not filed', () => {
  const env = makeEnv(session())
  env.run(['start'])
  const r = env.file(1, { chunk: 1, checkpoints: tokensOf(env.chunk(1)).slice(2), candidates: [], empty_reason: 'nothing' })
  assert.equal(r.code, 1)
  assert.match(r.out, /0 of 3 checkpoint tokens found/)
})

test('a ledger citing lines outside its slice is not filed', () => {
  const env = makeEnv(session())
  env.run(['start'])
  const r = env.file(1, { chunk: 1, checkpoints: tokensOf(env.chunk(1)), candidates: [{ ...CANDS[0], lines: [59, 62] }] })
  assert.equal(r.code, 1)
  assert.match(r.out, /not in this slice/)
})

test('an extractor cannot dispose its own candidates', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [{ ...CANDS[2], disposition: { type: 'rejected', bar: 'transient', reason: 'x' } }] })
  assert.equal(readJson(join(env.dir(), 'chunk-001.ledger.json')).candidates[0].disposition, undefined)
})

test('start --force clears the old ledgers', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [] })
  const r = env.run(['start', '--force'])
  assert.match(r.out, /1 of 1 chunk\(s\) to extract/)
})

test('show prints an entry in full', () => {
  const env = makeEnv(session())
  const r = env.run(['show', '--transcript', env.transcript, '--line', '5'])
  assert.match(r.out, /TimeoutError: export never resolved/)
})

// ---------- dispositions, check and report ----------

test('a full pass: dispose, check, report, and a stale verdict', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: CANDS })
  assert.match(env.hook().reason, /no disposition/)
  let r = env.run(['check'])
  assert.equal(r.code, 1)
  assert.match(r.out, /c001-01: no disposition/)

  appendFileSync(join(env.repo, 'AGENTS.md'), '- Never retry a flaky test in a loop; find and fix the race.\n')
  r = env.dispose([
    { id: 'c001-01', recorded: 'AGENTS.md:4', report: 'Never retry a flaky test in a loop; fix the race.' },
    { id: 'c001-02', covered: 'AGENTS.md:3', quote: 'Run `npm test` before shipping.' },
    { id: 'c001-03', rejected: 'transient', reason: 'one bad afternoon' },
  ])
  assert.equal(r.code, 0, r.out)
  r = env.run(['check'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1 recorded, 1 covered, 1 rejected/)
  assert.equal(env.hook(), null)
  r = env.run(['report'])
  assert.equal(r.code, 0)
  assert.match(r.out, /^Swept from the start of the session \("Fix the flaky export test"\) to this learn run.*: 1 learning\(s\) recorded\./)
  assert.ok(r.out.includes('📚 Never retry a flaky test in a loop; fix the race. (`AGENTS.md:4`)'))
  assert.doesNotMatch(r.out, /npm test/, 'covered and rejected candidates are not reported')

  env.edit(led => { led.candidates[2].disposition.reason = 'changed' })
  assert.match(env.hook().reason, /no passing check/)
})

test('a failed disposition is not saved', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [CANDS[1]] })
  env.run(['dispose', 'c001-02', 'covered', 'AGENTS.md:3', '--quote', 'words that are not there'])
  const r = env.run(['candidates', '--undisposed'])
  assert.match(r.out, /1 without a valid disposition/)
})

test('recorded must cite a line this pass wrote', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [CANDS[1]] })
  const r = env.run(['dispose', 'c001-02', 'recorded', 'AGENTS.md:3', '--report', 'Run npm test before shipping.'])
  assert.equal(r.code, 1)
  assert.match(r.out, /not written by this pass/)
})

test('recorded counts committed edits and new files', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [CANDS[0], CANDS[1]] })
  mkdirSync(join(env.repo, 'docs'))
  writeFileSync(join(env.repo, 'docs', 'flaky.md'), '# Flaky tests\n\nFix the race; never retry in a loop.\n')
  appendFileSync(join(env.repo, 'AGENTS.md'), '- See docs/flaky.md before touching a flaky test.\n')
  env.git('add', '-A')
  env.git('commit', '-qm', 'learn')
  const r = env.dispose([{ id: 'c001-01', recorded: 'docs/flaky.md:3', report: 'r1' }, { id: 'c001-02', recorded: 'AGENTS.md:4', report: 'r2' }])
  assert.equal(r.code, 0, r.out)
})

test('lines already dirty or untracked when the sweep started are not credited', () => {
  const env = makeEnv(session())
  appendFileSync(join(env.repo, 'AGENTS.md'), "- Someone else's uncommitted line.\n")
  writeFileSync(join(env.repo, 'notes.md'), '# Notes\n\nAn old untracked line.\n')
  env.run(['start'])
  env.extract({ 1: [CANDS[0], CANDS[1]] })
  let r = env.run(['dispose', 'c001-01', 'recorded', 'AGENTS.md:4', '--report', 'x'])
  assert.match(r.out, /not written by this pass/)
  r = env.run(['dispose', 'c001-02', 'recorded', 'notes.md:3', '--report', 'x'])
  assert.match(r.out, /not written by this pass/)
})

test('recorded refuses ignored files, wrong case, past-the-end lines and other repos', () => {
  const env = makeEnv(session())
  writeFileSync(join(env.repo, '.gitignore'), 'scratch.md\n')
  env.git('add', '-A')
  env.git('commit', '-qm', 'ignore')
  env.run(['start'])
  env.extract({ 1: [CANDS[0]] })
  writeFileSync(join(env.repo, 'scratch.md'), 'never retry\n')
  appendFileSync(join(env.repo, 'AGENTS.md'), '- New line.\n')
  const rec = loc => env.run(['dispose', 'c001-01', 'recorded', loc, '--report', 'x']).out
  assert.match(rec('scratch.md:1'), /ignored by git/)
  assert.match(rec('agents.md:4'), /differs in case|does not exist/)
  assert.match(rec('AGENTS.md:5'), /has 4 lines/)
  assert.match(rec(`${tmpdir()}/elsewhere.md:1`), /outside the repo|does not exist/)
})

test('covered cannot cite the sweep\'s own files', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [CANDS[0]] })
  const line = readFileSync(env.chunk(1), 'utf8').split('\n').findIndex(l => l.includes('never retry in a loop')) + 1
  const r = env.run(['dispose', 'c001-01', 'covered', `${env.chunk(1)}:${line}`, '--quote', 'never retry in a loop'])
  assert.match(r.out, /transcript or sweep file/)
})

test('covered must quote the cited place', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [CANDS[1]] })
  const r = env.run(['dispose', 'c001-02', 'covered', 'AGENTS.md:3', '--quote', 'Run the linter first'])
  assert.equal(r.code, 1)
  assert.match(r.out, /quote not found/)
})

test('rejected must name a known bar', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [CANDS[2]] })
  const r = env.run(['dispose', 'c001-03', 'rejected', 'boring', '--reason', 'meh'])
  assert.equal(r.code, 1)
  assert.match(r.out, /unknown bar/)
})

test('an empty chunk needs a reason', () => {
  const env = makeEnv(session())
  env.run(['start'])
  const r = env.file(1, { chunk: 1, checkpoints: tokensOf(env.chunk(1)), candidates: [], empty_reason: '' })
  assert.match(r.out, /no candidates and no empty_reason/)
})

// ---------- release ----------

test('release takes a whole call-off, however short, but not a fragment', () => {
  const env = makeEnv(session())
  assert.equal(env.run(['release', '--quote', 'skip it']).code, 2)
  env.append([human('also please commit when done', 'u3')])
  assert.equal(env.run(['release', '--quote', 'commit when done']).code, 2, 'a fragment of unrelated text')
  env.append([human('skip it', 'u4')])
  assert.equal(env.run(['release', '--quote', 'skip it']).code, 0)
  assert.equal(env.hook(), null)
})

test('release accepts an answer to a question and /learn\'s own arguments', () => {
  const asked = makeEnv([...session(), toolUse('AskUserQuestion', { questions: [] }, 'a5', 'm5', 't5'),
    toolResult('t5', 'User has answered your questions: "Run the sweep now?"="No, skip the learn sweep this time"', 'r5')])
  assert.equal(asked.run(['release', '--quote', 'No, skip the learn sweep this time']).code, 0)
  const args = makeEnv([...session().slice(0, 9), slashLearn('u2', 'never mind, no learnings today')])
  assert.equal(args.run(['release', '--quote', 'never mind, no learnings today']).code, 0)
})

// ---------- later runs, skill, Codex ----------

test('a second run starts where the last passing ledger stopped', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [] })
  assert.equal(env.run(['check']).code, 0)
  env.append([human('Now rename the exporter', 'u4'), assistant('Renamed.', 'a5', 'm5'), learnCall('a6', 'm6', 't6'), skillBody('learn', 's2')])
  assert.match(env.hook().reason, /never cut into chunks/)
  env.run(['start'])
  assert.deepEqual([env.manifest().span.start_line, env.manifest().span.end_line], [11, 14])
  env.run(['start', '--full', '--force'])
  assert.equal(env.manifest().span.start_line, 1)
})

test('the bars match SKILL.md', () => {
  const text = readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf8')
  const section = text.split('## Bars')[1].split('These are not bars')[0]
  const ids = [...section.matchAll(/^- `([a-z-]+)`:/gm)].map(m => m[1])
  assert.deepEqual(new Set(ids), new Set(Object.keys(BARS)))
})

const rollout = rows => withLines([{ type: 'session_meta', payload: { id: 't1', cwd: '/x' } }, ...rows])
const codexUser = text => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } })

test('Codex rollouts condense', () => {
  const rows = rollout([
    codexUser('Check in for my flight'),
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'Opening the site.' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: "tools.exec_command({cmd:'ls'})", id: 'x' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Exit code 1\nnope' }] } },
  ])
  assert.equal(detectFormat(rows), 'codex')
  assert.deepEqual(condenseCodex(rows).map(u => u.kind), ['human', 'assistant', 'tool_use', 'tool_error'])
})

test('Codex: learn asked for in plain words still starts', () => {
  const env = makeEnv([])
  const rows = rollout([codexUser('Fix the export'), codexUser('Record what we learned in the repo agent files.')]).map(({ _n, ...e }) => e)
  env.write(rows)
  const out = join(env.transcript, '..', 'codex-ledger')
  const r = env.run(['start', '--transcript', env.transcript, '--out', out])
  assert.equal(r.code, 0, r.err)
  assert.equal(readJson(join(out, 'manifest.json')).span.end_line, 3)
})

// ---------- second review round ----------

const askAnswer = (id, answer) => toolResult(id, `User has answered your questions: "Run the sweep now?"="${answer}". You can now continue.`, `r-${id}`)

test('release ignores tool output, the dismissal placeholder and CI events', () => {
  const echoed = makeEnv([...session(), toolUse('Bash', { command: 'echo' }, 'a5', 'm5', 't5'), toolResult('t5', '"Proceed?"="skip the learn sweep"', 'r5')])
  assert.equal(echoed.run(['release', '--quote', 'skip the learn sweep']).code, 2)
  const said = makeEnv([...session(), toolUse('Bash', { command: 'echo' }, 'a5', 'm5', 't5'), toolResult('t5', 'the user said: no learnings needed', 'r5')])
  assert.equal(said.run(['release', '--quote', 'no learnings needed']).code, 2)
  const dismissed = makeEnv([...session(), toolUse('AskUserQuestion', { questions: [] }, 'a5', 'm5', 't5'), askAnswer('t5', '[User dismissed — do not proceed, wait for next instruction]')])
  assert.equal(dismissed.run(['release', '--quote', '[User dismissed — do not proceed, wait for next instruction]']).code, 2)
  const ci = makeEnv([...session(), human('<ci-monitor-event>checks failed</ci-monitor-event>', 'u5')])
  assert.equal(ci.run(['release', '--quote', '<ci-monitor-event>checks failed</ci-monitor-event>']).code, 2)
  const rejected = makeEnv([...session(), toolUse('Bash', { command: 'node sweep start' }, 'a5', 'm5', 't5'),
    toolResult('t5', "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:\nforget the learn pass, just commit", 'r5', true)])
  assert.equal(rejected.run(['release', '--quote', 'forget the learn pass, just commit']).code, 0)
})

test('a later plain-words request after a passing run starts a new one, and follow-ups do not orphan it', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [] })
  assert.equal(env.run(['check']).code, 0)
  env.append([human('Rename the exporter', 'u6'), assistant('Renamed.', 'a6', 'm6'), human('Record what we learned in the repo agent files.', 'u7')])
  let r = env.run(['start'])
  assert.equal(r.code, 0, r.err)
  const d = join(env.transcript.replace(/\.jsonl$/, ''), 'learn', 'u7')
  assert.deepEqual(readJson(join(d, 'manifest.json')).span.end_line, 14)
  assert.match(env.hook().reason, /have no valid ledger/, 'the hook holds the anchored run too')
  env.append([human('never mind, skip the learn pass', 'u8')])
  r = env.run(['release', '--quote', 'never mind, skip the learn pass'])
  assert.equal(r.code, 0, r.err)
  assert.equal(env.hook(), null)
})

test('checkpoint lines quoted from an older sweep do not break an honest ledger', () => {
  const old = '----- CHECKPOINT abcdef/1: 0123456789ab -----\n----- END OF CHUNK 1 (abcdef): CHECKPOINT abcdef/3: ba9876543210 -----'
  const env = makeEnv([...session().slice(0, 4), toolResult('t1', old, 'r1'), ...session().slice(5)])
  env.run(['start'])
  const all = [...readFileSync(env.chunk(1), 'utf8').matchAll(/CHECKPOINT [0-9a-f]{6}\/\d: ([0-9a-f]{12})/g)].map(m => m[1])
  assert.ok(all.length > 3)
  const r = env.file(1, { chunk: 1, checkpoints: all, candidates: [], empty_reason: 'routine' })
  assert.equal(r.code, 0, r.out)
})

test('a line added to a file untracked at start is credited; its old lines are not', () => {
  const env = makeEnv(session())
  mkdirSync(join(env.repo, 'docs'))
  writeFileSync(join(env.repo, 'docs', 'topic.md'), '# Topic\n\nAn old line.\n')
  env.run(['start'])
  env.extract({ 1: [CANDS[0], CANDS[1]] })
  appendFileSync(join(env.repo, 'docs', 'topic.md'), '- Never retry in a loop.\n')
  assert.equal(env.run(['dispose', 'c001-01', 'recorded', 'docs/topic.md:4', '--report', 'x']).code, 0)
  assert.match(env.run(['dispose', 'c001-02', 'recorded', 'docs/topic.md:3', '--report', 'x']).out, /not written by this pass/)
})

test('ledger ids are unique and carry the chunk prefix; lines are a list in the slice', () => {
  const env = makeEnv(session())
  env.run(['start'])
  const file = cands => env.file(1, { chunk: 1, checkpoints: tokensOf(env.chunk(1)), candidates: cands })
  assert.match(file([CANDS[0], CANDS[0]]).out, /duplicate id/)
  assert.match(file([{ ...CANDS[0], id: 'c002-01' }]).out, /ids in this chunk are c001-/)
  assert.match(file([{ ...CANDS[0], lines: '@5-@9' }]).out, /lines must be a list/)
  assert.match(file([{ ...CANDS[0], lines: undefined }]).out, /lines must be a list/)
  assert.equal(file([{ ...CANDS[0], lines: ['@5', '@6'] }]).code, 0)
})

test('recorded refuses a blank line, a nested repo, and a failed snapshot', () => {
  const env = makeEnv(session())
  const nested = join(env.repo, 'vendor', 'sub')
  mkdirSync(nested, { recursive: true })
  spawnSync('git', ['-C', nested, 'init', '-q'])
  writeFileSync(join(nested, 'AGENTS.md'), '# Sub\n\nold\n')
  env.run(['start'])
  env.extract({ 1: [CANDS[0]] })
  appendFileSync(join(env.repo, 'AGENTS.md'), '\n')
  const rec = loc => env.run(['dispose', 'c001-01', 'recorded', loc, '--report', 'x']).out
  assert.match(rec('AGENTS.md:4'), /is blank/)
  assert.match(rec('vendor/sub/AGENTS.md:3'), /outside the repo/)
  const m = join(env.dir(), 'manifest.json')
  const man = readJson(m)
  writeJson(m, { ...man, repo: { ...man.repo, base: null, base_error: 'boom' } })
  appendFileSync(join(env.repo, 'AGENTS.md'), '- A real line.\n')
  assert.match(rec('AGENTS.md:5'), /start snapshot failed \(boom\)/)
})

test('diff.interHunkContext does not credit lines between two edits', () => {
  const env = makeEnv(session())
  writeFileSync(join(env.repo, 'AGENTS.md'), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  env.git('commit', '-qam', 'twelve')
  env.git('config', 'diff.interHunkContext', '8')
  env.run(['start'])
  env.extract({ 1: [CANDS[0]] })
  writeFileSync(join(env.repo, 'AGENTS.md'), Array.from({ length: 12 }, (_, i) => (i === 1 || i === 9 ? `new ${i + 1}` : `line ${i + 1}`)).join('\n') + '\n')
  assert.match(env.run(['dispose', 'c001-01', 'recorded', 'AGENTS.md:6', '--report', 'x']).out, /not written by this pass/)
  assert.equal(env.run(['dispose', 'c001-01', 'recorded', 'AGENTS.md:10', '--report', 'x']).code, 0)
})

test('a relative path resolves from the directory start ran in first', () => {
  const env = makeEnv(session())
  mkdirSync(join(env.repo, 'pkg'))
  writeFileSync(join(env.repo, 'pkg', 'AGENTS.md'), '# Pkg\n')
  env.git('add', '-A')
  env.git('commit', '-qm', 'pkg')
  env.run(['start', '--repo', join(env.repo, 'pkg')])
  env.extract({ 1: [CANDS[0]] })
  appendFileSync(join(env.repo, 'pkg', 'AGENTS.md'), '- Never retry in a loop.\n')
  assert.equal(env.run(['dispose', 'c001-01', 'recorded', 'AGENTS.md:2', '--report', 'x']).code, 0)
})

test('recorded needs a report line', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [CANDS[0]] })
  appendFileSync(join(env.repo, 'AGENTS.md'), '- Never retry in a loop.\n')
  assert.match(env.run(['dispose', 'c001-01', 'recorded', 'AGENTS.md:4']).out, /needs "report"/)
})

test('a resumed start lists only the chunks left, and a judged ledger is not refiled', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [CANDS[2]] })
  env.run(['dispose', 'c001-03', 'rejected', 'transient', '--reason', 'once'])
  assert.match(env.run(['start']).out, /All 1 chunk\(s\) are filed/)
  const r = env.file(1, { chunk: 1, checkpoints: tokensOf(env.chunk(1)), candidates: [CANDS[2]] })
  assert.equal(r.code, 2)
  assert.match(r.err, /already filed and judged/)
})

test('a later chunk is told the prompt that opened its turn', () => {
  const env = makeEnv([human('Build the exporter', 'u1'),
    ...Array.from({ length: 6 }, (_, k) => assistant('x'.repeat(900), `a${k}`, `m${k}`)), slashLearn('u2'), skillBody('learn', 's1')])
  env.run(['start', '--budget', '2000'])
  const second = readFileSync(env.chunk(2), 'utf8')
  assert.match(second, /SESSION PROMPTS[\s\S]*@1: Build the exporter/)
})

test('the CLI reads --batch=- and reports a bad ledger path without a stack', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [CANDS[2]] })
  const cli = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(env.transcript, '..', '..', '..'), CLAUDE_CODE_SESSION_ID: '11111111-2222-3333-4444-555555555555' }, cwd: env.repo })
  const r = cli(['dispose', '--batch=-'], JSON.stringify({ id: 'c001-03', rejected: 'transient', reason: 'once' }))
  assert.match(r.stdout, /1 disposition\(s\) written/)
  const bad = cli(['ledger', join(env.repo, 'nope.md')], '{}')
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /^sweep: /)
})

test('odd entry shapes do not crash start or the hook', () => {
  const env = makeEnv([...session().slice(0, 9),
    { type: 'user', uuid: 'w1', message: { role: 'user', content: { text: 'learn this' } } },
    { type: 'assistant', uuid: 'w2', message: { id: 'mw', content: [{ type: 'text', text: 42 }] } },
    slashLearn('u2'), skillBody('learn', 's1')])
  assert.equal(env.run(['start']).code, 0)
  assert.equal(env.hook().decision, 'block')
})

// ---------- final review round ----------

test('a released run is closed: a later plain-words request opens a new run the hook enforces', () => {
  const env = makeEnv(session())
  env.append([human('never mind, skip the learn pass', 'u3')])
  assert.equal(env.run(['release', '--quote', 'never mind, skip the learn pass']).code, 0)
  env.append([human('Rename the exporter', 'u4'), assistant('Renamed.', 'a4b', 'm4'), human('Record what we learned in the repo agent files.', 'u5')])
  assert.equal(env.run(['start']).code, 0)
  const man = readJson(join(env.transcript.replace(/\.jsonl$/, ''), 'learn', 'u5', 'manifest.json'))
  assert.deepEqual([man.span.start_line, man.span.end_line], [1, 15])
  assert.match(env.hook().reason, /have no valid ledger/)
})

test('a learn request typed mid-turn anchors the run at that message', () => {
  const env = makeEnv([human('/lfg build the exporter end to end', 'u1'), assistant('Building.', 'a1', 'm1'),
    midturn('when you are done, record what we learned in the agent files', 'q1'), assistant('Done building.', 'a2', 'm2')])
  assert.equal(env.run(['start']).code, 0)
  const man = readJson(join(env.transcript.replace(/\.jsonl$/, ''), 'learn', 'q1', 'manifest.json'))
  assert.equal(man.span.end_line, 3)
})

test('lines of a renamed or moved file are not new', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [CANDS[1]] })
  mkdirSync(join(env.repo, 'docs'))
  env.git('mv', 'AGENTS.md', 'docs/agents.md')
  assert.match(env.run(['dispose', 'c001-02', 'recorded', 'docs/agents.md:3', '--report', 'x']).out, /already in the repo when the sweep started/)
})

test('a skip-worktree file\'s local lines are not credited', () => {
  const env = makeEnv(session())
  appendFileSync(join(env.repo, 'AGENTS.md'), '- A local line kept out of commits.\n')
  env.git('update-index', '--skip-worktree', 'AGENTS.md')
  env.run(['start'])
  env.extract({ 1: [CANDS[0]] })
  assert.match(env.run(['dispose', 'c001-01', 'recorded', 'AGENTS.md:4', '--report', 'x']).out, /not written by this pass/)
})

test('CRLF files are compared with the repo\'s own eol rules, wherever start ran', () => {
  const env = makeEnv(session())
  writeFileSync(join(env.repo, '.gitattributes'), '* text=auto\n')
  writeFileSync(join(env.repo, 'AGENTS.md'), '# Repo\r\n\r\n- Run `npm test` before shipping.\r\n')
  env.git('add', '-A')
  env.git('commit', '-qm', 'crlf')
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-cwd-')))
  temps.push(elsewhere)
  const out = [], err = []
  const io = { env: { ...process.env, CLAUDE_CONFIG_DIR: join(env.transcript, '..', '..', '..'), CLAUDE_CODE_SESSION_ID: '11111111-2222-3333-4444-555555555555' }, cwd: elsewhere, out: x => out.push(x), err: x => err.push(x) }
  assert.equal(run(['start', '--repo', env.repo], io), 0, err.join('\n'))
  env.extract({ 1: [CANDS[0], CANDS[1]] })
  appendFileSync(join(env.repo, 'AGENTS.md'), '- Never retry in a loop.\r\n')
  assert.match(env.run(['dispose', 'c001-02', 'recorded', 'AGENTS.md:3', '--report', 'x']).out, /not written by this pass/)
  assert.equal(env.run(['dispose', 'c001-01', 'recorded', 'AGENTS.md:4', '--report', 'x']).code, 0)
})

test('an old last line without a newline is not credited when a line is appended', () => {
  const env = makeEnv(session())
  writeFileSync(join(env.repo, 'AGENTS.md'), '# Repo\n\n- Run `npm test` before shipping.')
  env.git('commit', '-qam', 'no newline')
  env.run(['start'])
  env.extract({ 1: [CANDS[0], CANDS[1]] })
  appendFileSync(join(env.repo, 'AGENTS.md'), '\n- Never retry in a loop.\n')
  assert.match(env.run(['dispose', 'c001-02', 'recorded', 'AGENTS.md:3', '--report', 'x']).out, /not written by this pass/)
  assert.equal(env.run(['dispose', 'c001-01', 'recorded', 'AGENTS.md:4', '--report', 'x']).code, 0)
})

test('one learning per recorded line', () => {
  const env = makeEnv(session())
  env.run(['start'])
  env.extract({ 1: [CANDS[0], CANDS[1]] })
  appendFileSync(join(env.repo, 'AGENTS.md'), '- Never retry in a loop; run npm test first.\n')
  assert.equal(env.run(['dispose', 'c001-01', 'recorded', 'AGENTS.md:4', '--report', 'x']).code, 0)
  assert.match(env.run(['dispose', 'c001-02', 'recorded', 'AGENTS.md:4', '--report', 'y']).out, /already recorded by c001-01/)
  assert.equal(env.run(['dispose', 'c001-02', 'covered', 'AGENTS.md:4', '--quote', 'run npm test first']).code, 0)
})

test('an answer with quotes inside releases whole, and a fragment does not', () => {
  const env = makeEnv([...session(), toolUse('AskUserQuestion', { questions: [] }, 'a5', 'm5', 't5'),
    toolResult('t5', 'User has answered your questions: "Run the sweep now?"="Skip the "learn" sweep this time, just commit". You can now continue with the user\'s answers in mind.', 'r5')])
  assert.equal(env.run(['release', '--quote', 'Skip the']).code, 2)
  assert.equal(env.run(['release', '--quote', 'Skip the "learn" sweep this time, just commit']).code, 0)
})

test('chunk prompts keep the turn opener and reach back before a later run\'s span', () => {
  const early = Array.from({ length: 12 }, (_, k) => human(`early prompt ${k} ${'p'.repeat(250)}`, `e${k}`))
  const env = makeEnv([...early, human('Build the exporter end to end', 'u1'), midturn('use tabs, not spaces', 'q1'),
    ...Array.from({ length: 8 }, (_, k) => assistant('x'.repeat(900), `a${k}`, `m${k}`)), slashLearn('u2'), skillBody('learn', 's1')])
  env.run(['start', '--budget', '2000'])
  const last = env.manifest().chunks.length
  const text = readFileSync(env.chunk(last), 'utf8')
  assert.match(text, /SESSION PROMPTS[\s\S]*Build the exporter end to end[\s\S]*use tabs, not spaces/)
})
