// 本地工程服务：127.0.0.1:5191，提供 /api/* 与 /project/* 静态资源。
// Vite dev server（5190）通过代理转发；编辑器与预览页都从这里拿数据。

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { validateProject, type ProjectState } from "../../scene-schema/src/index"
import { normalizePath, ProjectStore } from "./store"
import { startExport } from "./exporter"

const PORT = 5201
const MAX_IMPORT_BODY = 1024 * 1024 * 1024 // 1GB

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ktx2": "image/ktx2",
  ".b3dm": "application/octet-stream",
  ".i3dm": "application/octet-stream",
  ".pnts": "application/octet-stream",
  ".cmpt": "application/octet-stream",
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(data)
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("请求体过大"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

export function startServer(store: ProjectStore): http.Server {
  const token = crypto.randomUUID()

  const checkToken = (req: http.IncomingMessage): boolean =>
    req.headers["x-project-token"] === token || req.method === "GET"

  const isLocalOrigin = (req: http.IncomingMessage): boolean => {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      const url = new URL(origin)
      return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname === "0.0.0.0"
    } catch {
      return false
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const route = url.pathname

    if (route.startsWith("/project/")) {
      serveStatic(route, res)
      return
    }
    if (!route.startsWith("/api/")) {
      json(res, 404, { error: "not found" })
      return
    }
    if (!isLocalOrigin(req)) {
      json(res, 403, { error: "仅允许本机访问" })
      return
    }

    if (route === "/api/state" && req.method === "GET") {
      json(res, 200, {
        state: store.readAll(),
        revision: store.revision,
        token,
        projectName: store.activeName,
      })
      return
    }

    if (route === "/api/revision" && req.method === "GET") {
      json(res, 200, { revision: store.revision })
      return
    }

    if (route === "/api/projects" && req.method === "GET") {
      json(res, 200, { projects: store.listProjects() })
      return
    }

    if (!checkToken(req)) {
      json(res, 403, { error: "令牌校验失败" })
      return
    }

    if (route === "/api/state" && req.method === "PUT") {
      const body = JSON.parse((await readBody(req, 32 * 1024 * 1024)).toString("utf8"))
      const state = body.state as ProjectState
      const error = validateProject(state)
      if (error) {
        json(res, 400, { error })
        return
      }
      if (typeof body.revision === "number" && body.revision !== store.revision) {
        json(res, 409, { error: "工程已在其他窗口修改", revision: store.revision })
        return
      }
      await store.save(state)
      json(res, 200, { revision: store.revision })
      return
    }

    if (route === "/api/projects/open" && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 1024)).toString("utf8"))
      const state = store.openProject(String(body.name))
      json(res, 200, { state, revision: store.revision, projectName: store.activeName })
      return
    }

    if (route === "/api/projects/fork" && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 32 * 1024 * 1024)).toString("utf8"))
      const state = store.forkProject(String(body.name), body.state as ProjectState)
      json(res, 200, { state, revision: store.revision, projectName: store.activeName })
      return
    }

    if (route === "/api/projects/create" && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 1024)).toString("utf8"))
      const state = store.createProject(String(body.name))
      json(res, 200, { state, revision: store.revision, projectName: store.activeName })
      return
    }

    if (route === "/api/import" && req.method === "POST") {
      const raw = await readBody(req, MAX_IMPORT_BODY)
      const body = JSON.parse(raw.toString("utf8"))
      const files = (body.files as Array<{ path: string; data: string }>).map((f) => ({
        path: f.path,
        data: Buffer.from(f.data, "base64"),
      }))
      const entry = body.entry as { path: string; type: "model" | "tileset" }
      const asset = store.importFiles(files, entry, "导入资源")
      json(res, 200, { asset })
      return
    }

    if (route === "/api/assets/delete" && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 1024)).toString("utf8"))
      store.deleteAssetFiles(String(body.assetId))
      json(res, 200, { ok: true })
      return
    }

    if (route === "/api/export" && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 1024)).toString("utf8"))
      const jobId = startExport(String(body.kind), String(body.base ?? "/"), store)
      json(res, 202, { jobId })
      return
    }

    const jobMatch = route.match(/^\/api\/jobs\/([\w-]+)$/)
    if (jobMatch && req.method === "GET") {
      const { getJob } = await import("./exporter")
      const job = getJob(jobMatch[1]!)
      if (!job) {
        json(res, 404, { error: "任务不存在" })
        return
      }
      json(res, 200, { ...job, resultPath: job.result })
      return
    }

    json(res, 404, { error: "not found" })
  }

  function serveStatic(route: string, res: http.ServerResponse): void {
    const rel = normalizePath(route.replace(/^\/project\//, ""))
    if (!rel) {
      json(res, 400, { error: "bad path" })
      return
    }
    const root = path.join(store.projectsDir, store.activeName)
    const file = path.resolve(root, rel)
    if (!file.startsWith(root + path.sep)) {
      json(res, 403, { error: "forbidden" })
      return
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      json(res, 404, { error: "not found" })
      return
    }
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-store",
    })
    fs.createReadStream(file).pipe(res)
  }

  server.listen(PORT, "127.0.0.1")
  return server
}
