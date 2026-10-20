export type AtlasItem = {
  name: string
  description: string
  kind: 'skill' | 'agent'
  /** 'project' | 'global' | 'plugin:<plugin-name>' */
  scope: string
  /** Absolute path of the SKILL.md / agent .md behind the entry */
  path: string
}

export type AtlasGroup = { label: string; items: AtlasItem[] }

export type ProjectGroup = { project: string; items: AtlasItem[] }

declare module 'claude-code' {
  interface PluginState {
    'skill-atlas': {
      view: 'session' | 'projects'
      filter: string
      /** Addresses of entries showing their full description */
      expanded: string[]
      session: AtlasGroup[]
      projects: ProjectGroup[]
      scannedAt: number
    }
  }
}
