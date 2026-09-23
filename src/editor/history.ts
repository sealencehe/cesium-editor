// 快照式撤销 / 重做：每次编辑克隆整份工程文档，验证后入栈。

import { clone, validateProject, type ProjectState } from "../schema"

interface Snapshot {
  label: string
  state: ProjectState
}

const MAX_HISTORY = 80

export class EditorHistory {
  state: ProjectState
  onChange: () => void = () => {}

  private past: Snapshot[] = []
  private future: Snapshot[] = []
  private saved = ""

  constructor(initial: ProjectState) {
    this.state = initial
    this.saved = JSON.stringify(initial)
  }

  get dirty(): boolean {
    return JSON.stringify(this.state) !== this.saved
  }

  get undoCount(): number {
    return this.past.length
  }

  get redoCount(): number {
    return this.future.length
  }

  get undoLabel(): string {
    return this.past.length ? this.past[this.past.length - 1].label : ""
  }

  get redoLabel(): string {
    return this.future.length ? this.future[this.future.length - 1].label : ""
  }

  /** 抛出异常表示编辑不合法，文档保持不变 */
  execute(label: string, edit: (draft: ProjectState) => void): void {
    const next = clone(this.state)
    edit(next)
    const error = validateProject(next)
    if (error) throw new Error(error)
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.past.push({ label, state: this.state })
    if (this.past.length > MAX_HISTORY) this.past.shift()
    this.state = next
    this.future = []
    this.onChange()
  }

  undo(): string | null {
    const item = this.past.pop()
    if (!item) return null
    this.future.push({ label: item.label, state: this.state })
    this.state = item.state
    this.onChange()
    return item.label
  }

  redo(): string | null {
    const item = this.future.pop()
    if (!item) return null
    this.past.push({ label: item.label, state: this.state })
    this.state = item.state
    this.onChange()
    return item.label
  }

  markSaved(): void {
    this.saved = JSON.stringify(this.state)
  }

  /** 整体替换文档（打开工程 / 导入快照），清空历史 */
  replace(state: ProjectState): void {
    const error = validateProject(state)
    if (error) throw new Error(error)
    this.state = state
    this.past = []
    this.future = []
    this.saved = JSON.stringify(state)
    this.onChange()
  }
}
