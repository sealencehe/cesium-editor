import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

import cesiumModule from 'vite-plugin-cesium'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// 包的 CJS/ESM 类型互操作在 nodenext 下解析不一致，运行时默认导出即插件函数
const cesium = cesiumModule as unknown as () => Plugin
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    cesium(),
    AutoImport({
      resolvers: [ElementPlusResolver()],
      dts: r('apps/editor/src/auto-imports.d.ts'),
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: r('apps/editor/src/components.d.ts'),
      dirs: ['apps/editor/src/components'],
    }),
  ],
  resolve: {
    alias: {
      '@scene/schema': r('packages/scene-schema/src/index.ts'),
      '@scene/runtime': r('packages/scene-runtime/src/index.ts'),
      '@editor/core': r('packages/editor-core/src/index.ts'),
    },
  },
  server: {
    port: 5200,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5201' },
      '/project': { target: 'http://127.0.0.1:5201' },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: r('index.html'),
        player: r('player.html'),
      },
    },
  },
})
