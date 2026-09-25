import test from 'node:test'
import assert from 'node:assert/strict'
import { interpretWithJev } from './live/interpret.mjs'
import { questions } from './live/questions.mjs'
const answer=(choice:string,confidence=.99)=>({type:'choice',choice,confidence,probabilities:{[choice]:confidence}})
const context={pageId:'page:test',activeCount:0,selectedCount:0,selectedMatchesActive:false,activeObjects:[],hasAnchor:true,lastEdit:{action:'lock'}}
/** 除本题外的答案都取中性值。 */
const blank=(view:string='none')=>({
  ...Object.fromEntries(Object.keys(questions).map(key=>[key,answer('none')])),
  decision:answer('execute'),valueIntegrity:answer('clear'),viewIntent:answer(view)
})
const respond=(answers:Record<string,unknown>)=>async()=>new Response(JSON.stringify({answers,model:'test'}))
/** 多分句会按句依次请求：第一次是整句（判分句关系），之后每个分句一次。 */
const respondInTurn=(list:Record<string,unknown>[])=>{let index=0;return async()=>new Response(JSON.stringify({answers:list[Math.min(index++,list.length-1)],model:'test'}))}

test('a bare undo verb still undoes when the decision layer reads it as giving up',async()=>{
  // 实测：单说“撤销／撤回”时 decision 判 negated 0.82–0.89，同一次请求里 operation 判 undo 0.99–1.00。
  // 两个答案冲突时取更明确的那个——operation 是直接读动词的结果。
  for(const confidence of [.99,1]){
    const answers={...blank(),decision:answer('negated',.9),operation:answer('undo',confidence)}
    const payload=await interpretWithJev('撤销','fake',context,respond(answers))
    assert.deepEqual(payload.command,{kind:'edit',operation:'undo',operand:'object',parameters:{}})
    assert.equal(payload.metrics.modelRequests,1)
  }
})

test('the undo shortcut needs a clear operation, so negated undo requests stay negated',async()=>{
  // 反向指令的 operation 判不出来：实测“不要撤销”redo 0.37／undo 0.34，“别撤回”redo 0.61，“算了”unknown 0.61。
  const cases:[string,number][]=[['redo',.37],['unknown',.61],['undo',.34]]
  for(const [choice,confidence] of cases){
    const answers={...blank(),decision:answer('negated',.9),operation:answer(choice,confidence)}
    await assert.rejects(()=>interpretWithJev('不要撤销','fake',context,respond(answers)),
      `operation=${choice}@${confidence} 不该被当成撤销`)
  }
})

test('an explicit revert answer keeps working without the shortcut',async()=>{
  const answers={...blank(),decision:answer('revert')}
  const payload=await interpretWithJev('撤回刚才那一步','fake',context,respond(answers))
  assert.equal(payload.command.kind,'edit')
  assert.equal(payload.command.operation,'undo')
})

test('a dependent sequence accepts "it" as well as "previous"',async()=>{
  // Jev 把“它”判成 default（由代码映射为 current）与判成 previous 是同一件事的两条路径：
  // 执行层两者都指向 add 之后被选中的那个对象，所以校验接受两者。
  const sentence={...blank(),operation:answer('add'),operand:answer('object'),objectFamily:answer('graphic'),
    shapeKind:answer('circle'),position:answer('here'),clauseRelation:answer('dependent')}
  const step={...blank(),operation:answer('adjust'),attributeCategory:answer('dimensions'),
    attributeDetail:answer('size'),change:answer('increase'),valueKind:answer('step'),target:answer('current')}
  const payload=await interpretWithJev('在这里建一个圆，然后把它放大一点','fake',{},respondInTurn([sentence,sentence,step]))
  assert.equal(payload.command.kind,'sequence')
  assert.equal(payload.command.commands.length,2)
  assert.equal(payload.metrics.modelRequests,3)
})

test('a dependent step that points somewhere else is still rejected',async()=>{
  // 放宽只针对“落在前一步的对象上”。明确指向别的目标（这里按类型指一个已有圆形）不算依赖步骤。
  const sentence={...blank(),operation:answer('add'),operand:answer('object'),objectFamily:answer('graphic'),
    shapeKind:answer('circle'),position:answer('here'),clauseRelation:answer('dependent')}
  const step={...blank(),operation:answer('adjust'),attributeCategory:answer('dimensions'),
    attributeDetail:answer('size'),change:answer('increase'),valueKind:answer('step'),
    target:answer('kind'),explicitType:answer('circle')}
  await assert.rejects(()=>interpretWithJev('在这里建一个圆，然后把圆形放大一点','fake',{},respondInTurn([sentence,sentence,step])))
})
