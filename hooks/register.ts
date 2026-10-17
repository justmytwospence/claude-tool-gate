// tool-gate: pi-tool-gate's directory policy for Claude Code. A call that reads or writes outside
// its project's directories is put to you instead of running.
//
// Claude Code's own rules cannot say "nothing in ~/Projects except this repo": deny and ask rules
// outrank allow rules, and additionalDirectories only adds. So this mod sits on the engine's
// permission decision (`tool.check`) and turns an allow into an ask when a file tool's path, or a
// path named in a Bash command, lies outside the policy. Everything else is Claude Code's.
//
// The policy and its settings are pi-tool-gate's (`directories` in tool-gate.json):
// ~/.config/agents/tool-gate.json, then the project's .agents/tool-gate.json and
// .claude/tool-gate.json. /tool-gate shows the policy in force.
import type { EngineInterface, On } from 'claude-code'

import { bashPathAccess, expandHome } from './core/bash'
import { DEFAULT_DIRECTORIES, type DirectoriesConfig, type Policy, describePolicy, resolvePolicy, shown, violations } from './core/dirs'
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
export function accessOf(tool: string, input: unknown, cwd: string): Access | undefined {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (tool === 'Bash') return bashPathAccess(typeof args.command === 'string' ? args.command : '', cwd)
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
export function holds(policy: Policy, access: Access): string[] {
  return [...new Set(violations(policy, access).map((v) => `${v.access === 'write' ? 'writes' : 'reads'} ${shown(v.file)}`))]
}

/** Where the session runs: its working directory, the project's checkouts, and the paths settings live under. */
const where = { cwd: '/', project: undefined as string[] | undefined, home: '/', xdg: undefined as string | undefined }

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
  on('session.start', async ($, e, next) => {
    const started = await next(e)
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
    if (verdict.decision !== 'allow') return verdict
    const access = accessOf(e.tool, e.input, where.cwd)
    if (!access) return verdict
    const p = await currentPolicy($).catch(() => undefined)
    if (!p) return verdict
    const reasons = holds(p, access)
    if (!reasons.length) return verdict
    return { decision: 'ask', reason: `tool-gate: this call ${reasons.join('; ')}, outside this project's directories (/tool-gate).` }
  }).catch(($, e, next) => (next.called ? undefined : next(e)))
}
