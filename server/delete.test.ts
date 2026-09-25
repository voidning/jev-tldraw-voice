import assert from 'node:assert/strict'
import test from 'node:test'
import { compose } from './live/compose.mjs'
import { describeCommand } from '../src/command-description'
import { interpret as validate } from '../src/jev-validation'
import { interpretWithJev } from './live/interpret.mjs'

/** 「把第三个删除」把序号指代带进了删除。删除是这里唯一不可逆的操作，所以这条链路上
 *  取值必须全部来自原句、类型与序号必须互不代偿，含糊时宁可澄清也不能删错对象。
 *  同时锁住另一条边界：近指历史对象的句子（“把刚才建的删掉”）在整句意图题摇摆时
 *  由操作维度放行，而不含近指词的含糊句仍必须被拦下。 */

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

test('a spoken ordinal deletes the object carrying that number', () => {
  for (const text of ['把第三个删除', '删掉第三个', '第三个删了'])
    assert.deepEqual(parameters(compose(answers({ operation: 'delete', operand: 'object', target: 'sequence', explicitType: 'none' }), text, context)),
      { ordinals: [3] }, text)
})

test('several ordinals and a spoken range delete together', () => {
  // 并列时量词只在最后一项出现，两个序号都要留下。
  assert.deepEqual(parameters(compose(answers({ operation: 'delete', operand: 'object', target: 'sequence', explicitType: 'none' }), '把第二和第三个都删掉', context)),
    { ordinals: [2, 3] })
  assert.deepEqual(parameters(compose(answers({ operation: 'delete', operand: 'object', target: 'sequence', explicitType: 'none' }), '把前两个删了', context)),
    { ordinalRange: { edge: 'first', count: 2 } })
})

test('a whole type is reachable without ordinals', () => {
  const result = compose(answers({ operation: 'delete', operand: 'object', target: 'kindAll', explicitType: 'rectangle' }), '删除全部方形', context)
  assert.equal(result.command.target, 'kindAll')
  assert.deepEqual(parameters(result), { expectedObject: 'rectangle' })
})

test('wiping the canvas deletes every object, not just the focused one', () => {
  // 「清空画布」把画布本身当宾语。实测三种说法里两种澄清、一种被模型读成「没有引用限定」
  // 而落到当前焦点上——那是静默只删一个对象，用户却以为画布空了。
  for (const text of ['清空画布', '清空所有内容', '把画布清空'])
    assert.equal(compose(answers({ operation: 'delete', operand: 'object', target: 'default', explicitType: 'none' }), text, context).command.target, 'pageAll', text)
  assert.equal(compose(answers({ operation: 'delete', operand: 'object', target: 'default', explicitType: 'none' }), '全部删除', context).command.target, 'pageAll')
  // 带序号或图形名限定的“清空”说的是那个对象，不能被当成清空画布。
  assert.deepEqual(parameters(compose(answers({ operation: 'delete', operand: 'object', target: 'sequence', explicitType: 'none' }), '把第三个清空', context)),
    { ordinals: [3] })
  assert.deepEqual(parameters(compose(answers({ operation: 'delete', operand: 'object', target: 'kindAll', explicitType: 'rectangle' }), '清空所有方形', context)),
    { expectedObject: 'rectangle' })
})

test('deleting a property or the text inside keeps the same ordinal', () => {
  const filled = compose(answers({ operation: 'delete', operand: 'property', target: 'sequence', explicitType: 'none', attributeCategory: 'color', attributeDetail: 'fill' }), '把第三个的填充删掉', context)
  assert.equal(filled.command.operand, 'property')
  assert.deepEqual(parameters(filled), { property: 'fill', ordinals: [3] })
  const written = compose(answers({ operation: 'delete', operand: 'text', target: 'sequence', explicitType: 'none' }), '把第二个里写的字删掉', context)
  assert.equal(written.command.operand, 'text')
  assert.deepEqual(parameters(written), { ordinals: [2] })
})

test('spoken feedback for a delete names the numbers that were said', () => {
  assert.equal(describeCommand({ kind: 'edit', operation: 'delete', operand: 'object', target: 'sequence', parameters: { ordinals: [2, 3] } } as never), '删除第 2、3 个对象')
  assert.equal(describeCommand({ kind: 'edit', operation: 'delete', operand: 'object', target: 'kindAll', parameters: { expectedObject: 'rectangle' } } as never), '删除全部矩形')
})

const edited = (payload: unknown) => async () => ({
  ok: true, status: 200, payload: { decision: 'execute', source: 'jev', confidence: 0.9, command: payload },
})
test('the protocol accepts a resolveable ordinal delete and rejects a guessed one', async () => {
  const ok = await validate('把第三个删除', context as never,
    edited({ kind: 'edit', operation: 'delete', operand: 'object', target: 'sequence', parameters: { ordinals: [3] } }))
  assert.equal(ok.command.kind, 'edit')
  // 选了 sequence 却没有从原句读到序号：模型自己挑了一个引用，不能执行。
  await assert.rejects(() => validate('把那个删除', context as never,
    edited({ kind: 'edit', operation: 'delete', operand: 'object', target: 'sequence', parameters: {} })))
  // 「全部」必须带种类，否则和「全部对象」无法区分。
  await assert.rejects(() => validate('全部删除', context as never,
    edited({ kind: 'edit', operation: 'delete', operand: 'object', target: 'kindAll', parameters: {} })))
  await validate('清空画布', context as never,
    edited({ kind: 'edit', operation: 'delete', operand: 'object', target: 'pageAll', parameters: {} }))
  await assert.rejects(() => validate('全部改红', context as never,
    edited({ kind: 'edit', operation: 'set', operand: 'property', target: 'pageAll', parameters: { property: 'color', mode: 'set', value: { kind: 'color', name: 'red', source: 'literal' } } })))
})

const undecidedDelete = {
  decision: answer('action', 0.5), operation: answer('delete'), operand: answer('object'),
  target: answer('last'), explicitType: answer('none'), valueIntegrity: answer('clear'),
  clauseRelation: answer('continuation'),
}
const reply = (values: object) => async () => new Response(JSON.stringify({ answers: values }))
test('a recent object survives an undecided intent gate, a bare one still waits', async () => {
  // “刚才建的”会让整句意图在「编辑它」和「收回那一步」之间摇摆（实测 execute 0.42–0.76），
  // 操作维度却稳定判出删除；句中确实有近指历史对象的说法时按编辑请求走。
  for (const text of ['把刚才建的删掉', '删掉刚画的那个', '把上一个删了']) {
    const payload = await interpretWithJev(text, 'fake', {}, reply(undecidedDelete) as never)
    assert.equal((payload.command as { operation: string }).operation, 'delete', text)
  }
  // 不含近指词的句子照旧交给整句意图决定：含糊就是澄清，不许反过来被操作维度推翻。
  await assert.rejects(() => interpretWithJev('把那个删掉', 'fake', {}, reply(undecidedDelete) as never))
  // 疑问句不因为带“刚”就被执行。
  await assert.rejects(() => interpretWithJev('把刚建的那个删了？', 'fake', {}, reply(undecidedDelete) as never))
})
