import test from 'node:test'
import assert from 'node:assert/strict'
import { interpretWithJev } from './live/interpret.mjs'
import { interpret as validate } from '../src/jev-validation.js'
import { describeCommand } from '../src/command-description.js'
import { questions } from './live/questions.mjs'
const answer=(choice:string,confidence=.99)=>({type:'choice',choice,confidence})
const context={pageId:'page:test',activeCount:0,selectedCount:0,selectedMatchesActive:false,activeObjects:[],hasAnchor:true,lastEdit:null}
/** 除视图题外的全部答案都取中性值：视图短路不该读它们中的任何一个。 */
const blank=(view:'fit'|'selection'|'none'|'unknown',confidence=.99)=>({
  ...Object.fromEntries(Object.keys(questions).map(key=>[key,answer('none')])),
  decision:answer('execute'),valueIntegrity:answer('clear'),viewIntent:answer(view,confidence)
})
/** 一条普通的新建指令，用来证明视图轴不命中时既有流程完全不变。 */
const createAnswers={...blank('none'),operation:answer('add'),operand:answer('object'),objectFamily:answer('graphic'),shapeKind:answer('diamond'),position:answer('here')}
const respond=(answers:Record<string,unknown>)=>async()=>new Response(JSON.stringify({answers,model:'test'}))

test('a clear request to frame the whole page short-circuits before every edit dimension',async()=>{
  const payload=await interpretWithJev('看全部','fake',{},respond(blank('fit')))
  assert.deepEqual(payload.command,{kind:'control',action:'view',view:'fit'})
  // 一条原子指令仍只发一次请求：视图判定不引入第二次往返。
  assert.equal(payload.metrics.modelRequests,1)
  const result=await validate('看全部',context,async()=>({ok:true,status:200,payload}))
  assert.deepEqual(result.command,{kind:'control',action:'view',view:'fit'})
})

test('a request to frame only the selection stays a distinct view target',async()=>{
  const payload=await interpretWithJev('只看选中的那个','fake',{},respond(blank('selection')))
  assert.deepEqual(payload.command,{kind:'control',action:'view',view:'selection'})
})

test('the view axis is exempt from the "is this an edit request" gate',async()=>{
  // “看全部”本身不含编辑动作，decision 完全可能判成含糊或与画布无关。
  // 视图请求不要求先通过这一关，否则这句话永远走不到短路。
  for(const undecided of ['action','unrelated']){
    const answers={...blank('fit'),decision:answer(undecided)}
    const payload=await interpretWithJev('看全部','fake',{},respond(answers))
    assert.deepEqual(payload.command,{kind:'control',action:'view',view:'fit'})
  }
})

test('the exemption does not leak into ordinary commands',async()=>{
  // 视图轴未命中时，含糊的 decision 必须照旧被拦下——豁免只属于视图请求本身。
  const answers={...createAnswers,viewIntent:answer('none'),decision:answer('action')}
  await assert.rejects(()=>interpretWithJev('在这里加一个菱形','fake',{},respond(answers)))
})

test('a view command keeps its own confidence instead of inheriting the edit gate',async()=>{
  const answers={...blank('fit'),decision:answer('execute',.82)}
  const payload=await interpretWithJev('看全部','fake',{},respond(answers))
  assert.equal(payload.confidence,.99)
})

test('an unclear or absent view intent leaves the normal flow untouched',async()=>{
  // unknown 和低置信都不该短路：前者走到操作维度自然澄清，后者按未命中处理。
  for(const [view,confidence] of [['unknown',.99],['fit',.6]] as const){
    const answers={...createAnswers,viewIntent:answer(view,confidence)}
    const payload=await interpretWithJev('在这里加一个菱形','fake',{},respond(answers))
    assert.equal(payload.command.kind,'edit','视图轴不该吞掉正常指令')
    assert.equal(payload.command.operation,'add')
  }
})

test('the protocol accepts exactly the two view targets and nothing else',async()=>{
  const accepts=async(command:unknown)=>{
    const payload={command,source:'jev',confidence:.99,decision:'execute'}
    return validate('看全部',context,async()=>({ok:true,status:200,payload}))
  }
  await accepts({kind:'control',action:'view',view:'fit'})
  await accepts({kind:'control',action:'view',view:'selection'})
  const broken:unknown[]=[
    {kind:'control',action:'view',view:'zoom'},      // 未支持的取景方式
    {kind:'control',action:'view'},                  // 缺少取景目标
    {kind:'control',action:'view',view:null},
    {kind:'control',action:'pan'},                   // 未支持的控制动作
  ]
  for(const command of broken)await assert.rejects(()=>accepts(command),'必须拒绝')
})

test('the spoken feedback names the view it understood',()=>{
  assert.equal(describeCommand({kind:'control',action:'view',view:'fit'}),'把整个画布纳入视野')
  assert.equal(describeCommand({kind:'control',action:'view',view:'selection'}),'把镜头对准选中的对象')
  assert.equal(describeCommand({kind:'control',action:'stopListening'}),'停止麦克风聆听')
})
