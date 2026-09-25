import assert from 'node:assert/strict'
import test from 'node:test'
import { compose } from './live/compose.mjs'
import { parseOrdinalSequence } from './live/ordinal.mjs'
import { interpret as validate } from '../src/jev-validation'

/** 连线用序号说（「把第一个和第二个连起来」「把第二个连到第一个」）时，两端都是位置编号，
 *  而 fromObject/toObject 只认画布候选 ID —— 模型只能去猜一个 ID，于是卡在端点类型题上
 *  （实测澄清成「你是指「矩形」还是「未明确类型」？」）。这里锁住三件事：两个序号就足以
 *  定下两端、起点终点按原句出现顺序而不是升序、没有序号时仍走原来的候选 ID 路径。 */

const candidate = (id: string, kind: string, ordinal: number) => ({
  id, kind, text: '', ordinal, selected: false, focused: false, locked: false,
  bounds: { x: 0, y: 0, w: 140, h: 140 },
})
const context = {
  candidates: [candidate('shape:a', 'rectangle', 1), candidate('shape:b', 'circle', 2), candidate('shape:c', 'diamond', 3)],
  connections: [], pageId: 'page:1', activeCount: 0, selectedCount: 0, selectedMatchesActive: false,
  activeObjects: [], hasAnchor: false, lastEdit: null,
}
const answer = (choice: string, confidence = 0.99) => ({ type: 'choice', choice, confidence })
const answers = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).map(([key, choice]) => [key, answer(choice)]))
const parameters = (result: { command: unknown }) => (result.command as { parameters: Record<string, unknown> }).parameters

test('two ordinals connect the objects carrying those numbers', () => {
  const result = compose(answers({ operation: 'connect' }), '把第一个和第二个连起来', context)
  assert.equal(result.command.operation, 'connect')
  assert.deepEqual(parameters(result), { connection: 'explicit', fromOrdinal: 1, toOrdinal: 2 })
})

test('the spoken order is the arrow direction, not the sorted number order', () => {
  // parseOrderReference 会去重升序，那是集合语义；连线要的是路径语义，起点必须留在起点。
  const result = compose(answers({ operation: 'connect' }), '把第二个连到第一个', context)
  assert.deepEqual(parameters(result), { connection: 'explicit', fromOrdinal: 2, toOrdinal: 1 })
})

test('the sequence keeps the spoken order before any dedup or sort', () => {
  assert.deepEqual(parseOrdinalSequence('把第二个连到第一个'), [2, 1])
  assert.deepEqual(parseOrdinalSequence('把第一个和第二个连起来'), [1, 2])
  assert.deepEqual(parseOrdinalSequence('把第三和第一个连起来'), [3, 1])
  assert.equal(parseOrdinalSequence('把圆连到矩形'), undefined)
})

test('a connection without two ordinals still resolves by candidate id', () => {
  // 只有一个序号时不能说清两端，仍走原来的候选 ID 路径，序号不能冒充端点。
  const result = compose(answers({
    operation: 'connect', connection: 'explicit', fromObject: 'shape:a', toObject: 'shape:b',
    fromType: 'none', toType: 'none',
  }), '把第一个矩形连到圆形', context)
  assert.deepEqual(parameters(result), { connection: 'explicit', fromId: 'shape:a', toId: 'shape:b' })
})

const edited = (payload: unknown) => async () => ({
  ok: true, status: 200, payload: { decision: 'execute', source: 'jev', confidence: 0.9, command: payload },
})
test('the protocol accepts ordinal endpoints and a duplicate pair is not a path', async () => {
  const ok = await validate('把第一个和第二个连起来', context as never, edited({
    kind: 'edit', operation: 'connect', operand: 'object',
    parameters: { connection: 'explicit', fromOrdinal: 1, toOrdinal: 2 },
  }))
  assert.equal(ok.command.operation, 'connect')
  await assert.rejects(() => validate('把第一个连到第一个', context as never, edited({
    kind: 'edit', operation: 'connect', operand: 'object',
    parameters: { connection: 'explicit', fromOrdinal: 1, toOrdinal: 1 },
  })))
})
