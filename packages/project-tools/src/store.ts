// 本地工程存储：projects/<name>/ 目录结构
//   project.json + scenes/main.scene.json + assets/catalog.json + assets/files/<assetId>/…
// 写入均为 tmp+rename 原子操作，保存走串行队列。

import fs from "node:fs"
import path from "node:path"
import { newProject, uid, validateProject, type Asset, type ProjectState } from "../../scene-schema/src/index"

export interface IncomingFile {
  path: string
  data: Buffer
}

export interface ImportEntry {
  path: string
  type: "model" | "tileset"
}

const IMPORT_EXTENSIONS = new Set([
  "glb", "gltf", "bin", "png", "jpg", "jpeg", "webp", "ktx2", "json",
  "b3dm", "i3dm", "pnts", "cmpt",
])

export function normalizePath(p: string): string {
  const out: string[] = []
  for (const part of p.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out.join("/")
}

function dirName(p: string): string {
  const i = p.lastIndexOf("/")
  return i === -1 ? "" : p.slice(0, i)
}

const isAbsoluteUri = (uri: string) => /^(data:|https?:|blob:)/i.test(uri)

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  fs.writeFileSync(tmp, content, "utf8")
  fs.renameSync(tmp, file)
}

export class ProjectStore {
  readonly projectsDir: string
  readonly exportsDir: string
  activeName = ""
  revision = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(rootDir: string) {
    this.projectsDir = path.join(rootDir, "projects")
    this.exportsDir = path.join(rootDir, ".exports")
    fs.mkdirSync(this.projectsDir, { recursive: true })
  }

  private dir(name = this.activeName): string {
    return path.join(this.projectsDir, name)
  }

  /** 启动时确定活动工程；不存在则创建默认工程 */
  openInitial(): ProjectState {
    const names = fs
      .readdirSync(this.projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(this.projectsDir, d.name, "project.json")))
      .map((d) => d.name)
    if (!names.length) {
      const state = newProject("默认工程")
      this.activeName = state.project.name
      this.writeAll(state)
      return state
    }
    this.activeName = names[0]!
    return this.readAll()
  }

  listProjects(): Array<{ name: string; updatedAt: number }> {
    if (!fs.existsSync(this.projectsDir)) return []
    return fs
      .readdirSync(this.projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(this.projectsDir, d.name, "project.json")))
      .map((d) => {
        const stat = fs.statSync(path.join(this.projectsDir, d.name, "project.json"))
        return { name: d.name, updatedAt: stat.mtimeMs }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  readAll(name = this.activeName): ProjectState {
    const dir = this.dir(name)
    const project = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"))
    const scene = JSON.parse(fs.readFileSync(path.join(dir, "scenes", "main.scene.json"), "utf8"))
    const assets = JSON.parse(fs.readFileSync(path.join(dir, "assets", "catalog.json"), "utf8"))
    const state = { project, scene, assets } as ProjectState
    const error = validateProject(state)
    if (error) throw new Error(`工程 ${name} 数据无效：${error}`)
    return state
  }

  private writeAll(state: ProjectState, name = this.activeName): void {
    const dir = this.dir(name)
    atomicWrite(path.join(dir, "project.json"), JSON.stringify(state.project, null, 2))
    atomicWrite(path.join(dir, "scenes", "main.scene.json"), JSON.stringify(state.scene, null, 2))
    atomicWrite(path.join(dir, "assets", "catalog.json"), JSON.stringify(state.assets, null, 2))
  }

  /** 串行保存（乐观并发由 server 层校验 revision） */
  save(state: ProjectState): Promise<void> {
    const run = async () => {
      this.snapshot(state)
      this.writeAll(state)
      this.revision++
    }
    this.queue = this.queue.then(run, run)
    return this.queue as Promise<void>
  }

  /** 恢复快照（.history，保留最近 20 份） */
  private snapshot(state: ProjectState): void {
    try {
      const dir = path.join(this.dir(), ".history")
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${Date.now()}.json`)
      fs.writeFileSync(file, JSON.stringify(state))
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
      for (const old of files.slice(0, Math.max(0, files.length - 20))) fs.unlinkSync(path.join(dir, old))
    } catch {
      /* 快照失败不影响保存 */
    }
  }

  openProject(name: string): ProjectState {
    if (!/^[^\\/]+$/.test(name) || !fs.existsSync(path.join(this.projectsDir, name, "project.json")))
      throw new Error(`工程不存在：${name}`)
    this.activeName = name
    this.revision++
    return this.readAll()
  }

  forkProject(name: string, state: ProjectState): ProjectState {
    if (!/^[^\\/]+$/.test(name)) throw new Error("工程名称不能包含路径分隔符")
    const dir = path.join(this.projectsDir, name)
    if (fs.existsSync(path.join(dir, "project.json"))) throw new Error(`工程已存在：${name}`)
    // 拷贝当前工程文件再覆盖文档（保留已导入资源）
    const source = this.dir()
    fs.cpSync(source, dir, { recursive: true })
    const next: ProjectState = JSON.parse(JSON.stringify(state))
    next.project.name = name
    const error = validateProject(next)
    if (error) throw new Error(error)
    this.writeAll(next, name)
    this.activeName = name
    this.revision++
    return next
  }

  createProject(name: string): ProjectState {
    if (!/^[^\\/]+$/.test(name)) throw new Error("工程名称不能包含路径分隔符")
    const state = newProject(name)
    this.activeName = name
    this.writeAll(state)
    this.revision++
    return state
  }

  // ---------- 资源导入 ----------

  /** 过滤扩展名并识别入口候选 */
  static planEntries(files: IncomingFile[]): ImportEntry[] {
    const entries: ImportEntry[] = []
    for (const f of files) {
      const name = f.path.split("/").pop()!.toLowerCase()
      if (name === "tileset.json") entries.push({ path: f.path, type: "tileset" })
      else if (name.endsWith(".glb") || name.endsWith(".gltf")) entries.push({ path: f.path, type: "model" })
    }
    return entries
  }

  /** 入口校验：GLB 魔数 / JSON 结构 / 外部依赖齐备 */
  private validateEntry(files: IncomingFile[], entry: ImportEntry): void {
    const byPath = new Map(files.map((f) => [normalizePath(f.path), f]))
    const p = normalizePath(entry.path)
    const file = byPath.get(p)
    if (!file) throw new Error(`找不到入口文件：${entry.path}`)
    const base = dirName(p)

    if (/\.glb$/i.test(p)) {
      const magic = file.data.subarray(0, 4).toString("latin1")
      if (magic !== "glTF") throw new Error(`${p} 不是有效的 GLB 文件`)
      return
    }

    let json: any
    try {
      json = JSON.parse(file.data.toString("utf8"))
    } catch {
      throw new Error(`JSON 解析失败：${p}`)
    }

    if (entry.type === "model") {
      if (!json.asset) throw new Error(`${p} 不是有效的 glTF 文件`)
      const missing: string[] = []
      const check = (uri: string) => {
        if (!uri || isAbsoluteUri(uri)) return
        const target = normalizePath(`${base}/${uri}`)
        if (!byPath.has(target)) missing.push(target)
      }
      for (const b of json.buffers ?? []) if (b?.uri) check(b.uri)
      for (const i of json.images ?? []) if (i?.uri) check(i.uri)
      if (missing.length) throw new Error(`glTF 依赖缺失：${[...new Set(missing)].join("、")}`)
      return
    }

    // tileset：递归校验嵌套 JSON 与瓦片依赖
    const visited = new Set<string>()
    const checkTileset = (tp: string): void => {
      if (visited.has(tp)) return
      visited.add(tp)
      const f = byPath.get(tp)
      if (!f) throw new Error(`tileset 依赖缺失：${tp}`)
      let doc: any
      try {
        doc = JSON.parse(f.data.toString("utf8"))
      } catch {
        throw new Error(`JSON 解析失败：${tp}`)
      }
      if (!doc.asset) throw new Error(`${tp} 不是有效的 tileset JSON`)
      const dir = dirName(tp)
      const walkTile = (tile: any) => {
        if (!tile) return
        const contents = [
          ...(tile.content ? [tile.content] : []),
          ...(Array.isArray(tile.contents) ? tile.contents : []),
        ]
        for (const content of contents) {
          const uri = content?.uri ?? content?.url
          if (!uri || isAbsoluteUri(uri)) continue
          const target = normalizePath(`${dir}/${uri}`)
          if (!byPath.has(target)) throw new Error(`tileset 依赖缺失：${target}`)
          if (/\.json$/i.test(target)) checkTileset(target)
        }
        if (Array.isArray(tile.children)) tile.children.forEach(walkTile)
      }
      if (doc.root) walkTile(doc.root)
      if (Array.isArray(doc.tiles)) doc.tiles.forEach(walkTile)
    }
    checkTileset(p)
  }

  importFiles(files: IncomingFile[], entry: ImportEntry, folder: string): Asset {
    const usable = files.filter((f) => {
      const dot = f.path.lastIndexOf(".")
      return dot !== -1 && IMPORT_EXTENSIONS.has(f.path.slice(dot + 1).toLowerCase())
    })
    this.validateEntry(usable, entry)
    const assetId = uid("asset-")
    const dir = path.join(this.dir(), "assets", "files", assetId)
    const stored: string[] = []
    for (const f of usable) {
      const rel = normalizePath(f.path)
      const target = path.join(dir, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, f.data)
      stored.push(rel)
    }
    const entryPath = normalizePath(entry.path)
    return {
      id: assetId,
      name: entryPath.split("/").pop()!,
      type: entry.type,
      uri: `assets/files/${assetId}/${entryPath}`,
      folder,
      tags: [],
      revision: 1,
      files: stored,
    }
  }

  deleteAssetFiles(assetId: string): void {
    if (!/^[\w-]+$/.test(assetId)) return
    const dir = path.join(this.dir(), "assets", "files", assetId)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
