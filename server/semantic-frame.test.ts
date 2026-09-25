import test from 'node:test'
import assert from 'node:assert/strict'
import { interpretWithJev } from './live/interpret.mjs'
import { compose, UncertainChoiceError } from './live/compose.mjs'

const a=(choice:string,confidence=.99)=>({type:'choice' as const,choice,confidence})
const weak=(choice:string)=>a(choice,.6)
const context={hasAnchor:true,candidates:[
  {id:'shape:circle',kind:'circle',ordinal:1,bounds:{x:0,y:0,w:100,h:100}},
  {id:'shape:rectangle',kind:'rectangle',ordinal:2,bounds:{x:200,y:0,w:100,h:100}},
],objectCounts:{circle:1,rectangle:1},ordinalObjectCount:2}
const respond=(answers:Record<string,unknown>)=>async()=>new Response(JSON.stringify({answers}))

test('a certain creation frame supplies the new-object role when the general operand wavers',async()=>{
  const answers={decision:a('execute'),editFrame:a('create'),operation:a('add'),operand:weak('object'),
    objectFamily:a('graphic'),shapeKind:a('circle'),position:a('here'),creationSizeIntent:a('none'),creationConstraintScope:a('none'),
    valueIntegrity:a('clear'),clauseRelation:a('continuation')}
  const result=await interpretWithJev('在这里放一个圆','fake',context,respond(answers))
  assert.deepEqual(result.command,{kind:'edit',operation:'add',operand:'object',parameters:{object:'circle',position:{kind:'anchor'}}})
  await assert.rejects(()=>interpretWithJev('如果在这里放一个圆会怎样？','fake',context,respond({...answers,decision:weak('unrelated')})))
})

test('an independently certain connection frame resolves general action and link-form overlap',async()=>{
  const answers={decision:weak('execute'),editFrame:a('connect'),operation:weak('connect'),
    connection:weak('explicit'),fromObject:a('shape:circle'),toObject:a('shape:rectangle'),
    fromType:a('circle'),toType:a('rectangle'),valueIntegrity:a('clear'),clauseRelation:a('continuation')}
  const result=await interpretWithJev('从圆画条线到矩形','fake',context,respond(answers))
  assert.equal(result.confidence,.99)
  assert.deepEqual(result.command.parameters,{connection:'explicit',fromId:'shape:circle',toId:'shape:rectangle',fromType:'circle',toType:'rectangle'})
  const weakAdd=await interpretWithJev('画一条从圆到矩形的线','fake',context,
    respond({...answers,operation:weak('add'),operand:weak('object')}))
  assert.equal(weakAdd.command.operation,'connect')
  assert.deepEqual(weakAdd.command.parameters,result.command.parameters)
  await assert.rejects(()=>interpretWithJev('从圆画条线到矩形','fake',context,respond({...answers,editFrame:weak('connect')})))
  await assert.rejects(()=>interpretWithJev('画一条从圆到矩形的线','fake',context,
    respond({...answers,operation:a('add')})),/判断相互冲突/)
  for(const choice of ['delete','set','unknown'])
    await assert.rejects(()=>interpretWithJev('画一条从圆到矩形的线','fake',context,
      respond({...answers,operation:weak(choice)})))
  await assert.rejects(()=>interpretWithJev('画一条从圆到矩形的线','fake',context,
    respond({...answers,operation:weak('add'),operand:a('text')})),/判断相互冲突/)
  await assert.rejects(()=>interpretWithJev('不要从圆画条线到矩形','fake',context,respond({...answers,decision:a('negated')})),/否定/)
  await assert.rejects(()=>interpretWithJev('如果从圆画条线到矩形会怎样？','fake',context,respond({...answers,decision:weak('unrelated')})))
})

test('a separate color-part judgment resolves whole color without guessing a value or target',async()=>{
  const answers={decision:a('execute'),editFrame:a('recolor'),operation:a('set'),operand:a('property'),
    attributeCategory:a('color'),attributeDetail:weak('fill'),colorRole:a('whole'),
    valueKind:a('literalColor'),literalColor:a('orange'),target:a('default'),explicitType:a('circle'),
    valueIntegrity:a('clear'),clauseRelation:a('continuation')}
  const result=await interpretWithJev('把圆涂成橙色','fake',context,respond(answers))
  assert.equal(result.command.parameters.property,'color')
  assert.equal(result.command.parameters.value.name,'orange')
  await assert.rejects(()=>interpretWithJev('把圆涂成橙色','fake',context,respond({...answers,colorRole:weak('whole')})))
  await assert.rejects(()=>interpretWithJev('把圆涂成橙色','fake',context,respond({...answers,literalColor:weak('orange')})))
})

test('legacy write/add fallback cannot reinterpret a confident semantic frame',()=>{
  const answers={operation:{...weak('write'),probabilities:{write:.51,add:.49}},editFrame:a('connect')}
  const content={text:'开始',source:{start:7,end:9}}
  assert.throws(()=>compose(answers,'在矩形里加一个开始',context,content),UncertainChoiceError)
  // Requests outside the migrated frames retain their existing text behavior.
  const legacy=compose({...answers,editFrame:a('none')},'在矩形里加一个开始',context,content)
  assert.equal(legacy.command.operation,'set')
  assert.equal(legacy.command.operand,'text')
})

test('confident old operation or operand cannot override a conflicting new frame',async()=>{
  const base={decision:a('execute'),valueIntegrity:a('clear'),clauseRelation:a('continuation')}
  const conflicts=[
    {text:'在矩形里加一个圆',answers:{editFrame:a('create'),operation:a('write'),operand:a('text')}},
    {text:'在矩形里加一个圆',answers:{editFrame:a('create'),operation:a('add'),operand:a('text')}},
    {text:'把圆涂成橙色',answers:{editFrame:a('recolor'),operation:a('set'),operand:a('text')}},
  ]
  for(const {text,answers} of conflicts){
    await assert.rejects(()=>interpretWithJev(text,'fake',context,respond({...base,...answers})),/判断相互冲突/)
    assert.throws(()=>compose({...base,...answers},text,context),UncertainChoiceError)
  }
})

test('recent-object shortcut no longer bypasses the gate for an unframed recolor',async()=>{
  const answers={decision:weak('action'),editFrame:weak('none'),operation:a('set'),operand:a('property'),
    attributeCategory:a('color'),attributeDetail:a('color'),literalColor:a('orange'),
    target:a('last'),explicitType:a('circle'),valueIntegrity:a('clear'),clauseRelation:a('continuation')}
  await assert.rejects(()=>interpretWithJev('把刚才建的圆改成橙色','fake',context,respond(answers)))
  const framed=await interpretWithJev('把刚才建的圆改成橙色','fake',context,
    respond({...answers,editFrame:a('recolor')}))
  assert.equal(framed.command.parameters.property,'color')
})
