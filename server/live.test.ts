import test from 'node:test'
import assert from 'node:assert/strict'
import { collectSpeech, AckQueue } from '../src/voice-queue.js'
import { interpretWithJev } from './live/interpret.mjs'
import { interpret as validate } from '../src/jev-validation.js'
import { questions } from './live/questions.mjs'
const answer=(choice:string)=>({type:'choice',choice,confidence:.99})
test('final speech segments are delivered exactly once, interim text never dispatched',()=>{
  const results=[{isFinal:false,0:{transcript:'加一个'}}]
  const seen=new Set<number>()
  assert.deepEqual(collectSpeech(results,0,seen),{final:[],interim:'加一个'})
  results[0]={isFinal:true,0:{transcript:'加一个圆'}}
  assert.deepEqual(collectSpeech(results,0,seen).final,['加一个圆'])
  assert.deepEqual(collectSpeech(results,0,seen).final,[])
  results.push({isFinal:true,0:{transcript:'大一点'}})
  assert.deepEqual(collectSpeech(results,1,seen).final,['大一点'])
  seen.clear();assert.equal(collectSpeech([results[0]],0,seen).final.length,1)
})
test('queue serializes acknowledgements',()=>{
  const calls:string[]=[];const q=new AckQueue<string>(s=>calls.push(s))
  q.enqueue('create');q.enqueue('resize');assert.deepEqual(calls,['create']);q.finish();assert.deepEqual(calls,['create','resize'])
})
test('migrated Jev protocol composes and validates supported shapes',async()=>{
  const answers=Object.fromEntries(Object.keys(questions).map(k=>[k,answer('none')]))
  Object.assign(answers,{decision:answer('execute'),valueIntegrity:answer('clear'),operation:answer('add'),operand:answer('object'),objectFamily:answer('graphic'),shapeKind:answer('diamond'),position:answer('here')})
  const fakeFetch=async()=>new Response(JSON.stringify({answers,model:'test'}))
  const payload=await interpretWithJev('在这里加一个菱形','fake',{},fakeFetch)
  const context={pageId:'page:test',activeCount:0,selectedCount:0,selectedMatchesActive:false,activeObjects:[],hasAnchor:true,lastEdit:null}
  const result=await validate('在这里加一个菱形',context,async()=>({ok:true,status:200,payload}))
  assert.equal(result.command.kind,'edit')
  answers.operation=answer('unknown')
  await assert.rejects(()=>interpretWithJev('天气如何','fake',{},fakeFetch))
})

test('precise numeric parsing remains deterministic',async()=>{
  const {parseLength,additionalCopies}=await import('./live/compose.mjs')
  assert.deepEqual(parseLength('宽度设为400像素'),{kind:'length',amount:400,unit:'px'})
  assert.equal(additionalCopies('复制两个',1,'additional'),2)
  assert.equal(additionalCopies('复制成三份',1,'total'),2)
  assert.throws(()=>additionalCopies('复制两三个',1,'additional'))
  assert.throws(()=>parseLength('宽度设为20还是30像素'))
})

/** 撤回由 decision 层判定，其余维度一律先填“不明确”，确保下列断言不靠它们通过。 */
const revertAnswers=(overrides:Record<string,unknown>={})=>Object.assign(
  Object.fromEntries(Object.keys(questions).map(k=>[k,answer('none')])),
  {decision:answer('execute'),valueIntegrity:answer('clear'),operation:answer('unknown')},overrides)
const fetchAnswers=(answers:unknown)=>async()=>new Response(JSON.stringify({answers,model:'test'}))

test('撤回已完成的操作合成撤销命令，即使操作维度判不出',async()=>{
  // 回退指向历史，不由操作维度表达：operation=unknown 也必须走撤销。
  const payload=await interpretWithJev('算了','fake',{},fetchAnswers(revertAnswers({decision:answer('revert')})))
  assert.equal(payload.command.operation,'undo')
  assert.equal(payload.command.operand,'object')
})

test('回退语句没有新值，价值歧义不阻止它；但不够明确的回退不执行',async()=>{
  const payload=await interpretWithJev('算了','fake',{},fetchAnswers(revertAnswers({decision:answer('revert'),valueIntegrity:answer('number')})))
  assert.equal(payload.command.operation,'undo')
  const weak=fetchAnswers(revertAnswers({decision:{type:'choice',choice:'revert',confidence:.5}}))
  await assert.rejects(()=>interpretWithJev('算了','fake',{},weak))
})

test('否定不被当作回退',async()=>{
  const negated=fetchAnswers(revertAnswers({decision:answer('negated')}))
  await assert.rejects(()=>interpretWithJev('别画了','fake',{},negated),/否定/)
})

test('画布上刚有操作时，否定提示指出可以撤销；没有可撤操作时不提',async()=>{
  const negated=fetchAnswers(revertAnswers({decision:answer('negated')}))
  const afterEdit={lastEdit:{action:'set',property:'color',mode:'set'}}
  await assert.rejects(()=>interpretWithJev('算了','fake',afterEdit,negated),/撤销/)
  await assert.rejects(()=>interpretWithJev('算了','fake',{lastEdit:null},negated),(error:Error)=>{
    assert.doesNotMatch(error.message,/撤销/);return true
  })
})
