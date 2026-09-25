import test from 'node:test'
import assert from 'node:assert/strict'
import {targetCountError,lockNeed,lockNoopError} from '../src/targeting.js'

test('an empty target set asks for a selection instead of “一个目标”',()=>{
  // 对齐、排列、锁定都要多个对象，笼统地要“一个目标”是错的方向。
  assert.equal(targetCountError([],'current',true,'请先框选要对齐或调整层叠顺序的对象。'),'请先框选要对齐或调整层叠顺序的对象。')
  assert.equal(targetCountError([],'all',true,'请先框选要锁定或解锁的对象。'),'请先框选要锁定或解锁的对象。')
  // 没有专门提示的操作保持原文案，行为不变。
  assert.match(targetCountError([],'current',false)!,/一个目标/)
})

test('several targets are only accepted by the operations that asked for many',()=>{
  // 对齐、排列、锁定、解锁允许多个。
  assert.equal(targetCountError(['a','b'],'current',true),null)
  // 单对象操作仍然必须唯一——放开多个会让“改成红色”作用到一堆对象上。
  assert.match(targetCountError(['a','b'],'current',false)!,/一个目标/)
  // all / previous 一直允许多个，未受影响。
  assert.equal(targetCountError(['a','b'],'all',false),null)
  assert.equal(targetCountError(['a','b'],'pageAll',false),null)
  assert.equal(targetCountError(['a','b'],'previous',false),null)
  // “全部”在空集合上同样需要框选，不能凭这句话凭空造出目标。
  assert.match(targetCountError([],'all',true)!,/一个目标/)
})

test('locking only flips the objects whose real state differs',()=>{
  const locked:Record<string,boolean>={start:true,review:false,end:true}
  const stateOf=(id:string)=>locked[id]
  // 解锁：只翻已锁定的。
  assert.deepEqual(lockNeed(['start','review','end'],stateOf,false),['start','end'])
  // 锁定：只翻未锁定的——否则 tldraw 的统一翻转会把已锁定的那批解开。
  assert.deepEqual(lockNeed(['start','review','end'],stateOf,true),['review'])
  // 同一含义换顺序与组合复测。
  assert.deepEqual(lockNeed(['start','end','review'],stateOf,true),['review'])
})

test('a lock change with nothing to flip is empty, and must not read as success',()=>{
  const stateOf=(id:string)=>id==='locked'
  assert.deepEqual(lockNeed(['locked'],stateOf,true),[])
  assert.deepEqual(lockNeed(['open'],stateOf,false),[])
  // 目标已消失时不参与翻转，也不能被当成一次成功的锁定。
  assert.deepEqual(lockNeed(['gone'],()=>undefined,true),[])
  assert.deepEqual(lockNeed([],stateOf,false),[])
  // 空操作的反馈必须说清真实状态，不能回报“已锁定/已解除锁定”。
  assert.match(lockNoopError(true),/已经锁定/)
  assert.match(lockNoopError(false),/没有锁定/)
  assert.doesNotMatch(lockNoopError(true),/已锁定/)
  assert.doesNotMatch(lockNoopError(false),/已解除锁定/)
})

test('the same rule holds across different hints and object sets',()=>{
  for(const hint of ['请先框选要对齐或调整层叠顺序的对象。','请先框选要排列的对象。','请先框选要锁定或解锁的对象。'])
    assert.equal(targetCountError([],'current',true,hint),hint)
  const stateOf=(id:string)=>id.startsWith('locked:')
  assert.deepEqual(lockNeed(['locked:a','open:b','locked:c'],stateOf,false),['locked:a','locked:c'])
  assert.deepEqual(lockNeed(['locked:a','open:b','locked:c'],stateOf,true),['open:b'])
})
