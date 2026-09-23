// 源码工程导出冒烟测试（不含 install/build，只验证模板与 runtime 打包）。
import path from "node:path"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import { ProjectStore } from "./store.ts"
import { startServer } from "./server.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const store = new ProjectStore(root)
store.openInitial()
const server = startServer(store)
const base = "http://127.0.0.1:5201"

const state = await (await fetch(`${base}/api/state`)).json()
const res = await fetch(`${base}/api/export`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-project-token": state.token },
  body: JSON.stringify({ kind: "source", base: "/" }),
})
const { jobId } = await res.json()
let job: { status: string; resultPath?: string; error?: string }
do {
  await new Promise((r) => setTimeout(r, 300))
  job = await (await fetch(`${base}/api/jobs/${jobId}`)).json()
} while (job.status === "running")
console.log("export source:", job.status, job.resultPath ?? job.error)
if (job.resultPath) {
  console.log("runtime.js size:", fs.statSync(path.join(job.resultPath, "runtime.js")).size)
  console.log("files:", fs.readdirSync(job.resultPath).join(", "))
  console.log("public/project:", fs.readdirSync(path.join(job.resultPath, "public", "project")).join(", "))
  const runtime = fs.readFileSync(path.join(job.resultPath, "runtime.js"), "utf8")
  console.log("runtime external cesium:", runtime.includes('from"cesium"'))
}
server.close()
process.exit(0)
