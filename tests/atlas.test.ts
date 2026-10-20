import { test, expect, mock } from 'claude-code/testing'
import type { FsEntry } from 'claude-code'

const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const file = (name: string): FsEntry => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })

const HOME = '/home/u'
const ROOT = `${HOME}/Projects/app`
const PLUGIN_DIR = `${HOME}/.claude/plugins/cache/mk/dia/1.0.0`

const DIRS: Record<string, FsEntry[]> = {
  [`${ROOT}/.claude/skills`]: [dir('deploy')],
  [`${ROOT}/.claude/agents`]: [file('reviewer.md')],
  [`${HOME}/.claude/skills`]: [dir('deploy'), dir('review-adoption')],
  [`${PLUGIN_DIR}/skills`]: [dir('diagram-design')],
  [`${HOME}/Projects`]: [dir('app'), dir('other'), dir('Magmalabs'), dir('node_modules')],
  [`${HOME}/Projects/other/.claude/skills`]: [dir('thing')],
  [`${HOME}/Projects/Magmalabs`]: [dir('delivery-assistant')],
  [`${HOME}/Projects/Magmalabs/delivery-assistant/.claude/skills`]: [dir('triage')],
}

const FILES: Record<string, string> = {
  [`${ROOT}/.claude/skills/deploy/SKILL.md`]: '---\nname: deploy\ndescription: Ship the app\n---\nbody',
  [`${ROOT}/.claude/agents/reviewer.md`]: '---\nname: reviewer\ndescription: Reviews code\n---\nbody',
  [`${HOME}/.claude/skills/deploy/SKILL.md`]: '---\nname: deploy\ndescription: Global shadowed copy\n---\nbody',
  [`${HOME}/.claude/skills/review-adoption/SKILL.md`]:
    '---\nname: review-adoption\ndescription: >\n  Evaluate a tool\n  for adoption fit\n---\nbody',
  [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
    version: 2,
    plugins: { 'dia@mk': [{ scope: 'user', installPath: PLUGIN_DIR }] },
  }),
  [`${PLUGIN_DIR}/skills/diagram-design/SKILL.md`]:
    '---\nname: diagram-design\ndescription: Draw diagrams\n---\nbody',
  [`${HOME}/Projects/other/.claude/skills/thing/SKILL.md`]:
    '---\nname: thing\ndescription: A thing elsewhere\n---\nbody',
  [`${HOME}/Projects/Magmalabs/delivery-assistant/.claude/skills/triage/SKILL.md`]:
    '---\nname: triage\ndescription: Nested one level down\n---\nbody',
}

const PANE = {
  plugin: 'skill-atlas',
  component: 'Pane',
  requestId: 'skill-atlas',
  props: {
    title: 'Skill atlas',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('pane lists session inventory, dedupes, filters, and shows all projects', async ($, on) => {
  mock.env(on, { HOME })
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', (_$, e) => ({ value: e.path in DIRS || e.path in FILES }))
  on('fs.list', (_$, e) => {
    const entries = DIRS[e.path]
    return entries === undefined ? { deny: `ENOENT: ${e.path}` } : { value: entries }
  })
  on('fs.read', (_$, e) => {
    const text = FILES[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Before any scan the pane says so rather than erroring.
  expect(await ui.find({ type: 'Text', text: 'Scanning' })).toBeDefined()

  // Refresh runs the scan; the press settles once the unawaited work does.
  await ui.press({ key: 'refresh' })

  // Session view: project skill + agent, global skill, plugin skill.
  expect(await ui.find({ key: 's:Project skills:skill:deploy' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Ship the app' })).toBeDefined()
  expect(await ui.find({ key: 's:Project agents:agent:reviewer' })).toBeDefined()
  // Agent rows carry a personality icon on surfaces that draw Svg.
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ key: 's:Global skills:skill:review-adoption' })).toBeDefined()
  // Folded (>) descriptions are joined into one line.
  expect(await ui.find({ type: 'Text', text: 'Evaluate a tool for adoption fit' })).toBeDefined()
  expect(await ui.find({ key: 's:Plugin skills:skill:diagram-design' })).toBeDefined()

  // The global copy of "deploy" is shadowed by the project's.
  expect(await ui.find({ key: 's:Global skills:skill:deploy' })).toBeUndefined()

  // Pressing an entry expands it: full description plus the file's path.
  await ui.press({ key: 's:Global skills:skill:review-adoption' })
  expect(
    await ui.find({ type: 'Text', text: `${HOME}/.claude/skills/review-adoption/SKILL.md` }),
  ).toBeDefined()
  await ui.press({ key: 's:Global skills:skill:review-adoption' })
  expect(
    await ui.find({ type: 'Text', text: `${HOME}/.claude/skills/review-adoption/SKILL.md` }),
  ).toBeUndefined()

  // Filtering narrows by name.
  await ui.input({ key: 'filter', text: 'reviewer', kind: 'change' })
  expect(await ui.find({ key: 's:Project agents:agent:reviewer' })).toBeDefined()
  expect(await ui.find({ key: 's:Project skills:skill:deploy' })).toBeUndefined()
  await ui.input({ key: 'filter', text: '', kind: 'change' })

  // The cross-project view groups by project folder, global set first.
  await ui.press({ key: 'view-projects' })
  expect(await ui.find({ key: 'p:other:skill:thing' })).toBeDefined()
  expect(await ui.find({ key: 'p:app:skill:deploy' })).toBeDefined()
  expect(await ui.find({ key: 'p:global · ~/.claude:skill:review-adoption' })).toBeDefined()
  // A project nested under a grouping folder is found and named by its path.
  expect(await ui.find({ key: 'p:Magmalabs/delivery-assistant:skill:triage' })).toBeDefined()
  // A project holding both kinds separates them with sub-headers.
  expect(await ui.find({ type: 'Text', text: 'skills · 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'agents · 1' })).toBeDefined()

  await ui.unmount()
})
