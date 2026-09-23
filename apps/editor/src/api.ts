// 本地工程服务 API 封装：自动携带令牌，409 抛 CONFLICT 供上层处理。

let token = ""

export class ConflictError extends Error {
  constructor() {
    super("工程已在其他窗口修改")
  }
}

export async function api<T>(route: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(route, {
    method,
    headers: {
      "content-type": "application/json",
      "x-project-token": token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 409) throw new ConflictError()
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `请求失败（${res.status}）`)
  }
  return (await res.json()) as T
}

export interface StateResponse {
  state: import("@scene/schema").ProjectState
  revision: number
  token: string
  projectName: string
}

export async function fetchState(): Promise<StateResponse> {
  const data = await api<StateResponse & { token: string }>("/api/state")
  token = data.token
  return data
}
