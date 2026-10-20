// tool-gate: pi-tool-gate's directory policy for Claude Code. A call that reads or writes outside
// its project's directories is put to you instead of running.
//
// Claude Code's own rules cannot say "nothing in ~/Projects except this repo": deny and ask rules
// outrank allow rules, and additionalDirectories only adds. So this mod sits on the engine's
// permission decision (`tool.check`) and holds a call it would allow or ask about when a file tool's path, or a path
// named in a Bash command, lies outside the policy. Everything else is Claude Code's.
//
// How a held call is put to you depends on the mode. In default, accept-edits, plan and dontAsk
// modes the verdict becomes `ask`, which is Claude Code's own dialog. In auto mode an `ask` would
// go to the auto-mode classifier, so the mod asks you itself: allow once, allow the folder for
// the session, or deny. Bypass mode runs everything. With no one to ask (`-p`, the SDK) a held
// call is denied.
//
// The policy and its settings are pi-tool-gate's (`directories` in tool-gate.json):
// ~/.config/agents/tool-gate.json, then the project's .agents/tool-gate.json and
// .claude/tool-gate.json. /tool-gate shows the policy in force.
import type { EngineInterface, On } from 'claude-code'

import { bashPathAccess, expandHome } from './core/bash'
import { DEFAULT_DIRECTORIES, type DirectoriesConfig, type Policy, type Violation, describePolicy, grantKey, resolvePolicy, shown, violations } from './core/dirs'
import path, { setEnv } from './core/path'

const NAME = 'tool-gate'

/** The file tools and the argument naming their path; a missing path means the working directory. */
const FILE_TOOLS: Record<string, { key: string; access: 'read' | 'write' }> = {
  Read: { key: 'file_path', access: 'read' },
  Grep: { key: 'path', access: 'read' },
  Glob: { key: 'path', access: 'read' },
  LS: { key: 'path', access: 'read' },
  Edit: { key: 'file_path', access: 'write' },
  MultiEdit: { key: 'file_path', access: 'write' },
  Write: { key: 'file_path', access: 'write' },
  NotebookEdit: { key: 'notebook_path', access: 'write' },
}

type Access = { reads: string[]; writes: string[] }

/** What a call reads and writes, or undefined for a tool the policy does not cover. */
export function accessOf(tool: string, input: unknown, cwd: string, exempt: readonly string[] = []): Access | undefined {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (tool === 'Bash') return bashPathAccess(typeof args.command === 'string' ? args.command : '', cwd, [], exempt)
  const spec = FILE_TOOLS[tool]
  if (!spec) return undefined
  const raw = typeof args[spec.key] === 'string' && args[spec.key] ? (args[spec.key] as string) : '.'
  const file = path.resolve(cwd, expandHome(raw))
  return spec.access === 'read' ? { reads: [file], writes: [] } : { reads: [], writes: [file] }
}

/** `directories` from each settings file, later files winning key by key. */
export function mergeDirectories(texts: readonly (string | undefined)[]): DirectoriesConfig {
  let out: DirectoriesConfig = { ...DEFAULT_DIRECTORIES }
  for (const text of texts) {
    if (!text) continue
    try {
      const dirs = JSON.parse(text)?.directories
      if (dirs && typeof dirs === 'object' && !Array.isArray(dirs)) out = { ...out, ...dirs }
    } catch {}
  }
  return out
}

/** The reasons a call is put to you, or [] when the policy covers it. */
export function holds(policy: Policy, access: Access, granted: ReadonlySet<string> = new Set()): string[] {
  return reasonsOf(violations(policy, access).filter((v) => !granted.has(grantKey(v))))
}

function reasonsOf(found: readonly Violation[]): string[] {
  return [...new Set(found.map((v) =>
    v.hint !== undefined
      ? `writes ${shown(v.file)}, a derived path (generated from a source elsewhere). ${v.hint || 'Edit its source instead.'}`
      : `${v.access === 'write' ? 'writes' : 'reads'} ${shown(v.file)}, outside this project's directories`))]
}

/** How a held call is settled in a permission mode: Claude Code's dialog, the mod's own question, or not held. */
export function settleBy(mode: string | undefined, interactive: boolean): 'dialog' | 'question' | 'deny' | 'run' {
  if (mode === 'bypassPermissions') return 'run'
  if (!interactive) return 'deny'
  return mode === 'auto' || mode === undefined ? 'question' : 'dialog'
}

/** Where the session runs: its working directory, the project's checkouts, the paths settings live under, its mode and whether a person is there. */
const where = {
  cwd: '/', project: undefined as string[] | undefined, home: '/', xdg: undefined as string | undefined,
  mode: undefined as string | undefined, interactive: true,
}

/** Folders allowed for the session from the question, as grantKey()s. */
const granted = new Set<string>()

/** One question at a time: parallel calls wait their turn, and a grant answers the ones queued behind it. */
let questions: Promise<unknown> = Promise.resolve()

/** The settings files: shared, then the project's (from the main checkout, where a worktree's untracked settings live). */
function settingsFiles(): string[] {
  const root = (where.project ?? [where.cwd]).slice(-1)[0] as string
  return [`${where.xdg || `${where.home}/.config`}/agents/${NAME}.json`, `${root}/.agents/${NAME}.json`, `${root}/.claude/${NAME}.json`]
}

/** The policy in force now, read fresh so edits apply to the next call; undefined when off. */
async function currentPolicy($: EngineInterface): Promise<Policy | undefined> {
  const texts: (string | undefined)[] = []
  for (const file of settingsFiles()) texts.push(await $.fs.read(file).catch(() => undefined))
  const config = mergeDirectories(texts)
  if (config.enabled === false) return undefined
  return resolvePolicy(config, where.project ?? [where.cwd])
}

export function register(on: On): void {
  // The mode is on every classic hook's input; a prompt's is current for the calls it leads to.
  const noteMode = (e: { permission_mode?: string }) => {
    if (e.permission_mode) where.mode = e.permission_mode
  }
  on('classic.SessionStart', async ($, e, next) => (noteMode(e), next(e)))
  on('classic.UserPromptSubmit', async ($, e, next) => (noteMode(e), next(e)))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    where.interactive = e.isInteractive
    where.home = (await $.env.get('HOME')) || '/'
    where.xdg = (await $.env.get('XDG_CONFIG_HOME')) || undefined
    setEnv({ home: where.home, tmpdir: (await $.env.get('TMPDIR')) || '/tmp' })
    where.cwd = await $.session.cwd()
    const out = await $.process
      .run(['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd: where.cwd })
      .catch(() => undefined)
    const [top, common] = (out?.stdout ?? '').split('\n').map((l) => l.trim())
    if (out?.exitCode === 0 && top) {
      const main = common && path.basename(common) === '.git' ? path.dirname(common) : undefined
      where.project = main && main !== top ? [top, main] : [top]
    }
    await $.command.register({ name: NAME, description: 'tool-gate: the directories this project reads and writes without asking', immediate: true })
    return started
  })

  on('command.run', { command: NAME }, async ($) => {
    const p = await currentPolicy($)
    return { text: p ? describePolicy(p) : 'Directory policy: off.' }
  }).catch(() => ({ text: 'tool-gate: could not read the policy' }))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // An ask is held too: in auto mode the classifier, not you, would settle it.
    if (verdict.decision === 'deny') return verdict
    const p = await currentPolicy($).catch(() => undefined)
    if (!p) return verdict
    const access = accessOf(e.tool, e.input, where.cwd, p.exempt)
    if (!access) return verdict
    const held = () => violations(p, access).filter((v) => !granted.has(grantKey(v)))
    if (!held().length) return verdict
    const why = (found: readonly Violation[]) => `tool-gate: this call ${reasonsOf(found).join('; ')} (/tool-gate).`
    switch (settleBy(where.mode, where.interactive)) {
      case 'run':
        return verdict
      case 'deny':
        return { decision: 'deny', reason: `${why(held())} No one is here to allow it; continue without it.` }
      case 'dialog':
        return { decision: 'ask', reason: why(held()) }
    }
    const ask = async (): Promise<{ decision: 'allow' | 'deny'; reason?: string }> => {
      const found = held()
      if (!found.length) return { decision: 'allow' }
      const scopes = [...new Set(found.map((v) => `${v.access} ${shown(v.scope)}`))]
      const folder = `Allow ${scopes.join(' and ')} this session`
      const answer = await $.ui
        .ask(`${why(found)} Allow it?`, { header: 'tool-gate', options: ['Allow once', folder, 'Deny'] })
        .catch(() => undefined)
      if (answer === 'Allow once') return { decision: 'allow' }
      if (answer === folder) {
        for (const v of found) granted.add(grantKey(v))
        return { decision: 'allow' }
      }
      const said = answer && answer !== 'Deny' ? ` They said: ${answer}` : ''
      return { decision: 'deny', reason: `The user declined this call.${said} Do not retry it as it was.` }
    }
    const turn = questions.then(ask, ask)
    questions = turn.catch(() => undefined)
    return turn
  }).catch(($, e, next) => (next.called ? undefined : next(e)))
}
