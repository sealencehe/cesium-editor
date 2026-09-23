// 纯前端持久化：IndexedDB 存工程文档与导入的资源文件。

import type { ProjectState } from "../schema"

const DB_NAME = "cesium-editor"
const DB_VERSION = 1

export interface ProjectRecord {
  name: string
  state: ProjectState
  updatedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "name" })
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files")
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("无法打开本地数据库"))
  })
  return dbPromise
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("数据库操作失败"))
  })
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb()
  return db.transaction(name, mode).objectStore(name)
}

// ---------- 工程 ----------

export async function listProjects(): Promise<ProjectRecord[]> {
  const s = await store("projects", "readonly")
  const records = await request<ProjectRecord[]>(s.getAll() as IDBRequest<ProjectRecord[]>)
  return records.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadProject(name: string): Promise<ProjectState | undefined> {
  const s = await store("projects", "readonly")
  const rec = await request<ProjectRecord | undefined>(s.get(name) as IDBRequest<ProjectRecord | undefined>)
  return rec?.state
}

export async function saveProject(name: string, state: ProjectState): Promise<void> {
  const s = await store("projects", "readwrite")
  await request(s.put({ name, state, updatedAt: Date.now() } as ProjectRecord))
}

export async function deleteProject(name: string): Promise<void> {
  const s = await store("projects", "readwrite")
  await request(s.delete(name))
}

// ---------- 资源文件（键格式 `${assetId}/${相对路径}`） ----------

export function fileKey(assetId: string, path: string): string {
  return `${assetId}/${path}`
}

export async function putFile(key: string, blob: Blob): Promise<void> {
  const s = await store("files", "readwrite")
  await request(s.put(blob, key))
}

export async function getFile(key: string): Promise<Blob | undefined> {
  const s = await store("files", "readonly")
  return request<Blob | undefined>(s.get(key) as IDBRequest<Blob | undefined>)
}

export async function deleteFilesOfAsset(assetId: string): Promise<void> {
  const s = await store("files", "readwrite")
  const keys = (await request(s.getAllKeys() as IDBRequest<IDBValidKey[]>)) as string[]
  await Promise.all(keys.filter((k) => k.startsWith(`${assetId}/`)).map((k) => request(s.delete(k))))
}

// ---------- 杂项 ----------

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const s = await store("meta", "readonly")
  const rec = await request<{ key: string; value: T } | undefined>(
    s.get(key) as IDBRequest<{ key: string; value: T } | undefined>,
  )
  return rec?.value
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const s = await store("meta", "readwrite")
  await request(s.put({ key, value }))
}
