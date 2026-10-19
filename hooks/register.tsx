import type { Register, EngineInterface } from 'claude-code'

import type { AtlasItem, AtlasGroup, ProjectGroup } from '../types'

const PANE = 'skill-atlas'

const viewRef = { plugin: 'skill-atlas', key: 'view' } as const
const filterRef = { plugin: 'skill-atlas', key: 'filter' } as const
const sessionRef = { plugin: 'skill-atlas', key: 'session' } as const
const projectsRef = { plugin: 'skill-atlas', key: 'projects' } as const
const scannedRef = { plugin: 'skill-atlas', key: 'scannedAt' } as const

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
  for (const entry of await listDir($, base)) {
    if (entry.kind !== 'dir' && entry.kind !== 'other') continue
    const projectDir = `${base}/${entry.name}`
    const items = [
      ...(await scanSkillsDir($, `${projectDir}/.claude/skills`, 'project')),
      ...(await scanAgentsDir($, `${projectDir}/.claude/agents`, 'project')),
    ]
    if (items.length > 0) groups.push({ project: entry.name, items })
  }
  return groups.sort((a, b) => a.project.localeCompare(b.project))
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

const trim = (text: string): string => (text.length > 160 ? `${text.slice(0, 159)}…` : text)

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

    const { Box, Text, Button, Input } = $.ui.resolve(e)

    const item = (one: AtlasItem, address: string) => (
      <Box flexDirection="column">
        <Button key={address} onPress={() => $.ui.toast(one.path)}>
          {`${one.kind === 'skill' ? '/' : '@'}${one.name}`}{' '}
          <Text dimColor size="caption">{one.kind}</Text>
          {one.scope !== 'project' && <Text dimColor size="caption">{` ${one.scope}`}</Text>}
        </Button>
        {one.description !== '' && (
          <Text dimColor size="caption" wrap="wrap">{trim(one.description)}</Text>
        )}
      </Box>
    )

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
          sessionGroups.map(group => (
            <Box flexDirection="column">
              <Box gap={1}>
                <Text weight="semibold" size="caption">{group.label.toUpperCase()}</Text>
                <Text dimColor size="caption">{group.items.length}</Text>
              </Box>
              {group.items.map(one => item(one, `s:${group.label}:${one.kind}:${one.name}`))}
            </Box>
          ))}
        {view === 'projects' &&
          projectGroups.map(group => (
            <Box flexDirection="column">
              <Box gap={1}>
                <Text weight="semibold" size="caption">{group.project.toUpperCase()}</Text>
                <Text dimColor size="caption">{group.items.length}</Text>
              </Box>
              {group.items.map(one => item(one, `p:${group.project}:${one.kind}:${one.name}`))}
            </Box>
          ))}
        {scannedAt !== 0 && (
          <Text dimColor size="caption">
            {shown} shown · scanned {new Date(scannedAt).toLocaleTimeString()}
          </Text>
        )}
      </Box>
    )
  })
}
