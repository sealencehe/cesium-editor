// 资源解析：把 idb:// 资源解析为 Cesium 可用的 URL。
// glTF / 3D Tiles 的外部依赖（.bin / 贴图 / 瓦片 / 嵌套 tileset.json）
// 通过改写 JSON 里的 URI 为 blob: 地址实现无服务加载。

import type { Asset } from "../schema"
import { fileKey, getFile, putFile } from "./db"

export interface ImportedFile {
  path: string
  blob: Blob
}

const IMPORT_EXTENSIONS = new Set([
  "glb", "gltf", "bin", "png", "jpg", "jpeg", "webp", "ktx2", "json",
  "b3dm", "i3dm", "pnts", "cmpt", "gltf",
])

// 会话级 blob URL 缓存（原始文件 / 改写后的 JSON 文档分开）
const rawUrlCache = new Map<string, string>()
const docUrlCache = new Map<string, string>()

export function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out.join("/")
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? "" : path.slice(0, i)
}

function isAbsoluteUri(uri: string): boolean {
  return /^(data:|https?:|blob:)/i.test(uri)
}

async function rawFileUrl(assetId: string, path: string): Promise<string> {
  const key = `${assetId}:${path}`
  const cached = rawUrlCache.get(key)
  if (cached) return cached
  const blob = await getFile(fileKey(assetId, path))
  if (!blob) throw new Error(`资源文件缺失：${path}`)
  const url = URL.createObjectURL(blob)
  rawUrlCache.set(key, url)
  return url
}

async function readJson(assetId: string, path: string): Promise<any> {
  const blob = await getFile(fileKey(assetId, path))
  if (!blob) throw new Error(`资源文件缺失：${path}`)
  try {
    return JSON.parse(await blob.text())
  } catch {
    throw new Error(`JSON 解析失败：${path}`)
  }
}

function docUrl(key: string, json: unknown): string {
  const cached = docUrlCache.get(key)
  if (cached) return cached
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(json)], { type: "application/json" }),
  )
  docUrlCache.set(key, url)
  return url
}

/** 解析资源为可交给 Cesium 的 URL；远程资源原样返回 */
export async function resolveAssetUrl(asset: Asset): Promise<string> {
  if (/^https?:\/\//i.test(asset.uri)) return asset.uri
  const m = asset.uri.match(/^idb:\/\/([^/]+)\/(.+)$/)
  if (!m) throw new Error(`无法解析资源地址：${asset.uri}`)
  const [, assetId, entry] = m
  const lower = entry.toLowerCase()
  if (lower.endsWith(".glb")) return rawFileUrl(assetId, entry)
  if (lower.endsWith(".gltf")) return resolveGltf(assetId, entry)
  if (lower.endsWith(".json")) return resolveTileset(assetId, entry)
  return rawFileUrl(assetId, entry)
}

async function resolveGltf(assetId: string, entry: string): Promise<string> {
  const key = `${assetId}:${entry}`
  const cached = docUrlCache.get(key)
  if (cached) return cached
  const json = await readJson(assetId, entry)
  if (!json.asset) throw new Error(`不是有效的 glTF 文件：${entry}`)
  const dir = dirName(entry)
  const mapUri = (uri: string) => {
    if (!uri || isAbsoluteUri(uri)) return uri
    const target = normalizePath(`${dir}/${uri}`)
    return rawFileUrl(assetId, target)
  }
  for (const buffer of json.buffers ?? []) {
    if (buffer?.uri) buffer.uri = await mapUri(buffer.uri)
  }
  for (const image of json.images ?? []) {
    if (image?.uri) image.uri = await mapUri(image.uri)
  }
  return docUrl(key, json)
}

async function resolveTileset(assetId: string, entry: string): Promise<string> {
  const key = `${assetId}:${entry}`
  const cached = docUrlCache.get(key)
  if (cached) return cached
  const json = await readJson(assetId, entry)
  if (!json.asset) throw new Error(`不是有效的 tileset.json：${entry}`)
  const dir = dirName(entry)

  const resolveRef = async (uri: string): Promise<string> => {
    const target = normalizePath(`${dir}/${uri}`)
    if (/\.json$/i.test(target)) return resolveTileset(assetId, target)
    return rawFileUrl(assetId, target)
  }
  const rewriteContent = async (content: any) => {
    if (!content) return
    const uri = content.uri ?? content.url
    if (uri && !isAbsoluteUri(uri)) {
      const url = await resolveRef(uri)
      content.uri = url
      content.url = url
    }
    if (Array.isArray(content.contents)) {
      for (const c of content.contents) await rewriteContent(c)
    }
  }
  const walkTile = async (tile: any) => {
    if (!tile) return
    if (tile.content) await rewriteContent(tile.content)
    if (Array.isArray(tile.children)) {
      for (const child of tile.children) await walkTile(child)
    }
  }
  if (json.root) await walkTile(json.root)
  if (Array.isArray(json.tiles)) for (const tile of json.tiles) await walkTile(tile)
  return docUrl(key, json)
}

/** 释放某资源的全部 blob URL（删除资源 / 切换工程时调用） */
export function revokeAssetUrls(assetId: string): void {
  const prefix = `${assetId}:`
  for (const cache of [rawUrlCache, docUrlCache]) {
    for (const [key, url] of [...cache.entries()]) {
      if (key.startsWith(prefix)) {
        URL.revokeObjectURL(url)
        cache.delete(key)
      }
    }
  }
}

export function clearAssetCaches(): void {
  for (const cache of [rawUrlCache, docUrlCache]) {
    for (const url of cache.values()) URL.revokeObjectURL(url)
    cache.clear()
  }
}

// ---------- 导入 ----------

export interface ImportEntry {
  path: string
  type: "model" | "tileset"
}

export interface ImportPlan {
  files: ImportedFile[]
  entries: ImportEntry[]
}

/** 过滤扩展名并识别入口候选（tileset.json 或 glb/gltf） */
export function planImport(all: ImportedFile[]): ImportPlan {
  const files = all.filter((f) => {
    const dot = f.path.lastIndexOf(".")
    if (dot === -1) return false
    return IMPORT_EXTENSIONS.has(f.path.slice(dot + 1).toLowerCase())
  })
  const entries: ImportEntry[] = []
  for (const f of files) {
    const name = f.path.split("/").pop()!.toLowerCase()
    if (name === "tileset.json") entries.push({ path: f.path, type: "tileset" })
    else if (name.endsWith(".glb") || name.endsWith(".gltf")) entries.push({ path: f.path, type: "model" })
  }
  return { files, entries }
}

function collectPaths(source: { has(path: string): boolean }, paths: string[] | undefined, base: string, missing: string[]): void {
  for (const uri of paths ?? []) {
    if (!uri || isAbsoluteUri(uri)) continue
    const target = normalizePath(`${base}/${uri}`)
    if (!source.has(target)) missing.push(target)
  }
}

async function readAsJson(file: ImportedFile): Promise<any> {
  try {
    return JSON.parse(await file.blob.text())
  } catch {
    throw new Error(`JSON 解析失败：${file.path}`)
  }
}

/** 入口文件校验：GLB 魔数 / JSON 结构 / 外部依赖是否齐备 */
export async function validateEntry(files: ImportedFile[], entry: ImportEntry): Promise<void> {
  const byPath = new Map(files.map((f) => [normalizePath(f.path), f]))
  const path = normalizePath(entry.path)
  const file = byPath.get(path)
  if (!file) throw new Error(`找不到入口文件：${entry.path}`)
  const base = dirName(path)

  if (/\.glb$/i.test(path)) {
    const head = new Uint8Array(await file.blob.slice(0, 4).arrayBuffer())
    const magic = String.fromCharCode(head[0], head[1], head[2], head[3])
    if (magic !== "glTF") throw new Error(`${path} 不是有效的 GLB 文件`)
    return
  }

  const json = await readAsJson(file)
  if (entry.type === "model") {
    if (!json.asset) throw new Error(`${path} 不是有效的 glTF 文件`)
    const missing: string[] = []
    for (const buffer of json.buffers ?? []) if (buffer?.uri) collectPaths(byPath, [buffer.uri], base, missing)
    for (const image of json.images ?? []) if (image?.uri) collectPaths(byPath, [image.uri], base, missing)
    if (missing.length) throw new Error(`glTF 依赖缺失：${[...new Set(missing)].join("、")}`)
    return
  }

  // tileset：递归校验嵌套 JSON 与瓦片依赖
  const visited = new Set<string>()
  const checkTileset = async (p: string): Promise<void> => {
    if (visited.has(p)) return
    visited.add(p)
    const f = byPath.get(p)
    if (!f) throw new Error(`tileset 依赖缺失：${p}`)
    const doc = await readAsJson(f)
    if (!doc.asset) throw new Error(`${p} 不是有效的 tileset JSON`)
    const dir = dirName(p)
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
        if (/\.json$/i.test(target)) void checkTileset(target)
      }
      if (Array.isArray(tile.children)) tile.children.forEach(walkTile)
    }
    if (doc.root) walkTile(doc.root)
    if (Array.isArray(doc.tiles)) doc.tiles.forEach(walkTile)
  }
  await checkTileset(path)
}

/** 把导入文件写入 IndexedDB */
export async function storeAssetFiles(assetId: string, files: ImportedFile[]): Promise<void> {
  await Promise.all(files.map((f) => putFile(fileKey(assetId, normalizePath(f.path)), f.blob)))
}
