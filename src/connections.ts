import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
export type ConnectionMode = 'pair' | 'pointed' | 'explicit'
/** Resolve references in code. A model never invents node IDs. */
export function resolveConnection(mode: ConnectionMode, selected: string[], hovered: string | null, focus: string[], candidates: string[]): [string,string] {
  const allowed = new Set(candidates)
  const valid = (ids:string[]) => ids.length===2 && ids[0]!==ids[1] && ids.every(id=>allowed.has(id))
  if(mode==='pointed') {
    const from=selected.length?selected:focus
    const ids=[from[0],hovered || '']
    if(from.length!==1 || !valid(ids)) throw Error('请选中起点，再把鼠标停到另一个图形上。')
    return ids as [string,string]
  }
  if(selected.length>2) throw Error('选中了超过两个对象，请只选中要连接的两个。')
  if(selected.length===2) {
    if(!valid(selected)) throw Error('选中的两个对象无法连线，请选择未锁定的图形或文字。')
    return selected as [string,string]
  }
  if(valid(focus) && (!selected.length || focus.includes(selected[0]))) return focus as [string,string]
  if(valid(candidates) && (!selected.length || candidates.includes(selected[0]))) return candidates as [string,string]
  throw Error('无法确定“它俩”指哪两个，请框选或 Shift 点选两个对象后再说。')
}
export function connectObjects(editor:Editor, mode:ConnectionMode, hovered:TLShapeId|null, focus:TLShapeId[],explicit?:[TLShapeId,TLShapeId]):TLShapeId[] {
  const candidates=editor.getCurrentPageShapes().filter(s=>s.parentId===editor.getCurrentPageId() && ['geo','text','note'].includes(s.type) && !s.isLocked).map(s=>s.id)
  // Locked shapes count as ambiguity; do not silently choose the remaining two.
  const pageObjects=editor.getCurrentPageShapes().filter(s=>s.parentId===editor.getCurrentPageId() && ['geo','text','note'].includes(s.type)).map(s=>s.id)
  const selected=editor.getSelectedShapeIds()
  const resolved=mode==='explicit'?explicit:resolveConnection(mode,selected,hovered,focus,pageObjects) as [TLShapeId,TLShapeId]
  if(!resolved||resolved[0]===resolved[1]||resolved.some(id=>!pageObjects.includes(id)))throw Error('连线端点不明确或已失效。')
  if(resolved.some(id=>!candidates.includes(id))) throw Error('目标已锁定或失效，请重新选择。')
  let [fromId,toId]=resolved
  let from=editor.getShapePageBounds(fromId)!,to=editor.getShapePageBounds(toId)!
  if(mode==='pair' && (from.midX>to.midX || from.midX===to.midX && from.midY>to.midY)) {
    [fromId,toId]=[toId,fromId];[from,to]=[to,from]
  }
  const arrowId=createShapeId()
  editor.createShape({id:arrowId,type:'arrow',x:from.midX,y:from.midY,props:{start:{x:0,y:0},end:{x:to.midX-from.midX,y:to.midY-from.midY}}})
  for(const [terminal,target] of [['start',fromId],['end',toId]] as const) editor.createBinding({type:'arrow',fromId:arrowId,toId:target,props:{terminal,normalizedAnchor:{x:.5,y:.5},isExact:false,isPrecise:false,snap:'none'}})
  editor.select(fromId,toId)
  return [fromId,toId]
}
