// EditorGizmo：cesium-transform-gizmo(npm 0.1.1) 的编辑器适配层。
// npm 版只有 onUpdate 回调、且只对真实 Model / Cesium3DTileset 写矩阵，
// 因此这里绑定真实 primitive，并用 pointerdown / pointerup 自己合成
// 拖拽事务边界：一次拖拽只产生一条历史记录。

import { TransformGizmo } from "cesium-transform-gizmo"
import type { SceneApp } from "@scene/runtime"
import type { SceneNode, Transform } from "@scene/schema"
import { clone } from "@scene/schema"
import { transformsEqual } from "@scene/runtime"

export type GizmoMode = "translate" | "rotate" | "scale"

const BUSY_WINDOW_MS = 180

export class EditorGizmo {
  private gizmo: TransformGizmo
  private app: SceneApp
  private commit: (id: string, transform: Transform) => void

  private nodeId: string | null = null
  private before: Transform | null = null
  private dragging = false
  private armed = false
  private committedAt = 0
  private cameraLock: { zoom: boolean; tilt: boolean } | null = null

  /** 拖拽过程中的实时变换（供属性面板展示） */
  onLive: (id: string, transform: Transform) => void = () => {}

  /** 拖拽结束（提交或取消） */
  onLiveEnd: () => void = () => {}

  constructor(app: SceneApp, commit: (id: string, transform: Transform) => void) {
    this.app = app
    this.commit = commit
    this.gizmo = new TransformGizmo({
      viewer: app.viewer,
      mode: "translate",
      onUpdate: () => this.handleUpdate(),
    })
    const canvas = app.viewer.scene.canvas as HTMLCanvasElement
    canvas.addEventListener("pointerdown", () => {
      this.armed = true
    })
    window.addEventListener("pointerup", () => this.handleUp())
    window.addEventListener("blur", () => this.cancel())
  }

  get busy(): boolean {
    return this.dragging || performance.now() - this.committedAt < BUSY_WINDOW_MS
  }

  get draggingNow(): boolean {
    return this.dragging
  }

  setMode(mode: GizmoMode): void {
    this.gizmo.mode = mode
    this.app.requestRender()
  }

  /** 绑定选中节点；分组节点不绑定 gizmo */
  bind(node: SceneNode | null | undefined): void {
    this.gizmo.detach()
    this.nodeId = null
    if (!node) {
      this.app.requestRender()
      return
    }
    const handle = this.app.handles.get(node.id)
    if (!handle?.ready || !handle.primitive || node.type === "group") {
      this.app.requestRender()
      return
    }
    this.nodeId = node.id
    this.gizmo.bindObject(handle.primitive)
  }

  private docTransform(): Transform | null {
    if (!this.nodeId) return null
    const node = this.app.state.scene.nodes.find((n) => n.id === this.nodeId)
    return node ? clone(node.transform) : null
  }

  private handleUpdate(): void {
    if (!this.nodeId) return
    if (!this.dragging) {
      // bindObject 会立即触发一次 onUpdate（当前状态），不是拖拽
      if (!this.armed) return
      this.dragging = true
      this.before = this.docTransform()
      this.lockCamera(true)
    }
    const live = this.app.nodeTransformFromPrimitive(this.nodeId)
    if (live) this.onLive(this.nodeId, live)
  }

  private handleUp(): void {
    if (this.dragging) {
      this.lockCamera(false)
      const id = this.nodeId
      const final = id ? this.app.nodeTransformFromPrimitive(id) : null
      this.dragging = false
      if (id && final && this.before && !transformsEqual(this.before, final)) {
        this.commit(id, final)
      } else if (id) {
        // 未产生变化时把 primitive 拉回文档值，消除浮点漂移
        this.applyDocTransform(id)
      }
      this.committedAt = performance.now()
      this.before = null
      this.onLiveEnd()
    }
    this.armed = false
    // 指针在画布外松开时 gizmo 自身的 LEFT_UP 不会触发，手动收尾
    this.forceInternalUp()
  }

  /** Esc / 窗口失焦：取消本次拖拽并复位 */
  cancel(): void {
    if (!this.dragging) return
    this.lockCamera(false)
    const id = this.nodeId
    this.dragging = false
    this.before = null
    this.onLiveEnd()
    this.forceInternalUp()
    if (id) {
      this.applyDocTransform(id)
      const node = this.app.state.scene.nodes.find((n) => n.id === id)
      this.gizmo.detach()
      if (node) this.bind(node)
    }
  }

  private applyDocTransform(id: string): void {
    const node = this.app.state.scene.nodes.find((n) => n.id === id)
    if (!node) return
    this.app.sync(this.app.state)
  }

  private forceInternalUp(): void {
    try {
      ;(this.gizmo as unknown as { handleUp?: () => void }).handleUp?.()
    } catch {
      /* 忽略：内部方法不可用时依赖其自身 LEFT_UP */
    }
  }

  private lockCamera(lock: boolean): void {
    const controller = this.app.viewer.scene.screenSpaceCameraController
    if (lock) {
      this.cameraLock = { zoom: controller.enableZoom, tilt: controller.enableTilt }
      controller.enableZoom = false
      controller.enableTilt = false
    } else if (this.cameraLock) {
      controller.enableZoom = this.cameraLock.zoom
      controller.enableTilt = this.cameraLock.tilt
      this.cameraLock = null
    }
  }

  destroy(): void {
    this.gizmo.destroy()
  }
}
