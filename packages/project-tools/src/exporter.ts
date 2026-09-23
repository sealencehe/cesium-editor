// 导出器：场景包 / 源码工程 / 静态网站，写入 .exports/<任务ID>。
// 源码工程 = Vite + 原生 Cesium + 打包好的 runtime.js + public/project 数据。

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const here = path.dirname(fileURLToPath(import.meta.url))
import type { ProjectStore } from "./store"

export type ExportKind = "scene" | "source" | "build"

export interface ExportJob {
  status: "running" | "done" | "error"
  kind: ExportKind
  result?: string
  error?: string
}

const jobs = new Map<string, ExportJob>()

export function getJob(id: string): ExportJob | undefined {
  return jobs.get(id)
}

export function startExport(kind: string, base: string, store: ProjectStore): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const job: ExportJob = { status: "running", kind: kind as ExportKind }
  jobs.set(id, job)
  if (!["scene", "source", "build"].includes(kind)) {
    job.status = "error"
    job.error = `未知导出类型：${kind}`
    return id
  }
  void run(kind as ExportKind, base, store, job, id).catch((err: unknown) => {
    job.status = "error"
    job.error = err instanceof Error ? err.message : String(err)
  })
  return id
}

async function run(kind: ExportKind, base: string, store: ProjectStore, job: ExportJob, id: string): Promise<void> {
  const outDir = path.join(store.exportsDir, id)
  fs.mkdirSync(outDir, { recursive: true })
  const state = store.readAll()
  const safeName = state.project.name.replace(/[^\w\-\u4e00-\u9fa5]+/g, "_")

  if (kind === "scene") {
    const dest = path.join(outDir, `${safeName}-场景包`)
    fs.cpSync(path.join(store.projectsDir, store.activeName), dest, { recursive: true })
    job.status = "done"
    job.result = dest
    return
  }

  const projectDir = await buildSourceProject(outDir, base, store, state)
  if (kind === "source") {
    job.status = "done"
    job.result = projectDir
    return
  }

  // build：在导出的工程里安装依赖并构建静态站
  await runCommand(projectDir, packageManager(), ["install", "--silent"])
  await runCommand(projectDir, packageManager(), ["run", "build"])
  job.status = "done"
  job.result = path.join(projectDir, "dist")
}

function packageManager(): string {
  return process.execPath.includes("bun") || process.env.BUN_INSTALL ? "bun" : "npm"
}

function runCommand(cwd: string, command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: process.platform === "win32" })
    child.stdout?.on("data", (d) => process.stdout.write(`[export] ${d}`))
    child.stderr?.on("data", (d) => process.stderr.write(`[export] ${d}`))
    child.on("error", reject)
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} 退出码 ${code}`))))
  })
}

async function buildSourceProject(outDir: string, base: string, store: ProjectStore, state: import("../../scene-schema/src/index").ProjectState): Promise<string> {
  const name = (state.project.name || "scene").replace(/[^\w\-\u4e00-\u9fa5]+/g, "-")
  const dir = path.join(outDir, `${name}-源码工程`)
  fs.mkdirSync(dir, { recursive: true })

  // 运行时打包（cesium 外部化）
  await esbuild.build({
    entryPoints: [path.join(here, "template", "runtime-entry.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    minify: true,
    outfile: path.join(dir, "runtime.js"),
    external: ["cesium"],
    alias: {
      "@scene/runtime": path.resolve(here, "..", "..", "scene-runtime", "src", "index.ts"),
      "@scene/schema": path.resolve(here, "..", "..", "scene-schema", "src", "index.ts"),
    },
    logLevel: "silent",
  })

  // 场景数据
  const publicProject = path.join(dir, "public", "project")
  fs.mkdirSync(publicProject, { recursive: true })
  const filesDir = path.join(store.projectsDir, store.activeName, "assets", "files")
  if (fs.existsSync(filesDir)) fs.cpSync(filesDir, path.join(publicProject, "assets", "files"), { recursive: true })
  fs.writeFileSync(path.join(publicProject, "project.json"), JSON.stringify(state))

  const templateBase = base.endsWith("/") ? base : base + "/"

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "scene-player",
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        dependencies: { cesium: "^1.145.0", "vite-plugin-cesium": "^1.2.23" },
        devDependencies: { vite: "^8.3.0" },
      },
      null,
      2,
    ),
  )

  fs.writeFileSync(
    path.join(dir, "vite.config.js"),
    `import { defineConfig } from 'vite'\nimport cesium from 'vite-plugin-cesium'\n\nexport default defineConfig({\n  base: '${templateBase}',\n  plugins: [cesium()],\n})\n`,
  )

  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n<title>${state.project.name}</title>\n<style>html,body,#app{margin:0;height:100%}</style>\n</head>\n<body>\n<div id="app"></div>\n<script type="module" src="/src/main.js"></script>\n</body>\n</html>\n`,
  )

  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, "src", "main.js"),
    `import { loadScene } from '../runtime.js'\n\nconst base = import.meta.env.BASE_URL\nconst state = await (await fetch(base + 'project/project.json')).json()\nawait loadScene(document.getElementById('app'), state, base + 'project/')\n`,
  )

  fs.writeFileSync(
    path.join(dir, "README.md"),
    `# ${state.project.name}\n\n导出的 Cesium 场景运行工程。\n\n\`\`\`bash\nbun install\nbun run dev     # 开发预览\nbun run build   # 构建静态网站到 dist/\n\`\`\`\n\n场景数据位于 public/project，业务代码可继续在 src/main.js 中编写。\n如需 Cesium ion 影像，在 index.html 里设置 window.CESIUM_ION_TOKEN 或自行修改图源。\n`,
  )

  return dir
}
