import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOrderReference, stripOrderReference, defaultRangeCount } from './live/ordinal.mjs'
import { parseLength } from './live/compose.mjs'
import { targetCountError } from '../src/targeting'
import { describeCommand } from '../src/command-description'

/** 顺序引用的数值一律从原句读，模型只判断「这是不是按创建顺序指代」。
 *  这里是那层读取的边界：并列序号不能丢项，范围要说清前后和个数。 */
test('spoken order references keep every numeral', () => {
  assert.deepEqual(parseOrderReference('第二个小一点'), { ordinals: [2] })
  assert.deepEqual(parseOrderReference('第二个方形小一点'), { ordinals: [2] })
  assert.deepEqual(parseOrderReference('第二方形小一点'), undefined)
  // 并列时量词只在最后一项出现——旧写法只认到「第三个」，第一个被静默吞掉。
  assert.deepEqual(parseOrderReference('第一和第三个改成蓝色'), { ordinals: [1, 3] })
  assert.deepEqual(parseOrderReference('第一个、第三个改成蓝色'), { ordinals: [1, 3] })
  assert.deepEqual(parseOrderReference('第三个和第一个改成蓝色'), { ordinals: [1, 3] })
  assert.deepEqual(parseOrderReference('第三个和第三个'), { ordinals: [3] })
  assert.deepEqual(parseOrderReference('第十个'), { ordinals: [10] })
  assert.deepEqual(parseOrderReference('第十二个'), { ordinals: [12] })
})

test('range references name an edge and a count', () => {
  assert.deepEqual(parseOrderReference('前三个变小一点'), { range: { edge: 'first', count: 3 } })
  assert.deepEqual(parseOrderReference('后两个变小一点'), { range: { edge: 'last', count: 2 } })
  assert.deepEqual(parseOrderReference('最后两个变小一点'), { range: { edge: 'last', count: 2 } })
  assert.deepEqual(parseOrderReference('前3个变小一点'), { range: { edge: 'first', count: 3 } })
  // 「最后一个」不说数字就是一个；「前几个」是相对范围，与「大一点」折算 10% 同类。
  assert.deepEqual(parseOrderReference('最后一个删掉'), { range: { edge: 'last', count: 1 } })
  assert.deepEqual(parseOrderReference('前几个变小一点'), { range: { edge: 'first', count: defaultRangeCount } })
})

test('non-reference sentences read as no reference at all', () => {
  for (const text of ['把它们顶对齐', '在它下面建一个矩形', '把这个菱形里写上结束两个字', '看全部', '放大一点'])
    assert.equal(parseOrderReference(text), undefined, text)
})

test('an order reference never leaks into length or count numerals', () => {
  // 「前两个」里的「两」是序号不是尺寸：不摘掉会被读成缺单位的数字。
  assert.equal(parseLength('前两个小一点'), null)
  assert.equal(parseLength('第二个小一点'), null)
  assert.equal(stripOrderReference('前两个小一点'), '小一点')
  assert.deepEqual(parseLength('第二个宽度设为200像素'), { kind: 'length', amount: 200, unit: 'px' })
  assert.deepEqual(parseLength('把前两个往上移30像素'), { kind: 'length', amount: 30, unit: 'px' })
})

test('batch references are their own kind, not a single-target reference', () => {
  // 说法本身指一批，数量由说法决定，不该再要求恰好一个；否则「前三个」永远进不来。
  assert.equal(targetCountError(['a', 'b', 'c'], 'sequence', false), null)
  assert.equal(targetCountError(['a', 'b'], 'kindAll', false), null)
  assert.equal(targetCountError(['a', 'b'], 'kind', false), '请明确选中一个目标，或说“全部”。')
  assert.equal(targetCountError([], 'sequence', false), '请明确选中一个目标，或说“全部”。')
})

test('spoken feedback names the reference the way it was said', () => {
  const shrink = (target: string, parameters: object) => describeCommand({
    kind: 'edit', operation: 'adjust', operand: 'property', target, parameters,
  } as never)!
  const step = { property: 'size', mode: 'decrease', value: { kind: 'step', count: 1 } }
  assert.equal(shrink('sequence', { ordinals: [1, 3], ...step }), '把第 1、3 个对象的整体尺寸缩小 10%')
  assert.equal(shrink('sequence', { ordinalRange: { edge: 'first', count: 3 }, ...step }), '把前 3 个对象的整体尺寸缩小 10%')
  assert.equal(shrink('sequence', { ordinalRange: { edge: 'last', count: 2 }, expectedObject: 'rectangle', ...step }), '把后 2 个矩形的整体尺寸缩小 10%')
  assert.equal(shrink('kindAll', { expectedObject: 'circle', ...step }), '把全部圆形的整体尺寸缩小 10%')
})
