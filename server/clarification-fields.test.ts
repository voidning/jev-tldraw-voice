import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { clarificationFields } from './live/interpret.mjs'

/** 每一道题都可能判不出来，判不出来时给用户看什么，由 interpret 层的 clarificationFields
 *  与 spokenOptions 决定。漏配一个，用户看到的就是兜底文案「你想执行什么操作？」——
 *  而模型明明已经判出了操作，只是分不清是图形还是文字。
 *
 *  实测「在第二个上面画一个圆」：所有维度答案都对（decision=execute 0.99、operation=add 0.98、
 *  shapeKind=circle、placementReference=shape:b 0.90、position=above 0.88），
 *  唯独 operand 在 object/text 之间平票——而 operand 当时不在映射表里，
 *  于是用户被告知「你想执行什么操作？」。同一个词换「下面」8/8 通过，「上面」只有 5/8：
 *  中文「在……上面」能读成「附着在表面上」，模型因此怀疑是不是要在那个对象里写字。
 *
 *  这条测试扫 compose 里所有会读的轴，防止新增题目时再漏一个。 */

const source = readFileSync(new URL('./live/compose.mjs', import.meta.url), 'utf8')
// 有些轴不走 read()：它们有各自的兜底与放宽规则（代词与焦点等价、内部位置的动词摇摆等），
// 轴名写在函数体里，正则扫不到，所以在这里显式登记——漏登记等于漏配，退化成通用问句。
const customReaders = { readOperation: 'operation', readOperand: 'operand' }
const askedAxes = [...new Set([
  ...[...source.matchAll(/\bread\(\s*'([a-zA-Z]+)'/g)].map(match => match[1]),
  ...Object.values(customReaders),
])]

// 不需要单独文案的轴，各自有明确去处：
const handledElsewhere = new Set([
  'operation', // 摇摆时问「你想执行什么操作？」恰好就是用户缺的那一半
  'objectFamily', // interpretClause 特判为「你想建哪种图形？圆形、矩形还是菱形？」
  'role', 'semanticColor', 'componentSemantic', // 设计组件扩展轴，主流程题集不产出它们
])

test('every axis the composer can stall on has a clarification destination', () => {
  const unmapped = askedAxes.filter(axis => !handledElsewhere.has(axis) && !(axis in clarificationFields))
  assert.deepEqual(unmapped, [],
    `这些轴判不出来时会退化成「你想执行什么操作？」：${unmapped.join('、')}；请给出字段分类与口语选项名`)
})

test('the source scan still sees the axes it claims to check', () => {
  assert.ok(askedAxes.length >= 20, `只扫到 ${askedAxes.length} 个轴，扫描规则可能已失效`)
  // placementReference 不走 read()，它有自己的解析函数（代词与焦点等价时放宽），
  // 所以只在这里锚住几个确定的 read() 轴。
  for (const axis of ['operand', 'layout', 'shapeKind', 'orderRelation'])
    assert.ok(askedAxes.includes(axis), `没扫到 ${axis}，正则或 compose 结构已变`)
  for (const [fn, axis] of Object.entries(customReaders)) {
    assert.ok(source.includes(`function ${fn}(`), `没找到 ${fn}()，${axis} 轴的兜底可能已被删掉`)
    assert.ok(askedAxes.includes(axis), `${axis} 没有被登记进扫描结果`)
  }
})
