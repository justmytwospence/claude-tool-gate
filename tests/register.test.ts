import { expect, test } from 'claude-code/testing'

import { DEFAULT_DIRECTORIES, resolvePolicy } from '../hooks/core/dirs'
import { setEnv } from '../hooks/core/path'
import { accessOf, holds, mergeDirectories, settleBy } from '../hooks/register'

setEnv({ home: '/Users/me', tmpdir: '/var/folders/x/T' })
const app = '/Users/me/Projects/app'
const policy = (over = {}) => resolvePolicy({ ...DEFAULT_DIRECTORIES, ...over }, [app])

test('file tools: reads and writes of their path, relative to the working directory', () => {
  expect(accessOf('Read', { file_path: '~/Projects/other/a.ts' }, app)).toEqual({ reads: ['/Users/me/Projects/other/a.ts'], writes: [] })
  expect(accessOf('Edit', { file_path: 'src/a.ts' }, app)).toEqual({ reads: [], writes: [`${app}/src/a.ts`] })
  expect(accessOf('Grep', { pattern: 'x' }, app)).toEqual({ reads: [app], writes: [] })
  expect(accessOf('WebFetch', { url: 'https://x' }, app)).toBeUndefined()
})

test('Bash: paths in the command', () => {
  expect(accessOf('Bash', { command: 'cp src/a.ts ~/Projects/other/' }, app)).toEqual({ reads: [`${app}/src/a.ts`], writes: ['/Users/me/Projects/other'] })
})

test('the default policy holds other projects and private folders, not the project or system paths', () => {
  const p = policy()
  expect(holds(p, { reads: [`${app}/a`, '/etc/hosts', '/Users/me/.config/git/config'], writes: [`${app}/b`, '/tmp/x', '/private/var/folders/x/T/y'] })).toEqual([])
  expect(holds(p, { reads: ['/Users/me/Projects/other/a'], writes: ['/Users/me/.zshrc'] })).toEqual(['writes ~/.zshrc, outside this project\'s directories', 'reads ~/Projects/other/a, outside this project\'s directories'])
})

test('grants from settings files: later files win key by key, invalid ones are skipped', () => {
  const merged = mergeDirectories(['{"directories":{"read":["*"]}}', 'not json', undefined, '{"directories":{"write":["~/dotfiles"]}}'])
  expect(merged.read).toEqual(['*'])
  expect(merged.write).toEqual(['~/dotfiles'])
  const p = resolvePolicy(merged, [app])
  expect(holds(p, { reads: ['/Users/me/Projects/other/a'], writes: ['/Users/me/dotfiles/x'] })).toEqual([])
  expect(holds(p, { reads: [], writes: ['/Users/me/Projects/other/a'] })).toEqual(['writes ~/Projects/other/a, outside this project\'s directories'])
})

test('a held call is settled by the mode: the dialog, its own question in auto mode, deny with no one there, run in bypass', () => {
  expect(settleBy('default', true)).toBe('dialog')
  expect(settleBy('acceptEdits', true)).toBe('dialog')
  expect(settleBy('auto', true)).toBe('question')
  expect(settleBy(undefined, true)).toBe('question')
  expect(settleBy('auto', false)).toBe('deny')
  expect(settleBy('default', false)).toBe('deny')
  expect(settleBy('bypassPermissions', false)).toBe('run')
})

test('a folder allowed for the session is no longer held', () => {
  const p = policy()
  const access = { reads: ['/Users/me/Projects/other/a'], writes: [] }
  expect(holds(p, access, new Set(['dir:read:/Users/me/Projects/other']))).toEqual([])
  expect(holds(p, { reads: [], writes: ['/Users/me/Projects/other/a'] }, new Set(['dir:read:/Users/me/Projects/other']))).toEqual(['writes ~/Projects/other/a, outside this project\'s directories'])
})

test('derived paths are held under a grant, with the hint; exempt commands name no paths', () => {
  const p = policy({ write: ['~/.config'], derived: [{ path: '~/.config/app', hint: 'Edit ~/src/app.toml.' }], exemptCommands: ['gen apply'] })
  expect(holds(p, { reads: [], writes: ['/Users/me/.config/other'] })).toEqual([])
  expect(holds(p, { reads: [], writes: ['/Users/me/.config/app/a'] })).toEqual(['writes ~/.config/app/a, a derived path (generated from a source elsewhere). Edit ~/src/app.toml.'])
  expect(accessOf('Bash', { command: 'gen apply ~/.config/app/a' }, app, p.exempt)).toEqual({ reads: [], writes: [] })
  expect(accessOf('Bash', { command: 'cp x ~/.config/app/a' }, app, p.exempt)?.writes).toEqual(['/Users/me/.config/app/a'])
})
