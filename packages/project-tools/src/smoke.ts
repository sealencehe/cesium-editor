// 服务端冒烟测试：不开 vite，验证 store + server 基本可用后退出。
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ProjectStore } from "./store.ts"
import { startServer } from "./server.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const store = new ProjectStore(root)
store.openInitial()
const server = startServer(store)

const base = "http://127.0.0.1:5201"
const state = await (await fetch(`${base}/api/state`)).json()
console.log("active:", state.projectName, "revision:", state.revision, "token:", state.token ? "ok" : "missing")

const put = await fetch(`${base}/api/state`, {
  method: "PUT",
  headers: { "content-type": "application/json", "x-project-token": state.token },
  body: JSON.stringify({ state: state.state, revision: state.revision }),
})
console.log("save:", put.status)

const stale = await fetch(`${base}/api/state`, {
  method: "PUT",
  headers: { "content-type": "application/json", "x-project-token": state.token },
  body: JSON.stringify({ state: state.state, revision: 0 }),
})
console.log("stale save (expect 409):", stale.status)

const projects = await (await fetch(`${base}/api/projects`)).json()
console.log("projects:", projects.projects.map((p: { name: string }) => p.name).join(", "))

// 导入一个最小 GLB（12 字节空壳不合法，改用真实魔数 + 最小 GLB 头）
const glb = Buffer.alloc(20)
glb.write("glTF", 0, "latin1") // 魔数，通过校验即可
const imported = await fetch(`${base}/api/import`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-project-token": state.token },
  body: JSON.stringify({ files: [{ path: "test.glb", data: glb.toString("base64") }], entry: { path: "test.glb", type: "model" } }),
})
const importData = await imported.json()
console.log("import:", imported.status, importData.asset?.uri)

// 静态资源
const file = await fetch(`${base}/project/${importData.asset.uri}`)
console.log("static fetch:", file.status, file.headers.get("content-type"))

// 场景包导出
const exportRes = await fetch(`${base}/api/export`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-project-token": state.token },
  body: JSON.stringify({ kind: "scene", base: "/" }),
})
const { jobId } = await exportRes.json()
let job: { status: string; resultPath?: string; error?: string }
do {
  await new Promise((r) => setTimeout(r, 300))
  job = await (await fetch(`${base}/api/jobs/${jobId}`)).json()
} while (job.status === "running")
console.log("export scene:", job.status, job.resultPath ?? job.error)

server.close()
process.exit(0)
