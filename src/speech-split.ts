// 流式聆听：把「已经听到的话」切成可以立刻执行的分句。
//
// 为什么需要它：浏览器只在停顿后把一段话转正（isFinal）。用户一口气说完
// 「在这里建一个圆，然后在它里面写“开始”，然后把它改成绿色」时，整段会是一块，
// 画布要等整句说完才开始动。而识别的未定稿结果（interim）其实早就把前面几段说出来了。
//
// 判据与服务端 splitClauses 相同（逗号、分号、句号、「然后」「接着」是边界，
// 引号内的不算），差别在增量：只取边界**之前**的部分。边界之后的文字还在被识别改写，
// 提前执行等于猜——「圆」在未定稿里可能先是「元」，落笔画下去就错了。
//
// 这一层是纯本地的，它回答的不是「用户想要什么」，而是「这句话说完了没有」。
// 答案在字符序列里，不需要模型。

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['“', '”'], ['「', '」'], ['『', '』'], ['"', '"'], ["'", "'"],
]

const BOUNDARY = /[，,；;。]|然后|接着/g

/** 边界落在这些区间内就不算边界——那是用户在念要写进画布的文字。 */
function quotedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let index = 0
  while (index < text.length) {
    const pair = QUOTE_PAIRS.find(([open]) => text[index] === open)
    if (!pair) { index += 1; continue }
    const close = text.indexOf(pair[1], index + 1)
    // 引号还没闭上，说明正在说引号里的内容：它之后的一切都按「引号内」处理，
    // 免得把正在念的文字当成下一句指令的起点。
    ranges.push([index, close === -1 ? text.length : close + 1])
    index = close === -1 ? text.length : close + 1
  }
  return ranges
}

/** 按边界把一段话切成所有分句。与服务端 splitClauses 同样的口径。 */
export function splitClauses(text: string): string[] {
  const ranges = quotedRanges(text)
  const parts: string[] = []
  let last = 0
  for (const match of text.matchAll(BOUNDARY)) {
    if (ranges.some(([a, b]) => match.index >= a && match.index < b)) continue
    parts.push(text.slice(last, match.index))
    last = match.index + match[0].length
  }
  parts.push(text.slice(last))
  return parts.map(part => part.trim()).filter(part => part && !/^(然后|接着)$/.test(part))
}

export type StreamCut = { segments: string[], consumed: number }

/**
 * 从 text 的 from 位置起，切出「已经确定说完」的分句，并给出下次该从哪继续。
 *
 * 只认结束位置**严格小于**文本末尾的边界。边界刚好落在末尾时（用户正说到逗号后面）
 * 先不切，等下一个字出现——这样切出去的内容永远不是当前正在改写的那个尾巴。
 */
export function cutReadyClauses(text: string, from: number): StreamCut {
  const start = Math.max(0, Math.min(from, text.length))
  const tail = text.slice(start)
  const ranges = quotedRanges(tail)
  let lastEnd = -1
  for (const match of tail.matchAll(BOUNDARY)) {
    const end = match.index + match[0].length
    if (end >= tail.length) continue
    if (ranges.some(([a, b]) => match.index >= a && match.index < b)) continue
    lastEnd = end
  }
  if (lastEnd < 0) return { segments: [], consumed: start }
  return { segments: splitClauses(tail.slice(0, lastEnd)), consumed: start + lastEnd }
}

/**
 * 跨事件累积识别的转写，吐出可以立刻提交的分句。
 *
 * 两个信源，两条规则：
 * - **定稿段**（isFinal）——浏览器认为这段说完了，从上次提交点到这里的全部内容都可以走；
 * - **未定稿文本**（interim）——只取边界之前的部分，边界之后不动。
 *
 * consumed 是绝对位置，所以同一段文字不会被提交两次：定稿时它已经在 consumed 之前，
 * 兜底那一句切出来就是空的。
 */
export class SpeechStream {
  private finalized = ''
  private consumed = 0

  reset() {
    this.finalized = ''
    this.consumed = 0
  }

  push(newFinal: string[], interim: string): string[] {
    const before = this.finalized.length
    for (const segment of newFinal) this.finalized += segment
    const justFinalized = this.finalized.length > before

    const ready: string[] = []
    if (justFinalized) {
      ready.push(...splitClauses(this.finalized.slice(Math.min(this.consumed, this.finalized.length))))
      this.consumed = this.finalized.length
    }
    const cut = cutReadyClauses(this.finalized + interim, Math.max(this.consumed, this.finalized.length))
    ready.push(...cut.segments)
    this.consumed = cut.consumed
    return ready
  }
}
