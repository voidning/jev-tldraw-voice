import assert from 'node:assert/strict'
import test from 'node:test'
import { compose, UncertainChoiceError } from './live/compose.mjs'
import { interpretWithJev, ClarificationError } from './live/interpret.mjs'

/** 「方形中间写一个结束」的问题不是形状，也不是操作——是「文字写进这个对象，还是另立一个
 *  独立文字」这件事模型判不出来（实测 writePlacement 只有 0.51–0.62 的把握）。而这两条路
 *  在当前场景里根本不对等：在画布上新建文字要鼠标落点，免手时说不出落点，执行层只会回
 *  「请先把鼠标移到画布上的创建位置」。
 *
 *  所以句中已经用内部位置说法指定了某个已有对象时，容器由代码定，不问模型：
 *  唯一指名才兜底（形状名对应多个对象、序号越界时都不猜），文字内容里的图形名不算容器
 *  （「在方形里写上圆形」的内容是“圆形”，容器还是方形）。 */

const candidate = (id: string, kind: string, ordinal: number, text = '') => ({
  id, kind, text, ordinal, selected: false, focused: false, locked: false,
  bounds: { x: 0, y: 0, w: 100, h: 100 },
})
const context = (items: ReturnType<typeof candidate>[]) => ({
  candidates: items, connections: [], pageId: 'page:1', activeCount: 0, selectedCount: 0,
  selectedMatchesActive: false, activeObjects: [], hasAnchor: false, lastEdit: null,
})
const single = context([candidate('shape:a', 'rectangle', 1)])
const mixed = context([candidate('shape:a', 'circle', 1), candidate('shape:b', 'rectangle', 2)])
const twoSquares = context([candidate('shape:a', 'rectangle', 1), candidate('shape:b', 'rectangle', 2)])
const answer = (choice: string) => ({ type: 'choice', choice, confidence: 0.99 })
const write = { operation: answer('write') }
/** 原句里真实存在的文字片段：textValue 会核对 source 切出来的就是这段文字。 */
const content = (transcript: string, text: string) => {
  const start = transcript.indexOf(text)
  return { kind: 'text', text, source: { start, end: start + text.length } }
}

test('writing inside a named shape edits that shape instead of asking', () => {
  const transcript = '方形中间写一个结束。'
  const result = compose(write, transcript, single, content(transcript, '结束'))
  assert.deepEqual(result.command, {
    kind: 'edit', operation: 'set', operand: 'text', target: 'object',
    parameters: {
      value: { kind: 'text', text: '结束', source: { start: 7, end: 9 } },
      placement: 'center', expectedObject: 'rectangle', targetId: 'shape:a',
    },
  })
})

test('inside wording variants all resolve to the container', () => {
  for (const transcript of ['在方形中间写上开始', '在方框里写上开始', '在方形内部写开始', '方形里边写“开始”']) {
    const result = compose(write, transcript, single, content(transcript, '开始'))
    assert.equal(result.command.target, 'object', transcript)
    assert.equal(result.command.parameters.targetId, 'shape:a', transcript)
  }
})

test('an ordinal inside a shape keeps the ordinal, not a snapshot id', () => {
  const transcript = '在第二个里面写上结束'
  const result = compose(write, transcript, mixed, content(transcript, '结束'))
  assert.equal(result.command.target, 'sequence')
  assert.deepEqual(result.command.parameters, {
    value: { kind: 'text', text: '结束', source: { start: 8, end: 10 } },
    placement: 'center', ordinals: [2],
  })
})

test('the text being written never counts as the container', () => {
  // 「圆形」是内容，不是容器：容器是那个唯一的方形，不能因为句中出现“圆”就去找圆。
  const transcript = '在方形里写上圆形'
  const result = compose(write, transcript, mixed, content(transcript, '圆形'))
  assert.equal(result.command.parameters.targetId, 'shape:b')
})

test('the rule stays out of the way when the container is not unique', () => {
  // 两个方形时谁都不是“那个方形”，静默挑一个比澄清更糟——交回模型判 writePlacement。
  // 序号不同：它本来就唯一对上一个对象，照旧兜底（见上一条）。
  const transcript = '在方形中间写一个结束'
  assert.throws(() => compose(write, transcript, twoSquares, content(transcript, '结束')),
    (error: unknown) => error instanceof UncertainChoiceError && error.axis === 'writePlacement')
})

test('outside wording is not an inside container', () => {
  for (const transcript of ['在方形下面写一个标题', '在方形右边写上标题', '在这里写一个标题']) {
    assert.throws(() => compose(write, transcript, single, content(transcript, '标题')),
      (error: unknown) => error instanceof UncertainChoiceError && error.axis === 'writePlacement', transcript)
  }
})

test('an explicit standalone text request is left alone', () => {
  // 「新建一个独立文字」是另立一个对象，不是写进方形；「写一个独立文字」里的“独立文字”
  // 只是内容，仍按容器走（见上一条的连用条件）。
  const asked = '在方形中间新建一个独立文字'
  assert.throws(() => compose(write, asked, single, content(asked, '独立文字')),
    (error: unknown) => error instanceof UncertainChoiceError && error.axis === 'writePlacement')
  const written = '在方形中间写一个独立文字'
  assert.equal(compose(write, written, single, content(written, '独立文字')).command.parameters.targetId, 'shape:a')
})

/** 「写一个标题」既没说写什么、也没说写在哪。旧文案回「你想操作哪个对象？」——用户不是
 *  分不清对象，是缺文字和落点。这里锁住：缺什么就说什么，且没有鼠标落点时不提“鼠标位置”
 *  这条路以外的选项（免手时它走不通）。 */
const writeOnly = (operation = 'write', decision = 0.6) => ({
  decision: { type: 'choice', choice: 'execute', confidence: decision },
  valueIntegrity: answer('clear'), operation: answer(operation),
})

test('a bare write request says what is missing, not which object', async () => {
  for (const hasAnchor of [false, true]) {
    await assert.rejects(
      () => interpretWithJev('写一个标题', 'fake', { ...context([]), hasAnchor },
        async () => new Response(JSON.stringify({ answers: writeOnly() }))),
      (error: unknown) => {
        assert.ok(error instanceof ClarificationError)
        assert.equal(error.field, 'target')
        assert.match(error.message, hasAnchor ? /要写入的文字/ : /文字要写在哪里/)
        return true
      })
  }
})

test('other uncertain sentences keep the existing fallback wording', async () => {
  await assert.rejects(
    () => interpretWithJev('大一点', 'fake', context([]),
      async () => new Response(JSON.stringify({ answers: writeOnly('adjust') }))),
    (error: unknown) => error instanceof ClarificationError && error.message === '你想操作哪个对象？')
})

test('clearing the text inside a named shape edits that shape', () => {
  const transcript = '把方形里写的字删掉'
  const result = compose({ operation: answer('delete'), operand: answer('text') }, transcript, mixed)
  assert.deepEqual(result.command, {
    kind: 'edit', operation: 'delete', operand: 'text', target: 'object',
    parameters: { expectedObject: 'rectangle', targetId: 'shape:b' },
  })
})

test('deleting another object inside the same wording is not hijacked', () => {
  // 「把方形里的圆删掉」删的是圆这个对象，不是方形的文字：兜底要求句中有文字相关词。
  const transcript = '把方形里的圆删掉'
  const result = compose({ operation: answer('delete'), operand: answer('object'), target: answer('kind'), explicitType: answer('circle') }, transcript, mixed)
  assert.equal(result.command.parameters.expectedObject, 'circle')
  assert.equal(result.command.parameters.targetId, undefined)
})

test('creating inside another object is refused with the reason, not with "no position given"', () => {
  const transcript = '在方形中间画一个圆'
  assert.throws(() => compose({
    operation: answer('add'), operand: answer('object'), objectFamily: answer('graphic'),
    shapeKind: answer('circle'), position: answer('insideCenter'),
  }, transcript, mixed), /还不能把新图形建在另一个对象的内部/)
  // 位置确实没说时，仍报“请说明画布落点或相对位置”。
  assert.throws(() => compose({
    operation: answer('add'), operand: answer('object'), objectFamily: answer('graphic'),
    shapeKind: answer('circle'), position: answer('none'),
  }, transcript, mixed), /请说明画布落点或相对位置/)
})
