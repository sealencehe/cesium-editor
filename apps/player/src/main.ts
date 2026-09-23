// 场景预览页：只读加载当前工程。
// 开发环境从本地工程服务 /api/state 拿数据；静态导出部署时读取 BASE_URL + project/project.json。

import { SceneApp } from '@scene/runtime'
import type { ProjectState } from '@scene/schema'

async function bootstrap() {
  const host = document.getElementById('app')!
  let state: ProjectState | undefined
  let projectBase = '/project/'

  try {
    const res = await fetch('/api/state')
    if (res.ok) {
      const data = (await res.json()) as { state: ProjectState }
      state = data.state
      projectBase = '/project/'
    }
  } catch {
    /* 非 dev 环境，走静态数据 */
  }

  if (!state) {
    const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : import.meta.env.BASE_URL + '/'
    const res = await fetch(`${base}project/project.json`)
    if (!res.ok) {
      host.textContent = '无法加载场景数据（project/project.json）'
      return
    }
    const payload = (await res.json()) as { state?: ProjectState } | ProjectState
    state = (payload as { state?: ProjectState }).state ?? (payload as ProjectState)
    projectBase = `${base}project/`
  }

  const app = new SceneApp(host, state, { editing: false, projectBase })
  app.sync(state)
  app.restoreCamera()
  Object.assign(window, { __scene: app })
}

void bootstrap()
