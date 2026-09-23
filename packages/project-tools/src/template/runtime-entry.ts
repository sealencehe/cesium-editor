// 独立运行时入口：esbuild 打包进导出的源码工程（runtime.js）。
// 对外只暴露 loadScene，cesium 作为外部依赖由工程自身安装。

import { SceneApp } from "@scene/runtime"
import type { ProjectState } from "@scene/schema"

export interface SceneHandle {
  focus(id?: string): void
  destroy(): void
}

export async function loadScene(
  container: HTMLElement,
  state: ProjectState,
  projectBase: string,
): Promise<SceneHandle> {
  const app = new SceneApp(container, state, { editing: false, projectBase })
  app.sync(state)
  app.restoreCamera()
  return {
    focus: (id?: string) => app.focus(id),
    destroy: () => app.destroy(),
  }
}
