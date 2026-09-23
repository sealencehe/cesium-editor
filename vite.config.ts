import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

import cesiumModule from 'vite-plugin-cesium'

// CJS/ESM 类型互操作在 nodenext 下解析不一致，运行时默认导出即插件函数
const cesium = cesiumModule as unknown as () => Plugin

import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    cesium(),
    AutoImport({
      resolvers: [ElementPlusResolver()],
      dts: 'src/auto-imports.d.ts',
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: 'src/components.d.ts',
    }),
  ],
})
