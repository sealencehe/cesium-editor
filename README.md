# Cesium 场景编辑器


## 启动

需要 bun。首次运行：

```powershell
bun install
bun run dev
```

打开 http://127.0.0.1:5200 。`bun run dev` 会同时启动：

- Vite dev server（5200，编辑器 + /player.html 预览页）
- 本地工程服务（5201，`/api/*` 与 `/project/*` 静态资源）

如需 Cesium ion 影像，在 `.env.local` 里配置 `VITE_CESIUM_ION_TOKEN=自己的Token`。

## 编辑

- 顶部工程名：创建、打开、另存工程；自动保存（1.8s 防抖），Ctrl+S 立即保存。
- 「导入文件 / 导入目录」导入 GLB、glTF（含外部 bin/贴图）与 3D Tiles（tileset.json 目录）；
  「登记远程」添加在线 3D Tiles / 模型地址。
- 双击资源添加到场景；拖入视口在地面落点放置。
- 左侧选择对象，W/E/R 移动旋转缩放，F 聚焦，Delete 删除，Ctrl+Z / Ctrl+Y 撤销重做。
- 「存为组合」生成静态预制体，实例化后各对象独立编辑。
- 多窗口同时编辑同一工程时：干净状态自动重载，有本地修改则暂停保存并提示。
- 左右栏、资源栏边缘可拖动调整尺寸（记住布局）。

## 预览与导出

- 「预览」打开 player.html，以只读模式加载当前工程。
- 「构建 / 导出」三种产物（写入 `.exports/<任务ID>`）：
  - 场景包：拷贝工程数据目录（project.json + scenes + assets）。
  - 源码工程：可独立运行的 Vite 项目（cesium 外置依赖 + 打包好的 runtime.js + public/project 数据），
    在导出目录 `bun install && bun run dev / build`。
  - 静态网站：在源码工程基础上执行安装与构建，输出 `dist/`，可直接部署；支持自定义 base 路径。

## 模块

```
apps/editor     编辑器 UI（Vue 3 + Element Plus）
apps/player     预览页（只读运行时）
packages/scene-schema     文档模型与校验
packages/scene-runtime    Cesium 对象运行时（SceneApp，编辑器与预览共用）
packages/editor-core      快照式撤销历史 + gizmo 适配（cesium-transform-gizmo）
packages/project-tools    本地工程服务（磁盘存储 / HTTP API / 导出器 / CLI）
projects/       工程数据目录（gitignore）
.exports/       导出产物目录（gitignore）
```

