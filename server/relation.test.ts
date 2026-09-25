import test from 'node:test'
import assert from 'node:assert/strict'
import {interpretWithJev,ClarificationError} from './live/interpret.mjs'
import {certainChoice,competingOptions} from './live/compose.mjs'
import {interpret as validate} from '../src/jev-validation.js'
import {relationMatches} from '../src/relation.js'
import {describeCommand} from '../src/command-description.js'

const a=(choice:string,confidence=.99)=>({type:'choice',choice,confidence})
/** Same supporting answers as the noise suite, so these cases differ only in the axis under test. */
const base={decision:a('execute'),valueIntegrity:a('clear'),clauseRelation:a('continuation'),operation:a('adjust'),operand:a('property'),target:a('kind'),explicitType:a('rectangle'),shapeKind:a('rectangle'),attributeDetail:a('size'),change:a('increase'),valueKind:a('step'),referenceSourceProperty:a('same')}
const shape=(id:string,text:string,ordinal:number)=>({id,kind:'rectangle',text,ordinal,selected:false,focused:false,locked:false,bounds:{x:0,y:0,w:140,h:140}})
const context={pageId:'page:test',activeCount:3,selectedCount:0,selectedMatchesActive:false,activeObjects:[],hasAnchor:true,lastEdit:null,
  candidates:[shape('shape:end','结束',1),shape('shape:review','审核',2),shape('shape:start','开始',3)],
  connections:[{id:'shape:arrow',from:'shape:review',to:'shape:end'}]}

test('the confidence gate no longer loosens as the option count grows',()=>{
  const spread=(count:number,top:number)=>({type:'choice',choice:'a',confidence:(count*top-1)/(count-1),
    probabilities:Object.fromEntries([['a',top],...Array.from({length:count-1},(_,i)=>['x'+i,(1-top)/(count-1)])])})
  // 80 options: confidence lands just above the old 0.8 gate while top is only 0.81.
  const many=spread(80,.81)
  assert.ok(many.confidence>=.8,'派生 confidence 会放过它')
  assert.equal(certainChoice(many),false,'top 概率要过与候选项数量无关的下限')
  // Few options never became looser, and clear winners still pass either way.
  assert.equal(certainChoice(spread(2,.9)),true)
  assert.equal(certainChoice(spread(80,.95)),true)
})

test('answers without a distribution keep the previous confidence-only behaviour',()=>{
  assert.equal(certainChoice(a('execute',.9)),true)
  assert.equal(certainChoice(a('execute',.5)),false)
  assert.equal(certainChoice(undefined),false)
})

test('competing options expose only a real near-tie',()=>{
  assert.deepEqual(competingOptions({type:'choice',choice:'a',confidence:.9,probabilities:{a:.6,b:.3,c:.1}}),['a','b'])
  assert.equal(competingOptions(a('execute',.9)),undefined)
})

test('an uncertain judgment asks about the two most likely readings',async()=>{
  const answers={...base,explicitType:{type:'choice',choice:'rectangle',confidence:.4,
    probabilities:{rectangle:.35,diamond:.3,circle:.2,text:.1,none:.05}}}
  let calls=0
  await assert.rejects(()=>interpretWithJev('含糊的目标','fake',context,async()=>{calls++;return new Response(JSON.stringify({answers}))}),
    (error:any)=>error instanceof ClarificationError&&error.field==='target'&&/矩形/.test(error.message)&&/菱形/.test(error.message))
  assert.equal(calls,1,'澄清仍然只用一次请求')
})

test('a connection-qualified target becomes a relation query instead of a chosen id',async()=>{
  const answers={...base,target:a('object'),explicitType:a('rectangle'),relationKind:a('connectedTo'),relationAnchor:a('shape:end'),targetObject:a('shape:review')}
  const result=await interpretWithJev('把连到结束的那个方框放大一点','fake',context,async()=>new Response(JSON.stringify({answers})))
  assert.equal(result.command.target,'relation')
  assert.equal(result.command.parameters.relationAnchorId,'shape:end')
  assert.equal(result.command.parameters.relationKind,'connectedTo')
  assert.equal(result.command.parameters.expectedObject,'rectangle')
  assert.equal(result.command.parameters.targetId,undefined,'不再依赖模型直接挑一个对象 ID')
})

test('the relation axis reaches Jev with the real connections folded onto each candidate',async()=>{
  await interpretWithJev('把连到结束的方框放大一点','fake',context,async(_url:any,init:any)=>{
    const body=JSON.parse(init.body)
    const criteria=body.questions.relationAnchor.criteria
    assert.deepEqual(criteria['shape:review']['连出'],['结束'],'审核 连出到 结束')
    assert.deepEqual(criteria['shape:end']['连入'],['审核'])
    assert.equal(criteria['shape:start'],undefined,'没有连线的对象不进锚点候选')
    assert.ok(body.questions.relationKind&&body.questions.propertyReference)
    assert.ok(body.questions.attributeDetail&&body.questions.creationSizeIntent)
    assert.equal(body.questions.attributeCategory,undefined,'属性只由一个问题判断')
    assert.equal(body.questions.creationConstraintScope,undefined,'创建约束只由一个问题判断')
    return new Response(JSON.stringify({answers:base}))
  })
})

test('a reference edit carries the reference object instead of a spoken number',async()=>{
  const answers={...base,operation:a('set'),attributeDetail:a('width'),referenceIntent:a('yes'),propertyReference:a('shape:start'),propertyEditTarget:a('shape:review')}
  const result=await interpretWithJev('把宽度调成和开始一样','fake',context,async()=>new Response(JSON.stringify({answers})))
  assert.deepEqual(result.command.parameters.value,{kind:'reference',property:'width',targetId:'shape:start'})
  assert.equal(result.command.target,'object')
  assert.equal(result.command.parameters.targetId,'shape:review')
  assert.equal(result.command.parameters.mode,'set')
})

test('reference editing separates modified target and value source, including spoken ordinals',async()=>{
  const answers={...base,operation:a('set'),attributeDetail:a('width'),referenceIntent:a('yes'),
    target:a('sequence'),propertyEditTarget:a('shape:review'),propertyReference:a('shape:start')}
  for(const text of ['把第二个的宽度调成和第三个一样','把第二个的宽度调成和“第三个”一样']){
    const result=await interpretWithJev(text,'fake',context,async()=>new Response(JSON.stringify({answers})))
    assert.equal(result.command.target,'object')
    assert.equal(result.command.parameters.targetId,'shape:review')
    assert.equal(result.command.parameters.value.targetId,'shape:start')
    assert.equal(result.command.parameters.ordinals,undefined)
    await validate(text,context as never,async()=>({ok:true,status:200,payload:{source:'jev',decision:'execute',confidence:.99,command:result.command}}))
  }
  for(const role of ['propertyEditTarget','propertyReference'])
    await assert.rejects(()=>interpretWithJev('把第二个的宽度调成和第三个一样','fake',context,
      async()=>new Response(JSON.stringify({answers:{...answers,[role]:a('unknown')}}))),ClarificationError)
  await assert.rejects(()=>interpretWithJev('把第二个的宽度调成和第三个一样','fake',context,
    async()=>new Response(JSON.stringify({answers:{...answers,propertyReference:a('shape:review')}}))),/参照对象不能是要修改的对象自身/)
})

test('reference edits use the same target/source roles for color and reject unsupported property pairs',async()=>{
  const answers={...base,operation:a('set'),attributeDetail:a('color'),
    referenceIntent:a('yes'),propertyEditTarget:a('shape:review'),propertyReference:a('shape:start')}
  const text='把审核的颜色改成和开始一样'
  const result=await interpretWithJev(text,'fake',context,async()=>new Response(JSON.stringify({answers})))
  assert.deepEqual(result.command.parameters.value,{kind:'reference',property:'color',targetId:'shape:start'})
  assert.equal(result.command.parameters.targetId,'shape:review')
  await validate(text,context as never,async()=>({ok:true,status:200,payload:{source:'jev',decision:'execute',confidence:.99,command:result.command}}))
  await assert.rejects(()=>validate(text,context as never,async()=>({ok:true,status:200,payload:{source:'jev',decision:'execute',confidence:.99,
    command:{...result.command,parameters:{...result.command.parameters,value:{...result.command.parameters.value,property:'fill'}}}}})))
})

test('unsupported reference properties are refused instead of approximated',async()=>{
  const answers={...base,operation:a('set'),attributeDetail:a('size'),referenceIntent:a('yes'),propertyReference:a('shape:start'),propertyEditTarget:a('shape:review')}
  await assert.rejects(()=>interpretWithJev('把宽度调成和开始一样','fake',context,async()=>new Response(JSON.stringify({answers}))),
    (error:any)=>error instanceof ClarificationError)
})

test('a reference can supply width to the target height without guessing from the target property',async()=>{
  const answers={...base,operation:a('set'),attributeDetail:a('height'),referenceIntent:a('yes'),
    referenceSourceProperty:a('width'),propertyReference:a('shape:start'),propertyEditTarget:a('shape:review')}
  const text='把审核的高度改成和开始的宽度一样'
  const result=await interpretWithJev(text,'fake',context,async()=>new Response(JSON.stringify({answers})))
  assert.equal(result.command.parameters.property,'height')
  assert.deepEqual(result.command.parameters.value,{kind:'reference',property:'width',targetId:'shape:start'})
  assert.match(describeCommand(result.command as never),/高度设为「参照对象」的宽度/)
  await validate(text,context as never,async()=>({ok:true,status:200,payload:{source:'jev',decision:'execute',confidence:.99,command:result.command}}))
  await assert.rejects(()=>interpretWithJev(text,'fake',context,async()=>new Response(JSON.stringify({answers:{...answers,
    referenceSourceProperty:a('unknown')}}))),ClarificationError)
  await assert.rejects(()=>interpretWithJev(text,'fake',context,async()=>new Response(JSON.stringify({answers:{...answers,
    referenceSourceProperty:a('color')}}))),/其他跨属性参照尚未支持/)
})

test('same and an explicit source property are equivalent when both name the target property',async()=>{
  const answers={...base,operation:a('set'),attributeDetail:a('width'),referenceIntent:a('yes'),
    referenceSourceProperty:{type:'choice',choice:'width',confidence:.49,probabilities:{width:.56,same:.44}},
    propertyReference:a('shape:start'),propertyEditTarget:a('shape:review')}
  const result=await interpretWithJev('把审核的宽度改成和开始一样','fake',context,
    async()=>new Response(JSON.stringify({answers})))
  assert.deepEqual(result.command.parameters.value,{kind:'reference',property:'width',targetId:'shape:start'})
})

test('a complete new reference request cannot inherit a pending property clarification',async()=>{
  const pending={...context,clarification:{originalTranscript:'把审核的高度改成和开始的填充一样',field:'property'}}
  const answers={...base,decision:a('execute'),operation:a('set'),attributeDetail:a('fill'),
    referenceIntent:a('yes'),referenceSourceProperty:a('width'),propertyReference:a('shape:start'),
    propertyEditTarget:a('shape:review')}
  let calls=0
  await assert.rejects(()=>interpretWithJev('把审核的填充改成和开始的宽度一样','fake',pending,
    async(_url:any,init:any)=>{
      calls++
      const body=JSON.parse(init.body)
      assert.equal(body.state.canvas.clarification,undefined,'完整新指令先独立解释')
      return new Response(JSON.stringify({answers}))
    }),/其他跨属性参照尚未支持/)
  assert.equal(calls,1,'新指令不能退回旧澄清上下文后被改写')
})

test('the spoken connection direction decides which objects qualify',()=>{
  // 审核 → 结束
  const edges=[{from:'shape:review',to:'shape:end'},{from:'shape:start',to:'shape:loop'}]
  assert.equal(relationMatches(edges,'shape:review','shape:end','connectedTo'),true,'目标连向锚点')
  assert.equal(relationMatches(edges,'shape:review','shape:end','connectedFrom'),false,'方向说反了就不该匹配')
  assert.equal(relationMatches(edges,'shape:review','shape:end','any'),true,'未表达方向时任一方向都算')
  assert.equal(relationMatches(edges,'shape:end','shape:review','connectedFrom'),true,'换成锚点视角，同一根箭头仍然成立')
  assert.equal(relationMatches(edges,'shape:end','shape:review','connectedTo'),false)
  assert.equal(relationMatches(edges,'shape:end','shape:end','any'),false,'锚点不能是自己')
  assert.equal(relationMatches(edges,'shape:start','shape:end','any'),false,'无关对象不匹配')
})

test('the protocol accepts a well-formed relation query and rejects malformed ones',async()=>{
  const command:any={kind:'edit',operation:'set',operand:'property',target:'relation',
    parameters:{property:'width',mode:'set',value:{kind:'reference',property:'width',targetId:'shape:start'},
      relationAnchorId:'shape:end',relationKind:'connectedTo',expectedObject:'rectangle'}}
  const payload=(item:unknown)=>({source:'jev',decision:'execute',confidence:.99,command:item})
  await validate('把宽度调成和开始一样',context as any,async()=>({ok:true,status:200,payload:payload(command)}))
  const broken=[
    {...command,parameters:{...command.parameters,relationKind:'sideways'}},
    {...command,parameters:{...command.parameters,relationAnchorId:'end'}},
    {...command,parameters:{...command.parameters,relationAnchorId:undefined}},
    {...command,parameters:{...command.parameters,value:{kind:'reference',property:'fill',targetId:'shape:start'}}},
    {...command,parameters:{...command.parameters,value:{kind:'reference',property:'width',targetId:'start'}}},
    {...command,parameters:{...command.parameters,mode:'increase'}},
  ]
  for(const item of broken)await assert.rejects(()=>validate('把宽度调成和开始一样',context as any,async()=>({ok:true,status:200,payload:payload(item)})))
})
