import assert from 'node:assert/strict'
import test from 'node:test'
import { compose, UncertainChoiceError } from './live/compose.mjs'

/** 「在方形中间加一个开始」：内部位置已经把容器说死了，可「加／放／填／添」这类动词在
 *  「写字」与「新建图形」之间天生摇摆——实测 operation=write 只有 0.70、operand=object 0.78，
 *  回一句「你是指写字还是新建图形」等于把句中已经给出的信息再问一遍。
 *
 *  这两条路哪一条成立，取决于原文里写着的事实：容器由代码从画布数出来，要放进去的那个词
 *  是不是图形名也是写出来的字。所以判定交给代码，模型只管它判得准的那些维度。
 *
 *  反向也要锁住：真的是要往对象内部新建一个图形时（「在方形里加一个圆」），不能有半点
 *  静默——那件事目前做不到，要说清楚，而不是拿一个二选一让用户挑两条都走不通的路。 */

const candidate = (id: string, kind: string, ordinal: number, text = '') => ({
  id, kind, text, ordinal, selected: false, focused: false, locked: false,
  bounds: { x: 0, y: 0, w: 100, h: 100 },
})
const context = (items: ReturnType<typeof candidate>[]) => ({
  candidates: items, connections: [], pageId: 'page:1', activeCount: 0, selectedCount: 0,
  selectedMatchesActive: false, activeObjects: [], hasAnchor: false, lastEdit: null,
})
const single = context([candidate('shape:a', 'rectangle', 1)])
const twoSquares = context([candidate('shape:a', 'rectangle', 1), candidate('shape:b', 'rectangle', 2)])
const answer = (choice: string) => ({ type: 'choice', choice, confidence: 0.99 })
/** 模型在两个选项之间平票时的答案形状：confidence 压在门限下，probabilities 给出前两名。 */
const wobble = (first: string, second: string) => ({
  type: 'choice', choice: first, confidence: 0.55, probabilities: { [first]: 0.5, [second]: 0.45 },
})
const content = (transcript: string, text: string) => {
  const start = transcript.indexOf(text)
  return { kind: 'text', text, source: { start, end: start + text.length } }
}
const create = (overrides = {}) => ({
  operation: answer('add'), operand: answer('object'), objectFamily: answer('graphic'),
  shapeKind: answer('circle'), position: answer('inside'), ...overrides,
})

test('a wobbling verb still writes when the inside container is named', () => {
  const transcript = '在方形中间加一个开始'
  const result = compose({ operation: wobble('write', 'add'), operand: answer('text') },
    transcript, single, content(transcript, '开始'))
  assert.equal(result.command.operation, 'set')
  assert.equal(result.command.operand, 'text')
  assert.equal(result.command.parameters.value.text, '开始')
  assert.equal(result.command.parameters.targetId, 'shape:a')
})

test('a shape word in the tail means creating, not writing', () => {
  // 内容本身没被提取（模型认为这句不是写字）时，看内部位置说法后面剩下的那段话：
  // 「在方形里加一个圆」的“圆”在尾巴上，于是判成新建——而不是拿“圆”去当要写的字。
  // 新建在对象内部目前做不到，所以这里落到那句如实拒绝，落点本身就是判成 add 的证据。
  assert.throws(
    () => compose(create({ operation: wobble('add', 'write'), operand: wobble('object', 'text') }),
      '在方形里加一个圆', single),
    /还不能把新图形建在另一个对象的内部/)
})

test('creating inside an object says it cannot be done instead of offering a choice', () => {
  const message = /还不能把新图形建在另一个对象的内部/
  assert.throws(
    () => compose(create({ position: wobble('inside', 'insideCenter') }), '在方形里加一个圆', single),
    message)
  // 动词摇摆时也走同一条路：inside 与 insideCenter 通向同一句拒绝，摆二选一没有意义。
  assert.throws(
    () => compose(create({ operation: wobble('add', 'write'), operand: wobble('object', 'text'), position: wobble('insideCenter', 'inside') }),
      '在方形里加一个圆', single),
    message)
})

test('a writing verb keeps its content even when the content looks like a shape', () => {
  // 「在方形里写上圆形」写的是“圆形”两个字：动词已经把意图说死了，不因为内容像图形名
  // 就改判成「在方形里新建一个圆」。
  const transcript = '在方形里写上圆形'
  const result = compose({ operation: wobble('write', 'add'), operand: wobble('text', 'object') },
    transcript, single, content(transcript, '圆形'))
  assert.equal(result.command.operation, 'set')
  assert.equal(result.command.parameters.value.text, '圆形')
})

test('an ambiguous container still asks', () => {
  // 兜底的边界：形状名在画布上对应多个对象时，用户想要的可能是其中任何一个，
  // 静默挑一个比澄清更糟——这时该问的还是得问。
  const transcript = '在方形中间加一个开始'
  assert.throws(() => compose({ operation: wobble('write', 'add'), operand: answer('text') },
    transcript, twoSquares, content(transcript, '开始')),
    error => error instanceof UncertainChoiceError && error.axis === 'operation')
})

test('outside placement is never mistaken for an inside container', () => {
  // 「在方形下面加一个圆」没有内部位置说法，容器不成立，动词摇摆就该照旧问。
  assert.throws(() => compose({ operation: wobble('write', 'add'), operand: wobble('text', 'object') },
    '在方形下面加一个圆', single),
    error => error instanceof UncertainChoiceError && error.axis === 'operation')
})
