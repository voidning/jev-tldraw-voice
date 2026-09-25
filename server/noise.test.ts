import test from 'node:test'
import assert from 'node:assert/strict'
import {interpretWithJev,ClarificationError} from './live/interpret.mjs'
import {textCandidates} from './live/text-content.mjs'
import {parseLength} from './live/compose.mjs'
import {describeCommand} from '../src/command-description.js'
import {interpret as validate} from '../src/jev-validation.js'
const a=(choice:string,confidence=.99)=>({type:'choice',choice,confidence})
const resize={explicitType:a('rectangle'),decision:a('execute'),valueIntegrity:a('clear'),operation:a('adjust'),operand:a('property'),target:a('kind'),shapeKind:a('rectangle'),attributeCategory:a('dimensions'),attributeDetail:a('size'),change:a('increase'),valueKind:a('step'),clauseRelation:a('continuation')}
const context={pageId:'page:private',activeCount:1,selectedCount:1,selectedMatchesActive:true,activeObjects:['rectangle'] as const,hasAnchor:true,lastEdit:null}
test('one model request for noisy and normal commands, no rewrite or retry; minimal context',async()=>{
 for(const text of ['方形放大一点','方形放达一点','方行大一点','方形，放大，一点']){
  let requests=0
  const result=await interpretWithJev(text,'fake',{...context,secret:'do not send',lastEdit:{action:'adjust',property:'size',mode:'increase',text:'private'}},async(_url:any,init:any)=>{
   requests++;const body=JSON.parse(init.body)
   assert.equal(body.state.utterance,text);assert.equal(body.state.canvas.secret,undefined);assert.equal(body.state.canvas.pageId,undefined);assert.equal(body.state.canvas.lastEdit.text,undefined)
   assert.equal(body.questions.objectFamily.criteria.component,undefined)
   assert.equal(body.questions.attributeDetail.criteria.cornerRadius,undefined)
   assert.ok(body.questions.decision);assert.ok(body.questions.contentSpan)
   return new Response(JSON.stringify({answers:resize}))
  })
  assert.equal(requests,1);assert.equal(result.metrics.modelRequests,1);assert.equal(result.originalTranscript,text)
  assert.equal(result.command.parameters.property,'size');assert.match(describeCommand(result.command),/矩形.*放大 10%/)
 }
})
test('uncertain, negated, unrelated or ambiguous decisions never produce a command or retry',async()=>{
 for(const decision of ['target','property','text','number','unit','negated','unrelated','action']){
  let calls=0
  await assert.rejects(()=>interpretWithJev('含糊转写','fake',{},async()=>{calls++;return new Response(JSON.stringify({answers:{...resize,decision:a(decision)}}))}), (e:any)=>e instanceof ClarificationError&&e.field===decision&&e.metrics.modelRequests===1)
  assert.equal(calls,1)
 }
 for(const answer of [a('execute',.6),undefined,a('execute',NaN)])await assert.rejects(()=>interpretWithJev('大一点','fake',{},async()=>new Response(JSON.stringify({answers:{...resize,decision:answer}}))))
 let calls=0
 await assert.rejects(()=>interpretWithJev('大一点','fake',{},async()=>{calls++;return new Response(JSON.stringify({answers:{...resize,attributeDetail:a('size',.3)}}))}),/属性/)
 assert.equal(calls,1)
})
test('content selected in the same request preserves source, punctuation, homophones and negation',async()=>{
 for(const literal of ['开使','篮色','不要放大，20或30','第二个',"don't 改字"]){
  const text=`  圆形中间写“${literal}”  `;let calls=0
  const span=textCandidates(text).find((s:any)=>s.text===literal)!
  assert.ok(span)
  const result=await interpretWithJev(text,'fake',{},async()=>{calls++;return new Response(JSON.stringify({answers:{decision:a('execute'),valueIntegrity:a('clear'),operation:a('set'),operand:a('text'),target:a('kind'),explicitType:a('circle'),shapeKind:a('circle'),position:a('insideCenter'),contentSpan:a(span.id),clauseRelation:a('continuation')}}))})
  assert.equal(calls,1);assert.equal(result.command.parameters.value.text,literal)
  assert.equal(text.slice(result.command.parameters.value.source.start,result.command.parameters.value.source.end),literal)
  const validContext={...context,activeObjects:['rectangle'] as ('rectangle')[]}
  await validate(text,validContext,async()=>({ok:true,status:200,payload:result}))
  const tampered=structuredClone(result);tampered.command.parameters.value.text='开始'
  await assert.rejects(()=>validate(text,validContext,async()=>({ok:true,status:200,payload:tampered})))
 }
})
test('numeric ambiguity cannot become a guessed length or approximate step',async()=>{
 for(const text of ['宽度设为20还是30像素','宽度设为20','宽度设为20厘米','宽度设为-20像素','宽度设为20像素或30像素'])assert.throws(()=>parseLength(text))
 assert.deepEqual(parseLength('宽度设为200像素'),{kind:'length',amount:200,unit:'px'})
 for(const text of ['放大20','放大百分之十','放大20厘米'])await assert.rejects(()=>interpretWithJev(text,'fake',{},async()=>new Response(JSON.stringify({answers:resize}))))
})
test('a fragment inherits the pending command only after standalone interpretation fails',async()=>{
 const previous='第二个宽度设为20还是30像素'
 let calls=0
 const result=await interpretWithJev('200像素','fake',{...context,clarification:{originalTranscript:previous,field:'number'}},async(_url:any,init:any)=>{
  calls++
  const body=JSON.parse(init.body)
  if(!body.state.canvas.clarification){assert.equal(body.questions.followup,undefined)
   return new Response(JSON.stringify({answers:{decision:a('action'),operation:a('unknown')}}))}
  assert.equal(body.state.canvas.clarification.originalTranscript,previous)
  assert.equal(body.state.utterance,previous)
  assert.equal(body.state.clarificationAnswer,'200像素')
  assert.ok(body.questions.followup)
  return new Response(JSON.stringify({answers:{...resize,followup:a('followup'),operation:a('set'),target:a('sequence'),attributeDetail:a('width'),valueKind:a('length')}}))
 })
 assert.equal(result.clarificationSource,previous);assert.equal(result.originalTranscript,'200像素');
 assert.deepEqual(result.command.parameters.ordinals,[2]);assert.equal(result.command.parameters.value.amount,200);assert.equal(result.metrics.modelRequests,2);assert.equal(calls,2)
 await assert.rejects(()=>interpretWithJev('红色','fake',{clarification:{originalTranscript:previous,field:'number'}},async(_url:any,init:any)=>{
  const body=JSON.parse(init.body)
  return new Response(JSON.stringify({answers:body.state.canvas.clarification
   ?{...resize,followup:a('unknown')}
   :{decision:a('action'),operation:a('unknown')}}))
 }),/数字/)
})
test('write protocol preserves quoted digits; explicit constraints override current target',async()=>{
 const text='在中间写“不要放大，20或30”'
 const span=textCandidates(text).find((s:any)=>s.text==='不要放大，20或30')!
 const result=await interpretWithJev(text,'fake',{},async()=>new Response(JSON.stringify({answers:{decision:a('execute'),operation:a('write'),writePlacement:a('label'),position:a('insideCenter'),target:a('current'),explicitType:a('none'),contentSpan:a(span.id),valueIntegrity:a('clear'),clauseRelation:a('continuation')}})))
 assert.equal(result.command.parameters.value.text,'不要放大，20或30')
 const fetcher=async()=>new Response(JSON.stringify({answers:{...resize,target:a('current')}}))
 const result2=await interpretWithJev('明确类型目标','fake',{activeCount:1,activeObjects:['circle'],objectCounts:{rectangle:2}},fetcher)
 assert.equal(result2.command.target,'kind');assert.equal(result2.command.parameters.expectedObject,'rectangle')

})
test('existing dependent clauses use only their original clause requests, never text/repair retries',async()=>{
 const text='在这里建一个圆，然后在中间写“开始”';let calls=0
 const result=await interpretWithJev(text,'fake',{},async(_url:any,init:any)=>{
  calls++;const request=JSON.parse(init.body),raw=request.state.utterance
  const answers:any={decision:a('execute'),valueIntegrity:a('clear'),clauseRelation:a('dependent')}
  if(raw.includes('然后'))Object.assign(answers,{operation:a('add')})
  else if(raw.includes('建'))Object.assign(answers,{operation:a('add'),operand:a('object'),objectFamily:a('graphic'),shapeKind:a('circle'),position:a('here'),creationSizeIntent:a('none'),creationConstraintScope:a('none')})
  else Object.assign(answers,{operation:a('write'),writePlacement:a('label'),target:a('previous'),explicitType:a('none'),position:a('insideCenter'),contentSpan:a('span_0')})
  return new Response(JSON.stringify({answers}))
 })
 assert.equal(calls,3);assert.equal(result.metrics.modelRequests,3);assert.equal(result.command.kind,'sequence')
 const content=result.command.commands[1].parameters.value
 assert.equal(text.slice(content.source.start,content.source.end),'开始')
})
test('only explicit execute decision and current protocol reach the editor',async()=>{
 const payload:any={source:'jev',decision:'execute',confidence:.99,command:{kind:'edit',operation:'undo',operand:'object',parameters:{}}}
 const request=async()=>({ok:true,status:200,payload})
 await validate('撤销',context as any,request)
 for(const decision of [undefined,'negated','unrelated','clarify']){payload.decision=decision;await assert.rejects(()=>validate('撤销',context as any,request))}
 payload.decision='execute';payload.command={kind:'undo',reason:'explicit'}
 await assert.rejects(()=>validate('撤销',context as any,request))
})
test('color consumes only its supported literal value; stop listening also uses Jev',async()=>{
 const result=await interpretWithJev('颜色请求','fake',{},async()=>new Response(JSON.stringify({answers:{...resize,operation:a('set'),attributeCategory:a('color'),attributeDetail:a('color'),valueKind:a('literalColor',.2),literalColor:a('green')}})))
 assert.equal(result.command.parameters.value.name,'green')
 const stopped=await interpretWithJev('停止聆听','fake',{},async()=>new Response(JSON.stringify({answers:{decision:a('execute'),operation:a('stopListening')}})))
 assert.deepEqual(stopped.command,{kind:'control',action:'stopListening'})
 assert.equal(stopped.metrics.modelRequests,1)
})
