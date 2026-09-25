import assert from 'node:assert/strict'
import test from 'node:test'
import { compose, parseDistance } from './live/compose.mjs'
import { parseOrderReference } from './live/ordinal.mjs'
import { describeCommand } from '../src/command-description'
import { interpret } from '../src/jev-validation'
import { interpretWithJev, ClarificationError } from './live/interpret.mjs'

/** 方位参照是句中的第三种对象角色：它只给落点或移动定坐标系，自身不被修改。
 *  补上这个槽位之前，「在方形下面建一个圆」和「把第一个移到方形右边」都只能澄清，
 *  而且「把第一个挪到第二个右边」会把参照当成第二个目标 —— 两个一起移动 16px，
 *  不报错。这里锁住的是那条规则：参照先定，再把参照占用的序号从目标序号里剔掉。 */

const candidate = (id: string, kind: string, ordinal: number) => ({
  id, kind, text: '', ordinal, selected: false, focused: false, locked: false,
  bounds: { x: 0, y: 0, w: 100, h: 100 },
})
const context = {
  // 第 1 个是矩形，第 2 个是圆：形状与序号故意错开，好分辨取的是哪一个。
  candidates: [candidate('shape:a', 'rectangle', 1), candidate('shape:b', 'circle', 2)],
  connections: [], pageId: 'page:1', activeCount: 0, selectedCount: 0,
  selectedMatchesActive: false, activeObjects: [], hasAnchor: false, lastEdit: null,
}
const answer = (choice: string) => ({ type: 'choice', choice, confidence: 0.99 })
const answers = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).map(([key, choice]) => [key, answer(choice)]))

test('spoken distance steps replace the silent minimum', () => {
  // 没有数字时旧代码一律退回 16px：「挪远一点」看上去移动了很多，其实只动了一点。
  assert.equal(parseDistance('往右移一点'), null)
  assert.deepEqual(parseDistance('往右多移一点'), { kind: 'length', amount: 80, unit: 'px' })
  assert.deepEqual(parseDistance('把它挪远一点'), { kind: 'length', amount: 80, unit: 'px' })
  assert.deepEqual(parseDistance('往右移一点点'), { kind: 'length', amount: 8, unit: 'px' })
  assert.deepEqual(parseDistance('稍微往左挪一下'), { kind: 'length', amount: 8, unit: 'px' })
  // 精确像素优先，档位不覆盖它。
  assert.deepEqual(parseDistance('往右移100像素'), { kind: 'length', amount: 100, unit: 'px' })
})

test('a named object becomes the placement reference', () => {
  const result = compose(answers({
    operation: 'add', operand: 'object', objectFamily: 'graphic', shapeKind: 'circle',
    position: 'below', target: 'default', explicitType: 'none', placementReference: 'shape:a',creationSizeIntent:'none',creationConstraintScope:'none',
  }), '在方形下面建一个圆', context)
  assert.equal(result.command.operation, 'add')
  assert.deepEqual((result.command as never as { parameters: unknown }).parameters,
    { object: 'circle', position: { kind: 'relative-object', referenceId: 'shape:a', direction: 'below' } })
})

test('a pronoun keeps the existing focus-based path', () => {
  // 代词不需要候选题：参照由会话焦点提供，走的还是相对路径。
  const result = compose(answers({
    operation: 'add', operand: 'object', objectFamily: 'graphic', shapeKind: 'rectangle',
    position: 'below', target: 'current', explicitType: 'none', placementReference: 'none',creationSizeIntent:'none',creationConstraintScope:'none',
  }), '在它下面建一个矩形', context)
  assert.deepEqual((result.command as never as { parameters: unknown }).parameters,
    { object: 'rectangle', position: { kind: 'relative', reference: 'current', direction: 'below' } })
})

test('moving onto a reference carries the reference instead of a pixel offset', () => {
  const result = compose(answers({
    operation: 'move', operand: 'object', target: 'sequence', position: 'right',
    explicitType: 'none', placementReference: 'shape:a',
  }), '把第一个移到方形右边', context)
  const parameters = (result.command as never as { parameters: Record<string, unknown> }).parameters
  assert.deepEqual(parameters.ordinals, [1])
  assert.equal(parameters.referenceId, 'shape:a')
  assert.equal(parameters.distance, undefined)
})

test('the reference stops being counted as a second target', () => {
  // 参照是用序号说的：它占用的那个序号属于方位，不属于目标。
  assert.deepEqual(parseOrderReference('把第一个挪到第二个右边'), { ordinals: [1, 2] })
  const result = compose(answers({
    operation: 'move', operand: 'object', target: 'sequence', position: 'right',
    explicitType: 'none', placementReference: 'shape:b',
  }), '把第一个挪到第二个右边', context)
  const parameters = (result.command as never as { parameters: Record<string, unknown> }).parameters
  assert.deepEqual(parameters.ordinals, [1])
})

test('a reference said by shape does not consume a target ordinal', () => {
  // 「方形」是按形状说的，句中的两个序号都属于目标，一个都不能剔。
  // 参照就是第 1 个矩形本身：它虽然占着序号 1，但这个序号不是它从方位里拿走的。
  const result = compose(answers({
    operation: 'move', operand: 'object', target: 'sequence', position: 'right',
    explicitType: 'none', placementReference: 'shape:a',
  }), '把第一和第二个挪到方形右边', context)
  const parameters = (result.command as never as { parameters: Record<string, unknown> }).parameters
  assert.deepEqual(parameters.ordinals, [1, 2])
})

const edited = (payload: unknown) => async () => ({
  ok: true, status: 200, payload: { decision: 'execute', source: 'jev', confidence: 0.9, command: payload },
})
const command = (operation: string, parameters: object, target?: string) =>
  ({ kind: 'edit', operation, operand: 'object', ...(target ? { target } : {}), parameters })

test('the protocol accepts the new placement reference and rejects a bare move', async () => {
  const placed = await interpret('在方形下面建一个圆', context as never,
    edited(command('add', { object: 'circle', position: { kind: 'relative-object', referenceId: 'shape:a', direction: 'below' } })))
  assert.equal(placed.command.kind, 'edit')

  const moved = await interpret('把第一个移到方形右边', context as never,
    edited(command('move', { ordinals: [1], direction: 'right', referenceId: 'shape:a' }, 'sequence')))
  assert.equal(moved.command.kind, 'edit')

  // 有参照就不需要距离；两者都没有说明模型漏掉了方位，必须拒收。
  await assert.rejects(() => interpret('把第一个移过去', context as never,
    edited(command('move', { ordinals: [1], direction: 'right' }, 'sequence'))))
})

test('an edge-seeking phrase is refused instead of shrinking to the minimum step', () => {
  // 「挪到最右边」说的是位置极值，不是相对位移。没有参照物时旧实现把它落到默认 16 像素上，
  // 看上去执行了、其实只挪了一点点——这比报错更糟，因为它连解释的机会都不给。
  for (const text of ['把第一个挪到最右边', '把它移到最左边', '把第二个挪到最上面', '把它贴到底部'])
    assert.throws(() => compose(answers({
      operation: 'move', operand: 'object', target: 'sequence', explicitType: 'none', position: 'right', placementReference: 'none',
    }), text, context), /极值位置/, text)
  // 有参照物时仍是支持的「移到它旁边」，不因为句中有方位词被误拦。
  const moved = compose(answers({
    operation: 'move', operand: 'object', target: 'sequence', explicitType: 'none', position: 'right',
    placementReference: 'shape:a',
  }), '把第一个移到方形右边', context)
  assert.equal((moved.command as never as { parameters: { referenceId?: string } }).parameters.referenceId, 'shape:a')
})

test('the refusal reaches the speaker as a reason, not as a generic question', async () => {
  // 拒绝文案若被按字段名回放成「你想执行什么操作？」，同一条拒绝就退化成听不清。
  // 用户要知道的是做不到什么，而字段名只供前端分类。
  const spoken = answers({
    operation: 'move', operand: 'object', target: 'sequence', explicitType: 'none',
    position: 'right', placementReference: 'none', decision: 'execute',
    valueIntegrity: 'clear', clauseRelation: 'continuation',
  })
  await assert.rejects(
    () => interpretWithJev('把第一个挪到最右边', 'fake', {}, async () => new Response(JSON.stringify({ answers: spoken }))),
    (error: any) => error instanceof ClarificationError && /极值位置/.test(error.message))
})

test('spoken feedback names where the object goes', () => {
  assert.equal(describeCommand(command('add', { object: 'circle', position: { kind: 'relative-object', referenceId: 'shape:a', direction: 'below' } }) as never),
    '创建圆形，位于参照对象下侧')
  assert.equal(describeCommand(command('add', { object: 'circle', position: { kind: 'relative', reference: 'current', direction: 'right' } }) as never),
    '创建圆形，位于参照对象右侧')
  assert.equal(describeCommand(command('move', { ordinals: [1], direction: 'right', referenceId: 'shape:a' }, 'sequence') as never),
    '把第 1 个对象移到「参照对象」的右侧')
  assert.equal(describeCommand(command('move', { ordinals: [1], direction: 'right', referenceId: 'shape:a' }, 'sequence') as never,
    id => id === 'shape:a' ? '第一个矩形' : id),
  '把第 1 个对象移到「第一个矩形」的右侧')
  // 没有参照时仍按像素位移报告，与用户说的一致。
  assert.equal(describeCommand(command('move', { ordinals: [2], direction: 'left', distance: { kind: 'length', amount: 80, unit: 'px' } }, 'sequence') as never),
    '把第 2 个对象向左移动 80 像素')
})
