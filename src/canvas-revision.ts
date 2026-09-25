import type { Editor } from 'tldraw'

/** The facts used to resolve a command: shape records and arrow relationships. */
export function canvasRevision(editor: Editor): string {
  const shapes = [...editor.getCurrentPageShapes()].sort((a, b) => a.id.localeCompare(b.id))
  const bindings = shapes.filter(shape => shape.type === 'arrow')
    .flatMap(shape => editor.getBindingsFromShape(shape.id, 'arrow'))
    .sort((a, b) => a.id.localeCompare(b.id))
  return JSON.stringify([shapes, bindings])
}
