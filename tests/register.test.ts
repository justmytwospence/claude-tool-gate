import { expect, test } from 'claude-code/testing'

import { DEFAULT_DIRECTORIES, resolvePolicy } from '../hooks/core/dirs'
import { setEnv } from '../hooks/core/path'
import { accessOf, holds, mergeDirectories } from '../hooks/register'

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
  expect(holds(p, { reads: ['/Users/me/Projects/other/a'], writes: ['/Users/me/.zshrc'] })).toEqual(['writes ~/.zshrc', 'reads ~/Projects/other/a'])
})

test('grants from settings files: later files win key by key, invalid ones are skipped', () => {
  const merged = mergeDirectories(['{"directories":{"read":["*"]}}', 'not json', undefined, '{"directories":{"write":["~/dotfiles"]}}'])
  expect(merged.read).toEqual(['*'])
  expect(merged.write).toEqual(['~/dotfiles'])
  const p = resolvePolicy(merged, [app])
  expect(holds(p, { reads: ['/Users/me/Projects/other/a'], writes: ['/Users/me/dotfiles/x'] })).toEqual([])
  expect(holds(p, { reads: [], writes: ['/Users/me/Projects/other/a'] })).toEqual(['writes ~/Projects/other/a'])
})
