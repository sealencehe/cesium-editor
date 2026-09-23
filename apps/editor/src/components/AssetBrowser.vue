<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Box,
  Files,
  FolderOpened,
  Link,
  MagicStick,
  Picture,
  Search,
  Upload,
  UploadFilled,
} from '@element-plus/icons-vue'
import type { Asset } from '@scene/schema'

const props = defineProps<{
  assets: Asset[]
}>()

const emit = defineEmits<{
  add: [asset: Asset]
  info: [asset: Asset]
  importFiles: []
  importDir: []
  registerRemote: []
}>()

const folder = ref('')
const search = ref('')

const folders = computed(() => {
  const set = new Set<string>()
  for (const a of props.assets) if (a.folder) set.add(a.folder)
  return [...set]
})

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return props.assets.filter((a) => {
    if (folder.value && a.folder !== folder.value) return false
    if (!q) return true
    return (
      a.name.toLowerCase().includes(q) ||
      a.tags.some((t) => t.toLowerCase().includes(q))
    )
  })
})

const typeLabel = (a: Asset) =>
  a.type === 'model' ? '模型' : a.type === 'tileset' ? '3D Tiles' : '预制体'

function onDragStart(e: DragEvent, asset: Asset) {
  e.dataTransfer?.setData('application/x-scene-asset', asset.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}

function iconFor(a: Asset) {
  if (a.thumbnail) return undefined
  if (a.type === 'tileset') return Files
  if (a.type === 'prefab') return MagicStick
  return Box
}
</script>

<template>
  <section class="assetbar">
    <div class="panel-head">
      <span style="color: var(--fg-dim)">资源</span>
      <el-select v-model="folder" size="small" style="width: 140px" placeholder="全部资源" clearable>
        <el-option label="全部资源" value="" />
        <el-option v-for="f in folders" :key="f" :label="f" :value="f" />
      </el-select>
      <el-input
        v-model="search"
        size="small"
        style="width: 180px"
        placeholder="搜索名称或标签"
        clearable
        :prefix-icon="Search"
      />
      <span class="spacer" style="flex: 1"></span>
      <el-button size="small" :icon="Upload" @click="emit('importFiles')">导入文件</el-button>
      <el-tooltip content="导入 3D Tiles 等目录（选择 tileset.json 所在目录）" :show-after="400">
        <el-button size="small" :icon="UploadFilled" @click="emit('importDir')">导入目录</el-button>
      </el-tooltip>
      <el-button size="small" :icon="Link" @click="emit('registerRemote')">登记远程</el-button>
    </div>
    <div class="asset-tiles">
      <div v-if="!filtered.length" class="empty-tip" style="width: 100%">
        暂无资源，点击「导入文件」导入 GLB / glTF，或「登记远程」添加在线 3D Tiles
      </div>
      <div
        v-for="asset in filtered"
        :key="asset.id"
        class="asset-tile"
        draggable="true"
        title="双击添加到场景，或拖入视口放置"
        @dragstart="onDragStart($event, asset)"
        @dblclick="emit('add', asset)"
        @click="emit('info', asset)"
      >
        <div class="thumb">
          <img v-if="asset.thumbnail" :src="asset.thumbnail" alt="" />
          <el-icon v-else-if="iconFor(asset)" :size="26">
            <component :is="iconFor(asset)!" />
          </el-icon>
          <el-icon v-else :size="26"><Picture /></el-icon>
        </div>
        <div class="tile-name" :title="asset.name">{{ asset.name }}</div>
        <div class="tile-meta">
          {{ typeLabel(asset) }}
          <span v-if="asset.folder"> · {{ asset.folder }}</span>
          <el-icon v-if="asset.uri.startsWith('http')" :size="11" style="vertical-align: -1px">
            <FolderOpened />
          </el-icon>
        </div>
      </div>
    </div>
  </section>
</template>
