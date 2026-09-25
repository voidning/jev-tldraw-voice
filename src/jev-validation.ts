import type {ConversationContext,LiveCommand,ReferenceProperty,Role,Target,ViewTarget} from './live-command';

const targets=new Set<Target>(['current','selected','first','middle','last','all','pageAll','previous','named','sequence','kindAll','kind','object','relation']);
const relationKinds=new Set(['connectedTo','connectedFrom','any']);
const referenceProperties=new Set<ReferenceProperty>(['width','height','color','fill','stroke','textColor']);
const shapeId=(value:any)=>typeof value==='string'&&value.startsWith('shape:');
const roles=new Set<Role>(['primary','secondary','danger']);
const properties=new Set(['size','width','height','cornerRadius','color','fill','stroke','textColor','strokeWidth','layout','semanticRole','componentOverride','content']);
const modes=new Set(['set','increase','decrease','restore']);
const directions=new Set(['left','right','above','below']);
const alignEdges=new Set(['left','right','top','bottom','center-horizontal','center-vertical']);
const layerMoves=new Set(['front','back','forward','backward']);
const viewTargets=new Set<ViewTarget>(['fit','selection']);
const length=(value:any)=>value?.kind==='length'&&value.unit==='px'&&Number.isFinite(value.amount)&&value.amount>=0&&value.amount<=10000;
const textValue=(value:any,transcript:string)=>value?.kind==='text'&&
  typeof value.text==='string'&&value.text.trim().length>0&&value.text.length<=80&&
  Number.isInteger(value.source?.start)&&Number.isInteger(value.source?.end)&&
  value.source.start>=0&&value.source.end>value.source.start&&
  transcript.slice(value.source.start,value.source.end)===value.text;
const colorValue=(value:any)=>value?.kind==='color'&&
  (value.source==='literal'&&(['red','blue','gray','green','yellow','orange','violet','black','white'].includes(value.name)||/^#[0-9a-fA-F]{6}$/.test(value.name))||
    value.source==='semantic'&&['primary','secondary','danger'].includes(value.name));
/** A reference edit copies a supported property of another object; the value is read at execution time. */
const referenceValue=(value:any,property:string)=>value?.kind==='reference'&&
  referenceProperties.has(value.property)&&shapeId(value.targetId)&&
  (value.property===property||['width','height'].includes(property)&&['width','height'].includes(value.property));
/** 连线端点用序号说（「把第一个和第二个连起来」）时两端都是位置编号，由执行层按创建顺序取对象。 */
const ordinalPair=(p:any)=>Number.isInteger(p.fromOrdinal)&&p.fromOrdinal>0&&
  Number.isInteger(p.toOrdinal)&&p.toOrdinal>0&&p.fromOrdinal!==p.toOrdinal;

function validEdit(command:any,transcript:string):boolean{
  const p=command.parameters;
  if(!p||typeof p!=='object'||!['object','text','property'].includes(command.operand))return false;
  if(command.operation==='connect')return command.operand==='object'&&(['pair','pointed'].includes(p.connection)||p.connection==='explicit'&&(ordinalPair(p)||typeof p.fromId==='string'&&p.fromId.startsWith('shape:')&&typeof p.toId==='string'&&p.toId.startsWith('shape:')&&p.fromId!==p.toId&&[p.fromType,p.toType].every(t=>t===undefined||['circle','rectangle','diamond','text'].includes(t))));
  if(command.operation==='undo')return command.operand==='object'&&(p.expectedLastAction===undefined||['add','set','adjust','move','delete','duplicate','arrange','order','connect'].includes(p.expectedLastAction));
  if(command.operation==='redo')return command.operand==='object';
  if(command.operation==='add'&&command.operand==='object')return ['component','circle','rectangle','text','diamond'].includes(p.object)&&
    (p.object!=='component'||p.semantic==='button')&&
    (p.sizeReference===undefined||p.object!=='text'&&p.object!=='component'&&p.sizeReference.kind==='reference-bounds'&&shapeId(p.sizeReference.referenceId)&&['both','width','height'].includes(p.sizeReference.axes))&&
    (p.position?.kind==='anchor'||
      p.position?.kind==='relative'&&targets.has(p.position.reference)&&directions.has(p.position.direction)||
      p.position?.kind==='relative-object'&&shapeId(p.position.referenceId)&&directions.has(p.position.direction))&&
    (p.content===undefined||p.object==='text'&&textValue(p.content,transcript));
  if(!targets.has(command.target))return false;
  if(command.target==='pageAll'&&!(command.operation==='delete'&&command.operand==='object'))return false;
  if(command.target==='object'&&!shapeId(p.targetId))return false;
  if(command.target==='relation'&&(!relationKinds.has(p.relationKind)||!shapeId(p.relationAnchorId)))return false;
  if(command.target==='kind'&&!['circle','rectangle','diamond','text'].includes(p.expectedObject))return false;
  // 「全部方形」必须带种类，否则它和「全部」没有区别，执行层无从知道要收哪一类。
  if(command.target==='kindAll'&&!['circle','rectangle','diamond','text'].includes(p.expectedObject))return false;
  // 两种顺序指代互斥，必须恰好给出一边：明确序号表，或前后一段。
  // 都没有，说明模型选了一个原句里读不到的引用；都有，说明合成出了问题。
  if(command.target==='sequence'){
    const listOk=Array.isArray(p.ordinals)&&p.ordinals.length>=1&&p.ordinals.length<=20&&
      p.ordinals.every((value:any)=>Number.isInteger(value)&&value>=1&&value<=99);
    const rangeOk=Boolean(p.ordinalRange&&['first','last'].includes(p.ordinalRange.edge)&&
      Number.isInteger(p.ordinalRange.count)&&p.ordinalRange.count>=1&&p.ordinalRange.count<=99);
    if(listOk===rangeOk)return false;
  }
  if(p.expectedObject!==undefined&&!['component','circle','rectangle','text','diamond'].includes(p.expectedObject))return false;
  if(p.expectedSemantic!==undefined&&(p.expectedObject!=='component'||p.expectedSemantic!=='button'))return false;
  // Aligning and reordering are one family: a relation between several objects,
  // stated with a direction the executor never has to guess.
  if(command.operation==='order')return command.operand==='object'&&
    (p.order?.kind==='align'&&alignEdges.has(p.order.edge)||p.order?.kind==='layer'&&layerMoves.has(p.order.move));
  if(command.operation==='lock'||command.operation==='unlock')return command.operand==='object';
  if(command.operation==='delete')return command.operand!=='property'||properties.has(p.property);
  if(command.operand==='text'&&['add','set'].includes(command.operation))return textValue(p.value,transcript)&&
    ['center','existing-or-center'].includes(p.placement);
  if(command.operand==='property'&&['add','set','adjust'].includes(command.operation)){
    if(!properties.has(p.property))return false;
    if(command.operation==='add'&&p.property==='stroke')return p.value===undefined||colorValue(p.value);
    if(!modes.has(p.mode))return false;
    if(p.mode==='restore')return p.value===undefined;
    if(['size','width','height','cornerRadius'].includes(p.property))
      return p.value?.kind==='step'&&p.value.count===1||length(p.value)||p.mode==='set'&&referenceValue(p.value,p.property);
    if(p.property==='strokeWidth')return length(p.value);
    if(['color','fill','stroke','textColor'].includes(p.property))return colorValue(p.value)||p.mode==='set'&&referenceValue(p.value,p.property);
    if(p.property==='semanticRole')return p.value?.kind==='role'&&roles.has(p.value.name);
    if(p.property==='layout')return p.value?.kind==='layout'&&['horizontal','vertical'].includes(p.value.direction);
    return false;
  }
  if(command.operation==='duplicate')return command.operand==='object'&&Number.isInteger(p.additional)&&p.additional>=1&&p.additional<=19&&
    ['horizontal','vertical'].includes(p.arrangement);
  // 移到鼠标位置，或按方向移动。方向有两种基准：给像素位移，或给一个参照对象
  // （“移到方形右边”）——后者不需要距离，距离只在没有参照时才必须。
  if(command.operation==='move')return command.operand==='object'&&
    (p.position?.kind==='anchor'||directions.has(p.direction)&&
      (p.referenceId===undefined?length(p.distance):shapeId(p.referenceId)&&(p.distance===undefined||length(p.distance))));
  if(command.operation==='arrange')return command.operand==='object'&&['horizontal','vertical'].includes(p.direction);
  return false;
}

/** Only the current typed protocol is accepted; no legacy command fallback. */
function valid(command:any,transcript:string):command is LiveCommand{
  if(!command||typeof command!=='object')return false;
  if(command.kind==='control')return command.action==='stopListening'||
    command.action==='view'&&viewTargets.has(command.view);
  if(command.kind==='edit')return validEdit(command,transcript);
  if(!['batch','sequence'].includes(command.kind)||!Array.isArray(command.commands)||command.commands.length<2||command.commands.length>3)return false;
  if(!command.commands.every((item:any)=>item?.kind==='edit'&&validEdit(item,transcript)&&item.operation!=='undo'))return false;
  if(command.kind==='batch')return command.commands.every((item:any)=>item.operand==='property'&&['set','adjust'].includes(item.operation));
  // 后续步骤落在前一步刚建的对象上：previous 与 current 在执行层都指向 add 之后被选中的那个对象。
  return command.commands[0].operation==='add'&&['object','property'].includes(command.commands[0].operand)&&command.commands.slice(1).every((item:any)=>['previous','current'].includes(item.target));
}

export type JevReply={ok:boolean;status:number;payload:{command?:unknown;source?:string;confidence?:number;decision?:string;error?:string}};

export async function interpret(text:string,context:ConversationContext,
  request:(text:string,context:ConversationContext)=>Promise<JevReply>):Promise<{command:LiveCommand;confidence:number}>{
  const response=await request(text,context);
  const payload=response.payload;
  if(!response.ok)throw Error(payload.error||`Jev 服务错误（HTTP ${response.status}）。`);
  if(payload.decision!=='execute'||payload.source!=='jev'||typeof payload.confidence!=='number'||payload.confidence<.8||!valid(payload.command,text))
    throw Error('Jev 返回了无效或低置信度的编辑命令，本步未执行。');
  return {command:payload.command,confidence:payload.confidence};
}
