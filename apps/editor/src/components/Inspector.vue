<script setup lang="ts">
import { watch, reactive } from 'vue'
import type { SceneNode, Transform } from '@scene/schema'
import { clone } from '@scene/schema'

const props = defineProps<{
  node: SceneNode | null
  groups: SceneNode[]
  /** gizmo 拖拽中的实时变换（覆盖显示） */
  live: Transform | null
}>()

const emit = defineEmits<{
  apply: [node: SceneNode]
  remove: []
}>()

const form = reactive<SceneNode>(clone(props.node ?? makeEmpty()))

function makeEmpty(): SceneNode {
  return {
    id: '',
    name: '',
    type: 'group',
    visible: true,
    parentId: null,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }
}

watch(
  () => props.node,
  (node) => {
    Object.assign(form, clone(node ?? makeEmpty()))
  },
)

const shown = (): Transform => props.live ?? form.transform
const dragging = () => props.live !== null

function setPos(i: number, v: number | null | undefined) {
  if (v === null || v === undefined || dragging()) return
  form.transform.position[i] = v
  emit('apply', clone(form))
}

function setRot(i: number, v: number | null | undefined) {
  if (v === null || v === undefined || dragging()) return
  form.transform.rotation[i] = v
  emit('apply', clone(form))
}

function setScale(i: number, v: number | null | undefined) {
  if (v === null || v === undefined || dragging() || !(v > 0)) return
  if (form.type === 'group') {
    form.transform.scale = [v, v, v]
  } else {
    form.transform.scale[i] = v
  }
  emit('apply', clone(form))
}

function setName(name: string) {
  form.name = name
  emit('apply', clone(form))
}

function setVisible(visible: string | number | boolean) {
  form.visible = Boolean(visible)
  emit('apply', clone(form))
}

function setParent(parentId: unknown) {
  form.parentId = typeof parentId === 'string' && parentId ? parentId : null
  emit('apply', clone(form))
}

const typeLabel = (node: SceneNode) =>
  node.type === 'group' ? '分组' : node.type === 'model' ? '模型' : '3D Tiles'
</script>

<template>
  <aside class="inspector">
    <div v-if="!node" class="empty">未选中对象<br />点击视口或左侧列表选择</div>
    <template v-else>
      <div class="section-title">{{ typeLabel(node) }} · {{ node.id.slice(0, 8) }}</div>
      <el-form label-position="top" size="small" @submit.prevent>
        <el-form-item label="名称">
          <el-input :model-value="form.name" @change="setName" />
        </el-form-item>
        <el-form-item label="可见">
          <el-switch :model-value="form.visible" @change="setVisible" />
        </el-form-item>
        <el-form-item label="所属分组">
          <el-select :model-value="form.parentId ?? ''" placeholder="无" @change="setParent">
            <el-option label="无（根级）" value="" />
            <el-option
              v-for="g in groups.filter((g) => g.id !== node?.id)"
              :key="g.id"
              :label="g.name"
              :value="g.id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <div class="section-title">
        变换
        <span v-if="dragging()" style="color: var(--accent)">（拖拽中）</span>
      </div>
      <div class="triple-grid">
        <span class="axis-label">X</span>
        <el-input-number
          :model-value="Number(shown().position[0].toFixed(3))"
          :step="0.5"
          :disabled="dragging()"
          controls-position="right"
          @change="(v: number | undefined) => setPos(0, v)"
        />
        <span class="axis-label">Y</span>
        <el-input-number
          :model-value="Number(shown().position[1].toFixed(3))"
          :step="0.5"
          :disabled="dragging()"
          controls-position="right"
          @change="(v: number | undefined) => setPos(1, v)"
        />
        <span class="axis-label">Z</span>
        <el-input-number
          :model-value="Number(shown().position[2].toFixed(3))"
          :step="0.5"
          :disabled="dragging()"
          controls-position="right"
          @change="(v: number | undefined) => setPos(2, v)"
        />
      </div>

      <div class="section-title">旋转（航向 / 俯仰 / 翻滚，度）</div>
      <div class="triple-grid">
        <span class="axis-label">H</span>
        <el-input-number
          :model-value="Number(shown().rotation[0].toFixed(2))"
          :step="1"
          :disabled="dragging()"
          controls-position="right"
          @change="(v: number | undefined) => setRot(0, v)"
        />
        <span class="axis-label">P</span>
        <el-input-number
          :model-value="Number(shown().rotation[1].toFixed(2))"
          :step="1"
          :disabled="dragging()"
          controls-position="right"
          @change="(v: number | undefined) => setRot(1, v)"
        />
        <span class="axis-label">R</span>
        <el-input-number
          :model-value="Number(shown().rotation[2].toFixed(2))"
          :step="1"
          :disabled="dragging()"
          controls-position="right"
          @change="(v: number | undefined) => setRot(2, v)"
        />
      </div>

      <div class="section-title">
        {{ node.type === 'group' ? '缩放（等比）' : '缩放' }}
      </div>
      <div v-if="node.type === 'group'" class="triple-grid">
        <span class="axis-label">S</span>
        <el-input-number
          :model-value="Number(shown().scale[0].toFixed(4))"
          :step="0.1"
          :min="0.01"
          :disabled="dragging()"
          controls-position="right"
          @change="(v: number | undefined) => setScale(0, v)"
        />
      </div>
      <div v-else class="triple-grid">
        <span class="axis-label">X</span>
        <el-input-number
          :model-value="Number(shown().scale[0].toFixed(4))"
          :step="0.1"
          :min="0.01"
          :disabled="dragging()"
          controls-position="right"
          @change="(v: number | undefined) => setScale(0, v)"
        />
        <span class="axis-label">Y</span>
        <el-input-number
          :model-value="Number(shown().scale[1].toFixed(4))"
          :step="0.1"
          :min="0.01"
          :disabled="dragging()"
          controls-position="right"
          @change="(v: number | undefined) => setScale(1, v)"
        />
        <span class="axis-label">Z</span>
        <el-input-number
          :model-value="Number(shown().scale[2].toFixed(4))"
          :step="0.1"
          :min="0.01"
          :disabled="dragging()"
          controls-position="right"
          @change="(v: number | undefined) => setScale(2, v)"
        />
      </div>

      <div class="section-title">操作</div>
      <el-button type="danger" plain size="small" style="width: 100%" @click="emit('remove')">删除对象</el-button>
    </template>
  </aside>
</template>
