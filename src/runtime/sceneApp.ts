// SceneApp：原生 Cesium 场景运行时。
// 职责：模型 / 3D Tiles 加载、文档 diff 同步、拾取、相机、矩阵换算。

import * as C from "cesium"
import type { ProjectState, SceneNode, Transform, Vec3 } from "../schema"
import { resolveAssetUrl } from "../storage/assets"
import { localFromWorld, nodeWorldMatrix, parentWorldMatrix, sceneFrame } from "./matrix"

interface Handle {
  ready: boolean
  primitive?: C.Model | C.Cesium3DTileset
  abort: AbortController
  signature: string
}

export class SceneApp {
  viewer: C.Viewer
  state: ProjectState
  frame = C.Matrix4.clone(C.Matrix4.IDENTITY)
  handles = new Map<string, Handle>()

  onObjectClick: (nodeId: string | undefined) => void = () => {}
  onNodeReady: (id: string) => void = () => {}
  onError: (message: string) => void = () => {}

  private handler: C.ScreenSpaceEventHandler
  private destroyed = false

  constructor(container: HTMLElement, state: ProjectState) {
    this.state = state
    this.viewer = new C.Viewer(container, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      baseLayer: new C.ImageryLayer(
        new C.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
      ),
      terrainProvider: new C.EllipsoidTerrainProvider(),
      scene3DOnly: true,
      requestRenderMode: true,
    })
    const scene = this.viewer.scene
    scene.globe.baseColor = C.Color.fromCssColorString("#2b3038")
    scene.globe.depthTestAgainstTerrain = true
    ;(this.viewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none'

    this.handler = new C.ScreenSpaceEventHandler(scene.canvas)
    this.handler.setInputAction((e: C.ScreenSpaceEventHandler.PositionedEvent) => {
      this.handleClick(e.position)
    }, C.ScreenSpaceEventType.LEFT_CLICK)
  }

  private handleClick(position: C.Cartesian2): void {
    const picked = this.viewer.scene.pick(position)
    // gizmo 手柄的 GeometryInstance id 带 axis 字段，忽略这类点击
    if (picked && typeof picked.id === "object" && picked.id && "axis" in picked.id) return
    let id: string | undefined = typeof picked?.id === "string" ? picked.id : undefined
    if (!id && picked) {
      for (const [key, h] of this.handles) {
        if (h.primitive && (h.primitive === picked.primitive || h.primitive === picked.tileset)) {
          id = key
          break
        }
      }
    }
    this.onObjectClick(id)
  }

  // ---------- 同步 ----------

  private signature(node: SceneNode): string {
    const asset = node.assetId ? this.state.assets.find((a) => a.id === node.assetId) : undefined
    return JSON.stringify([node.type, node.assetId ?? "", asset?.revision ?? 0, asset?.uri ?? ""])
  }

  sync(state: ProjectState): void {
    this.state = state
    this.frame = sceneFrame(state.scene.anchor)
    const seen = new Set<string>()
    for (const node of state.scene.nodes) {
      seen.add(node.id)
      this.syncNode(node)
    }
    for (const id of [...this.handles.keys()]) {
      if (!seen.has(id)) this.destroyHandle(id)
    }
    this.requestRender()
  }

  private syncNode(node: SceneNode): void {
    const sig = this.signature(node)
    const existing = this.handles.get(node.id)
    if (existing && existing.signature === sig) {
      this.applyNodeState(node)
      return
    }
    if (existing) this.destroyHandle(node.id)
    const handle: Handle = { ready: node.type === "group", abort: new AbortController(), signature: sig }
    this.handles.set(node.id, handle)
    if (node.type === "group") return
    this.loadPrimitive(node, handle, sig).catch((err: unknown) => {
      if (this.destroyed || handle.abort.signal.aborted) return
      if (this.handles.get(node.id) !== handle) return
      this.onError(`${node.name} 加载失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private async loadPrimitive(node: SceneNode, handle: Handle, sig: string): Promise<void> {
    const asset = this.state.assets.find((a) => a.id === node.assetId)
    if (!asset) throw new Error("资源不存在")
    const url = await resolveAssetUrl(asset)
    if (this.destroyed || handle.abort.signal.aborted || this.handles.get(node.id) !== handle) return

    if (node.type === "model") {
      const model = await C.Model.fromGltfAsync({
        url,
        modelMatrix: nodeWorldMatrix(this.state, node),
        id: node.id,
      })
      if (this.destroyed || this.handles.get(node.id) !== handle || handle.signature !== sig) {
        this.viewer.scene.primitives.remove(model)
        return
      }
      this.viewer.scene.primitives.add(model)
      handle.primitive = model
      model.show = node.visible
      handle.ready = true
      this.onNodeReady(node.id)
      this.requestRender()
      return
    }

    const tileset = await C.Cesium3DTileset.fromUrl(url)
    if (this.destroyed || this.handles.get(node.id) !== handle || handle.signature !== sig) {
      tileset.destroy()
      return
    }
    this.viewer.scene.primitives.add(tileset)
    handle.primitive = tileset
    // 节点变换相对场景锚点；modelMatrix 叠加在 tileset 自身定位之上
    tileset.modelMatrix = this.tilesetMatrix(node)
    tileset.show = node.visible
    handle.ready = true
    this.onNodeReady(node.id)
    this.requestRender()
  }

  /** 文档值 → 运行时（签名未变化时被 sync 调用） */
  private applyNodeState(node: SceneNode): void {
    const handle = this.handles.get(node.id)
    if (!handle?.primitive) return
    if (node.type === "tileset") {
      ;(handle.primitive as C.Cesium3DTileset).modelMatrix = this.tilesetMatrix(node)
    } else {
      ;(handle.primitive as C.Model).modelMatrix = nodeWorldMatrix(this.state, node)
    }
    handle.primitive.show = node.visible
  }

  private tilesetMatrix(node: SceneNode): C.Matrix4 {
    const world = nodeWorldMatrix(this.state, node)
    return C.Matrix4.multiply(world, C.Matrix4.inverse(this.frame, new C.Matrix4()), new C.Matrix4())
  }

  private destroyHandle(id: string): void {
    const handle = this.handles.get(id)
    if (!handle) return
    handle.abort.abort()
    if (handle.primitive) this.viewer.scene.primitives.remove(handle.primitive)
    this.handles.delete(id)
    this.requestRender()
  }

  requestRender(): void {
    if (!this.destroyed) this.viewer.scene.requestRender()
  }

  // ---------- 变换读取（供 gizmo 提交用） ----------

  /** 从 primitive 当前矩阵（gizmo 拖拽后）反推文档局部 TRS */
  nodeTransformFromPrimitive(id: string): Transform | null {
    const handle = this.handles.get(id)
    const node = this.state.scene.nodes.find((n) => n.id === id)
    if (!handle?.primitive || !node) return null
    const matrix = handle.primitive.modelMatrix
    const world =
      node.type === "tileset"
        ? C.Matrix4.multiply(matrix, this.frame, new C.Matrix4())
        : C.Matrix4.clone(matrix)
    return localFromWorld(this.state, node.parentId ?? null, world)
  }

  worldMatrixOf(node: SceneNode): C.Matrix4 {
    return nodeWorldMatrix(this.state, node)
  }

  localFromWorldOf(parentId: string | null, world: C.Matrix4): Transform {
    return localFromWorld(this.state, parentId, world)
  }

  // ---------- 相机 ----------

  focus(id?: string): void {
    if (!id) {
      this.restoreCamera()
      return
    }
    const handle = this.handles.get(id)
    const node = this.state.scene.nodes.find((n) => n.id === id)
    if (!node) return
    let sphere: C.BoundingSphere | undefined = handle?.primitive?.boundingSphere
    if (!sphere) {
      sphere = new C.BoundingSphere(
        C.Matrix4.getTranslation(nodeWorldMatrix(this.state, node), new C.Cartesian3()),
        node.type === "group" ? 60 : 40,
      )
    }
    this.viewer.camera.flyToBoundingSphere(sphere, { duration: 0.7 })
  }

  restoreCamera(): void {
    const cam = this.state.scene.camera
    this.viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(cam.position[0], cam.position[1], cam.position[2]),
      orientation: {
        heading: C.Math.toRadians(cam.heading),
        pitch: C.Math.toRadians(cam.pitch),
        roll: C.Math.toRadians(cam.roll),
      },
    })
    this.requestRender()
  }

  captureCamera(): { position: Vec3; heading: number; pitch: number; roll: number } {
    const cam = this.viewer.camera
    const carto = cam.positionCartographic
    return {
      position: [C.Math.toDegrees(carto.longitude), C.Math.toDegrees(carto.latitude), carto.height],
      heading: C.Math.toDegrees(cam.heading),
      pitch: C.Math.toDegrees(cam.pitch),
      roll: C.Math.toDegrees(cam.roll),
    }
  }

  /** 屏幕坐标 → 椭球面世界坐标 */
  pickPosition(screenX: number, screenY: number): C.Cartesian3 | null {
    const ray = this.viewer.camera.getPickRay(new C.Cartesian2(screenX, screenY))
    if (!ray) return null
    return this.viewer.scene.globe.pick(ray, this.viewer.scene) ?? null
  }

  /** 世界坐标点 → 指定父级下的局部位置（用于拖放置放，只做平移） */
  worldPointToLocal(parentId: string | null, world: C.Cartesian3): Vec3 {
    const inv = C.Matrix4.inverse(parentWorldMatrix(this.state, parentId), new C.Matrix4())
    const p = C.Matrix4.multiplyByPoint(inv, world, new C.Cartesian3())
    return [p.x, p.y, p.z]
  }

  destroy(): void {
    this.destroyed = true
    this.handler.destroy()
    for (const id of [...this.handles.keys()]) this.destroyHandle(id)
    this.viewer.destroy()
  }
}
