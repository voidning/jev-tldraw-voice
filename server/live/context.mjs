const kinds=['circle','rectangle','diamond','text','note','arrow','other'];
const count=n=>Number.isInteger(n)&&n>=0?Math.min(n,10000):0;
// Only the bounded current-page snapshot: no arbitrary metadata or hidden document history.
export function minimalContext(context={}){
  const last=context.lastEdit;
  const candidates=Array.isArray(context.candidates)?context.candidates.slice(0,80).filter(c=>c&&typeof c.id==='string'&&kinds.includes(c.kind)).map(c=>({
    id:c.id.slice(0,120),kind:c.kind,text:typeof c.text==='string'?c.text.slice(0,300):'',ordinal:Number.isInteger(c.ordinal)&&c.ordinal>0?c.ordinal:null,
    style:Object.fromEntries(Object.entries(c.style||{}).filter(([k,v])=>['color','fill','labelColor','dash'].includes(k)&&typeof v==='string').map(([k,v])=>[k,v.slice(0,40)])),
    selected:c.selected===true,focused:c.focused===true,locked:c.locked===true,
    bounds:Object.fromEntries(['x','y','w','h'].map(k=>[k,Number.isFinite(c.bounds?.[k])?c.bounds[k]:0]))
  })):[];
  const ids=new Set(candidates.map(c=>c.id));
  const connections=Array.isArray(context.connections)?context.connections.slice(0,120).filter(c=>ids.has(c.from)&&ids.has(c.to)).map(c=>({from:c.from,to:c.to})):[];
  return {
    candidates,connections,candidatesTruncated:context.candidatesTruncated===true,
    ...(context.clarification&&typeof context.clarification.originalTranscript==='string'&&['action','target','property','creationConstraint','text','number','unit','placement','clauseRelation','placementReference'].includes(context.clarification.field)?{clarification:{originalTranscript:context.clarification.originalTranscript.slice(0,500),field:context.clarification.field}}:{}),
    activeCount:count(context.activeCount),selectedCount:count(context.selectedCount),activeTextCount:count(context.activeTextCount),
    activeObjects:Array.isArray(context.activeObjects)?context.activeObjects.filter(k=>kinds.includes(k)).slice(0,20):[],
    objectCounts:Object.fromEntries(kinds.map(k=>[k,count(context.objectCounts?.[k])])),
    ordinalObjectCount:count(context.ordinalObjectCount),hasAnchor:context.hasAnchor===true,
    lastEdit:last&&['add','delete','set','adjust','duplicate','move','arrange','connect','undo'].includes(last.action)?{
      action:last.action,...(['size','width','height','color','fill','stroke','textColor'].includes(last.property)?{property:last.property}:{}),
      ...( ['increase','decrease','set'].includes(last.mode)?{mode:last.mode}:{})
    }:null,
    priorSteps:Array.isArray(context.priorSteps)?context.priorSteps.slice(0,3).map(c=>({operation:c.operation,operand:c.operand,object:c.parameters?.object,property:c.parameters?.property})):[]
  };
}
export const capabilities={objects:['circle','rectangle','diamond','text'],operations:['add','delete','set','adjust','duplicate','move','arrange','connect','undo','stopListening'],
  properties:['size','width','height','color','fill','stroke','textColor'],colors:['red','blue','gray','green','yellow','orange','violet','black','white'],
  defaults:{relativeSizeStep:'增大10%或缩小10%，仅当未给精确数值而说一点时使用',relativeMove:'未给具体距离时说一点为16像素，说远一点/多一点为80像素，说一点点/稍微为8像素',copyLayout:'未给排列方向时横向'},
  constraints:['只有基础图形和文字支持属性编辑','独立文字仅支持尺寸和文字颜色','尺寸单位只支持 px/像素，不支持百分比、厘米或模糊数字','不能删除尺寸、不能删除文字颜色；可删除文字/对象/填充/描边','复制单个来源，最多新增19个','不支持组件、圆角、精确描边宽度、任意自定义颜色','上下文仅协助指代，不构成执行意图','参照编辑支持宽度、高度、整体颜色、填充、描边和文字颜色；目标、参照、目标属性、来源属性分别确定，宽度和高度可交叉参照，其他属性只支持同属性，执行时读取真实状态','方位参照只用来定位：既可以给新建对象定落点，也可以给移动定方向基准，参照对象自身不被修改']};
/** Fold each connection onto the objects it touches, so Jev never has to join
 *  candidate ids against the connections list itself. Objects that take part in no
 *  connection are omitted, which keeps the candidate criteria small. */
export function connectionLabels(canvas){
  const candidates=canvas.candidates||[],known=new Set(candidates.map(c=>c.id));
  const name=new Map(candidates.map(c=>[c.id,c.text?.trim()||c.kind]));
  const links=new Map();
  const add=(id,key,other)=>{
    const entry=links.get(id)||{连入:[],连出:[]},label=name.get(other)||'未命名对象';
    if(!entry[key].includes(label))entry[key].push(label);
    links.set(id,entry);
  };
  for(const edge of canvas.connections||[]){
    if(known.has(edge.from))add(edge.from,'连出',edge.to);
    if(known.has(edge.to))add(edge.to,'连入',edge.from);
  }
  return links;
}
