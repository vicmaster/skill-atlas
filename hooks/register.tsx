import type { Register, EngineInterface } from 'claude-code'

import type { AtlasItem, AtlasGroup, ProjectGroup } from '../types'

const PANE = 'skill-atlas'
// Keep in step with .claude-plugin/plugin.json; shown in the pane footer so a
// stale copy is visible at a glance.
const VERSION = '0.5.0'

const viewRef = { plugin: 'skill-atlas', key: 'view' } as const
const filterRef = { plugin: 'skill-atlas', key: 'filter' } as const
const sessionRef = { plugin: 'skill-atlas', key: 'session' } as const
const projectsRef = { plugin: 'skill-atlas', key: 'projects' } as const
const scannedRef = { plugin: 'skill-atlas', key: 'scannedAt' } as const
const expandedRef = { plugin: 'skill-atlas', key: 'expanded' } as const

/** Minimal YAML frontmatter reader: name + description, quoted or folded. */
const parseFrontmatter = (text: string): { name?: string; description?: string } => {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const lines = text.slice(3, end).split('\n')
  const out: { name?: string; description?: string } = {}
  for (let i = 0; i < lines.length; i++) {
    const m = /^(name|description):\s*(.*)$/.exec(lines[i] ?? '')
    if (!m) continue
    let value = (m[2] ?? '').trim()
    if (value === '' || /^[>|][+-]?$/.test(value)) {
      const parts: string[] = []
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j] ?? ''); j++) {
        parts.push((lines[j] ?? '').trim())
      }
      value = parts.join(' ')
    }
    value = value.replace(/^["']/, '').replace(/["']$/, '')
    if (m[1] === 'name') out.name = value
    else out.description = value
  }
  return out
}

const listDir = async ($: EngineInterface, dir: string) => {
  try {
    return await $.fs.list(dir)
  } catch {
    return []
  }
}

const readText = async ($: EngineInterface, path: string): Promise<string | undefined> => {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

/** Skills live as <dir>/<name>/SKILL.md, or (rarely) as a loose <name>.md. */
const scanSkillsDir = async ($: EngineInterface, dir: string, scope: string): Promise<AtlasItem[]> => {
  const items: AtlasItem[] = []
  for (const entry of await listDir($, dir)) {
    if (entry.kind === 'file' && entry.name.endsWith('.md')) {
      const path = `${dir}/${entry.name}`
      const text = await readText($, path)
      if (text === undefined) continue
      const meta = parseFrontmatter(text)
      items.push({
        name: meta.name ?? entry.name.replace(/\.md$/, ''),
        description: meta.description ?? '',
        kind: 'skill',
        scope,
        path,
      })
      continue
    }
    if (entry.kind !== 'dir' && entry.kind !== 'other') continue
    const path = `${dir}/${entry.name}/SKILL.md`
    const text = await readText($, path)
    if (text === undefined) continue
    const meta = parseFrontmatter(text)
    items.push({
      name: meta.name ?? entry.name,
      description: meta.description ?? '',
      kind: 'skill',
      scope,
      path,
    })
  }
  return items.sort((a, b) => a.name.localeCompare(b.name))
}

/** Agents are flat <dir>/<name>.md files with name/description frontmatter. */
const scanAgentsDir = async ($: EngineInterface, dir: string, scope: string): Promise<AtlasItem[]> => {
  const items: AtlasItem[] = []
  for (const entry of await listDir($, dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    const path = `${dir}/${entry.name}`
    const text = await readText($, path)
    if (text === undefined) continue
    const meta = parseFrontmatter(text)
    items.push({
      name: meta.name ?? entry.name.replace(/\.md$/, ''),
      description: meta.description ?? '',
      kind: 'agent',
      scope,
      path,
    })
  }
  return items.sort((a, b) => a.name.localeCompare(b.name))
}

/** Skills shipped by installed plugins, via installed_plugins.json. */
const scanPluginSkills = async ($: EngineInterface, home: string): Promise<AtlasItem[]> => {
  const raw = await readText($, `${home}/.claude/plugins/installed_plugins.json`)
  if (raw === undefined) return []
  let plugins: Record<string, Array<{ installPath?: string }>> = {}
  try {
    plugins = JSON.parse(raw).plugins ?? {}
  } catch {
    return []
  }
  const items: AtlasItem[] = []
  for (const [key, installs] of Object.entries(plugins)) {
    const installPath = installs?.[0]?.installPath
    if (!installPath) continue
    const pluginName = key.split('@')[0]
    items.push(...(await scanSkillsDir($, `${installPath}/skills`, `plugin:${pluginName}`)))
  }
  return items.sort((a, b) => a.name.localeCompare(b.name))
}

/** The session view: project, global and plugin inventories, project wins a name clash. */
const scanSession = async ($: EngineInterface): Promise<AtlasGroup[]> => {
  const root = await $.session.root()
  const home = (await $.env.get('HOME')) ?? ''
  const groups: AtlasGroup[] = []
  const seen = new Set<string>()
  const push = (label: string, items: AtlasItem[]) => {
    const kept = items.filter(item => {
      const id = `${item.kind}:${item.name}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    if (kept.length > 0) groups.push({ label, items: kept })
  }
  push('Project skills', await scanSkillsDir($, `${root}/.claude/skills`, 'project'))
  push('Project agents', await scanAgentsDir($, `${root}/.claude/agents`, 'project'))
  if (home !== '' && home !== root) {
    push('Global skills', await scanSkillsDir($, `${home}/.claude/skills`, 'global'))
    push('Global agents', await scanAgentsDir($, `${home}/.claude/agents`, 'global'))
  }
  if (home !== '') push('Plugin skills', await scanPluginSkills($, home))
  return groups
}

const SKIPPED_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'tmp', 'Library'])

/** The cross-project view: every sibling project's .claude/{skills,agents}. */
const scanProjects = async ($: EngineInterface): Promise<ProjectGroup[]> => {
  const home = (await $.env.get('HOME')) ?? ''
  const root = await $.session.root()
  let base = `${home}/Projects`
  if (home === '' || !(await $.fs.exists(base))) {
    const cut = root.lastIndexOf('/')
    base = cut > 0 ? root.slice(0, cut) : root
  }
  const groups: ProjectGroup[] = []
  // Projects may sit under grouping folders (~/Projects/<group>/<project>):
  // walk a few levels, stop descending once a folder proves to be a project,
  // and name the group by its path relative to the base.
  const walk = async (dir: string, label: string, depth: number): Promise<void> => {
    for (const entry of await listDir($, dir)) {
      if (entry.kind !== 'dir' && entry.kind !== 'other') continue
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue
      const projectDir = `${dir}/${entry.name}`
      const name = label === '' ? entry.name : `${label}/${entry.name}`
      const items = [
        ...(await scanSkillsDir($, `${projectDir}/.claude/skills`, 'project')),
        ...(await scanAgentsDir($, `${projectDir}/.claude/agents`, 'project')),
      ]
      if (items.length > 0) groups.push({ project: name, items })
      else if (depth > 1) await walk(projectDir, name, depth - 1)
    }
  }
  await walk(base, '', 3)
  groups.sort((a, b) => a.project.localeCompare(b.project))
  // The machine-wide set leads the map, so global vs per-project is one glance.
  if (home !== '') {
    const globalItems = [
      ...(await scanSkillsDir($, `${home}/.claude/skills`, 'global')),
      ...(await scanAgentsDir($, `${home}/.claude/agents`, 'global')),
    ]
    if (globalItems.length > 0) groups.unshift({ project: 'global · ~/.claude', items: globalItems })
  }
  return groups
}

const rescan = async ($: EngineInterface): Promise<void> => {
  const [session, projects] = await Promise.all([scanSession($), scanProjects($)])
  await $.state.set(sessionRef, session)
  await $.state.set(projectsRef, projects)
  await $.state.set(scannedRef, Date.now())
}

const matches = (item: AtlasItem, query: string): boolean =>
  query === '' ||
  item.name.toLowerCase().includes(query) ||
  item.description.toLowerCase().includes(query) ||
  item.scope.toLowerCase().includes(query)

const trim = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text

// Agent icons ported from coide's agentIcons.ts: deterministic keyword match
// over name + description, 14x14 strokes, one hue per personality.
type AgentIcon = { paths: string; color: string }

const AGENT_ICONS: Record<string, AgentIcon> = {
  architect: {
    paths:
      '<path d="M2 12h10M3 12V6M6 12V4M9 12V6M11 12V6M2 4l4-2 4 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    color: '#fbbf24',
  },
  review: {
    paths:
      '<circle cx="6" cy="6" r="3.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M9 9l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    color: '#60a5fa',
  },
  design: {
    paths:
      '<circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="4.5" cy="6" r="0.6" fill="currentColor"/><circle cx="6" cy="9.5" r="0.6" fill="currentColor"/><circle cx="9.5" cy="6.5" r="0.6" fill="currentColor"/>',
    color: '#f472b6',
  },
  security: {
    paths:
      '<path d="M7 1.5L2 3.5v3.5c0 3 2 5 5 6 3-1 5-3 5-6V3.5L7 1.5z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><path d="M5 7l1.5 1.5L9 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    color: '#34d399',
  },
  debug: {
    paths:
      '<ellipse cx="7" cy="8" rx="3" ry="3.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 4.5V6M4 8H2M12 8h-2M4 11l-1.5 1.5M10 11l1.5 1.5M5.5 4l-1-1.5M8.5 4l1-1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    color: '#f87171',
  },
  test: {
    paths:
      '<path d="M5 1.5v4L2.5 11.5a1 1 0 00.9 1.5h7.2a1 1 0 00.9-1.5L9 5.5v-4M4 1.5h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="6" cy="9" r="0.6" fill="currentColor"/><circle cx="8" cy="10.5" r="0.6" fill="currentColor"/>',
    color: '#22d3ee',
  },
  research: {
    paths:
      '<path d="M2 2.5h6.5L11 5v8H2v-10.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M8 2.5V5h3M4 7h5M4 9.5h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    color: '#c084fc',
  },
  writer: {
    paths:
      '<path d="M2 11.5L4 13l8.5-8.5L11 3 2.5 11.5zM10 4l1 1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    color: '#38bdf8',
  },
  perf: {
    paths:
      '<path d="M7 1.5l-4 7h3l-1 4 5-7h-3l1-4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>',
    color: '#facc15',
  },
  release: {
    paths:
      '<path d="M7 1.5c-2 1.5-3 3.5-3 5.5L2 10l2.5-1 2 2 1-2.5 2.5 2v-2c2-2 2-4 0-7z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><circle cx="7" cy="5" r="1" fill="currentColor"/>',
    color: '#fb923c',
  },
  data: {
    paths:
      '<ellipse cx="7" cy="3" rx="4" ry="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M3 3v8c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5V3M3 7c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5" stroke="currentColor" stroke-width="1.2" fill="none"/>',
    color: '#818cf8',
  },
  default: {
    paths:
      '<path d="M7 1.5l1.5 3.5L12 6.5l-3 2 1 3.5-3-2-3 2 1-3.5-3-2 3.5-1L7 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>',
    color: '#9ca3af',
  },
}

// Every skill shares one badge — a rounded square holding the "/" it is
// invoked with, in one fixed hue — so the shape family tells the kind apart:
// square+slash = skill, round personality icon = agent.
const SKILL_ICON: AgentIcon = {
  paths:
    '<g opacity="0.75"><rect x="1.5" y="1.5" width="11" height="11" rx="3" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M8.6 3.8L5.4 10.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></g>',
  color: '#14b8a6',
}

const ICON_KEYWORDS: Array<{ keys: string[]; icon: keyof typeof AGENT_ICONS }> = [
  { keys: ['architect', 'system', 'design pattern'], icon: 'architect' },
  { keys: ['review', 'critic', 'inspect', 'audit'], icon: 'review' },
  { keys: ['design', 'ui', 'ux', 'visual', 'styling', 'layout'], icon: 'design' },
  { keys: ['security', 'auth', 'vuln', 'pentest', 'crypto'], icon: 'security' },
  { keys: ['debug', 'bug', 'fix', 'troubleshoot'], icon: 'debug' },
  { keys: ['test', 'qa', 'spec', 'coverage'], icon: 'test' },
  { keys: ['research', 'explore', 'investigate', 'analyze', 'docs'], icon: 'research' },
  { keys: ['write', 'author', 'doc', 'content', 'copy'], icon: 'writer' },
  { keys: ['perf', 'fast', 'optim', 'speed', 'profile'], icon: 'perf' },
  { keys: ['release', 'deploy', 'ship', 'publish'], icon: 'release' },
  { keys: ['data', 'database', 'sql', 'query', 'migration', 'schema'], icon: 'data' },
]

const pickAgentIcon = (name: string, description: string): AgentIcon => {
  const haystack = `${name} ${description}`.toLowerCase()
  for (const entry of ICON_KEYWORDS) {
    if (entry.keys.some(k => haystack.includes(k))) return AGENT_ICONS[entry.icon] ?? AGENT_ICONS.default!
  }
  return AGENT_ICONS.default!
}

const svgSource = (icon: AgentIcon): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" color="${icon.color}">${icon.paths}</svg>`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skill-atlas',
      description: 'Show every skill and subagent (this session + all projects) in a pane',
    })
    void $.ui.open({ id: PANE, title: 'Skill atlas' })
    void rescan($)

    return next(e)
  })

  on('command.run', { command: 'skill-atlas' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Skill atlas' })
    void rescan($)

    return { text: 'Skill atlas pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { value: view = 'session' } = await $.state.get(viewRef)
    const { value: filter = '' } = await $.state.get(filterRef)
    const { value: session = [] } = await $.state.get(sessionRef)
    const { value: projects = [] } = await $.state.get(projectsRef)
    const { value: scannedAt = 0 } = await $.state.get(scannedRef)
    const { value: expanded = [] } = await $.state.get(expandedRef)
    const query = filter.trim().toLowerCase()

    if (e.surface === 'mobile') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" padding={1}>
          <Text weight="semibold">Skill atlas</Text>
          <Text dimColor>Open on desktop for the full pane.</Text>
        </Box>
      )
    }

    const table = $.ui.resolve(e)
    const { Box, Text, Button, Input } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    // Roughly two lines of description under the indent, as coide clamps it.
    const descMax = Math.max(80, (e.props.bodyColumns - 2) * 2)
    // Overlong on purpose: wrap="truncate" clips it to the box on every
    // surface, where a width computed from bodyColumns (cells) overflows the
    // desktop's proportional text and wraps.
    const rule = '─'.repeat(120)

    const item = (one: AtlasItem, address: string) => {
      const icon = one.kind === 'agent' ? pickAgentIcon(one.name, one.description) : SKILL_ICON
      const isExpanded = expanded.includes(address)
      const toggle = () =>
        void $.state.set(
          expandedRef,
          isExpanded ? expanded.filter(a => a !== address) : [...expanded, address],
        )
      return (
        <Box flexDirection="column">
          <Box gap={1} alignItems="center">
            {Svg !== undefined && (
              <Svg source={svgSource(icon)} alt={one.kind} width={14} height={14} />
            )}
            <Button key={address} onPress={toggle}>
              {`${one.kind === 'skill' ? '/' : '@'}${one.name}`}
              {one.scope !== 'project' && <Text dimColor size="caption">{` ${one.scope}`}</Text>}
            </Button>
          </Box>
          {one.description !== '' && (
            <Box paddingLeft={2}>
              <Text dimColor size="caption" wrap="wrap">
                {isExpanded ? one.description : trim(one.description, descMax)}
              </Text>
            </Box>
          )}
          {isExpanded && (
            <Box paddingLeft={2}>
              <Text dimColor size="caption" mono wrap="wrap">{one.path}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const sessionGroups = session
      .map(group => ({ ...group, items: group.items.filter(one => matches(one, query)) }))
      .filter(group => group.items.length > 0)
    const projectGroups = projects
      .map(group => ({ ...group, items: group.items.filter(one => matches(one, query)) }))
      .filter(group => group.items.length > 0)

    const shown =
      view === 'session'
        ? sessionGroups.reduce((n, g) => n + g.items.length, 0)
        : projectGroups.reduce((n, g) => n + g.items.length, 0)

    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Box gap={1}>
          <Button
            key="view-session"
            variant={view === 'session' ? 'primary' : undefined}
            onPress={() => void $.state.set(viewRef, 'session')}
          >
            This session
          </Button>
          <Button
            key="view-projects"
            variant={view === 'projects' ? 'primary' : undefined}
            onPress={() => void $.state.set(viewRef, 'projects')}
          >
            All projects
          </Button>
          <Button key="refresh" onPress={() => void rescan($)}>
            Refresh
          </Button>
        </Box>
        <Input
          key="filter"
          placeholder="Filter by name, description or scope…"
          value={filter}
          submitLabel="filter"
          onInput={value => void $.state.set(filterRef, value)}
          onSubmit={value => void $.state.set(filterRef, value)}
        />
        {scannedAt === 0 && <Text dimColor>Scanning…</Text>}
        {scannedAt !== 0 && shown === 0 && (
          <Text dimColor>{query === '' ? 'Nothing found.' : `No matches for “${filter.trim()}”.`}</Text>
        )}
        {view === 'session' &&
          sessionGroups.map((group, i) => (
            <Box flexDirection="column" rowGap={1} marginBottom={1}>
              {i > 0 && <Text dimColor wrap="truncate">{rule}</Text>}
              <Box gap={1}>
                <Text weight="semibold" size="caption">{group.label.toUpperCase()}</Text>
                <Text dimColor size="caption">{group.items.length}</Text>
              </Box>
              {group.items.map(one => item(one, `s:${group.label}:${one.kind}:${one.name}`))}
            </Box>
          ))}
        {view === 'projects' &&
          projectGroups.map((group, i) => {
            const skills = group.items.filter(one => one.kind === 'skill')
            const agents = group.items.filter(one => one.kind === 'agent')
            const isMixed = skills.length > 0 && agents.length > 0
            return (
              <Box flexDirection="column" rowGap={1} marginBottom={1}>
                {i > 0 && <Text dimColor wrap="truncate">{rule}</Text>}
                <Box gap={1}>
                  <Text weight="semibold" size="caption">{group.project.toUpperCase()}</Text>
                  <Text dimColor size="caption">{group.items.length}</Text>
                </Box>
                {isMixed && <Text dimColor size="caption" italic>skills · {skills.length}</Text>}
                {skills.map(one => item(one, `p:${group.project}:skill:${one.name}`))}
                {isMixed && <Text dimColor size="caption" italic>agents · {agents.length}</Text>}
                {agents.map(one => item(one, `p:${group.project}:agent:${one.name}`))}
              </Box>
            )
          })}
        {scannedAt !== 0 && (
          <Text dimColor size="caption">
            v{VERSION} · {shown} shown · press an entry for its full description · scanned{' '}
            {new Date(scannedAt).toLocaleTimeString()}
          </Text>
        )}
      </Box>
    )
  })
}
