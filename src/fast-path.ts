import type {LiveCommand,ViewTarget} from './live-command'

/** Closed-set control phrases: the sentence has exactly one reading, so no amount of
 *  semantic judgment could change what it means. Those stay here and never reach
 *  Jev. Moving the camera is not a matter of opinion, and sending it to a
 *  discriminative model buys one network round trip while diluting the score this
 *  project exists to measure.
 *
 *  The dividing line is ambiguity, not length. "放大" is deliberately absent:
 *  it can mean the camera or the object, so only Jev — which sees the whole
 *  sentence and the canvas — may decide. "看镜头" is here because in this app it
 *  is a fixed command, and a local list is free to grow one word at a time.
 *
 *  Only a whole-sentence match qualifies. "看全部然后删掉那个圆" carries a second
 *  action, so it never lands here and takes the normal route. */
export const directPhrases:Record<string,ViewTarget>={
  '看全部':'fit','看全':'fit','全览':'fit','看整体':'fit','看全貌':'fit','看全景':'fit',
  '看整个画布':'fit','看整个画面':'fit','看全画布':'fit','看全部内容':'fit','看所有内容':'fit',
  '全部显示':'fit','显示全部':'fit','看镜头':'fit','拉远镜头':'fit','镜头拉远':'fit',
  '看选中的':'selection','看选中':'selection','看选区':'selection','只看选中的':'selection',
  '聚焦选中的':'selection','聚焦选中':'selection','聚焦到选中的':'selection',
  '对准选中的':'selection','看选中的对象':'selection',
}
const selectAllPhrases=new Set(['全选'])
const trailing=/[。．.!！?？,，、;；:：~～…]+$/
const particle=/(?:吧|啊|呀|呢|哈|嘛|哦|噢|唉)$/
/** Collapse whitespace and strip sentence-final punctuation plus a trailing
 *  particle, touching nothing inside the sentence — the match stays whole-sentence. */
function normalize(text:string):string{
  return text.replace(/\s+/g,'').replace(trailing,'').replace(particle,'')
}
/** Local controls resolved without any model call. Returns null unless the whole
 *  sentence is an exact control phrase. */
export function matchDirectCommand(text:string):LiveCommand|null{
  const normalized=normalize(text)
  if(selectAllPhrases.has(normalized))return {kind:'control',action:'selectAll'}
  const view=directPhrases[normalized]
  return view?{kind:'control',action:'view',view}:null
}
