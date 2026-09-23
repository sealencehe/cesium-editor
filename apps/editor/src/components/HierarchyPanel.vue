<script setup lang="ts">
import { computed, ref } from 'vue'
import { Box, Folder, FolderAdd, CopyDocument, Delete, MagicStick, View, Hide } from '@element-plus/icons-vue'
import { nodeDescendants, orderedNodes, type ProjectState, type SceneNode } from '@scene/schema'

export interface HierarchyMove {
  id: string
  type: 'before' | 'after' | 'inside' | 'root-end'
  nodeId?: string
}

type DropZone = 'before' | 'after' | 'inside'

const props = defineProps<{
  state: ProjectState
  selectedId: string
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
}>()

const rows = computed(() => orderedNodes(props.state))

const typeIcon = (node: SceneNode) => (node.type === 'group' ? Folder : Box)

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
  </aside>
</template>
