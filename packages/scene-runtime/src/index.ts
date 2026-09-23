// SceneApp：原生 Cesium 场景运行时（编辑器与预览页共用）。
// 职责：模型 / 3D Tiles 加载、文档 diff 同步、地图图层与地形、拾取、相机、矩阵换算。

import * as C from "cesium"
import type { Asset, ImageryLayerConfig, ProjectState, SceneNode, TerrainConfig, Transform, Vec3 } from "@scene/schema"
import { localFromWorld, nodeWorldMatrix, parentWorldMatrix, sceneFrame, transformsEqual } from "./matrix"

export { transformsEqual }

interface ManagedImagery {
  id: string
  name: string
  /** undefined = 异步加载中或未配置（token / 资产 id 待填） */
  layer?: C.ImageryLayer
  /** 参与加载的配置签名，变化时重建图层 */
  signature: string
}

interface Handle {
  ready: boolean
  primitive?: C.Model | C.Cesium3DTileset
  abort: AbortController
  signature: string
}

export interface SceneAppOptions {
  /** 编辑模式：开启点击拾取；预览页设为 false */
  editing?: boolean
  /** 工程静态资源前缀，默认 /project/（由本地服务或部署目录提供） */
  projectBase?: string
}

/** 资源 URI → 可加载地址：http(s) 原样，工程相对路径拼上 projectBase */
export function assetUrl(asset: Asset, projectBase: string): string {
  if (/^https?:\/\//i.test(asset.uri)) return asset.uri
  return projectBase.replace(/\/$/, "") + "/" + asset.uri.replace(/^\//, "")
}

const SELECT_COLOR = C.Color.fromCssColorString("#ffd04b")
const SELECT_SILHOUETTE_SIZE = 3

export class SceneApp {
  viewer: C.Viewer
  state: ProjectState
  frame = C.Matrix4.clone(C.Matrix4.IDENTITY)
  handles = new Map<string, Handle>()
  editing: boolean
  projectBase: string

  onObjectClick: (nodeId: string | undefined) => void = () => {}
  onNodeReady: (id: string) => void = () => {}
  onError: (message: string) => void = () => {}

  private handler: C.ScreenSpaceEventHandler
  private destroyed = false

  // 地图图层 / 地形状态
  private mapLayers: ManagedImagery[] = []
  private imagerySignature = ""
  private terrainSignature = ""
  private terrainPending = false
  private appliedBaseToken = ""
  private baseSwapping = false

  constructor(container: HTMLElement, state: ProjectState, options: SceneAppOptions = {}) {
    this.state = state
    this.editing = options.editing ?? true
    this.projectBase = options.projectBase ?? "/project/"
    const env = (import.meta as { env?: Record<string, string | undefined> }).env
    const globalScope = typeof window !== "undefined" ? (window as unknown as { CESIUM_ION_TOKEN?: string }) : undefined
    const ionToken = env?.VITE_CESIUM_ION_TOKEN ?? globalScope?.CESIUM_ION_TOKEN
    if (ionToken) C.Ion.defaultAccessToken = ionToken
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
      terrainProvider: new C.EllipsoidTerrainProvider(),
      scene3DOnly: true,
      requestRenderMode: true,
    })
    const scene = this.viewer.scene
    scene.globe.baseColor = C.Color.fromCssColorString("#2b3038")
    scene.globe.depthTestAgainstTerrain = true
    ;(this.viewer.cesiumWidget.creditContainer as HTMLElement).style.display = "none"

    this.handler = new C.ScreenSpaceEventHandler(scene.canvas)
    this.handler.setInputAction((e: C.ScreenSpaceEventHandler.PositionedEvent) => {
      this.handleClick(e.position)
    }, C.ScreenSpaceEventType.LEFT_CLICK)
  }

  private handleClick(position: C.Cartesian2): void {
    if (!this.editing) return
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

  // ---------- 节点同步 ----------

  private nodeSignature(node: SceneNode): string {
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
    const base = this.viewer.imageryLayers.get(0)
    if (base) base.show = state.scene.baseMapShow ?? true
    this.syncImagery(state.scene.imageryLayers ?? [])
    this.swapBaseMapToken(state.scene.baseMapIonToken)
    this.syncTerrain(state.scene.terrain)
    this.requestRender()
  }

  private syncNode(node: SceneNode): void {
    const sig = this.nodeSignature(node)
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
    const url = assetUrl(asset, this.projectBase)

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
      // fromGltfAsync 完成时模型尚未渲染首帧，boundingSphere 要等 ready 后才可读
      const ready = await this.waitModelReady(model)
      if (this.destroyed || this.handles.get(node.id) !== handle || handle.signature !== sig) return
      if (!ready) throw new Error("模型就绪超时")
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

  /** 等待模型完成首帧更新（_ready），requestRenderMode 下主动驱动渲染 */
  private waitModelReady(model: C.Model, timeoutMs = 15000): Promise<boolean> {
    return new Promise((resolve) => {
      if (model.ready) {
        resolve(true)
        return
      }
      let done = false
      let poll: ReturnType<typeof setInterval> | undefined
      let timeout: ReturnType<typeof setTimeout> | undefined
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        if (poll) clearInterval(poll)
        if (timeout) clearTimeout(timeout)
        removeReadyListener()
        resolve(ok)
      }
      const removeReadyListener = model.readyEvent.addEventListener(() => finish(true))
      poll = setInterval(() => {
        if (model.ready) finish(true)
        else this.requestRender()
      }, 50)
      timeout = setTimeout(() => finish(model.ready), timeoutMs)
    })
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

  /** 选中高亮：模型用 Cesium 原生模板描边（只描外轮廓，不含内部结构） */
  setSelected(id: string | null): void {
    for (const [hid, h] of this.handles) {
      const model = h.primitive
      if (model instanceof C.Model) {
        model.silhouetteColor = SELECT_COLOR
        model.silhouetteSize = hid === id ? SELECT_SILHOUETTE_SIZE : 0
      }
    }
    this.requestRender()
  }

  // ---------- 地图图层 / 地形 ----------

  private static loadSignature(cfg: ImageryLayerConfig): string {
    return JSON.stringify([
      cfg.kind ?? "url-template",
      cfg.url,
      cfg.subdomains,
      cfg.maximumLevel,
      cfg.credit,
      cfg.ionToken,
      cfg.ionAssetId,
    ])
  }

  /** 创建图层（ion 异步；未配置 token / id 时返回 null，等待右侧面板补齐） */
  private async createImageryLayer(cfg: ImageryLayerConfig): Promise<C.ImageryLayer | null> {
    try {
      if (cfg.kind === "ion-imagery") {
        if (!cfg.ionToken || !cfg.ionAssetId) return null
        const provider = await C.IonImageryProvider.fromAssetId(cfg.ionAssetId, {
          accessToken: cfg.ionToken,
        })
        if (this.destroyed) return null
        return this.viewer.imageryLayers.addImageryProvider(provider)
      }
      if (!cfg.url) return null
      const provider = new C.UrlTemplateImageryProvider({
        url: cfg.url,
        subdomains: cfg.subdomains || "abc",
        maximumLevel: cfg.maximumLevel,
        credit: cfg.credit,
      })
      return this.viewer.imageryLayers.addImageryProvider(provider)
    } catch (err) {
      this.onError(`地图图层 ${cfg.name} 加载失败：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /** 文档图层配置 → 运行时：按 id + 加载签名增量同步，显隐切换不重建 */
  private syncImagery(configs: ImageryLayerConfig[]): void {
    const signature = JSON.stringify(configs)
    if (signature !== this.imagerySignature) {
      this.imagerySignature = signature
      const existing = new Map(this.mapLayers.map((m) => [m.id, m]))
      const next: ManagedImagery[] = []
      for (const cfg of configs) {
        const loadSig = SceneApp.loadSignature(cfg)
        const kept = existing.get(cfg.id)
        if (kept && kept.signature === loadSig) {
          kept.name = cfg.name
          if (kept.layer) kept.layer.show = cfg.show
          existing.delete(cfg.id)
          next.push(kept)
          continue
        }
        if (kept?.layer) this.viewer.imageryLayers.remove(kept.layer, true)
        existing.delete(cfg.id)
        const managed: ManagedImagery = { id: cfg.id, name: cfg.name, signature: loadSig }
        next.push(managed)
        void this.createImageryLayer(cfg).then((layer) => {
          if (this.destroyed) {
            if (layer) this.viewer.imageryLayers.remove(layer, true)
            return
          }
          const current = (this.state.scene.imageryLayers ?? []).find((c) => c.id === cfg.id)
          if (!current || SceneApp.loadSignature(current) !== loadSig) {
            if (layer) this.viewer.imageryLayers.remove(layer, true)
            return
          }
          managed.layer = layer ?? undefined
          if (managed.layer) managed.layer.show = current.show
          this.reorderImagery()
          this.requestRender()
        })
      }
      for (const [, m] of existing) {
        if (m.layer) this.viewer.imageryLayers.remove(m.layer, true)
      }
      this.mapLayers = next
    }
    this.reorderImagery()
    this.requestRender()
  }

  /** 图层顺序与配置一致（底图保持在最底层，索引 0） */
  private reorderImagery(): void {
    const configs = this.state.scene.imageryLayers ?? []
    const collection = this.viewer.imageryLayers
    for (let target = configs.length - 1; target >= 0; target--) {
      const managed = this.mapLayers.find((m) => m.id === configs[target]!.id)
      if (!managed?.layer) continue
      let guard = 0
      while (collection.indexOf(managed.layer) > target + 1 && guard++ < 64) {
        collection.lower(managed.layer)
      }
    }
  }

  /** 默认底图（Bing 影像）显隐 */
  setBaseMapShow(show: boolean): void {
    const base = this.viewer.imageryLayers.get(0)
    if (base) base.show = show
    this.requestRender()
  }

  /** 替换默认底图的 ion 令牌（不填恢复 Cesium 默认令牌） */
  swapBaseMapToken(token: string | undefined): void {
    const desired = token ?? ""
    if (desired === this.appliedBaseToken || this.baseSwapping) return
    this.baseSwapping = true
    void (async () => {
      try {
        const provider = await C.IonImageryProvider.fromAssetId(2, desired ? { accessToken: desired } : {})
        if (this.destroyed) return
        const layers = this.viewer.imageryLayers
        const old = layers.get(0)
        const added = layers.addImageryProvider(provider, 0)
        added.show = old ? old.show : true
        if (old) layers.remove(old, true)
        this.appliedBaseToken = desired
        this.requestRender()
      } catch (err) {
        this.onError(`底图加载失败：${err instanceof Error ? err.message : String(err)}（检查 ion 令牌）`)
      } finally {
        this.baseSwapping = false
      }
    })()
  }

  private syncTerrain(cfg: TerrainConfig | undefined): void {
    const signature = JSON.stringify(cfg ?? { kind: "ellipsoid" })
    if (signature === this.terrainSignature) return
    this.terrainSignature = signature
    if (!cfg || cfg.kind === "ellipsoid" || !cfg.ionToken) {
      this.viewer.terrainProvider = new C.EllipsoidTerrainProvider()
      this.requestRender()
      return
    }
    if (this.terrainPending) return
    this.terrainPending = true
    const wanted = signature
    void (async () => {
      try {
        const resource = await C.IonResource.fromAssetId(cfg.ionAssetId ?? 1, { accessToken: cfg.ionToken })
        const provider = await C.CesiumTerrainProvider.fromUrl(resource)
        if (this.destroyed || wanted !== this.terrainSignature) return
        this.viewer.terrainProvider = provider
        this.requestRender()
      } catch (err) {
        this.onError(`ion 地形加载失败：${err instanceof Error ? err.message : String(err)}（检查令牌与资产 id）`)
      } finally {
        this.terrainPending = false
      }
    })()
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
    let sphere: C.BoundingSphere | undefined
    try {
      if ((handle?.primitive as C.Model | undefined)?.ready !== false)
        sphere = handle?.primitive?.boundingSphere
    } catch {
      sphere = undefined // 模型尚未就绪时 boundingSphere 会抛错，退回矩阵中心
    }
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
