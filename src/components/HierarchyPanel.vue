<script setup lang="ts">
import { computed } from 'vue'
import { Box, Folder, FolderAdd, CopyDocument, Delete, MagicStick, View, Hide } from '@element-plus/icons-vue'
import { orderedNodes, type ProjectState, type SceneNode } from '../schema'

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
}>()

const rows = computed(() => orderedNodes(props.state))

const typeIcon = (node: SceneNode) => (node.type === 'group' ? Folder : Box)
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
    <div class="node-list">
      <div v-if="!rows.length" class="empty-tip">暂无对象，双击资源或拖入视口添加</div>
      <div
        v-for="row in rows"
        :key="row.node.id"
        class="node-row"
        :class="{
          selected: row.node.id === selectedId,
          'hidden-node': !row.node.visible,
        }"
        :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }"
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
