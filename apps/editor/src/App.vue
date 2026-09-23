<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import * as C from 'cesium'
import {
  Aim,
  ArrowDown,
  Camera,
  CaretBottom,
  Delete,
  DocumentChecked,
  FolderOpened,
  Loading,
  Place,
  Position,
  RefreshLeft,
  RefreshRight,
  VideoPlay,
} from '@element-plus/icons-vue'
import AssetBrowser from './components/AssetBrowser.vue'
import HierarchyPanel from './components/HierarchyPanel.vue'
import Inspector from './components/Inspector.vue'
import { api, ConflictError, fetchState, type StateResponse } from './api'
import { usePanels } from './usePanels'
import { EditorGizmo, EditorHistory, type GizmoMode } from '@editor/core'
import { SceneApp } from '@scene/runtime'
import {
  assetReferences,
  clone,
  defaultTransform,
  newProject,
  nodeDescendants,
  uid,
  type Asset,
  type ProjectState,
  type SceneNode,
  type Transform,
} from '@scene/schema'

// ---------- 基础状态 ----------

const hostEl = ref<HTMLElement>()
const state = shallowRef<ProjectState | null>(null)
const selectedId = ref('')
const mode = ref<GizmoMode>('translate')
const booting = ref(true)
const importing = ref(false)
const message = ref('')
const saveState = ref<'saved' | 'dirty' | 'saving'>('saved')
const projectName = ref('')
const conflict = ref(false)
const viewportDragover = ref(false)
const liveId = ref('')
const liveTransform = shallowRef<Transform | null>(null)
const { panels, startDrag, toggleAssetbar } = usePanels()

let app: SceneApp | null = null
let gizmo: EditorGizmo | null = null
let history: EditorHistory | null = null
let revision = 0
let bootstrapped = false

const gridStyle = computed(() => ({
  gridTemplateColumns: `${panels.left}px 1fr ${panels.right}px`,
  gridTemplateRows: `48px 40px 1fr ${panels.assetbar ? panels.bottom : 0}px 26px`,
}))

const selectedNode = computed<SceneNode | null>(
  () => state.value?.scene.nodes.find((n) => n.id === selectedId.value) ?? null,
)
const groupNodes = computed<SceneNode[]>(() => state.value?.scene.nodes.filter((n) => n.type === 'group') ?? [])
const liveForSelected = computed<Transform | null>(() =>
  liveId.value && liveId.value === selectedId.value ? liveTransform.value : null,
)
const modelCount = computed(() => state.value?.scene.nodes.filter((n) => n.type === 'model').length ?? 0)
const tilesetCount = computed(() => state.value?.scene.nodes.filter((n) => n.type === 'tileset').length ?? 0)
const saveText = computed(
  () => ({ saved: '已保存', dirty: '未保存', saving: '保存中…' })[saveState.value],
)
const saveTagType = computed(() => (saveState.value === 'saved' ? 'success' : 'warning'))
const canUndo = computed(() => !!history?.undoCount)
const canRedo = computed(() => !!history?.redoCount)
const undoTip = computed(() => `撤销 Ctrl+Z${history?.undoLabel ? '：' + history.undoLabel : ''}`)
const redoTip = computed(() => `重做 Ctrl+Y${history?.redoLabel ? '：' + history.redoLabel : ''}`)

function focusSelection() {
  app?.focus(selectedId.value || undefined)
}

function focusNode(id: string) {
  app?.focus(id)
}

function resetCamera() {
  app?.restoreCamera()
}

function status(text: string) {
  message.value = text
}

// ---------- 编辑入口 ----------

function edit(label: string, fn: (draft: ProjectState) => void) {
  if (!history) return
  try {
    history.execute(label, fn)
  } catch (err) {
    ElMessage.error(`${label}失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

function refresh() {
  if (!history || !app) return
  state.value = history.state
  app.sync(history.state)
  const sel = selectedId.value
    ? history.state.scene.nodes.find((n) => n.id === selectedId.value)
    : undefined
  if (!sel) {
    selectedId.value = ''
    gizmo?.bind(null)
  } else {
    gizmo?.bind(sel)
  }
  scheduleAutosave()
}

function choose(id: string) {
  selectedId.value = id
  const node = id && history ? history.state.scene.nodes.find((n) => n.id === id) : undefined
  gizmo?.bind(node ?? null)
}

// ---------- 命令 ----------

function uniqueName(base: string): string {
  const names = new Set((history?.state.scene.nodes ?? []).map((n) => n.name))
  if (!names.has(base)) return base
  for (let i = 2; ; i++) {
    const name = `${base} ${i}`
    if (!names.has(name)) return name
  }
}

function targetParentId(): string | null {
  const sel = selectedNode.value
  if (!sel) return null
  if (sel.type === 'group') return sel.id
  return sel.parentId
}

function addObject(asset: Asset, world?: C.Cartesian3 | null) {
  if (!history || !app) return
  if (asset.type === 'prefab') {
    instantiatePrefab(asset)
    return
  }
  const parentId = targetParentId()
  let transform = defaultTransform()
  if (world) {
    const pos = app.worldPointToLocal(parentId, world)
    transform = { position: pos, rotation: [0, 0, 0], scale: [1, 1, 1] }
  }
  const node: SceneNode = {
    id: uid('node-'),
    name: uniqueName(asset.name.replace(/\.(glb|gltf|json)$/i, '')),
    type: asset.type,
    visible: true,
    transform,
    parentId,
    assetId: asset.id,
  }
  edit('添加对象', (s) => {
    s.scene.nodes.push(node)
  })
  choose(node.id)
  if (!world) status(`已添加 ${node.name}（拖入视口可在落点放置）`)
}

function removeNode() {
  if (!history || !selectedNode.value) return
  const node = selectedNode.value
  const ids = new Set([node.id, ...nodeDescendants(history.state, node.id)])
  edit('删除对象', (s) => {
    s.scene.nodes = s.scene.nodes.filter((n) => !ids.has(n.id))
  })
  if (ids.has(selectedId.value)) choose('')
  status(`已删除 ${node.name}（共 ${ids.size} 个对象）`)
}

function copyNode() {
  if (!history || !selectedNode.value) return
  const node = selectedNode.value
  const ids = [node.id, ...nodeDescendants(history.state, node.id)]
  const map = new Map<string, string>()
  for (const id of ids) map.set(id, uid('node-'))
  edit('复制对象', (s) => {
    for (const id of ids) {
      const src = history!.state.scene.nodes.find((n) => n.id === id)!
      const copy = clone(src)
      copy.id = map.get(id)!
      if (id === node.id) {
        copy.parentId = src.parentId
        copy.name = uniqueName(src.name)
        copy.transform = clone(src.transform)
        copy.transform.position[0] += 6
      } else {
        copy.parentId = map.get(src.parentId!) ?? null
      }
      s.scene.nodes.push(copy)
    }
  })
  choose(map.get(node.id)!)
}

function addGroup() {
  const node: SceneNode = {
    id: uid('node-'),
    name: uniqueName('分组'),
    type: 'group',
    visible: true,
    transform: defaultTransform(),
    parentId: targetParentId(),
  }
  edit('创建分组', (s) => {
    s.scene.nodes.push(node)
  })
  choose(node.id)
}

function toggleVisible(node: SceneNode) {
  edit('修改对象', (s) => {
    const n = s.scene.nodes.find((x) => x.id === node.id)
    if (n) n.visible = !n.visible
  })
}

function applyNode(next: SceneNode) {
  if (!app || !history) return
  const sceneApp = app
  edit('修改对象', (s) => {
    const node = s.scene.nodes.find((n) => n.id === next.id)
    if (!node) return
    let transform = clone(next.transform)
    if (next.parentId !== node.parentId) {
      // 换分组时保持世界变换不变，重新换算局部 TRS
      const world = sceneApp.worldMatrixOf(node)
      transform = sceneApp.localFromWorldOf(next.parentId, world)
    }
    if (node.type === 'group') {
      const [sx, sy, sz] = transform.scale
      const u = (sx + sy + sz) / 3
      transform.scale = [u, u, u]
    }
    node.name = next.name
    node.visible = next.visible
    node.parentId = next.parentId
    node.transform = transform
  })
}

const commitTransform = (id: string, transform: Transform) => {
  edit('变换对象', (s) => {
    const node = s.scene.nodes.find((n) => n.id === id)
    if (node) node.transform = transform
  })
}

function savePrefab() {
  if (!history || !selectedNode.value) return
  const node = selectedNode.value
  const ids = [node.id, ...nodeDescendants(history.state, node.id)]
  const nodes = ids
    .map((id) => history!.state.scene.nodes.find((n) => n.id === id)!)
    .map((n, i) => {
      const copy = clone(n)
      if (i === 0) copy.parentId = null
      return copy
    })
  const asset: Asset = {
    id: uid('asset-'),
    name: node.name,
    type: 'prefab',
    uri: `prefab://${node.id}`,
    folder: '预制体',
    tags: [],
    revision: 1,
    data: { nodes },
  }
  edit('创建预制体', (s) => {
    s.assets.push(asset)
  })
  status(`已存为组合 ${asset.name}，可在资源栏双击实例化`)
}

function instantiatePrefab(asset: Asset) {
  if (!history) return
  const parentId = targetParentId()
  const map = new Map<string, string>()
  for (const n of asset.data?.nodes ?? []) map.set(n.id, uid('node-'))
  const copies: SceneNode[] = (asset.data?.nodes ?? []).map((n) => {
    const copy = clone(n)
    copy.id = map.get(n.id)!
    copy.parentId = n.parentId ? (map.get(n.parentId) ?? parentId) : parentId
    return copy
  })
  if (!copies.length) return
  copies[0].name = uniqueName(copies[0].name)
  edit('实例化预制体', (s) => {
    s.scene.nodes.push(...copies)
  })
  choose(copies[0].id)
}

function saveDefaultView() {
  if (!app) return
  const camera = app.captureCamera()
  edit('保存默认视角', (s) => {
    s.scene.camera = camera
  })
  status('已保存默认视角')
}

function undo() {
  if (!history?.undoCount) return
  gizmo?.cancel()
  const label = history.undo()
  if (label) status(`已撤销：${label}`)
}

function redo() {
  if (!history?.redoCount) return
  gizmo?.cancel()
  const label = history.redo()
  if (label) status(`已重做：${label}`)
}

function setMode(next: GizmoMode) {
  if (gizmo?.draggingNow) return
  mode.value = next
  gizmo?.setMode(next)
}

watch(mode, (m) => gizmo?.setMode(m))

// ---------- 保存 / 工程同步 ----------

let autosaveTimer: ReturnType<typeof setTimeout> | undefined
let revisionTimer: ReturnType<typeof setInterval> | undefined

function scheduleAutosave() {
  if (!history) return
  saveState.value = history.dirty ? 'dirty' : 'saved'
  if (!history.dirty || conflict.value) return
  clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => void save(false), 1800)
}

async function save(manual = false) {
  if (!history || saveState.value === 'saving') return
  saveState.value = 'saving'
  try {
    const data = await api<{ revision: number }>('/api/state', 'PUT', {
      state: history.state,
      revision,
    })
    revision = data.revision
    history.markSaved()
    saveState.value = 'saved'
    if (manual) ElMessage.success('已保存')
  } catch (err) {
    saveState.value = 'dirty'
    if (err instanceof ConflictError) {
      conflict.value = true
      ElMessage.warning('检测到其他窗口修改了本工程，自动保存已暂停')
    } else {
      ElMessage.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

async function applyServerState(data: StateResponse) {
  revision = data.revision
  projectName.value = data.projectName
  history!.replace(data.state)
  choose('')
  app!.restoreCamera()
}

async function pollRevision() {
  try {
    const data = await api<{ revision: number }>('/api/revision')
    if (data.revision === revision) return
    if (history?.dirty) {
      conflict.value = true
      return
    }
    await applyServerState(await fetchState())
  } catch {
    /* 服务暂不可达时忽略 */
  }
}

async function discardLocalAndReload() {
  conflict.value = false
  await applyServerState(await fetchState())
  status('已放弃本地修改并重新加载')
}

// ---------- 工程 ----------

const projectsVisible = ref(false)
const projectList = ref<Array<{ name: string; updatedAt: number }>>()
const newProjectName = ref('')

async function openProjects() {
  projectsVisible.value = true
  await refreshProjectList()
}

async function refreshProjectList() {
  const data = await api<{ projects: Array<{ name: string; updatedAt: number }> }>('/api/projects')
  projectList.value = data.projects
}

async function createNewProject(name: string) {
  const trimmed = name.trim()
  if (!trimmed) {
    ElMessage.warning('请输入工程名称')
    return
  }
  try {
    if (history?.dirty) await save(false)
    await applyServerState(await api<StateResponse>('/api/projects/create', 'POST', { name: trimmed }))
    projectsVisible.value = false
    newProjectName.value = ''
    status(`已创建工程 ${trimmed}`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

async function openProjectByName(name: string) {
  try {
    if (history?.dirty) await save(false)
    await applyServerState(await api<StateResponse>('/api/projects/open', 'POST', { name }))
    projectsVisible.value = false
    status(`已打开 ${name}`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
    await refreshProjectList()
  }
}

async function deleteProjectByName(name: string) {
  if (name === projectName.value) {
    ElMessage.warning('不能删除当前打开的工程')
    return
  }
  try {
    await ElMessageBox.confirm(`确定删除工程「${name}」？请手动删除 projects 目录下的对应文件夹。`, '删除工程', {
      type: 'warning',
      confirmButtonText: '知道了',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  status(`请手动删除 projects/${name} 目录`)
}

async function saveAs() {
  let name: string
  try {
    const res = await ElMessageBox.prompt('输入新工程名称', '另存为', {
      inputValue: `${projectName.value} 副本`,
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValidator: (v: string) => (v.trim() ? true : '名称不能为空'),
    })
    name = res.value.trim()
  } catch {
    return
  }
  try {
    const st = clone(history!.state)
    st.project.name = name
    await applyServerState(await api<StateResponse>('/api/projects/fork', 'POST', { name, state: st }))
    status(`已另存为 ${name}`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

// ---------- 预览 / 导出 ----------

async function preview() {
  try {
    if (history?.dirty) await save(false)
  } finally {
    window.open('/player.html', '_blank')
  }
}

const exportVisible = ref(false)
const exportKind = ref<'scene' | 'source' | 'build'>('scene')
const exportBase = ref('/')
const exportJob = ref<{ status: string; resultPath?: string; error?: string } | null>(null)
let exportJobId = ''

function openExport() {
  exportVisible.value = true
  exportJob.value = null
}

async function startExportJob() {
  if (history?.dirty) await save(false)
  const data = await api<{ jobId: string }>('/api/export', 'POST', {
    kind: exportKind.value,
    base: exportBase.value,
  })
  exportJobId = data.jobId
  exportJob.value = { status: 'running' }
  void pollExportJob()
}

async function pollExportJob() {
  const job = await api<{ status: string; resultPath?: string; error?: string }>(`/api/jobs/${exportJobId}`)
  exportJob.value = job
  if (job.status === 'running') {
    setTimeout(() => void pollExportJob(), 800)
  } else if (job.status === 'done') {
    ElMessage.success('导出完成，结果见对话框内路径')
  } else {
    ElMessage.error(`导出失败：${job.error ?? '未知错误'}`)
  }
}

// ---------- 快照 ----------

function exportSnapshot() {
  const blob = new Blob(
    [JSON.stringify({ app: 'cesium-editor', version: 1, state: history!.state }, null, 2)],
    { type: 'application/json' },
  )
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${projectName.value}.scene.json`
  a.click()
  URL.revokeObjectURL(a.href)
  status('已导出场景快照（不含资源文件本体）')
}

async function onSnapshotPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const data = JSON.parse(await file.text())
    if (data?.app !== 'cesium-editor' || !data?.state) throw new Error('不是本编辑器导出的快照')
    edit('导入快照', (s) => {
      const incoming = data.state as ProjectState
      s.scene = incoming.scene
      s.assets = incoming.assets
    })
    await save(false)
    ElMessage.success('快照已导入（引用的本地资源需已存在）')
  } catch (err) {
    ElMessage.error(`导入快照失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------- 资源导入 ----------

const fileInputRef = ref<HTMLInputElement>()
const dirInputRef = ref<HTMLInputElement>()
const snapshotInputRef = ref<HTMLInputElement>()
const importDialogVisible = ref(false)
const importCandidates = ref<Array<{ path: string; type: 'model' | 'tileset' }>>([])
const importEntryPath = ref('')
let pendingFiles: File[] = []

const IMPORT_ACCEPT = '.glb,.gltf,.bin,.png,.jpg,.jpeg,.webp,.ktx2,.json,.b3dm,.i3dm,.pnts,.cmpt'

function collectFiles(list: File[]): Array<{ path: string; blob: File }> {
  return list.map((f) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath
    // 目录导入时去掉顶层目录名，与 tileset.json 内部的相对路径对齐
    const path = rel ? rel.split('/').slice(1).join('/') || f.name : f.name
    return { path: path.replace(/\\/g, '/'), blob: f }
  })
}

function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  void handleFiles(files)
}

function handleFiles(files: File[]) {
  pendingFiles = files
  const entries = collectFiles(files)
    .filter(
      (f) =>
        f.path.split('/').pop()?.toLowerCase() === 'tileset.json' ||
        /\.(glb|gltf)$/i.test(f.path),
    )
    .map((f) => ({
      path: f.path,
      type: f.path.split('/').pop()?.toLowerCase() === 'tileset.json' ? ('tileset' as const) : ('model' as const),
    }))
  if (!entries.length) {
    ElMessage.error('未找到入口文件（tileset.json 或 .glb / .gltf）')
    return
  }
  if (entries.length === 1) {
    void doImport(entries[0]!)
  } else {
    importCandidates.value = entries
    importEntryPath.value = entries[0]!.path
    importDialogVisible.value = true
  }
}

function confirmImport() {
  const entry = importCandidates.value.find((e) => e.path === importEntryPath.value)
  importDialogVisible.value = false
  if (entry) void doImport(entry)
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function doImport(entry: { path: string; type: 'model' | 'tileset' }) {
  importing.value = true
  try {
    const files = collectFiles(pendingFiles)
    const payload = await Promise.all(files.map(async (f) => ({ path: f.path, data: await blobToBase64(f.blob) })))
    const data = await api<{ asset: Asset }>('/api/import', 'POST', { files: payload, entry })
    const asset = data.asset
    edit('导入资源', (s) => {
      s.assets.push(asset)
    })
    ElMessage.success(`已导入 ${asset.name}`)
  } catch (err) {
    ElMessage.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    importing.value = false
  }
}

// ---------- 远程资源 ----------

const remoteVisible = ref(false)
const remoteForm = reactive({ url: '', type: 'tileset' as 'tileset' | 'model' })

function registerRemote() {
  const url = remoteForm.url.trim()
  if (!/^https?:\/\//i.test(url)) {
    ElMessage.warning('请输入 http(s) 地址')
    return
  }
  let name = '远程资源'
  try {
    const u = new URL(url)
    name = decodeURIComponent(u.pathname.split('/').pop() || u.hostname)
  } catch {
    /* 保留默认名 */
  }
  edit('登记服务', (s) => {
    s.assets.push({
      id: uid('asset-'),
      name,
      type: remoteForm.type,
      uri: url,
      folder: '远程资源',
      tags: [],
      revision: 1,
    })
  })
  remoteVisible.value = false
  remoteForm.url = ''
  status(`已登记远程资源 ${name}`)
}

// ---------- 资源信息 ----------

const infoVisible = ref(false)
const infoAssetId = ref('')
const infoForm = reactive({ name: '', folder: '', tags: '' })
const infoAsset = computed(() => state.value?.assets.find((a) => a.id === infoAssetId.value) ?? null)

function openAssetInfo(asset: Asset) {
  infoAssetId.value = asset.id
  infoForm.name = asset.name
  infoForm.folder = asset.folder
  infoForm.tags = asset.tags.join(', ')
  infoVisible.value = true
}

function saveAssetInfo() {
  edit('修改资源', (s) => {
    const asset = s.assets.find((a) => a.id === infoAssetId.value)
    if (!asset) return
    asset.name = infoForm.name.trim() || asset.name
    asset.folder = infoForm.folder.trim()
    asset.tags = infoForm.tags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)
  })
  infoVisible.value = false
}

function captureThumbnail() {
  if (!app || !infoAsset.value) return
  const thumbnail = app.viewer.canvas.toDataURL('image/jpeg', 0.55)
  edit('修改资源', (s) => {
    const asset = s.assets.find((a) => a.id === infoAssetId.value)
    if (asset) asset.thumbnail = thumbnail
  })
  status('已生成缩略图')
}

async function removeAsset() {
  const asset = infoAsset.value
  if (!asset || !history) return
  const refs = assetReferences(history.state, asset.id)
  if (refs.length) {
    ElMessage.warning(`资源被引用，无法删除：${refs.join('、')}`)
    return
  }
  try {
    await ElMessageBox.confirm(`确定删除资源「${asset.name}」？`, '删除资源', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  const assetId = asset.id
  const uri = asset.uri
  edit('删除资源', (s) => {
    s.assets = s.assets.filter((a) => a.id !== assetId)
  })
  if (uri.startsWith('assets/files/')) {
    try {
      await api('/api/assets/delete', 'POST', { assetId })
    } catch {
      /* 文件删除失败不阻塞 */
    }
  }
  infoVisible.value = false
  status(`已删除资源 ${asset.name}`)
}

// ---------- 视口拖放 ----------

let dragDepth = 0

function onDragEnter() {
  dragDepth++
  viewportDragover.value = true
}

function onDragLeave() {
  if (--dragDepth <= 0) {
    dragDepth = 0
    viewportDragover.value = false
  }
}

function onDrop(e: DragEvent) {
  dragDepth = 0
  viewportDragover.value = false
  const id = e.dataTransfer?.getData('application/x-scene-asset')
  if (!id || !history) return
  const asset = history.state.assets.find((a) => a.id === id)
  if (!asset || !app) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const world = app.pickPosition(e.clientX - rect.left, e.clientY - rect.top)
  addObject(asset, world)
  if (!world) ElMessage.warning('未拾取到地面落点，已放在锚点原点')
}

// ---------- 快捷键 ----------

function keydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  if (target?.closest?.('input,textarea,select,[contenteditable="true"]')) return
  if (!history) return
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  if (mod && key === 's') {
    e.preventDefault()
    void save(true)
    return
  }
  if (mod && key === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
    return
  }
  if (mod && key === 'y') {
    e.preventDefault()
    redo()
    return
  }
  switch (e.key) {
    case 'Escape':
      gizmo?.cancel()
      break
    case 'Delete':
      if (selectedId.value) removeNode()
      break
    case 'F':
    case 'f':
      app?.focus(selectedId.value || undefined)
      break
    case 'W':
    case 'w':
      setMode('translate')
      break
    case 'E':
    case 'e':
      setMode('rotate')
      break
    case 'R':
    case 'r':
      setMode('scale')
      break
  }
}

function beforeUnload(e: BeforeUnloadEvent) {
  if (history?.dirty) {
    e.preventDefault()
    e.returnValue = ''
  }
}

// ---------- 生命周期 ----------

onMounted(async () => {
  app = new SceneApp(hostEl.value!, newProject())
  app.onObjectClick = (id) => {
    if (gizmo?.busy) return
    choose(id ?? '')
  }
  app.onNodeReady = (id) => {
    if (id === selectedId.value) {
      const node = history?.state.scene.nodes.find((n) => n.id === id)
      gizmo?.bind(node ?? null)
    }
  }
  app.onError = (m) => ElMessage.error(m)

  gizmo = new EditorGizmo(app, commitTransform)
  gizmo.onLive = (id, t) => {
    liveId.value = id
    liveTransform.value = t
  }
  gizmo.onLiveEnd = () => {
    liveId.value = ''
    liveTransform.value = null
  }

  dirInputRef.value?.setAttribute('webkitdirectory', '')

  const data = await fetchState()
  revision = data.revision
  projectName.value = data.projectName
  history = new EditorHistory(data.state)
  history.onChange = refresh
  state.value = data.state
  app.sync(data.state)
  app.restoreCamera()
  refresh()

  window.addEventListener('keydown', keydown)
  window.addEventListener('beforeunload', beforeUnload)
  revisionTimer = setInterval(() => void pollRevision(), 3000)
  Object.assign(window, {
    __cesiumEditor: { app, history, gizmo },
  })
  booting.value = false
  bootstrapped = true
})

onBeforeUnmount(() => {
  if (!bootstrapped) return
  window.removeEventListener('keydown', keydown)
  window.removeEventListener('beforeunload', beforeUnload)
  if (revisionTimer) clearInterval(revisionTimer)
  gizmo?.destroy()
  app?.destroy()
})
</script>

<template>
  <div class="workbench" :style="gridStyle">
    <header class="topbar">
      <span class="brand">
        <el-icon><Place /></el-icon>
        Cesium 场景编辑器
      </span>
      <el-button size="small" :icon="FolderOpened" @click="openProjects">
        {{ projectName }}
      </el-button>
      <el-tag size="small" :type="saveTagType">{{ saveText }}</el-tag>
      <span class="spacer"></span>
      <el-button size="small" :icon="VideoPlay" @click="preview">预览</el-button>
      <el-button size="small" type="primary" :icon="DocumentChecked" @click="save(true)">保存</el-button>
      <el-dropdown
        @command="
          (cmd: string) =>
            cmd === 'export' ? openExport() : cmd === 'saveas' ? saveAs() : cmd === 'snap' ? exportSnapshot() : snapshotInputRef?.click()
        "
      >
        <el-button size="small">
          构建 / 导出
          <el-icon style="margin-left: 4px"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="export">构建 / 导出…</el-dropdown-item>
            <el-dropdown-item command="saveas">另存为新工程</el-dropdown-item>
            <el-dropdown-item command="snap">导出场景快照（JSON）</el-dropdown-item>
            <el-dropdown-item command="snapImport">导入场景快照…</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </header>

    <div v-if="conflict" class="conflict-banner">
      工程已在其他窗口被修改，自动保存已暂停。
      <el-button size="small" @click="saveAs">另存为新工程</el-button>
      <el-button size="small" @click="exportSnapshot">下载未保存快照</el-button>
      <el-button size="small" type="warning" @click="discardLocalAndReload">放弃本地修改并重新加载</el-button>
    </div>

    <nav class="toolbar">
      <el-tooltip :content="undoTip" :show-after="400">
        <el-button size="small" :icon="RefreshLeft" :disabled="!canUndo" @click="undo" />
      </el-tooltip>
      <el-tooltip :content="redoTip" :show-after="400">
        <el-button size="small" :icon="RefreshRight" :disabled="!canRedo" @click="redo" />
      </el-tooltip>
      <el-divider direction="vertical" />
      <el-segmented
        :model-value="mode"
        :options="[
          { label: '移动 W', value: 'translate' },
          { label: '旋转 E', value: 'rotate' },
          { label: '缩放 R', value: 'scale' },
        ]"
        @update:model-value="(v: string | number) => setMode(v as GizmoMode)"
      />
      <el-divider direction="vertical" />
      <el-button size="small" :icon="Position" :disabled="!selectedId" @click="focusSelection">
        聚焦 F
      </el-button>
      <span class="hint">
        双击资源添加 · 拖入视口放置 · W/E/R 变换 · F 聚焦 · Delete 删除 · Ctrl+Z / Ctrl+Y 撤销重做
      </span>
      <el-switch :model-value="panels.assetbar" active-text="资源栏" size="small" @change="toggleAssetbar" />
    </nav>

    <HierarchyPanel
      v-if="state"
      :state="state"
      :selected-id="selectedId"
      @select="choose"
      @focus="focusNode"
      @toggle="toggleVisible"
      @add-group="addGroup"
      @copy="copyNode"
      @remove="removeNode"
      @prefab="savePrefab"
    />

    <main
      class="viewport"
      :class="{ dragover: viewportDragover }"
      @dragenter.prevent="onDragEnter"
      @dragover.prevent
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
    >
      <div ref="hostEl" class="cesium-host"></div>
      <div class="drop-hint">松开鼠标放置到地面</div>
      <div v-if="booting || importing" class="loading-mask">
        <el-icon class="is-loading" :size="22"><Loading /></el-icon>
        {{ importing ? '正在导入资源…' : '正在初始化…' }}
      </div>
      <div class="viewport-strip">
        <el-button size="small" :icon="Camera" @click="saveDefaultView">设为默认视角</el-button>
        <el-button size="small" :icon="Aim" @click="resetCamera">回到默认视角</el-button>
      </div>
      <!-- 面板拖拽手柄 -->
      <div class="resize-handle col" title="拖动调整左栏宽度" @pointerdown="startDrag('left', $event)"></div>
      <div class="resize-handle col right-edge" title="拖动调整右栏宽度" @pointerdown="startDrag('right', $event)"></div>
      <div
        v-if="panels.assetbar"
        class="resize-handle row"
        title="拖动调整资源栏高度"
        @pointerdown="startDrag('bottom', $event)"
      >
        <el-icon :size="10"><CaretBottom /></el-icon>
      </div>
    </main>

    <Inspector
      :node="selectedNode"
      :groups="groupNodes"
      :live="liveForSelected"
      @apply="applyNode"
      @remove="removeNode"
    />

    <AssetBrowser
      v-if="state"
      :assets="state.assets"
      @add="(asset: Asset) => addObject(asset)"
      @info="openAssetInfo"
      @import-files="fileInputRef?.click()"
      @import-dir="dirInputRef?.click()"
      @register-remote="remoteVisible = true"
    />

    <footer class="statusbar">
      <span class="message">{{ message }}</span>
      <span class="spacer"></span>
      <span>模型 {{ modelCount }} · 瓦片 {{ tilesetCount }} · 资源 {{ state?.assets.length ?? 0 }}</span>
    </footer>

    <!-- 隐藏输入 -->
    <input ref="fileInputRef" type="file" multiple hidden :accept="IMPORT_ACCEPT" @change="onPickFiles" />
    <input ref="dirInputRef" type="file" multiple hidden @change="onPickFiles" />
    <input ref="snapshotInputRef" type="file" hidden accept=".json" @change="onSnapshotPicked" />

    <!-- 工程管理 -->
    <el-dialog v-model="projectsVisible" title="工程管理" width="540px">
      <div class="dialog-row">
        <el-input
          v-model="newProjectName"
          placeholder="新工程名称"
          style="flex: 1"
          @keyup.enter="createNewProject(newProjectName)"
        />
        <el-button type="primary" @click="createNewProject(newProjectName)">创建并打开</el-button>
      </div>
      <el-divider style="margin: 10px 0" />
      <div v-if="!projectList?.length" class="empty-tip">暂无已保存的工程</div>
      <div v-for="p in projectList ?? []" :key="p.name" class="dialog-row">
        <span class="grow" :title="p.name">{{ p.name }}</span>
        <span style="color: var(--fg-dim); font-size: 12px">{{ new Date(p.updatedAt).toLocaleString() }}</span>
        <el-button size="small" type="primary" plain @click="openProjectByName(p.name)">打开</el-button>
        <el-button
          size="small"
          type="danger"
          plain
          :icon="Delete"
          :disabled="p.name === projectName"
          @click="deleteProjectByName(p.name)"
        />
      </div>
    </el-dialog>

    <!-- 导入入口选择 -->
    <el-dialog v-model="importDialogVisible" title="选择导入入口" width="520px">
      <p style="color: var(--fg-dim); margin-bottom: 10px">
        检测到多个入口文件，请选择要导入的一个（其余文件作为依赖一并入库）：
      </p>
      <el-radio-group v-model="importEntryPath" style="display: flex; flex-direction: column; gap: 6px">
        <el-radio v-for="e in importCandidates" :key="e.path" :value="e.path">
          {{ e.path }}（{{ e.type === 'tileset' ? '3D Tiles' : '模型' }}）
        </el-radio>
      </el-radio-group>
      <template #footer>
        <el-button @click="importDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmImport">导入</el-button>
      </template>
    </el-dialog>

    <!-- 登记远程资源 -->
    <el-dialog v-model="remoteVisible" title="登记远程资源" width="480px">
      <el-form label-position="top">
        <el-form-item label="服务地址（http / https）">
          <el-input v-model="remoteForm.url" placeholder="https://example.com/tileset.json" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="remoteForm.type">
            <el-radio value="tileset">3D Tiles</el-radio>
            <el-radio value="model">模型（glb / gltf）</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="remoteVisible = false">取消</el-button>
        <el-button type="primary" @click="registerRemote">登记</el-button>
      </template>
    </el-dialog>

    <!-- 构建 / 导出 -->
    <el-dialog v-model="exportVisible" title="构建 / 导出" width="560px">
      <el-form label-position="top">
        <el-form-item label="导出内容">
          <el-radio-group v-model="exportKind" style="display: flex; flex-direction: column; gap: 8px">
            <el-radio value="scene">场景包（拷贝工程数据目录，可备份 / 迁移）</el-radio>
            <el-radio value="source">源码工程（可独立运行的 Vite 项目，含运行时与场景数据）</el-radio>
            <el-radio value="build">静态网站（在源码工程基础上执行构建，输出 dist/）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="部署基础路径（静态网站用，如 / 或 /my-scene/）">
          <el-input v-model="exportBase" placeholder="/" style="max-width: 280px" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="exportJob && exportJob.status === 'done'"
        type="success"
        :closable="false"
        :title="`导出完成：${exportJob.resultPath}`"
        style="margin-bottom: 8px"
      />
      <el-alert
        v-else-if="exportJob && exportJob.status === 'error'"
        type="error"
        :closable="false"
        :title="`导出失败：${exportJob.error}`"
        style="margin-bottom: 8px"
      />
      <div v-else-if="exportJob" class="dialog-row" style="color: var(--fg-dim)">
        <el-icon class="is-loading"><Loading /></el-icon>
        正在处理{{ exportKind === 'build' ? '（源码工程需安装依赖并构建，耗时较长）' : '' }}…
      </div>
      <template #footer>
        <el-button @click="exportVisible = false">关闭</el-button>
        <el-button type="primary" :loading="exportJob?.status === 'running'" @click="startExportJob">开始导出</el-button>
      </template>
    </el-dialog>

    <!-- 资源信息 -->
    <el-dialog v-model="infoVisible" :title="`资源信息 · ${infoAsset?.name ?? ''}`" width="480px">
      <el-form label-position="top" v-if="infoAsset">
        <el-form-item label="名称">
          <el-input v-model="infoForm.name" />
        </el-form-item>
        <el-form-item label="文件夹">
          <el-input v-model="infoForm.folder" placeholder="导入资源 / 远程资源 / 自定义" />
        </el-form-item>
        <el-form-item label="标签（逗号分隔）">
          <el-input v-model="infoForm.tags" placeholder="建筑, 主场景" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input :model-value="infoAsset.uri" readonly />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :icon="Camera" @click="captureThumbnail">以当前视角生成缩略图</el-button>
        <el-button type="danger" plain @click="removeAsset">删除</el-button>
        <el-button type="primary" @click="saveAssetInfo">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
