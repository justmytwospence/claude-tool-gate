# claude-tool-gate

The Claude Code mod of [pi-tool-gate](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-tool-gate)'s directory policy. A call that reads or writes outside its project's directories is put to you instead of running.

## How it works

Claude Code's own permission rules cannot say "nothing in `~/Projects` except this repo". Deny and ask rules outrank allow rules, and `additionalDirectories` only adds directories. So the mod hooks the engine's permission decision (`tool.check`). When Claude Code would allow a call or ask about it, but a path the call touches lies outside the policy, the mod holds it. A deny from Claude Code stands.

How a held call is put to you depends on the permission mode:

| Mode | Held call |
|---|---|
| default, accept edits, plan, don't ask | `ask`: Claude Code's own permission dialog |
| auto | The mod's own question: allow once, allow that folder (read or write) for the session, or deny. An `ask` here would go to the auto-mode classifier, which can allow it. |
| bypass permissions | runs |
| no one to ask (`-p`, the SDK) | denied, with the reason |

The mode is read from Claude Code's classic hook inputs (`SessionStart`, `UserPromptSubmit`); until one arrives the mod assumes auto. Parallel questions are asked one at a time, and a folder allowed for the session answers the ones waiting behind it.

- `Read`, `Grep`, `Glob` and `LS` read their path. `Edit`, `MultiEdit`, `Write` and `NotebookEdit` write theirs.
- `Bash` commands: words that look like paths (a slash, `~`, `.`) and redirect targets, with pi-tool-gate's parser. Read-only commands read what they name; `rm`, `mv`, `cp`'s destination and the like write it; other programs are assumed to write what they name. The command is resolved against the session's starting directory.

## The policy

It is pi-tool-gate's, from the same files:

- The project, meaning the git checkout plus the main checkout of a worktree, is readable and writable.
- Private roots (`~/Projects`, `~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive) are neither read nor written outside the project and its grants.
- Other paths can be read. They can be written only in temp and cache directories (`alwaysWrite`) or a `write` grant.

Settings are `directories` in `~/.config/agents/tool-gate.json` (under `$XDG_CONFIG_HOME` when set), then the project's `.agents/tool-gate.json` and `.claude/tool-gate.json`. Later files win key by key, and they are read on every call:

```json
{ "directories": { "read": ["*"], "write": ["~/dotfiles", "~/Projects/herdr-*"] } }
```

`read: ["*"]` reads anywhere. `"enabled": false` turns the policy off. `/tool-gate` shows the policy in force.

To have Claude Code's own rules agree, mirror the grants in its settings: write grants in `permissions.additionalDirectories` and `sandbox.filesystem.allowWrite`, read grants in `Read(//path/**)` allow rules and `sandbox.filesystem.allowRead`.

## Install

Load it as a plugin directory, either with `claude --plugin-dir <checkout>` or listed in `CLAUDE_CODE_PLUGIN_DIRS`.

## Development

```sh
claude plugin validate .   # static analysis of the hooks module
claude plugin test         # tests/
tsc -p .                   # after one load, which writes .claude-plugin/types/
```

`hooks/core/bash.ts` and `hooks/core/dirs.ts` are copies of pi-tool-gate's `src/bash.ts` and `src/dirs.ts`, with their imports pointed at `hooks/core/path.ts`, because a mod has no Node built-ins. Keep them in step.

## License

MIT
