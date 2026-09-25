import test from 'node:test'
import assert from 'node:assert/strict'
import { directPhrases, matchDirectCommand } from '../src/fast-path.js'

test('闭集口令在本地就得到取景命令',()=>{
  assert.deepEqual(matchDirectCommand('看全部'),{kind:'control',action:'view',view:'fit'})
  assert.deepEqual(matchDirectCommand('看镜头'),{kind:'control',action:'view',view:'fit'})
  assert.deepEqual(matchDirectCommand('聚焦到选中的'),{kind:'control',action:'view',view:'selection'})
})

test('句末标点、语气助词与空白不影响命中',()=>{
  for(const phrase of ['看全部。','看全部吧','全览！','看镜头～',' 看全部 ','看选中的呢','看 全部']){
    assert.ok(matchDirectCommand(phrase),`${phrase} 应当命中`)
  }
})

test('全选是整句本地控制口令，复合句不被吞掉',()=>{
  for(const phrase of ['全选','全选。','全选吧！',' 全 选 '])
    assert.deepEqual(matchDirectCommand(phrase),{kind:'control',action:'selectAll'})
  for(const phrase of ['先全选','全选然后删除','把圆全选','全选这两个'])
    assert.equal(matchDirectCommand(phrase),null)
})

test('复合句、带参数的说法与歧义词一律不命中',()=>{
  // 本地层只吃整句等价：句子里还有别的动作，就必须交给看得到上下文的 Jev。
  const outside=[
    '看全部然后删掉那个圆','把这两个看全部','先看全部','看全部，然后建一个圆',
    '放大','缩小','大一点','高一点','把圆放大','把镜头对准刚才那个','看看','看一下','看这个',
  ]
  for(const phrase of outside) assert.equal(matchDirectCommand(phrase),null,`${phrase} 不该被本地层吞掉`)
})

test('词表自身自洽：每条都合法、不带首尾空白、且能命中自己',()=>{
  for(const [phrase,view] of Object.entries(directPhrases)){
    assert.ok(view==='fit'||view==='selection',`${phrase} 映射到未支持的取景目标`)
    assert.equal(phrase,phrase.trim(),`${phrase} 带了首尾空白`)
    assert.deepEqual(matchDirectCommand(phrase),{kind:'control',action:'view',view},`${phrase} 命中不了自己`)
  }
})

test('取景词表只产出相机控制，不产出编辑命令',()=>{
  for(const phrase of Object.keys(directPhrases)){
    const command=matchDirectCommand(phrase)
    assert.equal(command?.kind,'control')
    assert.equal(command?.action,'view')
  }
})
