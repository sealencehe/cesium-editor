// 开发入口：启动工程服务（5191）并拉起 Vite dev server（5190）。

import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { ProjectStore } from "./store"
import { startServer } from "./server"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const store = new ProjectStore(root)
store.openInitial()
startServer(store)

const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js")
const child = spawn(process.execPath, [viteBin, "--port", "5200"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env },
})

process.stdout.write(`[project-tools] 当前工程：${store.activeName}（projects/ 目录）\n`)

child.on("exit", (code) => process.exit(code ?? 0))
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill(signal)
    process.exit(0)
  })
}
