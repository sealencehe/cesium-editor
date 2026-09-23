// 节点 TRS(ENU) 与 Cesium Matrix4(ECEF) 之间的换算。
// 约定：
//   localMatrix = T * R(HPR) * S
//   worldMatrix = parentWorld * localMatrix，根节点父级为场景锚点 ENU 帧

import * as C from "cesium"
import type { ProjectState, SceneNode, Transform, Vec3 } from "../schema"

export function localMatrix(t: Transform): C.Matrix4 {
  const hpr = new C.HeadingPitchRoll(
    C.Math.toRadians(t.rotation[0]),
    C.Math.toRadians(t.rotation[1]),
    C.Math.toRadians(t.rotation[2]),
  )
  return C.Matrix4.fromTranslationQuaternionRotationScale(
    new C.Cartesian3(t.position[0], t.position[1], t.position[2]),
    C.Quaternion.fromHeadingPitchRoll(hpr),
    new C.Cartesian3(t.scale[0], t.scale[1], t.scale[2]),
    new C.Matrix4(),
  )
}

export function sceneFrame(anchor: Vec3): C.Matrix4 {
  return C.Transforms.eastNorthUpToFixedFrame(
    C.Cartesian3.fromDegrees(anchor[0], anchor[1], anchor[2]),
  )
}

function safeNormalize(v: C.Cartesian3, fallback: C.Cartesian3): C.Cartesian3 {
  const m = C.Cartesian3.magnitude(v)
  if (m < 1e-12) return C.Cartesian3.clone(fallback, v)
  return C.Cartesian3.divideByScalar(v, m, v)
}

/** Matrix4 → TRS；旋转列先除以缩放再求 HPR（度） */
export function decompose(m: C.Matrix4): Transform {
  const translation = C.Matrix4.getTranslation(m, new C.Cartesian3())
  const scale = C.Matrix4.getScale(m, new C.Cartesian3())
  const rot = C.Matrix4.getMatrix3(m, new C.Matrix3())
  const col = new C.Cartesian3()
  for (let i = 0; i < 3; i++) {
    C.Matrix3.getColumn(rot, i, col)
    const fallback = new C.Cartesian3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0)
    C.Matrix3.setColumn(rot, i, safeNormalize(col, fallback), rot)
  }
  const hpr = C.HeadingPitchRoll.fromQuaternion(C.Quaternion.fromRotationMatrix(rot, new C.Quaternion()))
  return {
    position: [translation.x, translation.y, translation.z],
    rotation: [C.Math.toDegrees(hpr.heading), C.Math.toDegrees(hpr.pitch), C.Math.toDegrees(hpr.roll)],
    scale: [
      Math.max(scale.x, 1e-6),
      Math.max(scale.y, 1e-6),
      Math.max(scale.z, 1e-6),
    ],
  }
}

function findNode(state: ProjectState, id: string): SceneNode | undefined {
  return state.scene.nodes.find((n) => n.id === id)
}

export function parentWorldMatrix(state: ProjectState, parentId: string | null): C.Matrix4 {
  let m = sceneFrame(state.scene.anchor)
  const chain: SceneNode[] = []
  let cur = parentId ? findNode(state, parentId) : undefined
  while (cur) {
    chain.unshift(cur)
    cur = cur.parentId ? findNode(state, cur.parentId) : undefined
  }
  for (const n of chain) m = C.Matrix4.multiply(m, localMatrix(n.transform), new C.Matrix4())
  return m
}

export function nodeWorldMatrix(state: ProjectState, node: SceneNode): C.Matrix4 {
  const parent = parentWorldMatrix(state, node.parentId ?? null)
  return C.Matrix4.multiply(parent, localMatrix(node.transform), new C.Matrix4())
}

/** 把世界矩阵换算成指定父级下的局部 TRS */
export function localFromWorld(state: ProjectState, parentId: string | null, world: C.Matrix4): Transform {
  const invParent = C.Matrix4.inverse(parentWorldMatrix(state, parentId), new C.Matrix4())
  return decompose(C.Matrix4.multiply(invParent, world, new C.Matrix4()))
}

export function transformsEqual(a: Transform, b: Transform, eps = 1e-6): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.position[i] - b.position[i]) > eps) return false
    if (Math.abs(a.rotation[i] - b.rotation[i]) > eps) return false
    if (Math.abs(a.scale[i] - b.scale[i]) > eps) return false
  }
  return true
}
