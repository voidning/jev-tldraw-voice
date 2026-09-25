import assert from 'node:assert/strict'
import test from 'node:test'
import { interpretWithJev } from './live/interpret.mjs'

const answer = (choice: string) => ({ type: 'choice', choice, confidence: 0.99 })
const context = {
  pageId: 'page:test', activeCount: 0, selectedCount: 0, selectedMatchesActive: false,
  activeObjects: [], hasAnchor: false, lastEdit: null, connections: [],
  candidates: ['开始', '结束'].map((text, index) => ({
    id: `shape:${index}`, kind: 'rectangle', text, ordinal: index + 1,
    selected: false, focused: false, locked: false, bounds: { x: index * 200, y: 0, w: 140, h: 140 },
  })),
}

test('separate named targets in one sentence remain separate', async () => {
  const base = { decision: answer('execute'), valueIntegrity: answer('clear'),
    operation: answer('set'), target: answer('object'), explicitType: answer('none'),
    attributeCategory: answer('color'), attributeDetail: answer('color'), valueKind: answer('literalColor') }
  const replies = [
    { ...base, clauseRelation: answer('separate') },
    { ...base, clauseRelation: answer('continuation'), targetObject: answer('shape:0'), literalColor: answer('red') },
    { ...base, clauseRelation: answer('continuation'), targetObject: answer('shape:1'), literalColor: answer('blue') },
  ]
  let calls = 0
  const result = await interpretWithJev('把“开始”改成红色，然后把“结束”改成蓝色', 'fake', context,
    async () => new Response(JSON.stringify({ answers: replies[calls++] })))
  assert.equal(calls, 3)
  assert.equal(result.command.kind, 'batch')
  assert.deepEqual(result.command.commands.map((item: { parameters: { targetId: string } }) => item.parameters.targetId), ['shape:0', 'shape:1'])
})
