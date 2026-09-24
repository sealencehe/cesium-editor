<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  Box,
  Close,
  Folder,
  FolderAdd,
  CopyDocument,
  Delete,
  MagicStick,
  MapLocation,
  Picture,
  Plus,
  View,
  Hide,
} from '@element-plus/icons-vue'
import {
  nodeDescendants,
  orderedNodes,
  type ImageryLayerConfig,
  type ProjectState,
  type SceneNode,
  type TerrainConfig,
} from '@scene/schema'

export interface HierarchyMove {
  id: string
  type: 'before' | 'after' | 'inside' | 'root-end'
  nodeId?: string
}

type DropZone = 'before' | 'after' | 'inside'

const props = defineProps<{
  state: ProjectState
  selectedId: string
  imageryLayers: ImageryLayerConfig[]
  baseMapShow: boolean
  terrain: TerrainConfig | undefined
  /** 选中的地图项：'base' | 'terrain' | 图层 id */
  selectedMapId: string
}>()

const emit = defineEmits<{
  select: [id: string]
  focus: [id: string]
  toggle: [node: SceneNode]
  addGroup: []
  copy: []
  remove: []
  prefab: []
  move: [payload: HierarchyMove]
  mapAdd: [payload: { name: string; url: string; subdomains?: string; maximumLevel?: number; credit?: string }]
  mapToggle: [payload: { id: string; show: boolean }]
  mapRemove: [id: string]
  mapBaseToggle: [show: boolean]
  mapSelect: [id: string]
  mapAddIonImagery: []
  mapAddIonTerrain: []
}>()

const rows = computed(() => orderedNodes(props.state))

const typeIcon = (node: SceneNode) => (node.type === 'group' ? Folder : Box)

// ---------- 地图图层 ----------

/** 内置图层模板 */
const BUILTIN_LAYERS = [
  {
    name: 'OpenStreetMap 标准图',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maximumLevel: 19,
    credit: '© OpenStreetMap contributors',
  },
  {
    name: 'ArcGIS 卫星影像',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 19,
    credit: 'Esri, Maxar, Earthstar Geographics',
  },
  {
    name: '高德矢量地图',
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scale=1&style=8',
    subdomains: '1234',
    maximumLevel: 18,
  },
  {
    name: '高德卫星影像',
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&style=6',
    subdomains: '1234',
    maximumLevel: 18,
  },
]

const mapDialogVisible = ref(false)
const customForm = reactive({ name: '', url: '', subdomains: '' })

function openMapDialog() {
  customForm.name = ''
  customForm.url = ''
  customForm.subdomains = ''
  mapDialogVisible.value = true
}

function addBuiltin(layer: (typeof BUILTIN_LAYERS)[number]) {
  emit('mapAdd', { ...layer })
  mapDialogVisible.value = false
}

const terrainLabel = () =>
  props.terrain?.kind === 'ion' ? '地形：Cesium ion 世界地形' : '地形：椭球（无地形）'

function addCustom() {
  const url = customForm.url.trim()
  if (!customForm.name.trim()) {
    ElMessage.warning('请输入图层名称')
    return
  }
  if (!/^https?:\/\//i.test(url) || !/\{x\}/.test(url) || !/\{z\}/.test(url)) {
    ElMessage.warning('地址需为 http(s) URL 模板，且包含 {x} {y} {z} 占位')
    return
  }
  emit('mapAdd', {
    name: customForm.name.trim(),
    url,
    subdomains: customForm.subdomains.trim() || undefined,
  })
  mapDialogVisible.value = false
}

// ---------- 拖拽排序 ----------

const dragId = ref('')
const dropTarget = ref<{ id: string; zone: DropZone } | null>(null)
const rootDrop = ref(false)

function invalidTarget(rowId: string): boolean {
  if (!dragId.value || rowId === dragId.value) return true
  return nodeDescendants(props.state, dragId.value).includes(rowId)
}

function onDragStart(node: SceneNode, e: DragEvent) {
  dragId.value = node.id
  e.dataTransfer?.setData('text/plain', node.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragEnd() {
  dragId.value = ''
  dropTarget.value = null
  rootDrop.value = false
}

function onRowDragOver(node: SceneNode, e: DragEvent) {
  if (invalidTarget(node.id)) return
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  rootDrop.value = false
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = (e.clientY - rect.top) / rect.height
  let zone: DropZone
  if (node.type === 'group') zone = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside'
  else zone = ratio < 0.5 ? 'before' : 'after'
  dropTarget.value = { id: node.id, zone }
}

function onRowDragLeave() {
  dropTarget.value = null
}

function onRowDrop(node: SceneNode, e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  const target = dropTarget.value
  const id = dragId.value
  onDragEnd()
  if (!target || target.id !== node.id || !id) return
  emit('move', { id, type: target.zone, nodeId: node.id })
}

function onListDragOver(e: DragEvent) {
  if (!dragId.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  rootDrop.value = true
}

function onListDrop(e: DragEvent) {
  e.preventDefault()
  const id = dragId.value
  onDragEnd()
  if (!id) return
  emit('move', { id, type: 'root-end' })
}

function rowClasses(row: { node: SceneNode }): Record<string, boolean> {
  const target = dropTarget.value
  return {
    selected: row.node.id === props.selectedId,
    'hidden-node': !row.node.visible,
    dragging: dragId.value === row.node.id,
    'drop-before': target?.id === row.node.id && target.zone === 'before',
    'drop-after': target?.id === row.node.id && target.zone === 'after',
    'drop-inside': target?.id === row.node.id && target.zone === 'inside',
  }
}
</script>

<template>
  <aside class="hierarchy">
    <!-- 固定的地图图层组 -->
    <div class="map-layers">
      <div class="map-layer-head">
        <el-icon size="14" color="var(--accent)"><MapLocation /></el-icon>
        <span>地图图层</span>
        <span class="count">{{ imageryLayers.length + 1 }}</span>
        <span class="spacer"></span>
        <el-tooltip content="添加图层（内置 / 自定义）" :show-after="400">
          <el-button :icon="Plus" size="small" text type="primary" @click="openMapDialog" />
        </el-tooltip>
      </div>
      <div
        class="map-layer-row base"
        :class="{ selected: selectedMapId === 'base' }"
        title="点击在右侧面板配置"
        @click="emit('mapSelect', 'base')"
      >
        <el-icon size="13" color="var(--fg-dim)"><Picture /></el-icon>
        <span class="layer-name">Bing 影像（默认）</span>
        <el-tag size="small" type="info" effect="plain">底图</el-tag>
        <el-icon
          size="14"
          :color="baseMapShow ? 'var(--fg-dim)' : 'var(--accent)'"
          title="显示 / 隐藏默认底图"
          @click.stop="emit('mapBaseToggle', !baseMapShow)"
        >
          <View v-if="baseMapShow" />
          <Hide v-else />
        </el-icon>
      </div>
      <div
        class="map-layer-row"
        :class="{ selected: selectedMapId === 'terrain' }"
        title="点击在右侧面板配置地形"
        @click="emit('mapSelect', 'terrain')"
      >
        <el-icon size="13" color="var(--fg-dim)"><MapLocation /></el-icon>
        <span class="layer-name">{{ terrainLabel() }}</span>
        <el-tag v-if="terrain?.kind === 'ion' && !terrain.ionToken" size="small" type="warning" effect="plain">
          待填 token
        </el-tag>
      </div>
      <div
        v-for="layer in imageryLayers"
        :key="layer.id"
        class="map-layer-row"
        :class="{ off: !layer.show, selected: selectedMapId === layer.id }"
        title="点击在右侧面板配置"
        @click="emit('mapSelect', layer.id)"
      >
        <el-icon size="13" color="var(--fg-dim)"><Picture /></el-icon>
        <span class="layer-name" :title="layer.url">{{ layer.name }}</span>
        <el-tag v-if="layer.kind === 'ion-imagery' && !(layer.ionToken && layer.ionAssetId)" size="small" type="warning" effect="plain">
          待配置
        </el-tag>
        <el-icon
          size="14"
          class="action"
          :color="layer.show ? 'var(--fg-dim)' : 'var(--accent)'"
          @click.stop="emit('mapToggle', { id: layer.id, show: !layer.show })"
        >
          <View v-if="layer.show" />
          <Hide v-else />
        </el-icon>
        <el-icon
          size="14"
          class="action"
          color="var(--fg-dim)"
          title="移除图层"
          @click.stop="emit('mapRemove', layer.id)"
        >
          <Close />
        </el-icon>
      </div>
    </div>

    <div class="panel-head">
      <span>场景对象</span>
      <span class="count">{{ rows.length }}</span>
      <span class="spacer"></span>
      <el-tooltip content="新建分组" :show-after="400">
        <el-button :icon="FolderAdd" size="small" text type="primary" @click="emit('addGroup')" />
      </el-tooltip>
    </div>

    <div
      class="node-list"
      :class="{ 'root-drop': rootDrop }"
      @dragover="onListDragOver"
      @dragleave="rootDrop = false"
      @drop="onListDrop"
    >
      <div v-if="!rows.length" class="empty-tip">暂无对象，双击资源或拖入视口添加</div>
      <div
        v-for="row in rows"
        :key="row.node.id"
        class="node-row"
        draggable="true"
        :class="rowClasses(row)"
        :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }"
        :title="'拖动排序 / 拖入分组'"
        @dragstart="onDragStart(row.node, $event)"
        @dragend="onDragEnd"
        @dragover="onRowDragOver(row.node, $event)"
        @dragleave="onRowDragLeave"
        @drop="onRowDrop(row.node, $event)"
        @click="emit('select', row.node.id)"
        @dblclick="emit('focus', row.node.id)"
      >
        <el-icon size="14" color="var(--fg-dim)">
          <component :is="typeIcon(row.node)" />
        </el-icon>
        <span class="node-name">{{ row.node.name }}</span>
        <span class="node-type">{{
          row.node.type === 'group' ? '分组' : row.node.type === 'model' ? '模型' : '瓦片'
        }}</span>
        <el-icon
          size="14"
          class="action"
          :color="row.node.visible ? 'var(--fg-dim)' : 'var(--accent)'"
          @click.stop="emit('toggle', row.node)"
        >
          <View v-if="row.node.visible" />
          <Hide v-else />
        </el-icon>
      </div>
      <div v-if="rows.length && rootDrop" class="root-drop-hint">松开移动到根级末尾</div>
    </div>
    <div class="panel-foot">
      <el-tooltip content="复制选中对象（含子级）" :show-after="400">
        <el-button :icon="CopyDocument" size="small" :disabled="!selectedId" @click="emit('copy')">复制</el-button>
      </el-tooltip>
      <el-tooltip content="删除选中对象（含子级）" :show-after="400">
        <el-button :icon="Delete" size="small" :disabled="!selectedId" type="danger" plain @click="emit('remove')">
          删除
        </el-button>
      </el-tooltip>
      <el-tooltip content="把选中对象存为组合（预制体）" :show-after="400">
        <el-button :icon="MagicStick" size="small" :disabled="!selectedId" @click="emit('prefab')">
          存为组合
        </el-button>
      </el-tooltip>
    </div>

    <!-- 添加地图图层 -->
    <el-dialog v-model="mapDialogVisible" title="添加地图图层" width="520px" append-to-body>
      <div class="section-title" style="margin: 0 0 8px">内置图层</div>
      <div class="builtin-layers">
        <el-button
          v-for="layer in BUILTIN_LAYERS"
          :key="layer.name"
          size="small"
          plain
          @click="addBuiltin(layer)"
        >
          {{ layer.name }}
        </el-button>
        <el-button size="small" plain type="warning" @click="emit('mapAddIonImagery'); mapDialogVisible = false">
          Cesium ion 影像（需令牌 + 资产 id）
        </el-button>
        <el-button size="small" plain type="warning" @click="emit('mapAddIonTerrain'); mapDialogVisible = false">
          Cesium ion 地形（需令牌）
        </el-button>
      </div>
      <div class="section-title" style="margin: 16px 0 8px">自定义图层</div>
      <el-form label-position="top" size="small" @submit.prevent="addCustom">
        <el-form-item label="名称">
          <el-input v-model="customForm.name" placeholder="如：内网瓦片服务" />
        </el-form-item>
        <el-form-item label="URL 模板（支持 {x} {y} {z} {s} 占位）">
          <el-input v-model="customForm.url" placeholder="https://example.com/{z}/{x}/{y}.png" />
        </el-form-item>
        <el-form-item label="{s} 子域（可选，如 abc 或 1234）">
          <el-input v-model="customForm.subdomains" placeholder="abc" style="max-width: 160px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="mapDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="addCustom">添加自定义</el-button>
      </template>
    </el-dialog>
  </aside>
</template>
