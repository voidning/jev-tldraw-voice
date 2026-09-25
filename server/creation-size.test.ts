import test from 'node:test'
import assert from 'node:assert/strict'
import {compose} from './live/compose.mjs'
import {interpret as validate} from '../src/jev-validation'

const a=(choice:string)=>({type:'choice',choice,confidence:.99})
const circle={id:'shape:circle',kind:'circle',text:'',ordinal:1,selected:true,focused:true,locked:false,bounds:{x:0,y:0,w:154,h:154}}
const other={id:'shape:other',kind:'diamond',text:'',ordinal:2,selected:false,focused:false,locked:false,bounds:{x:300,y:0,w:260,h:90}}
const context={pageId:'page:test',candidates:[circle,other],activeCount:1,selectedCount:1,selectedMatchesActive:true,
  activeObjects:['circle'],objectCounts:{circle:1,diamond:1},ordinalObjectCount:2,hasAnchor:true,lastEdit:null}
const base={operation:a('add'),operand:a('object'),objectFamily:a('graphic'),shapeKind:a('rectangle'),
  position:a('below'),placementReference:a('shape:circle'),target:a('current'),explicitType:a('none')}

test('creation keeps placement and actual-size source as separate typed roles',async()=>{
  const transcript='在圆下面画个和它一样大的方形'
  const result=compose({...base,creationSizeIntent:a('sameBounds'),creationSizeReference:a('placement')},transcript,context)
  assert.deepEqual(result.command.parameters,{
    object:'rectangle',position:{kind:'relative-object',referenceId:'shape:circle',direction:'below'},
    sizeReference:{kind:'reference-bounds',referenceId:'shape:circle',axes:'both'},
  })
  await validate(transcript,context as never,async()=>({ok:true,status:200,payload:{source:'jev',decision:'execute',confidence:.99,command:result.command}}))
  const different=compose({...base,creationSizeIntent:a('width'),creationSizeReference:a('shape:other')},
    '在圆下面建一个和菱形一样宽的方形',context)
  assert.deepEqual(different.command.parameters.sizeReference,{kind:'reference-bounds',referenceId:'shape:other',axes:'width'})
})

test('a focused pronoun resolves the real source without inventing dimensions',()=>{
  const result=compose({...base,placementReference:a('none'),creationSizeIntent:a('sameBounds'),creationSizeReference:a('placement')},
    '在它下面画个和它一样大的方形',context)
  assert.deepEqual(result.command.parameters.position,{kind:'relative',reference:'current',direction:'below'})
  assert.deepEqual(result.command.parameters.sizeReference,{kind:'reference-bounds',referenceId:'shape:circle',axes:'both'})
})

test('equivalent low-confidence size-reference readings resolve to the same object',()=>{
  const result=compose({...base,creationSizeIntent:a('sameBounds'),creationSizeReference:{type:'choice',choice:'placement',confidence:.72,
    probabilities:{placement:.78,'shape:circle':.22}}},'在圆下面建一个跟圆一样大的方形',context)
  assert.deepEqual(result.command.parameters.sizeReference,{kind:'reference-bounds',referenceId:'shape:circle',axes:'both'})
})

test('ordinary relative creation does not inherit reference size',()=>{
  const result=compose({...base,creationSizeIntent:a('none')},
    '在圆下面建一个矩形',context)
  assert.equal(result.command.parameters.sizeReference,undefined)
  assert.deepEqual(result.command.parameters.position,{kind:'relative-object',referenceId:'shape:circle',direction:'below'})
})

test('ambiguous, unsupported, or unresolved creation constraints never become default size',()=>{
  for(const intent of ['ambiguous','unsupported'])assert.throws(()=>compose({...base,creationSizeIntent:a(intent)},
    '在圆下面建一个一样的方形',context),/画布未修改/)
  assert.throws(()=>compose({...base,creationSizeIntent:a('sameBounds'),creationSizeReference:a('unknown')},
    '在圆下面建一个一样大的方形',context))
  assert.throws(()=>compose({...base,placementReference:a('none'),creationSizeIntent:a('sameBounds'),creationSizeReference:a('placement')},
    '在它下面建一个一样大的方形',{...context,candidates:[{...circle,selected:true,focused:true},{...other,selected:true,focused:true}]}),/不唯一/)
})

test('invalid size references are rejected by the command protocol',async()=>{
  const command=compose({...base,creationSizeIntent:a('sameBounds'),creationSizeReference:a('placement')},
    '在圆下面建一个一样大的方形',context).command
  const request=(value:unknown)=>async()=>({ok:true,status:200,payload:{source:'jev',decision:'execute',confidence:.99,command:value}})
  for(const sizeReference of [
    {kind:'reference-bounds',referenceId:'other',axes:'both'},
    {kind:'reference-bounds',referenceId:'shape:circle',axes:'diagonal'},
  ])await assert.rejects(()=>validate('在圆下面建一个一样大的方形',context as never,
    request({...command,parameters:{...command.parameters,sizeReference}})))
})
