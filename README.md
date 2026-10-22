# skill-atlas

A Claude Code desktop mod: a live **Skill atlas** pane that shows every skill and subagent you have, so you never have to remember what lives where or fish for it in the slash autocomplete.

Ported from [coide](https://github.com/vicmaster/coide)'s `AvailableAgents` sidebar + slash autocomplete, rebuilt as a Claude Code plugin (hooks module) for the desktop app's Code tab.

## What it shows

Two views, toggled at the top of the pane:

- **This session** — everything the current session can use, grouped by origin:
  - project skills (`<project>/.claude/skills/`) and agents (`<project>/.claude/agents/`)
  - global skills/agents (`~/.claude/skills/`, `~/.claude/agents/`)
  - skills shipped by installed plugins (read from `~/.claude/plugins/installed_plugins.json`)

  When two entries share a name, the project one wins, then the global one.
- **All projects** — a scan of the folder your repos live in for `.claude/{skills,agents}/`: `~/Projects` if it exists, otherwise the folder that holds the project the session is open in. It goes up to three levels deep, so grouping folders like `<client>/<repo>` work, and skips hidden and build folders (`node_modules`, `vendor`, `dist`, `build`, `target`, `tmp`, `Library`). Results are grouped by project, with your global `~/.claude` set pinned on top, so you can see at a glance which skill lives in which repo.

Each entry shows its name (`/skill` or `@agent`), a kind icon and the description parsed from its frontmatter; globals and plugin skills also get a scope badge. The input at the top filters by name, description or scope as you type. Pressing an entry expands it to show the full description and the path of the file behind it; press again to collapse.

Everything is read-only: the mod never writes to any project.

## Install

Clone the repo and symlink (or copy) it into your user skills folder — plugins there auto-load on every session:

```bash
git clone https://github.com/vicmaster/skill-atlas.git
ln -s "$(pwd)/skill-atlas" ~/.claude/skills/skill-atlas
```

It loads on the next session as `skill-atlas@skills-dir`. The folder is watched, so edits hot-reload in live sessions.

For a one-off terminal session instead:

```bash
claude --plugin-dir path/to/skill-atlas
```

## Use

The pane opens itself when a session starts. Reopen it any time with:

```
/skill-atlas
```

`Refresh` rescans the filesystem (new skills/agents appear without a restart).

## Development

```bash
claude plugin validate .
claude plugin test .
```

`claude plugin test` needs a recent CLI. If yours doesn't have it, the binary bundled with the desktop app does (on macOS, under `~/Library/Application Support/Claude/claude-code/<version>/`).

`tests/atlas.test.ts` mounts the pane on a fake filesystem and covers scanning, project-over-global dedupe, expanding an entry, filtering and the cross-project view (nested folders included).

## Who built this

Built by [Victor Velázquez](https://victorvelazquez.dev) — COO at [MagmaLabs](https://www.magmalabs.io) and author of [*The Agentic Engineer*](https://leanpub.com/theagenticengineer).

## Layout

- `.claude-plugin/plugin.json` — manifest
- `hooks/register.tsx` — the whole mod: scanners, state, slash command, pane renderer
- `types/index.d.ts` — the plugin's state contract
- `tests/atlas.test.ts` — behaviour test
