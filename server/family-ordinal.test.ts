import assert from 'node:assert/strict'
import test from 'node:test'
import { compose } from './live/compose.mjs'
import { parseFamilyOrdinals } from './live/ordinal.mjs'

/** 「第二个圆形」在「圆·矩·圆」这块画布上曾经走不通：序号按画布位置取到第 2 个（矩形），
 *  形状名又要求它是圆形，两条约束互相打架——模型在目标题上摇摆，最后回一句
 *  「你想操作哪个对象？」，而序号与形状名其实是同一个名词短语的两半：序数数的就是
 *  它后面那个形状名的同类（第 2 个圆形＝画布上第 3 个）。
 *
 *  换算由代码做，不经过模型。只有一种读法说得通时才动；两种读法都成立却指向不同对象时
 *  如实摆出来让用户一句话定，绝不替用户挑。 */

const candidate = (id: string, kind: string, ordinal: number, text = '') => ({
  id, kind, text, ordinal, selected: false, focused: false, locked: false,
  bounds: { x: 0, y: 0, w: 100, h: 100 },
})
const context = (items: ReturnType<typeof candidate>[]) => ({
  candidates: items, connections: [], pageId: 'page:1', activeCount: 0, selectedCount: 0,
  selectedMatchesActive: false, activeObjects: [], hasAnchor: false, lastEdit: null,
})
const answer = (choice: string) => ({ type: 'choice', choice, confidence: 0.99 })
/** 圆·矩·圆：序数与形状名在这里互相打架的那块画布。 */
const circleRectCircle = context([
  candidate('shape:a', 'circle', 1), candidate('shape:b', 'rectangle', 2), candidate('shape:c', 'circle', 3),
])
/** 矩·圆·圆：位置编号与家族序号都成立、却指向不同对象。 */
const rectCircleCircle = context([
  candidate('shape:a', 'rectangle', 1), candidate('shape:b', 'circle', 2), candidate('shape:c', 'circle', 3),
])
/** 圆·圆·矩：两种读法落到同一个对象。 */
const circleCircleRect = context([
  candidate('shape:a', 'circle', 1), candidate('shape:b', 'circle', 2), candidate('shape:c', 'rectangle', 3),
])
const move = (direction: string, reference: string) => ({
  operation: answer('move'), position: answer(direction), placementReference: answer(reference),
  target: answer('sequence'),
  // 家族说法里的类型由代码从原句读，这里给的是模型对普通句子的答案（没有显式类型约束）。
  explicitType: answer('none'),
})
const content = (transcript: string, text: string) => {
  const start = transcript.indexOf(text)
  return { kind: 'text', text, source: { start, end: start + text.length } }
}

test('the shape name after an ordinal decides what the number counts', () => {
  assert.deepEqual(parseFamilyOrdinals('第二个圆形往下一点').map(p => [p.ordinal, p.kind, p.tail]),
    [[2, 'circle', '往下一点']])
  assert.deepEqual(parseFamilyOrdinals('把第一个圆形和第二个方形连起来').map(p => [p.ordinal, p.kind]),
    [[1, 'circle'], [2, 'rectangle']])
  assert.deepEqual(parseFamilyOrdinals('第2个菱形删掉').map(p => [p.ordinal, p.kind]), [[2, 'diamond']])
  // 口语里量词常被省掉；椭圆算圆形、方框算矩形。
  assert.deepEqual(parseFamilyOrdinals('第二方形小一点').map(p => [p.ordinal, p.kind]), [[2, 'rectangle']])
  assert.deepEqual(parseFamilyOrdinals('第三个椭圆放大').map(p => [p.ordinal, p.kind]), [[3, 'circle']])
  // 隔着方位词或动词的图形名不是被序数修饰的中心语：「第二个下面画一个圆」里的圆是新对象。
  assert.deepEqual(parseFamilyOrdinals('在第二个下面画一个圆'), [])
  assert.deepEqual(parseFamilyOrdinals('把第二个改成圆形'), [])
  assert.deepEqual(parseFamilyOrdinals('第二个往下一点'), [])
  // 引号里的文字是内容，不是画布上的说法。
  assert.deepEqual(parseFamilyOrdinals('写上“第二个圆形”'), [])
})

test('an ordinal counts inside the named family, not on the whole canvas', () => {
  const said = '第二个圆形往下一点'
  const result = compose(move('below', 'none'), said, circleRectCircle)
  assert.deepEqual(result.command.parameters.ordinals, [3])
  assert.equal(result.command.parameters.direction, 'below')
})

test('deleting and recolouring the same wording hits the same object', () => {
  const deleted = compose({ operation: answer('delete'), operand: answer('object'), target: answer('sequence') },
    '把第二个圆形删掉', circleRectCircle)
  assert.deepEqual(deleted.command.parameters, { expectedObject: 'circle', ordinals: [3] })
  const coloured = compose({
    operation: answer('set'), operand: answer('property'), target: answer('sequence'),
    attributeCategory: answer('color'), attributeDetail: answer('color'),
    valueKind: answer('literalColor'), literalColor: answer('red'),
  }, '把第二个圆形改成红色', circleRectCircle)
  assert.deepEqual(coloured.command.parameters.ordinals, [3])
  assert.equal(coloured.command.parameters.expectedObject, 'circle')
})

test('both readings landing on one object stay as they were', () => {
  // 「第二个圆形」在「圆·圆·矩」上本来就指第 2 个，换算不该把它挪走。
  assert.deepEqual(compose(move('below', 'none'), '第二个圆形往下一点', circleCircleRect)
    .command.parameters.ordinals, [2])
  assert.deepEqual(compose(move('below', 'none'), '第二个往下一点', circleRectCircle)
    .command.parameters.ordinals, [2])
})

test('a position number that happens to fit is still used when the family runs out', () => {
  // 画布上只有一个方形，「第二个方形」只能指位置编号上那一个——它有名字可以核对。
  const result = compose(move('below', 'none'), '第二个方形往下一点', circleRectCircle)
  assert.deepEqual(result.command.parameters.ordinals, [2])
  assert.equal(result.command.parameters.expectedObject, 'rectangle')
})

test('two readings that fit two different objects are named, not guessed', () => {
  assert.throws(() => compose(move('below', 'none'), '第二个圆形往下一点', rectCircleCircle),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /你说的是哪一个/)
      assert.match(error.message, /第 2 个/)
      assert.match(error.message, /第 3 个/)
      return true
    })
})

test('nothing to count in the family at all is reported as missing', () => {
  assert.throws(() => compose(move('below', 'none'), '第二个方形往下一点', rectCircleCircle),
    /画布上只有 1 个方形，找不到第 2 个方形/)
})

test('a truncated candidate list never stands in for a real count', () => {
  // 候选被截断时家族里的第几个是数不出来的：宁可把原样序号交给执行层（它还会按类型核对并
  // 如实报错），也不用数不准的家族序号悄悄落到别的对象上。
  for (const canvas of [rectCircleCircle, circleRectCircle])
    assert.deepEqual(compose(move('below', 'none'), '第二个圆形往下一点',
      { ...canvas, candidatesTruncated: true }).command.parameters.ordinals, [2])
})

test('the spoken kind belongs to the reference when a direction word follows it', () => {
  // 「把第一个移到第二个圆形右边」：圆形说的是参照物，目标的类型约束是空的，
  // 参照占掉的那个序号（换算后的第 3 个）要从目标里剔掉。
  const result = compose(move('right', 'shape:c'), '把第一个移到第二个圆形右边', circleRectCircle)
  assert.deepEqual(result.command.parameters.ordinals, [1])
  assert.equal(result.command.parameters.referenceId, 'shape:c')
  assert.equal(result.command.parameters.expectedObject, undefined)
})

test('a reference named by family is fixed by code when the model cannot tell', () => {
  const asked = '在第二个圆形下面画一个圆'
  const add = (reference: string) => ({
    operation: answer('add'), operand: answer('object'), objectFamily: answer('graphic'),
    shapeKind: answer('circle'), position: answer('below'), placementReference: answer(reference),creationSizeIntent:answer('none'),creationConstraintScope:answer('none'),
  })
  // 判不准、或明确说“说不清”，而原句其实已经说清了的时候，照原句走。
  assert.equal(compose(add('unknown'), asked, circleRectCircle).command.parameters.position.referenceId, 'shape:c')
  assert.equal(compose(add('shape:b'), asked, circleRectCircle).command.parameters.position.referenceId, 'shape:c')
  // 没有方位词跟着的形状名是目标自己（「在第二个下面画一个圆」的「第二个」是普通位置编号）。
  const plain = '在第二个下面画一个圆'
  assert.equal(compose(add('shape:b'), plain, circleRectCircle).command.parameters.position.referenceId, 'shape:b')
})

test('both ends of a connection can be named by family', () => {
  const connect = compose({ operation: answer('connect') }, '把第一个圆形和第二个圆形连起来', circleRectCircle)
  assert.deepEqual(connect.command.parameters, { connection: 'explicit', fromOrdinal: 1, toOrdinal: 3 })
  const plain = compose({ operation: answer('connect') }, '把第一个和第二个连起来', circleRectCircle)
  assert.deepEqual(plain.command.parameters, { connection: 'explicit', fromOrdinal: 1, toOrdinal: 2 })
})

test('two ends that resolve to one object are reported, not connected to itself', () => {
  // 「第二个圆形和第三个」在只有两个圆的画布上两端都落到第 3 个——那是「连到它自己」，
  // 说清比交给校验层回一句「无效命令」好。
  assert.throws(() => compose({ operation: answer('connect') }, '把第二个圆形和第三个连起来', circleRectCircle),
    /两端指的都是第 3 个对象/)
})

test('a family ordinal never doubles the same object in a list', () => {
  const deleteTwo = {
    operation: answer('delete'), operand: answer('object'), target: answer('sequence'),
    // 两个家族说法时类型仍由模型判（代码只在恰好一个归目标时才替它定）。
    explicitType: answer('circle'),
  }
  assert.deepEqual(compose(deleteTwo, '把第二个圆形和第三个圆形都删掉', circleRectCircle)
    .command.parameters.ordinals, [3])
  assert.deepEqual(compose(deleteTwo, '把第一个圆形和第二个圆形都删掉', circleRectCircle)
    .command.parameters.ordinals, [1, 3])
})

test('writing into a container named by family writes into that object', () => {
  const said = '第二个圆形中间写一个结束'
  const result = compose({ operation: answer('write') }, said, circleRectCircle, content(said, '结束'))
  assert.equal(result.command.target, 'sequence')
  assert.deepEqual(result.command.parameters.ordinals, [3])
  assert.equal(result.command.parameters.expectedObject, 'circle')
})
