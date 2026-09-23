// 开发入口：启动工程服务（5201），监听成功后用 node 拉起 Vite dev server（5200）。
// vite 子进程用 node 而不是 bun：bun 运行时下 vite 的 http-proxy 转发会 502。

import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcess } from "node:child_process"
import { ProjectStore } from "./store"
import { startServer } from "./server"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const store = new ProjectStore(root)
store.openInitial()

const server = startServer(store)
let child: ChildProcess | null = null

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      "[project-tools] 端口 5201 已被占用（可能是上次未退出的 bun run dev）。" +
        "请先结束残留进程再重新运行：taskkill /F /IM bun.exe\n",
    )
  } else {
    process.stderr.write(`[project-tools] 工程服务启动失败：${err.message}\n`)
  }
  if (child) child.kill()
  process.exit(1)
})

server.on("listening", () => {
  process.stdout.write(`[project-tools] 工程服务就绪 http://127.0.0.1:5201 （当前工程：${store.activeName}）\n`)
  const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js")
  // 优先 node（vite 代理行为可靠）；找不到再退回当前运行时（bun）
  let command = process.execPath
  try {
    spawn("node", ["--version"], { stdio: "ignore" })
    command = "node"
  } catch {
    /* node 不可用时退回 bun */
  }
  child = spawn(command, [viteBin, "--port", "5200"], {
    cwd: root,
    stdio: "inherit",
  })
  child.on("exit", (code) => process.exit(code ?? 0))
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child?.kill()
    server.close()
    process.exit(0)
  })
}
