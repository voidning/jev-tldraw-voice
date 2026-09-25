import type { RelationKind } from './live-command'

export type RelationEdge = { from:string; to:string }

/** Does `shapeId` satisfy the spoken connection direction relative to `anchorId`?
 *
 *  connectedTo:   an arrow leaves the target and points at the anchor.
 *  connectedFrom: an arrow leaves the anchor and points at the target.
 *  any:           a connection in either direction; never matches the anchor itself.
 *
 *  Kept free of tldraw imports so the rule can be regression-tested outside a browser. */
export function relationMatches(edges: RelationEdge[], shapeId: string, anchorId: string, kind: RelationKind): boolean {
  if (shapeId === anchorId) return false
  return edges.some(edge =>
    edge.to === anchorId && edge.from === shapeId ? kind !== 'connectedFrom' :
    edge.from === anchorId && edge.to === shapeId ? kind !== 'connectedTo' : false)
}
