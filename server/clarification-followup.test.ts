import assert from 'node:assert/strict'
import test from 'node:test'
import { interpretWithJev, ClarificationError } from './live/interpret.mjs'

/** 用户报的那句「第二个圆形往下一点」，在真实会话里是接着上一句没说清的追问说的。
 *  那时 canvas.clarification 还挂着，模型会多答一道「本句是补全还是新指令」——
 *  实测它对这道题的把握只有 0.2–0.3（用完整的「把第二个圆形删掉」回答删除澄清时
 *  followup=new 只有 0.30）。旧逻辑要求这一题也必须 ≥0.8，于是把用户刚说清的那句
 *  原样再问一遍「你想操作哪个对象？」，看起来就像系统听不懂。
 *
 *  这一题在合成层只决定一件事：要不要回原句读数值与序号。补全句自带这些时，
 *  它的把握高低不改变结果——真正缺东西的是合成层，由它自己说清缺什么。 */

const candidate = (id: string, kind: string, ordinal: number) => ({
  id, kind, text: '', ordinal, selected: false, focused: false, locked: false,
  bounds: { x: 0, y: 0, w: 100, h: 100 },
})
const canvas = {
  candidates: [candidate('shape:a', 'circle', 1), candidate('shape:b', 'rectangle', 2), candidate('shape:c', 'circle', 3)],
  connections: [], pageId: 'page:1', activeCount: 0, selectedCount: 0,
  selectedMatchesActive: false, activeObjects: [], hasAnchor: false, lastEdit: null,
}
const answer = (choice: string, confidence = 0.99) => ({ type: 'choice', choice, confidence })
const reply = (answers: Record<string, unknown>) => async () => new Response(JSON.stringify({ answers }))
/** 上一句没说清目标，澄清还悬着。 */
const pending = { ...canvas, clarification: { originalTranscript: '把那个删掉', field: 'target' } }

test('a complete sentence answering a pending question is executed, not asked again', async () => {
  const result = await interpretWithJev('把第二个圆形删掉', 'fake', pending, reply({
    decision: answer('execute'), valueIntegrity: answer('clear'), operation: answer('delete'),
    operand: answer('object'), target: answer('sequence'),
    // 模型对「这是补全还是新指令」没有把握——这不该改变结果。
    followup: answer('new', 0.3),
  }))
  assert.deepEqual(result.command, {
    kind: 'edit', operation: 'delete', operand: 'object', target: 'sequence',
    parameters: { expectedObject: 'circle', ordinals: [3] },
  })
})

test('bare ordinal answers inherit the action they are answering', async () => {
  // 只补一个序号是最自然的回答方式：句子里没有动词，decision 会判成 action，
  // 而 operation 在补充对话规则下继承了原请求的动作（实测 delete 0.90）。
  const result = await interpretWithJev('第三个', 'fake', pending, reply({
    decision: answer('action'), valueIntegrity: answer('clear'), operation: answer('delete', 0.9),
    operand: answer('object', 0.9), target: answer('sequence'), explicitType: answer('none'),
    followup: answer('followup', 0.3),
  }))
  assert.deepEqual(result.command.parameters.ordinals, [3])
  assert.equal(result.command.operation, 'delete')
})

test('an answer that is neither a follow-up nor an instruction is still refused', async () => {
  await assert.rejects(
    () => interpretWithJev('今天天气不错', 'fake', pending, reply({
      decision: answer('unrelated'), valueIntegrity: answer('clear'), operation: answer('unknown'),
      followup: answer('unknown'),
    })),
    (error: unknown) => error instanceof ClarificationError && error.field === 'unrelated')
})
