import assert from 'node:assert/strict'
import test from 'node:test'
import type { Editor } from 'tldraw'
import { canvasRevision } from '../src/canvas-revision'

test('changing an arrow binding invalidates an in-flight canvas judgment', () => {
  const shapes = [{ id: 'shape:arrow', type: 'arrow' }, { id: 'shape:a', type: 'geo' }, { id: 'shape:b', type: 'geo' }]
  let destination = 'shape:a'
  const editor = {
    getCurrentPageShapes: () => shapes,
    getBindingsFromShape: () => [{ id: 'binding:end', fromId: 'shape:arrow', toId: destination, props: { terminal: 'end' } }],
  } as unknown as Editor
  const before = canvasRevision(editor)
  destination = 'shape:b'
  assert.notEqual(canvasRevision(editor), before)
})
