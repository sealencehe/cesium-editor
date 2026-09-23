// 场景文档模型。
// 节点变换 = 锚点 ENU 坐标系下的局部 TRS（位置米 / 旋转 HPR 度 / 缩放）。

export type Vec3 = [number, number, number]

export interface Transform {
  /** 相对父级（根节点为场景锚点）的米制偏移 */
  position: Vec3
  /** 局部航向 / 俯仰 / 翻滚，单位度 */
  rotation: Vec3
  scale: Vec3
}

export type AssetType = "model" | "tileset" | "prefab"

export interface Asset {
  id: string
  name: string
  type: AssetType
  /** 工程相对路径（assets/files/<id>/<入口>）或 http(s) 地址 */
  uri: string
  folder: string
  tags: string[]
  revision: number
  thumbnail?: string
  /** 本地导入时随资源一起入库的相对路径清单 */
  files?: string[]
  /** 预制体载荷 */
  data?: { nodes: SceneNode[] }
}

export type SceneNodeType = "group" | "model" | "tileset"

export interface SceneNode {
  id: string
  name: string
  type: SceneNodeType
  visible: boolean
  transform: Transform
  parentId: string | null
  assetId?: string
}

/** position 为 [经度, 纬度, 高度]（度 / 米），姿态为度 */
export interface SceneCamera {
  position: Vec3
  heading: number
  pitch: number
  roll: number
}

export interface SceneDocument {
  version: 1
  id: string
  name: string
  /** 场景锚点 [经度, 纬度, 高度]（度 / 米） */
  anchor: Vec3
  nodes: SceneNode[]
  camera: SceneCamera
  /** 自定义地图图层（叠加在默认底图之上，数组顺序即图层顺序） */
  imageryLayers?: ImageryLayerConfig[]
  /** 默认底图（Bing 影像）是否可见，缺省为 true */
  baseMapShow?: boolean
  /** 默认底图的自定义 ion 令牌（不填用 Cesium 默认令牌） */
  baseMapIonToken?: string
  /** 场景地形配置，缺省为椭球 */
  terrain?: TerrainConfig
}

export type MapLayerKind = "url-template" | "ion-imagery"

export interface ImageryLayerConfig {
  id: string
  name: string
  show: boolean
  /** 缺省视为 url-template（旧工程兼容） */
  kind?: MapLayerKind
  /** URL 模板，支持 {x} {y} {z} {s} 占位（kind=url-template） */
  url?: string
  /** {s} 子域字符集，如 "abc" / "1234" */
  subdomains?: string
  /** 最大缩放级别 */
  maximumLevel?: number
  /** 版权说明 */
  credit?: string
  /** ion 访问令牌（kind=ion-imagery，在右侧面板填写） */
  ionToken?: string
  /** ion 影像资产 id（kind=ion-imagery） */
  ionAssetId?: number
}

/** 场景地形配置（最多一个） */
export interface TerrainConfig {
  kind: "ellipsoid" | "ion"
  /** ion 访问令牌（kind=ion，在右侧面板填写） */
  ionToken?: string
  /** ion 地形资产 id，缺省 1 = Cesium World Terrain */
  ionAssetId?: number
}

export interface ProjectState {
  project: { version: 1; name: string }
  scene: SceneDocument
  assets: Asset[]
}

export function uid(prefix = ""): string {
  return (
    prefix +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36).slice(-4)
  )
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function defaultTransform(): Transform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
}

export function newProject(name = "未命名工程"): ProjectState {
  return {
    project: { version: 1, name },
    scene: {
      version: 1,
      id: "main",
      name: "主场景",
      anchor: [104.0668, 30.5728, 0],
      nodes: [],
      camera: { position: [104.0668, 30.57, 450], heading: 0, pitch: -55, roll: 0 },
    },
    assets: [],
  }
}

const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v)

function validTransform(t: Transform): boolean {
  return (
    Array.isArray(t.position) &&
    t.position.length === 3 &&
    t.position.every(finite) &&
    Array.isArray(t.rotation) &&
    t.rotation.length === 3 &&
    t.rotation.every(finite) &&
    Array.isArray(t.scale) &&
    t.scale.length === 3 &&
    t.scale.every((v) => finite(v) && v > 0)
  )
}

/** 返回错误消息，合法时返回 null；写入历史前调用 */
export function validateProject(state: ProjectState): string | null {
  if (!state || !state.scene || !Array.isArray(state.scene.nodes)) return "场景文档结构无效"
  const nodes = state.scene.nodes
  const assets = Array.isArray(state.assets) ? state.assets : []
  const nodeIds = new Set<string>()
  for (const n of nodes) {
    if (!n.id || nodeIds.has(n.id)) return `节点 id 重复或为空：${n.id ?? ""}`
    nodeIds.add(n.id)
    if (!["group", "model", "tileset"].includes(n.type)) return `未知节点类型：${n.type}`
    if (!validTransform(n.transform)) return `节点 ${n.name} 的变换数值无效`
    if (n.type === "group") {
      const [sx, sy, sz] = n.transform.scale
      if (Math.abs(sx - sy) > 1e-6 || Math.abs(sy - sz) > 1e-6)
        return `分组 ${n.name} 必须使用等比缩放`
    }
    if (n.type !== "group") {
      if (!n.assetId) return `节点 ${n.name} 缺少资源引用`
      const asset = assets.find((a) => a.id === n.assetId)
      if (!asset) return `节点 ${n.name} 引用了不存在的资源`
      if (asset.type !== n.type) return `节点 ${n.name} 与资源 ${asset.name} 类型不匹配`
    }
  }
  for (const n of nodes) {
    if (n.parentId === null || n.parentId === undefined) continue
    const parent = nodes.find((p) => p.id === n.parentId)
    if (!parent) return `节点 ${n.name} 的分组不存在`
    if (parent.type !== "group") return `节点 ${n.name} 的父级必须是分组`
  }
  // 环检测
  for (const n of nodes) {
    const seen = new Set<string>([n.id])
    let cur = n.parentId
    while (cur) {
      if (seen.has(cur)) return `节点 ${n.name} 的分组关系存在循环`
      seen.add(cur)
      cur = nodes.find((p) => p.id === cur)?.parentId ?? null
    }
  }
  const assetIds = new Set<string>()
  for (const a of assets) {
    if (!a.id || assetIds.has(a.id)) return `资源 id 重复或为空`
    assetIds.add(a.id)
    if (!["model", "tileset", "prefab"].includes(a.type)) return `未知资源类型：${a.type}`
    if (!a.uri) return `资源 ${a.name} 缺少地址`
    if (!/^https?:\/\//i.test(a.uri) && (a.uri.includes("..") || a.uri.startsWith("/")))
      return `资源 ${a.name} 的地址必须是 http(s) 或工程相对路径`
  }
  if (!validTransform({ position: state.scene.anchor, rotation: [0, 0, 0], scale: [1, 1, 1] }))
    return "场景锚点数值无效"
  const layerIds = new Set<string>()
  for (const layer of state.scene.imageryLayers ?? []) {
    if (!layer.id || layerIds.has(layer.id)) return `地图图层 id 重复或为空`
    layerIds.add(layer.id)
    if (!layer.name) return `地图图层缺少名称`
    if (layer.kind === "ion-imagery") {
      if (layer.ionAssetId !== undefined && !Number.isFinite(layer.ionAssetId)) return `地图图层 ${layer.name} 的资产 id 无效`
    } else {
      if (!layer.url) return `地图图层 ${layer.name} 缺少地址`
      if (layer.url.includes("..")) return `地图图层 ${layer.name} 的地址不允许包含 ..`
    }
  }
  const terrain = state.scene.terrain
  if (terrain && !["ellipsoid", "ion"].includes(terrain.kind)) return "未知地形类型"
  if (terrain?.ionAssetId !== undefined && !Number.isFinite(terrain.ionAssetId)) return "地形资产 id 无效"
  if (state.scene.baseMapShow !== undefined && typeof state.scene.baseMapShow !== "boolean")
    return "默认底图可见性取值无效"
  return null
}

/** 深度优先的节点顺序（用于层级列表缩进） */
export function orderedNodes(state: ProjectState): Array<{ node: SceneNode; depth: number }> {
  const byParent = new Map<string | null, SceneNode[]>()
  for (const n of state.scene.nodes) {
    const key = n.parentId ?? null
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(n)
  }
  const out: Array<{ node: SceneNode; depth: number }> = []
  const visit = (parent: string | null, depth: number) => {
    for (const n of byParent.get(parent) ?? []) {
      out.push({ node: n, depth })
      visit(n.id, depth + 1)
    }
  }
  visit(null, 0)
  for (const n of state.scene.nodes) {
    if (!out.some((o) => o.node.id === n.id)) out.push({ node: n, depth: 0 })
  }
  return out
}

/** 收集 id 及其全部后代 */
export function nodeDescendants(state: ProjectState, id: string): string[] {
  const out: string[] = []
  const walk = (pid: string) => {
    for (const n of state.scene.nodes) {
      if (n.parentId === pid) {
        out.push(n.id)
        walk(n.id)
      }
    }
  }
  walk(id)
  return out
}

/** 引用某资源的节点（含预制体内嵌引用） */
export function assetReferences(state: ProjectState, assetId: string): string[] {
  const out: string[] = []
  for (const n of state.scene.nodes) if (n.assetId === assetId) out.push(n.name)
  for (const a of state.assets) {
    if (a.type === "prefab" && a.data?.nodes?.some((n) => n.assetId === assetId))
      out.push(`预制体 ${a.name}`)
  }
  return out
}
