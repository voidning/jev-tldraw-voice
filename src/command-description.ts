import type {LiveCommand,EditCommand} from './live-command'
const names:Record<string,string>={circle:'圆形',rectangle:'矩形',diamond:'菱形',text:'独立文字',size:'整体尺寸',width:'宽度',height:'高度',color:'颜色',fill:'填充色',stroke:'描边',textColor:'文字颜色',red:'红色',blue:'蓝色',gray:'灰色',green:'绿色',yellow:'黄色',orange:'橙色',violet:'紫色',black:'黑色',white:'白色',left:'左',right:'右',above:'上',below:'下'}
/** 对齐与层叠的中文说法：方向在前，动作在后，读起来和用户说的一致。 */
const orderNames:Record<string,string>={left:'左对齐',right:'右对齐',top:'顶端对齐',bottom:'底端对齐','center-horizontal':'左右居中','center-vertical':'上下居中',front:'放到最前面',back:'放到最后面',forward:'向上移一层',backward:'向下移一层'}
/** Object ids are only readable once resolved against the live canvas. */
type Resolve=(id:string)=>string
const name=(id:string|undefined,fallback:string,resolve?:Resolve)=>id&&resolve?resolve(id)||fallback:fallback
const relation=(p:EditCommand['parameters'],resolve?:Resolve)=>{
  const object=names[p.expectedObject||'']||'对象',anchor=`「${name(p.relationAnchorId,'指定对象',resolve)}」`
  if(p.relationKind==='connectedFrom')return `${anchor}连到的${object}`
  if(p.relationKind==='any')return `与${anchor}有连线的${object}`
  return `连接到${anchor}的${object}`
}
export function describeCommand(command:LiveCommand,resolve?:Resolve):string{
  if(command.kind==='sequence'||command.kind==='batch')return command.commands.map(item=>describeCommand(item,resolve)).join('；')
  if(command.kind==='control'){
    if(command.action==='stopListening')return '停止麦克风聆听'
    if(command.action==='selectAll')return '选中当前页面全部可选对象'
    return command.view==='selection'?'把镜头对准选中的对象':'把整个画布纳入视野'
  }
  if(command.kind!=='edit')return '更新画布'
  const {operation,operand,parameters:p}=command
  /* 顺序引用有两种形状，读起来要和用户说的一致：「第 1、3 个矩形」「前 3 个对象」。 */
  const typeName=names[p.expectedObject||'']
  const sequence=p.ordinals?.length?`第 ${p.ordinals.join('、')} 个${typeName||'对象'}`
    :p.ordinalRange?`${p.ordinalRange.edge==='first'?'前':'后'} ${p.ordinalRange.count} 个${typeName||'对象'}`
    :'指定序号的对象'
  const target=command.target==='relation'?relation(p,resolve):command.target==='kind'?typeName||'指定图形':command.target==='kindAll'?`全部${typeName||'同类图形'}`:command.target==='object'?'指定对象':command.target==='sequence'?sequence:({first:'第一个对象',last:'最后一个对象',middle:'中间对象',all:'当前对象组',pageAll:'当前页面的全部对象',selected:'选中对象',previous:'上一步对象',current:'当前对象'} as Record<string,string>)[command.target||'current']||'指定对象'
  if(operation==='undo')return '撤销上一步'
  if(operation==='redo')return '重做上一步'
  if(operation==='order'&&p.order)return p.order.kind==='align'?`把${target}${orderNames[p.order.edge]}`:`把${target}${orderNames[p.order.move]}`
  if(operation==='lock')return `锁定${target}`
  if(operation==='unlock')return `解除${target}的锁定`
  if(operation==='connect')return p.connection==='explicit'?`连接指定的${names[p.fromType||'']||'起点'}与${names[p.toType||'']||'终点'}`:p.connection==='pair'?'连接两个对象':'从选中对象连到鼠标所指对象'
  const beside=p.position?.kind==='relative'||p.position?.kind==='relative-object'?p.position.direction:undefined
  if(operation==='add'&&operand==='object')return `创建${names[p.object||'']||'对象'}${p.content?`“${p.content.text}”`:''}${beside?`，位于参照对象${names[beside]}侧`:'，位于鼠标位置'}${p.sizeReference?`，${p.sizeReference.axes==='both'?'宽高':p.sizeReference.axes==='width'?'宽度':'高度'}取自参照对象当前尺寸`:''}`
  if(operation==='delete')return `删除${target}${operand==='text'?'内的文字':operand==='property'?`的${names[p.property||'']}`:''}`
  if(operand==='text'&&p.value?.kind==='text')return `把${target}的文字设为“${p.value.text}”`
  if(operation==='duplicate')return `复制${target}，新增 ${p.additional} 个，${p.arrangement==='vertical'?'纵':'横'}向排列`
  if(operation==='arrange')return `把${target}${p.direction==='vertical'?'纵':'横'}向排列`
  if(operation==='move')return `把${target}${p.position?.kind==='anchor'?'移到鼠标位置':p.referenceId?`移到「${name(p.referenceId,'参照对象',resolve)}」的${names[p.direction||'']}侧`:`向${names[p.direction||'']}移动 ${p.distance?.amount} 像素`}`
  return describeProperty(command,target,resolve)
}
function describeProperty(command:EditCommand,target:string,resolve?:Resolve){
  const p=command.parameters,value=p.value,property=names[p.property||'']||'属性'
  if(value?.kind==='reference')return value.property===p.property
    ?`把${target}的${property}设为与「${name(value.targetId,'参照对象',resolve)}」一致`
    :`把${target}的${property}设为「${name(value.targetId,'参照对象',resolve)}」的${names[value.property]||value.property}`
  if(value?.kind==='color')return `把${target}的${property}设为${names[value.name]||value.name}`
  if(value?.kind==='step')return `把${target}的${property}${p.mode==='decrease'?'缩小 10%':'放大 10%'}`
  if(value?.kind==='length')return `把${target}的${property}${p.mode==='set'?'设为':p.mode==='decrease'?'减少':'增加'} ${value.amount} 像素`
  return `为${target}添加${property}`
}
