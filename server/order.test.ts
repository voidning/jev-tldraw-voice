import test from 'node:test'
import assert from 'node:assert/strict'
import {interpretWithJev,ClarificationError} from './live/interpret.mjs'
import {interpret as validate} from '../src/jev-validation.js'

const a=(choice:string,confidence=.99)=>({type:'choice',choice,confidence})
/** Only the axes the ordering family actually reads, so each case isolates one mapping. */
const base={decision:a('execute'),valueIntegrity:a('clear'),clauseRelation:a('continuation'),
  operation:a('order'),target:a('current'),explicitType:a('none'),orderRelation:a('alignLeft')}
const shape=(id:string,text:string,ordinal:number)=>({id,kind:'rectangle',text,ordinal,selected:false,focused:false,locked:false,bounds:{x:0,y:0,w:140,h:140}})
const context={pageId:'page:test',activeCount:3,selectedCount:3,selectedMatchesActive:false,
  activeObjects:['rectangle','rectangle','rectangle'],hasAnchor:false,lastEdit:null,
  candidates:[shape('shape:a','开始',1),shape('shape:b','审核',2),shape('shape:c','结束',3)],connections:[]}

const compose=(utterance:string,override:Record<string,unknown>={})=>
  interpretWithJev(utterance,'fake',context,async()=>new Response(JSON.stringify({answers:{...base,...override}})))

test('an alignment request maps the spoken edge onto the tldraw direction',async()=>{
  const expected=[['alignLeft','left'],['alignRight','right'],['alignTop','top'],['alignBottom','bottom']] as const
  for(const [spoken,edge] of expected){
    const result=await compose('让它们对齐',{orderRelation:a(spoken)})
    assert.equal(result.command.operation,'order')
    assert.equal(result.command.operand,'object')
    assert.deepEqual(result.command.parameters.order,{kind:'align',edge},spoken)
  }
})

test('the two centre alignments never collapse into one direction',async()=>{
  const horizontal=await compose('让它们左右居中',{orderRelation:a('alignCenterH')})
  const vertical=await compose('让它们上下居中',{orderRelation:a('alignCenterV')})
  assert.deepEqual(horizontal.command.parameters.order,{kind:'align',edge:'center-horizontal'})
  assert.deepEqual(vertical.command.parameters.order,{kind:'align',edge:'center-vertical'})
})

test('a stacking request maps onto the reorder move, not onto alignment',async()=>{
  const expected=[['layerFront','front'],['layerBack','back'],['layerForward','forward'],['layerBackward','backward']] as const
  for(const [spoken,move] of expected){
    const result=await compose('把它压到最下面',{orderRelation:a(spoken)})
    assert.deepEqual(result.command.parameters.order,{kind:'layer',move},spoken)
  }
})

test('an unclear ordering relation asks instead of picking a direction',async()=>{
  await assert.rejects(()=>compose('把它们弄整齐点',{orderRelation:a('unknown')}),
    (error:any)=>error instanceof ClarificationError)
})

test('lock, unlock and redo compose without a property payload',async()=>{
  const lock=(await compose('把它锁上',{operation:a('lock')})).command
  assert.equal(lock.operation,'lock')
  assert.equal(lock.operand,'object')
  assert.equal(lock.parameters.property,undefined)
  assert.equal(lock.parameters.value,undefined)

  const unlock=(await compose('解锁它',{operation:a('unlock')})).command
  assert.equal(unlock.operation,'unlock')

  const redo=(await compose('重做',{operation:a('redo')})).command
  assert.equal(redo.operation,'redo')
  assert.equal(redo.parameters.property,undefined)
})

test('the protocol accepts well-formed ordering, locking and redo commands',async()=>{
  const payload=(item:unknown)=>({source:'jev',decision:'execute',confidence:.99,command:item})
  const accept=(item:unknown,utterance='让它们左对齐')=>
    validate(utterance,context as any,async()=>({ok:true,status:200,payload:payload(item)}))
  await accept({kind:'edit',operation:'order',operand:'object',target:'current',parameters:{order:{kind:'align',edge:'center-horizontal'}}})
  await accept({kind:'edit',operation:'order',operand:'object',target:'current',parameters:{order:{kind:'layer',move:'back'}}})
  await accept({kind:'edit',operation:'lock',operand:'object',target:'current',parameters:{}})
  await accept({kind:'edit',operation:'unlock',operand:'object',target:'object',parameters:{targetId:'shape:a'}})
  await accept({kind:'edit',operation:'redo',operand:'object',parameters:{}})
  // 撤销可以用「对齐或层叠」限定，说明这两族已经进了同一份能力清单。
  await accept({kind:'edit',operation:'undo',operand:'object',parameters:{expectedLastAction:'order'}})
})

test('the protocol rejects malformed ordering and stacking commands',async()=>{
  const payload=(item:unknown)=>({source:'jev',decision:'execute',confidence:.99,command:item})
  const reject=(item:unknown)=>assert.rejects(()=>validate('让它们左对齐',context as any,async()=>({ok:true,status:200,payload:payload(item)})))
  const order=(parameters:unknown)=>({kind:'edit',operation:'order',operand:'object',target:'current',parameters})
  await reject(order({}))
  await reject(order({order:{kind:'align',edge:'sideways'}}))
  await reject(order({order:{kind:'align'}}))
  await reject(order({order:{kind:'layer',move:'top'}}))
  await reject(order({order:{kind:'layer'}}))
  await reject(order({order:{kind:'spread',edge:'left'}}))
  await reject({kind:'edit',operation:'order',operand:'text',target:'current',parameters:{order:{kind:'align',edge:'left'}}})
  await reject({kind:'edit',operation:'redo',operand:'property',parameters:{}})
  // 撤销的操作限定仍然只接受受支持的操作名。
  await reject({kind:'edit',operation:'undo',operand:'object',parameters:{expectedLastAction:'sideways'}})
  await reject({kind:'edit',operation:'undo',operand:'property',parameters:{expectedLastAction:'order'}})
})
