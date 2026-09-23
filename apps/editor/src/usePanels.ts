// 可拖拽面板尺寸：左 / 右 / 资源栏，持久化到 localStorage。

import { reactive } from 'vue'

export interface PanelSizes {
  left: number
  right: number
  bottom: number
  assetbar: boolean
}

const STORAGE_KEY = 'cesium-editor.panels'

const LIMITS = {
  left: [180, 520],
  right: [220, 560],
  bottom: [120, 460],
} as const

const clamp = (v: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, v))

function load(): PanelSizes {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Partial<PanelSizes>
    return {
      left: clamp(saved.left ?? 232, LIMITS.left),
      right: clamp(saved.right ?? 288, LIMITS.right),
      bottom: clamp(saved.bottom ?? 208, LIMITS.bottom),
      assetbar: saved.assetbar ?? true,
    }
  } catch {
    return { left: 232, right: 288, bottom: 208, assetbar: true }
  }
}

export function usePanels() {
  const panels = reactive(load())

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  function persist() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(panels))
    }, 300)
  }

  /** 开始拖拽：which 为 'left' | 'right' | 'bottom' */
  function startDrag(which: keyof typeof LIMITS, e: PointerEvent) {
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY, v: panels[which] as number }
    const body = document.body
    const prevSelect = body.style.userSelect
    body.style.userSelect = 'none'
    const move = (ev: PointerEvent) => {
      if (which === 'left') panels.left = clamp(start.v + ev.clientX - start.x, LIMITS.left)
      else if (which === 'right') panels.right = clamp(start.v - (ev.clientX - start.x), LIMITS.right)
      else panels.bottom = clamp(start.v - (ev.clientY - start.y), LIMITS.bottom)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      body.style.userSelect = prevSelect
      persist()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function toggleAssetbar() {
    panels.assetbar = !panels.assetbar
    persist()
  }

  return { panels, startDrag, toggleAssetbar }
}
