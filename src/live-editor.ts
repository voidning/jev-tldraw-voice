import { createShapeId, toRichText, type Editor, type TLShape, type TLShapeId, type TLGeoShape, type TLTextShape } from 'tldraw'
import { connectObjects } from './connections'
import { relationMatches } from './relation'
import { lockNeed, lockNoopError, targetCountError } from './targeting'
import { canvasRevision } from './canvas-revision'
import type { ConversationContext, LiveCommand, EditCommand, Position, ReferenceProperty, Target, ViewTarget } from './live-command'

type Shape = TLGeoShape | TLTextShape
function matchesType(shape:ReturnType<Editor['getShape']>,kind:string){return !!shape&&(kind==='text'?shape.type==='text':shape.type==='geo'&&shape.props.geo===({circle:'ellipse',rectangle:'rectangle',diamond:'diamond'} as Record<string,string>)[kind])}
/** 报错时要说清「第 2 个不是方形」，比笼统的类型不符有用得多。 */
const typeNames:Record<string,string>={circle:'圆形',rectangle:'矩形',diamond:'菱形',text:'独立文字',component:'组件'};
/** 空集合时按操作给出的框选提示：对齐、排列、锁定都需要多个对象，
 *  这时说“请明确选中一个目标”会把人引向错方向。 */
const emptyHints:Partial<Record<EditCommand['operation'],string>>={
  order:'请先框选要对齐或调整层叠顺序的对象。',arrange:'请先框选要排列的对象。',
  lock:'请先框选要锁定或解锁的对象。',unlock:'请先框选要锁定或解锁的对象。'}
const ordinalHooks = new WeakMap<Editor, () => void>()
function plainText(node:unknown):string{
  if(!node||typeof node!=='object')return ''
  if('text' in node&&typeof node.text==='string')return node.text
  return 'content' in node&&Array.isArray(node.content)?node.content.map(plainText).join(''):''
}
function hasText(node: unknown): boolean {
  if(!node || typeof node!=='object') return false
  if('text' in node && typeof node.text==='string' && node.text.trim()) return true
  return 'content' in node && Array.isArray(node.content) && node.content.some(hasText)
}
export type Anchor = { x: number; y: number }
export class TargetClarificationError extends Error {}
export class LiveEditor {
  private editor: Editor
  private lastEditRevision:string|null=null
  private revision(){return canvasRevision(this.editor)}
  private nextOrder=1
  constructor(editor: Editor) {
    this.editor = editor
    for(const record of editor.store.allRecords()) {
      if(record.typeName==='shape' && typeof record.meta.voiceOrder==='number') this.nextOrder=Math.max(this.nextOrder,record.meta.voiceOrder+1)
    }
    ordinalHooks.get(editor)?.()
    ordinalHooks.set(editor,editor.sideEffects.registerBeforeCreateHandler('shape', shape => {
      if(shape.meta.voiceOrderId===shape.id && typeof shape.meta.voiceOrder==='number') { this.nextOrder=Math.max(this.nextOrder,shape.meta.voiceOrder+1);return shape }
      return {...shape,meta:{...shape.meta,voiceOrder:this.nextOrder++,voiceOrderId:shape.id}}
    }))
  }
  private orderedIds(): TLShapeId[] {
    const shapes=this.editor.getCurrentPageShapesSorted().filter(s=>s.parentId===this.editor.getCurrentPageId() && ['geo','text','note'].includes(s.type))
    const missing=shapes.filter(s=>typeof s.meta.voiceOrder!=='number'||s.meta.voiceOrderId!==s.id)
    if(missing.length) this.editor.run(()=>{
      for(const shape of missing) this.editor.updateShape({id:shape.id,type:shape.type,meta:{...shape.meta,voiceOrder:this.nextOrder++,voiceOrderId:shape.id}})
    },{history:'ignore'})
    return shapes.map(s=>this.editor.getShape(s.id)!).sort((a,b)=>Number(a.meta.voiceOrder)-Number(b.meta.voiceOrder)).map(s=>s.id)
  }
  focus: TLShapeId[] = []
  lastEdit: ConversationContext['lastEdit'] = null
  private page = ''
  private sync() {
    const page = this.editor.getCurrentPageId()
    if (page !== this.page) { this.focus = []; this.lastEdit=null; this.page = page }
    this.focus = this.focus.filter(id => this.editor.getShape(id)?.parentId === page)
  }
  /** Real arrow bindings on the current page: every edge runs start → end.
   *  The relation query and the Jev context share this single definition. */
  private edges(shapes?: TLShape[]): { id:string; from:string; to:string }[] {
    const page = this.editor.getCurrentPageId()
    const arrows = (shapes ?? this.editor.getCurrentPageShapes()).filter(s => s.type === 'arrow' && s.parentId === page)
    return arrows.flatMap(s => {
      const bindings = this.editor.getBindingsFromShape(s.id, 'arrow')
      const from = bindings.find(b => b.props.terminal === 'start')?.toId, to = bindings.find(b => b.props.terminal === 'end')?.toId
      return from && to ? [{ id: String(s.id), from: String(from), to: String(to) }] : []
    })
  }
  /** Resolve the other role against the current page before reading its live property. */
  private referenceShape(targetId: TLShapeId, referenceId: string): TLShape {
    if (String(targetId) === referenceId) throw new TargetClarificationError('参照对象不能是目标自己；画布未修改。')
    const reference = this.editor.getShape(referenceId as TLShapeId)
    if (!reference || reference.parentId !== this.editor.getCurrentPageId()) throw new TargetClarificationError('参照对象已不在当前页面，请重说这句。')
    if (!['geo','text','note'].includes(reference.type)) throw new TargetClarificationError('参照对象必须是图形或文字；画布未修改。')
    return reference
  }
  /** Read a reference object's real size immediately before writing. Nothing is assumed. */
  private referenceSize(targetId: TLShapeId, referenceId: string, property: ReferenceProperty, expected: EditCommand['parameters']['property']): number {
    if (!['width','height'].includes(property)||!['width','height'].includes(expected||''))
      throw new TargetClarificationError('当前只能在宽度和高度之间参照尺寸；画布未修改。')
    const reference=this.referenceShape(targetId,referenceId)
    const bounds = this.editor.getShapePageBounds(reference.id)
    if (!bounds) throw new TargetClarificationError('无法读取参照对象的尺寸；画布未修改。')
    return property === 'height' ? bounds.h : bounds.w
  }
  /** 参照对象自身的边界。它必须还在当前页面，也不能同时是被操作的目标 ——
   *  「把第一个移到第二个右边」里两个角色撞在一起时必须澄清，而不是把对象移到自己旁边。 */
  private relativeReference(id:string, ids:TLShapeId[]=[]): TLShapeId {
    const shape=this.editor.getShape(id as TLShapeId)
    if(!shape||shape.parentId!==this.editor.getCurrentPageId())throw new TargetClarificationError('参照对象已不在当前页面，请重说这句。')
    if(!['geo','text','note'].includes(shape.type))throw new TargetClarificationError('参照对象必须是图形或文字；画布未修改。')
    if(ids.some(target=>String(target)===id))throw new TargetClarificationError('要操作的对象和参照对象是同一个，请说清参照的是哪个。')
    return shape.id
  }
  private bounds(id:TLShapeId){
    const bounds=this.editor.getShapePageBounds(id)
    if(!bounds)throw new TargetClarificationError('无法读取参照对象的位置；画布未修改。')
    return bounds
  }
  /** Place the new object's edge 30 px from the reference, whatever its dimensions. */
  private beside(b:{midX:number;midY:number;minX:number;maxX:number;minY:number;maxY:number},direction:Exclude<Position,'anchor'>,width:number,height:number){
    const gap=30
    if(direction==='right')return {x:b.maxX+gap+width/2,y:b.midY}
    if(direction==='left')return {x:b.minX-gap-width/2,y:b.midY}
    if(direction==='above')return {x:b.midX,y:b.minY-gap-height/2}
    return {x:b.midX,y:b.maxY+gap+height/2}
  }
  context(anchor: Anchor | null): ConversationContext {
    this.sync()
    const ordered=this.orderedIds()
    const ordinalObjectCount=ordered.length
    const kind=(id:TLShapeId):ConversationContext['activeObjects'][number]=>{const s=this.editor.getShape(id);return s?.type==='text'?'text':s?.type==='geo'&&s.props.geo==='ellipse'?'circle':s?.type==='geo'&&s.props.geo==='rectangle'?'rectangle':s?.type==='geo'&&s.props.geo==='diamond'?'diamond':'other'}
    const objectCounts:Record<string,number>={}
    for(const id of ordered){const k=kind(id);objectCounts[k]=(objectCounts[k]||0)+1}
    const selected = this.editor.getSelectedShapeIds()
    const ids = selected.length ? selected : this.focus
    const all=this.editor.getCurrentPageShapes().filter(s=>s.parentId===this.page)
    const chosen=[...new Set([...selected,...this.focus,...ordered,...all.map(s=>s.id)])].slice(0,80)
    const candidates=chosen.map(id=>{const shape=this.editor.getShape(id)!;const b=this.editor.getShapePageBounds(id)!;return {
      id,kind:kind(id)==='other'?shape.type:kind(id),text:'richText' in shape.props?plainText(shape.props.richText).slice(0,300):'',
      style:Object.fromEntries(Object.entries(shape.props).filter(([k,v])=>['color','fill','labelColor','dash'].includes(k)&&(typeof v==='string'||typeof v==='number'))) as Record<string,string|number>,
      ordinal:ordered.includes(id)?ordered.indexOf(id)+1:null,selected:selected.includes(id),focused:this.focus.includes(id),locked:shape.isLocked,
      bounds:{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.w),h:Math.round(b.h)}
    }})
    const connections=this.edges(all).slice(0,120)
    return { candidates,connections,candidatesTruncated:all.length>chosen.length,pageId: this.page, ordinalObjectCount, activeCount: ids.length, activeTextCount: ids.filter(id=>{const s=this.editor.getShape(id);return s && 'richText' in s.props && hasText(s.props.richText)}).length, selectedCount: selected.length,
      selectedMatchesActive: selected.length === 1 && ids[0] === selected[0],
      activeObjects: ids.map(kind), objectCounts,
      hasAnchor: !!anchor, lastEdit: this.lastEdit }
  }
  /** 画布编号层要的数据：位置序号 + 相对画布容器的坐标。位置序号而非内部自增号——删掉一个
   *  之后内部号会跳（1、3、4），而「第二个」指的是当前位置的第二个，两者必须一致。
   *
   *  pageToScreen 不能直接当容器内坐标用：它的 screenBounds 取自容器的
   *  getBoundingClientRect()，返回的是**视口坐标**。浮层浮在容器里，
   *  所以这里减去容器的 rect 才是浮层自己的坐标系。 */
  orderBadges():{id:string;index:number;x:number;y:number;locked:boolean}[]{
    this.sync()
    const rect=this.editor.getContainer().getBoundingClientRect()
    const badges:{id:string;index:number;x:number;y:number;locked:boolean}[]=[]
    this.orderedIds().forEach((id,index)=>{
      const shape=this.editor.getShape(id),bounds=this.editor.getShapePageBounds(id)
      if(!shape||!bounds)return
      const point=this.editor.pageToScreen({x:bounds.x,y:bounds.y})
      badges.push({id,index:index+1,x:Math.round(point.x-rect.left),y:Math.round(point.y-rect.top),locked:shape.isLocked})
    })
    return badges
  }
  /** Readable name for one object, used only to build the program-generated feedback. */
  label(id:string):string{
    const shape=this.editor.getShape(id as TLShapeId)
    if(!shape) return ''
    if('richText' in shape.props){const text=plainText(shape.props.richText).trim();if(text)return text.slice(0,24)}
    if(shape.type==='geo')return ({ellipse:'圆形',rectangle:'矩形',diamond:'菱形'} as Record<string,string>)[shape.props.geo]||'图形'
    return ({text:'文字',note:'便签',arrow:'连线'} as Record<string,string>)[shape.type]||'对象'
  }
  /** 移动相机取景。视图命令不碰任何对象，因此没有目标可解析、没有属性可校验，
   *  失败也不会损坏画布；tldraw 在忽略历史的路径上执行它，所以它不会进撤销栈，
   *  也不会成为之后一次「撤销」的目标。 */
  view(target: ViewTarget): string {
    if(![...this.editor.getCurrentPageShapeIds()].length) throw Error('画布上还没有内容，没有可取景的对象。')
    const animation = { animation: { duration: 200 } }
    if (target === 'selection') {
      // 没有选中时如实降级为看全部：相机操作幂等且无副作用，拒绝不如给出同一片视野，
      // 但绝不假装执行了「只看选中的」。
      if (!this.editor.getSelectedShapeIds().length) {
        this.editor.zoomToFit(animation)
        return '当前没有选中的对象，已改为看全部'
      }
      this.editor.zoomToSelection(animation)
      return '已聚焦到选中的对象'
    }
    this.editor.zoomToFit(animation)
    return '已看全部'
  }
  /** Whole-page selection independent of a previously selected group's parent. */
  selectAll(): string {
    this.sync()
    this.editor.selectNone().selectAll()
    this.focus = [...this.editor.getSelectedShapeIds()]
    return this.focus.length ? `已选中当前页面 ${this.focus.length} 个对象` : '当前页面没有可选对象'
  }
  /** What the page looks like right now, used to report what an undo really changed.
   *  Position is a record field, not a prop, so it has to be included explicitly. */
  private snapshot(): Map<string,{label:string;state:string}> {
    const map = new Map<string,{label:string;state:string}>()
    for (const shape of this.editor.getCurrentPageShapes()) map.set(String(shape.id),{label:this.label(String(shape.id)),state:JSON.stringify([shape.x,shape.y,shape.rotation,shape.props])})
    return map
  }
  /** Names the just-undone step actually touched. Reports the real diff instead of naming
   *  a command: tldraw's stack also holds pointer edits, so this.lastEdit cannot stand in
   *  for the top of the stack. */
  private changedLabels(before: Map<string,{label:string;state:string}>): string[] {
    const changed: string[] = []
    for (const [id,entry] of before) {
      const shape = this.editor.getShape(id as TLShapeId)
      if (!shape || JSON.stringify([shape.x,shape.y,shape.rotation,shape.props]) !== entry.state) changed.push(entry.label)
    }
    return [...new Set(changed.filter(Boolean))].slice(0,3)
  }
  /** Resolving several objects at once, and reaching locked ones, are both
   *  legitimate for a few operations and must not become a general relaxation. */
  private targets(target: Target = 'current', sequence?:EditCommand['parameters'], expectedObject?:EditCommand['parameters']['expectedObject'],targetId?:string,
    relation?:{anchorId?:string;kind?:EditCommand['parameters']['relationKind']},
    options?:{allowMany?:boolean;allowLocked?:boolean;emptyHint?:string}): TLShapeId[] {
    this.sync()
    // An explicit type must never degrade to an unrelated current selection.
    if(expectedObject&&['current','selected'].includes(target))target='kind'
    const selection = this.editor.getSelectedShapeIds()
    const group = this.focus.length ? this.focus : selection
    const orderedAll=this.orderedIds()
    const typedOrder=expectedObject?orderedAll.filter(id=>matchesType(this.editor.getShape(id),expectedObject)):orderedAll
    // last／middle／first 是「某种图形里最靠前、最靠后、居中」的极值描述，按类型过滤才是原意；
    // sequence 是位置编号，必须按全局创建顺序取——「第二个」就是画布上标着 2 的那个。
    // 若先按类型过滤，`第二个方形` 会悄悄变成「方形里的第二个」：在「矩形·圆·矩形」这种画布上
    // 会落到另一个对象上，而类型校验恰好通过，于是静默改错对象。类型只作校验，不参与取号。
    //
    // 「第 N 个 + 形状名」的两种读法怎么取舍，不在这里判：那一层在语义层做完了——它同时看着
    // 画布候选，只有一种读法说得通时才换算成位置编号，两种都成立却指向不同对象时摆出来让
    // 用户定。送到这里的 ordinals 已经是换算好的位置编号，类型仍照旧只作校验。
    const ordered=target==='sequence'?orderedAll:['first','last','middle'].includes(target)?typedOrder:[]
    if(target==='sequence'){
      const list=sequence?.ordinals
      if(list){
        for(const n of list){
          if(n>orderedAll.length)throw new TargetClarificationError(`当前只有 ${orderedAll.length} 个对象，找不到第 ${n} 个。`)
          if(expectedObject&&!matchesType(this.editor.getShape(orderedAll[n-1]),expectedObject))
            throw new TargetClarificationError(`第 ${n} 个不是${typeNames[expectedObject]||'这种图形'}；画布未修改。`)
        }
      } else if(!sequence?.ordinalRange) throw new TargetClarificationError('没有从这句话里读到序号，请重说一遍。')
    }
    const sequenceIds=():TLShapeId[]=>{
      const list=sequence?.ordinals
      if(list)return list.map(n=>orderedAll[n-1])
      const range=sequence?.ordinalRange
      if(!range)return []
      return range.edge==='first'?orderedAll.slice(0,range.count):orderedAll.slice(Math.max(0,orderedAll.length-range.count))
    }
    // 「全部方形」取的是页面上一类图形的整体，和「全部」（选区或会话组）不是一件事。
    const kindAllIds=():TLShapeId[]=>expectedObject?this.editor.getCurrentPageShapes()
      .filter(shape=>shape.parentId===this.editor.getCurrentPageId()&&matchesType(shape,expectedObject)).map(shape=>shape.id):[]
    const typeMatches=target==='kind'?this.editor.getCurrentPageShapes().filter(shape=>shape.parentId===this.editor.getCurrentPageId() && (expectedObject==='text'?shape.type==='text':shape.type==='geo' && shape.props.geo===(expectedObject==='circle'?'ellipse':expectedObject==='rectangle'?'rectangle':expectedObject==='diamond'?'diamond':''))).map(shape=>shape.id):[]
    if(target==='kind' && typeMatches.length!==1) throw new TargetClarificationError(typeMatches.length ? `找到 ${typeMatches.length} 个同类图形，请用“第几个”明确目标。` : '当前页面没有这种图形。')
    // A relation-qualified target is resolved from the real bindings, never from an ID the model picked.
    if(target==='relation'){
      const anchorId=relation?.anchorId, page=this.editor.getCurrentPageId()
      if(!anchorId) throw new TargetClarificationError('缺少连接关系的另一端，请重说这句。')
      const anchor=this.editor.getShape(anchorId as TLShapeId)
      if(!anchor||anchor.parentId!==page) throw new TargetClarificationError('连接关系的另一端已不在当前页面，请重说这句。')
      const edges=this.edges()
      const matched=this.editor.getCurrentPageShapes().filter(shape=>
        shape.parentId===page&&(!expectedObject||matchesType(shape,expectedObject))&&
        relationMatches(edges,String(shape.id),anchorId,relation?.kind??'any')
      ).map(shape=>shape.id)
      if(matched.length!==1) throw new TargetClarificationError(matched.length ? `有 ${matched.length} 个对象符合这个连接关系，请说得更具体。` : '当前页面没有符合这个连接关系的对象；画布未修改。')
      return matched
    }
    const ids = target==='object'?(targetId?[targetId as TLShapeId]:[]):target === 'kind' ? typeMatches : target === 'sequence' ? sequenceIds() : target === 'kindAll' ? kindAllIds() : target === 'pageAll' ? this.editor.getCurrentPageShapes().filter(shape=>shape.parentId===this.editor.getCurrentPageId()).map(shape=>shape.id) : target === 'selected' ? selection : target === 'current' ? (selection.length ? selection : group) : target === 'previous' ? group : target === 'all' ? (selection.length?selection:group) : target === 'first' ? ordered.slice(0,1) : target === 'last' ? ordered.slice(-1) : target === 'middle' && ordered.length % 2 ? [ordered[Math.floor(ordered.length/2)]] : []
    if(target==='kindAll'&&!ids.length)throw new TargetClarificationError('当前页面没有这种图形；画布未修改。')
    const countError=targetCountError(ids,target,!!options?.allowMany,options?.emptyHint)
    if(countError) throw new TargetClarificationError(countError)
    for (const id of ids) {
      const s = this.editor.getShape(id)
      if (!s || s.parentId !== this.editor.getCurrentPageId() || s.isLocked && !options?.allowLocked) throw new TargetClarificationError('目标已变化或被锁定，请重新选择。')
      if(expectedObject&&!matchesType(s,expectedObject))throw new TargetClarificationError('目标类型与明确指令约束不一致；画布未修改。')
    }
    return ids
  }
  /** 连线端点用序号说时（「把第一个和第二个连起来」）按全局创建顺序取对象——就是画布上标的号。
   *  越界如实澄清，不回落到别的对象。 */
  private byOrdinal(ordinal?:number):TLShapeId{
    const ordered=this.orderedIds()
    if(!ordinal||ordinal<1||ordinal>ordered.length)
      throw new TargetClarificationError(`当前只有 ${ordered.length} 个对象，找不到第 ${ordinal??'?'} 个。`)
    return ordered[ordinal-1]
  }
  execute(command: LiveCommand, anchor: Anchor | null, hovered: TLShapeId | null = null) {
    this.sync()
    if (command.kind === 'edit' && command.operation === 'undo') {
      if((command.parameters.expectedLastAction||command.parameters.expectedObject)&&this.lastEditRevision!==this.revision())throw new TargetClarificationError('画布历史已变化，无法确认指定的撤销目标。')
      if(command.parameters.expectedObject&&(!this.focus.length||this.focus.some(id=>!matchesType(this.editor.getShape(id),command.parameters.expectedObject!))))throw new TargetClarificationError('最近操作的对象与指定类型不一致，请确认要撤销哪一步。')
      if(command.parameters.expectedLastAction&&command.parameters.expectedLastAction!==this.lastEdit?.action)throw new TargetClarificationError('最近完成的操作与要求撤销的操作不一致，请确认要撤销哪一步。')
      if (!this.editor.canUndo()) throw Error('没有可撤销的操作。')
      const before=this.snapshot()
      this.editor.undo()
      this.lastEditRevision=null
      // 撤销之后画布回到上一步之前，项目不再确知“最近完成的操作”是什么。
      // 留 null 比留一个 undo 更诚实，也让带操作约束的下一次撤销走澄清而不是误判。
      this.lastEdit=null
      this.focus = [...this.editor.getSelectedShapeIds()]
      const changed=this.changedLabels(before)
      return changed.length?'已撤销：'+changed.join('、'):'已撤销上一步'
    }
    if (command.kind === 'edit' && command.operation === 'redo') {
      if (!this.editor.canRedo()) throw Error('没有可重做的操作。')
      const before=this.snapshot()
      this.editor.redo()
      // 同撤销：重做之后画布来自历史，项目不再确知“最近完成的操作”是什么。
      this.lastEditRevision=null
      this.lastEdit=null
      this.focus = [...this.editor.getSelectedShapeIds()]
      const changed=this.changedLabels(before)
      return changed.length?'已重做：'+changed.join('、'):'已重做上一步'
    }
    const before = [...this.focus]
    const mark = this.editor.markHistoryStoppingPoint('voice')
    try {
      let failure: unknown
      this.editor.run(() => { try { this.apply(command, anchor, hovered) } catch (error) { failure = error } })
      if(failure) throw failure
      this.editor.markHistoryStoppingPoint('voice-end')
    } catch (error) { this.editor.bailToMark(mark); this.focus = before; throw error }
    const last=command.kind==='sequence'||command.kind==='batch'?command.commands.at(-1):command
    this.lastEditRevision=this.revision()
    if(last?.kind==='edit')this.lastEdit={action:last.operation,property:last.parameters.property,mode:last.parameters.mode}
    if(command.kind==='edit' && command.operation==='connect') return '已连接两个对象'
    if(command.kind==='edit' && command.operation==='order' && command.parameters.order)
      return command.parameters.order.kind==='align'?'已对齐':'已调整前后层叠顺序'
    if(command.kind==='edit' && command.operation==='lock') return '已锁定'
    if(command.kind==='edit' && command.operation==='unlock') return '已解除锁定'
    return '已完成：' + (command.kind === 'sequence' ? `${command.commands.length} 个步骤` : '画布已更新')
  }
  private apply(command: LiveCommand, anchor: Anchor | null, hovered: TLShapeId | null): void {
    if (command.kind === 'sequence' || command.kind === 'batch') { for (const item of command.commands) this.apply(item, anchor, hovered); return }
    if (command.kind !== 'edit') throw Error('暂不支持此命令格式。')
    const { operation, operand, parameters: p } = command
    if(operation==='connect') {
      if(!p.connection) throw Error('缺少连线端点类型。')
      const endpoints=p.connection!=='explicit'?undefined:p.fromOrdinal||p.toOrdinal
        ?[this.byOrdinal(p.fromOrdinal),this.byOrdinal(p.toOrdinal)] as [TLShapeId,TLShapeId]
        :[this.targets('object',undefined,p.fromType,p.fromId)[0],this.targets('object',undefined,p.toType,p.toId)[0]] as [TLShapeId,TLShapeId]
      this.focus=connectObjects(this.editor,p.connection,hovered,this.focus,endpoints);return
    }
    if (operation === 'add' && operand === 'object') {
      if (!['circle','rectangle','text','diamond'].includes(p.object || '')) throw Error('暂不支持组件创建。')
      let width=140,height=140
      if(p.sizeReference){
        if(p.object==='text'||p.sizeReference.kind!=='reference-bounds')throw Error('当前只能为基础图形继承参照尺寸。')
        const reference=this.relativeReference(p.sizeReference.referenceId)
        const bounds=this.bounds(reference)
        if(['both','width'].includes(p.sizeReference.axes))width=bounds.w
        if(['both','height'].includes(p.sizeReference.axes))height=bounds.h
        if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1||width>10000||height>10000)
          throw Error('参照对象尺寸超出范围；画布未修改。')
      }
      let at = anchor
      // 相对落点有两种参照来源：语义层已指名的对象（reference-object），或需要执行层
      // 现算的目标（relative：代词、序号、形状名）。两者的方位含义完全一样。
      const relative=p.position?.kind==='relative'||p.position?.kind==='relative-object'?p.position:undefined
      if (relative) {
        const id = relative.kind === 'relative-object' ? this.relativeReference(relative.referenceId)
          : this.targets(relative.reference,p,p.expectedObject,p.targetId,{anchorId:p.relationAnchorId,kind:p.relationKind})[0]
        at = this.beside(this.bounds(id),relative.direction,width,height)
      }
      if (!at) throw Error('请先把鼠标移到画布上的创建位置。')
      const id = createShapeId()
      if (p.object === 'text') {
        if (!p.content?.text) throw Error('请说明文字内容。')
        this.editor.createShape({ id, type:'text', x:at.x, y:at.y, props:{richText:toRichText(p.content.text)} })
      } else this.editor.createShape({id,type:'geo',x:at.x-width/2,y:at.y-height/2,props:{geo:p.object === 'circle' ? 'ellipse' : p.object === 'diamond' ? 'diamond' : 'rectangle',w:width,h:height}})
      this.focus=[id]; this.editor.select(id); return
    }
    const ids = this.targets(command.target,p,p.expectedObject,p.targetId,{anchorId:p.relationAnchorId,kind:p.relationKind},
      {allowMany:['order','arrange','lock','unlock'].includes(operation),allowLocked:operation==='lock'||operation==='unlock',emptyHint:emptyHints[operation]})
    if (operation === 'order') {
      if(!p.order) throw Error('缺少秩序关系。')
      if(ids.length<2) throw Error('改变对齐或前后遮挡至少需要两个对象，请先框选它们。')
      if(p.order.kind==='align') this.editor.alignShapes(ids,p.order.edge)
      else {
        const move=p.order.move
        if(move==='front') this.editor.bringToFront(ids)
        else if(move==='back') this.editor.sendToBack(ids)
        else if(move==='forward') this.editor.bringForward(ids)
        else this.editor.sendBackward(ids)
      }
      this.focus=ids; this.editor.select(...ids); return
    }
    if (operation === 'lock' || operation === 'unlock') {
      const toLock=operation==='lock'
      // tldraw 的 toggleLock 是统一翻转：只要不是全都已锁定，它就会把它们全部锁定。
      // 所以先按真实状态过滤，只翻转状态不符的那些，否则“锁上”会把已锁定的一批解锁。
      const need=lockNeed(ids,id=>this.editor.getShape(id)?.isLocked,toLock)
      // 没有可翻转的对象时必须报错，不能静默成功：execute() 随后会记录 lastEdit，
      // 让紧接着的一句“撤销刚才那个锁定”通过校验，却撤掉更早的真实操作。
      if(!need.length) throw Error(lockNoopError(toLock))
      this.editor.toggleLock(need)
      this.editor.selectNone()
      // 锁定对象无法被选中，焦点仍保留这批对象，这样“把它解锁”还能说得通。
      this.focus=ids; return
    }
    if (operation === 'delete' && operand === 'object') { this.editor.deleteShapes(ids); this.focus=[]; return }
    if (operation === 'duplicate') {
      if (ids.length !== 1 || !p.additional || p.additional < 1 || p.additional > 19) throw Error('复制需单个来源，最多新增 19 个。')
      const bounds = this.editor.getShapePageBounds(ids[0])!
      const copies: TLShapeId[] = [...ids]
      for(let i=1;i<=p.additional;i++) { this.editor.duplicateShapes(ids,{x:p.arrangement==='vertical'?0:(bounds.w+24)*i,y:p.arrangement==='vertical'?(bounds.h+24)*i:0}); copies.push(...this.editor.getSelectedShapeIds()) }
      this.focus=[...new Set(copies)]; this.editor.select(...this.focus); return
    }
    if (operation === 'arrange') {
      // 旧文案让用户“说全部横向排列”，但没有框选时“全部”同样落到那个只有单个对象的焦点上，
      // 那句话给不出任何出路。框选（现已接受多个）才是唯一可行路径。
      if(ids.length<2) throw Error('排列至少需要两个对象，请先框选它们。')
      const first=this.editor.getShapePageBounds(ids[0])!; let offset=0
      for(const id of ids) { const b=this.editor.getShapePageBounds(id)!; this.editor.nudgeShapes([id],{x:first.x+(p.direction==='horizontal'?offset:0)-b.x,y:first.y+(p.direction==='vertical'?offset:0)-b.y}); offset+=(p.direction==='horizontal'?b.w:b.h)+24 }
    } else if(operation==='move') {
      if(p.position?.kind==='anchor'){
        if(!anchor)throw Error('请指定鼠标位置。')
        for(const id of ids){const b=this.editor.getShapePageBounds(id)!;this.editor.nudgeShapes([id],{x:anchor.x-b.midX,y:anchor.y-b.midY})}
        this.focus=ids;this.editor.select(...ids);return
      }
      if(p.referenceId){
        // 移到参照对象的某一侧：整组目标贴到那一侧的外边，保持固定间隙 ——
        // 这是「移到方形右边」的意思，不是「往右挪一段」。
        const reference=this.relativeReference(p.referenceId,ids)
        const b=this.bounds(reference)
        const boxes=ids.map(id=>this.bounds(id))
        const gap=32
        const dx=p.direction==='right'?b.maxX+gap-Math.min(...boxes.map(box=>box.minX))
          :p.direction==='left'?b.minX-gap-Math.max(...boxes.map(box=>box.maxX)):0
        const dy=p.direction==='below'?b.maxY+gap-Math.min(...boxes.map(box=>box.minY))
          :p.direction==='above'?b.minY-gap-Math.max(...boxes.map(box=>box.maxY)):0
        if(dx||dy)this.editor.nudgeShapes(ids,{x:dx,y:dy})
        this.focus=ids;this.editor.select(...ids);return
      }
      if(!p.distance || !Number.isFinite(p.distance.amount)) throw Error('移动需要明确的像素距离。')
      const n=p.distance.amount; this.editor.nudgeShapes(ids,{x:p.direction==='left'?-n:p.direction==='right'?n:0,y:p.direction==='above'?-n:p.direction==='below'?n:0})
    } else for (const id of ids) this.modify(this.editor.getShape(id) as Shape, command)
    this.focus=ids; this.editor.select(...ids)
  }
  private modify(shape: Shape, command: EditCommand) {
    if(!['geo','text'].includes(shape.type)) throw Error('此属性仅支持基础图形和文字。')
    const {operation,operand,parameters:p}=command
    const props: Record<string, unknown>={}
    if(operand==='text') {
      if(operation!=='delete' && p.value?.kind!=='text') throw Error('缺少文字内容。')
      if(operation==='delete' && shape.type==='text') {this.editor.deleteShape(shape.id);return}
      props.richText=toRichText(operation==='delete'?'':p.value?.kind==='text'?p.value.text:'')
      if(shape.type==='geo'){props.align='middle';props.verticalAlign='middle'}
    } else if(operand==='property') {
      if(['size','width','height'].includes(p.property || '')) {
        if(operation==='delete') throw Error('尺寸不能删除。')
        const b=this.editor.getShapePageBounds(shape.id)!; const value=p.value
        if(value?.kind!=='step' && value?.kind!=='length' && value?.kind!=='reference') throw Error('尺寸需要像素值、“大一点／小一点”，或一个参照对象。')
        const base=p.property==='height'?b.h:b.w
        const next=value.kind==='reference'?this.referenceSize(shape.id,value.targetId,value.property,p.property)
          :value.kind==='step'?base*(p.mode==='decrease'?.9:1.1)
          :p.mode==='set'?value.amount:base+(p.mode==='decrease'?-value.amount:value.amount)
        if(!Number.isFinite(next)||next<1||next>10000) throw Error('尺寸超出范围。')
        const ratio=next/base
        if(p.property==='size') {
          const position={x:b.midX+(shape.x-b.midX)*ratio,y:b.midY+(shape.y-b.midY)*ratio}
          if(shape.type==='geo') this.editor.updateShape({id:shape.id,type:'geo',...position,
            props:{w:shape.props.w*ratio,h:shape.props.h*ratio,growY:shape.props.growY*ratio,scale:shape.props.scale*ratio}})
          else this.editor.updateShape({id:shape.id,type:'text',...position,props:{scale:shape.props.scale*ratio}})
          return
        }
        this.editor.resizeShape(shape.id,{x:p.property==='height'?1:ratio,y:p.property==='width'?1:ratio},{scaleOrigin:b.center,scaleAxisRotation:shape.rotation})
        return
      }
      if(shape.type==='text' && p.property!=='textColor') throw Error('独立文字仅支持文字颜色与尺寸。')
      if(operation==='add' && p.property==='stroke' && !p.value) {props.dash='solid';props.color='black'}
      else if(operation==='delete' && p.property==='fill') props.fill='none'
      else if(operation==='delete' && p.property==='stroke') props.dash='none'
      else if(['color','fill','stroke','textColor'].includes(p.property||'')) {
        if(p.value?.kind==='reference'){
          if(p.value.property!==p.property)throw new TargetClarificationError('参照的属性与要修改的属性不一致；画布未修改。')
          const source=this.referenceShape(shape.id,p.value.targetId)
          if(p.property==='textColor'){
            if(source.type!=='geo'&&source.type!=='text')throw new TargetClarificationError('参照对象没有受支持的文字颜色；画布未修改。')
            const referenceColor=source.type==='geo'?source.props.labelColor:source.props.color
            if(shape.type==='text')props.color=referenceColor
            else props.labelColor=referenceColor
          }else{
            if(source.type!=='geo')throw new TargetClarificationError('参照对象没有受支持的图形颜色；画布未修改。')
            props.color=source.props.color
            if(p.property==='fill')props.fill=source.props.fill
            if(p.property==='stroke')props.dash=source.props.dash
          }
        }else{
          if(p.value?.kind!=='color' || p.value.source!=='literal') throw Error('请使用具体的预设颜色。')
          const name=p.value.name==='gray'?'grey':p.value.name
          if(!['red','blue','grey','green','yellow','black','white','orange','violet'].includes(name)) throw Error('当前不支持这个颜色，请使用预设色。')
          if(shape.type==='text') props.color=name
          else if(p.property==='textColor') props.labelColor=name
          else {props.color=name;if(p.property==='fill')props.fill='solid';else if(p.property==='stroke')props.dash='solid'}
        }
      } else throw Error('默认图形暂不支持此属性（如精确圆角或描边像素宽度）。')
    } else throw Error('暂不支持这项操作。')
    this.editor.updateShape({id:shape.id,type:shape.type,props} as Parameters<Editor['updateShape']>[0])
  }
}
