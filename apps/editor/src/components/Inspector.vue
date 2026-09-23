<script setup lang="ts">
import { watch, reactive, ref } from 'vue'
import { Lock, Unlock } from '@element-plus/icons-vue'
import type { ImageryLayerConfig, SceneNode, TerrainConfig, Transform } from '@scene/schema'
import { clone } from '@scene/schema'

export type MapSelection =
  | { kind: 'base'; token: string }
  | { kind: 'terrain'; config: TerrainConfig }
  | { kind: 'layer'; config: ImageryLayerConfig }
  | null

const props = defineProps<{
  node: SceneNode | null
  groups: SceneNode[]
  /** gizmo 拖拽中的实时变换（覆盖显示） */
  live: Transform | null
  /** 地图选中项（优先于 node 显示地图配置表单） */
  mapSelection: MapSelection
}>()

const emit = defineEmits<{
  apply: [node: SceneNode]
  remove: []
  applyMapLayer: [config: ImageryLayerConfig]
  applyBaseToken: [token: string]
  applyTerrain: [config: TerrainConfig]
}>()

const form = reactive<SceneNode>(clone(props.node ?? makeEmpty()))

/** 缩放比例锁：锁定时改任一轴，三轴同步（分组节点始终等比） */
const scaleLocked = ref(true)

// ---------- 地图配置表单 ----------

const baseTokenForm = reactive({ token: '' })
const terrainForm = reactive<{
  kind: 'ellipsoid' | 'ion'
  ionToken: string
  ionAssetId: number | undefined
}>({ kind: 'ellipsoid', ionToken: '', ionAssetId: undefined })
const mapForm = reactive<{
  name: string
  url: string
  subdomains: string
  maximumLevel: number | undefined
  ionToken: string
  ionAssetId: number | undefined
  show: boolean
}>({ name: '', url: '', subdomains: '', maximumLevel: undefined, ionToken: '', ionAssetId: undefined, show: true })

watch(
  () => props.mapSelection,
  (sel) => {
    if (sel?.kind === 'base') {
      baseTokenForm.token = sel.token
    } else if (sel?.kind === 'terrain') {
      terrainForm.kind = sel.config.kind
      terrainForm.ionToken = sel.config.ionToken ?? ''
      terrainForm.ionAssetId = sel.config.ionAssetId
    } else if (sel?.kind === 'layer') {
      mapForm.name = sel.config.name
      mapForm.url = sel.config.url ?? ''
      mapForm.subdomains = sel.config.subdomains ?? ''
      mapForm.maximumLevel = sel.config.maximumLevel
      mapForm.ionToken = sel.config.ionToken ?? ''
      mapForm.ionAssetId = sel.config.ionAssetId
      mapForm.show = sel.config.show
    }
  },
)

function onLayerChange() {
  if (props.mapSelection?.kind !== 'layer') return
  emit('applyMapLayer', {
    ...props.mapSelection.config,
    name: mapForm.name.trim() || props.mapSelection.config.name,
    url: mapForm.url.trim() || undefined,
    subdomains: mapForm.subdomains.trim() || undefined,
    maximumLevel: mapForm.maximumLevel,
    ionToken: mapForm.ionToken.trim() || undefined,
    ionAssetId: mapForm.ionAssetId,
    show: mapForm.show,
  })
}

function onLayerShow(visible: string | number | boolean) {
  mapForm.show = Boolean(visible)
  onLayerChange()
}

function onTerrainChange() {
  emit('applyTerrain', {
    kind: terrainForm.kind,
    ionToken: terrainForm.ionToken.trim() || undefined,
    ionAssetId: terrainForm.ionAssetId,
  })
}

function onTerrainKind(kind: unknown) {
  terrainForm.kind = kind === 'ion' ? 'ion' : 'ellipsoid'
  onTerrainChange()
}

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
  if (form.type === 'group' || scaleLocked.value) {
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
    <template v-if="mapSelection">
      <template v-if="mapSelection.kind === 'base'">
        <div class="section-title">地图底图 · Bing 影像（ion 资产 2）</div>
        <el-form label-position="top" size="small" @submit.prevent>
          <el-form-item label="ion 访问令牌（留空使用 Cesium 默认令牌）">
            <el-input
              v-model="baseTokenForm.token"
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
              show-password
              @change="emit('applyBaseToken', baseTokenForm.token.trim())"
            />
          </el-form-item>
        </el-form>
        <el-alert
          type="info"
          :closable="false"
          title="默认令牌有额度限制；正式使用建议在 ion 控制台创建受限权限令牌"
        />
      </template>

      <template v-else-if="mapSelection.kind === 'terrain'">
        <div class="section-title">地形</div>
        <el-form label-position="top" size="small" @submit.prevent>
          <el-form-item label="类型">
            <el-radio-group :model-value="terrainForm.kind" @change="onTerrainKind">
              <el-radio value="ellipsoid">椭球（无地形）</el-radio>
              <el-radio value="ion">Cesium ion 地形</el-radio>
            </el-radio-group>
          </el-form-item>
          <template v-if="terrainForm.kind === 'ion'">
            <el-form-item label="ion 访问令牌（必填）">
              <el-input v-model="terrainForm.ionToken" show-password @change="onTerrainChange" />
            </el-form-item>
            <el-form-item label="地形资产 id（默认 1 = Cesium World Terrain）">
              <el-input-number
                v-model="terrainForm.ionAssetId"
                :min="1"
                controls-position="right"
                @change="onTerrainChange"
              />
            </el-form-item>
          </template>
        </el-form>
        <el-alert
          v-if="terrainForm.kind === 'ion' && !terrainForm.ionToken"
          type="warning"
          :closable="false"
          title="未填令牌，当前仍为椭球地形"
        />
      </template>

      <template v-else>
        <div class="section-title">地图图层 · {{ mapSelection.config.name }}</div>
        <el-form label-position="top" size="small" @submit.prevent>
          <el-form-item label="名称">
            <el-input v-model="mapForm.name" @change="onLayerChange" />
          </el-form-item>
          <el-form-item label="显示">
            <el-switch :model-value="mapForm.show" @change="onLayerShow" />
          </el-form-item>
          <template v-if="mapSelection.config.kind === 'ion-imagery'">
            <el-form-item label="ion 访问令牌（必填）">
              <el-input v-model="mapForm.ionToken" show-password @change="onLayerChange" />
            </el-form-item>
            <el-form-item label="ion 影像资产 id（必填）">
              <el-input-number
                v-model="mapForm.ionAssetId"
                :min="1"
                controls-position="right"
                @change="onLayerChange"
              />
            </el-form-item>
            <el-alert
              v-if="!(mapForm.ionToken && mapForm.ionAssetId)"
              type="warning"
              :closable="false"
              title="填写令牌与资产 id 后图层才会加载"
            />
          </template>
          <template v-else>
            <el-form-item label="URL 模板（{x} {y} {z} {s} 占位）">
              <el-input v-model="mapForm.url" @change="onLayerChange" />
            </el-form-item>
            <el-form-item label="{s} 子域">
              <el-input v-model="mapForm.subdomains" style="max-width: 160px" @change="onLayerChange" />
            </el-form-item>
            <el-form-item label="最大缩放级别（可选）">
              <el-input-number
                v-model="mapForm.maximumLevel"
                :min="0"
                :max="24"
                controls-position="right"
                @change="onLayerChange"
              />
            </el-form-item>
          </template>
        </el-form>
      </template>
    </template>

    <div v-else-if="!node" class="empty">未选中对象<br />点击视口或左侧列表选择</div>
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
      <div v-if="node.type !== 'group'" style="display: flex; justify-content: flex-end; margin-top: 6px">
        <el-tooltip
          :content="scaleLocked ? '等比缩放已锁定：修改任一轴三轴同步，点击解锁' : '三轴独立缩放：点击锁定为等比'"
          :show-after="300"
        >
          <el-button
            size="small"
            :type="scaleLocked ? 'primary' : 'default'"
            plain
            :icon="scaleLocked ? Lock : Unlock"
            @click="scaleLocked = !scaleLocked"
          >
            {{ scaleLocked ? '等比' : '独立' }}
          </el-button>
        </el-tooltip>
      </div>

      <div class="section-title">操作</div>
      <el-button type="danger" plain size="small" style="width: 100%" @click="emit('remove')">删除对象</el-button>
    </template>
  </aside>
</template>
