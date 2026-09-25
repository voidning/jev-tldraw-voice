import { useEffect, useState } from 'react'
import type { Editor } from 'tldraw'
import type { LiveEditor } from './live-editor'

type Badge={id:string;index:number;x:number;y:number;locked:boolean}

/** 画布上常驻的创建顺序编号。语音说「第二个」时，用户和观众都要能立刻对上是哪一个——
 *  没有编号，序号只是一句口令；有编号，它才是看得见的引用。
 *
 *  编号是**位置序号**（有序对象里的第几个），不是内部的自增号：删掉一个之后内部号会跳
 *  （1、3、4），而「第二个」指的是当前位置的第二个，两者必须一致，否则屏幕上的数字和
 *  嘴里说的数字不是一回事。
 *
 *  坐标每帧换算到容器坐标系，所以随平移、缩放、窗口尺寸一起跟随；
 *  渲染在画布变换之外，所以编号本身保持固定大小，缩到「看全部」时也还认得出。 */
export function CanvasOrder({editor,live}:{editor:Editor;live:LiveEditor}){
  const [badges,setBadges]=useState<Badge[]>([])
  useEffect(()=>{
    let frame=0
    const read=()=>{ frame=0; setBadges(live.orderBadges()) }
    const schedule=()=>{ if(!frame) frame=requestAnimationFrame(read) }
    read()
    const stop=editor.store.listen(schedule,{scope:'all',source:'all'})
    // 相机不总是通过 store 通知（平移和滚轮缩放走的是直接路径），所以在容器上再挂一份，
    // 否则编号会在镜头移动时停在原地。
    const container=editor.getContainer()
    for(const type of ['wheel','pointermove','pointerup'] as const)container.addEventListener(type,schedule,{passive:true})
    // 容器尺寸/位置变化（窗口缩放、收起侧栏）也要重算，坐标里减掉的就是容器的 rect。
    const observer=new ResizeObserver(schedule)
    observer.observe(container)
    window.addEventListener('resize',schedule)
    return ()=>{
      stop()
      for(const type of ['wheel','pointermove','pointerup'] as const)container.removeEventListener(type,schedule)
      observer.disconnect()
      window.removeEventListener('resize',schedule)
      if(frame)cancelAnimationFrame(frame)
    }
  },[editor,live])
  if(!badges.length)return null
  return (
    <div className="canvas-order" aria-hidden="true">
      {badges.map(badge=><span key={badge.id} className={`order-badge${badge.locked?' is-locked':''}`} style={{left:badge.x,top:badge.y}}>{badge.index}</span>)}
    </div>
  )
}
