// 本地语音识别链路：浏览器采集 → 16k 单声道 PCM → 本地 VAD 切句 → 本地 Whisper。
//
// 为什么不用 webkitSpeechRecognition：它对我们是黑盒，没有热词入口，
// 「结束」会被稳定听成「接数」。本地 Whisper 可以用示例句做 decoder 偏置，
// 这类只差声调的同音错字才压得下去。代价是必须自己管采集与断句。
//
// 断句策略：不做「说完一句再回想」，而是实时算帧能量。进入语音要先连超阈值 2 帧，
// 退出要连续静音 520ms。前导留 3 帧 pre-roll，避免把起头的字削掉。
// 服务端还挂着 Silero VAD 兜静音幻觉，这里是第一道、不是唯一一道。

export type LocalAsrState = 'listening' | 'speech' | 'recognizing'

export type LocalAsrHandle = { stop: () => void }

export type LocalAsrOptions = {
  // 指向 whisper-server 的 /inference（开发期同源走项目 server 的 /api/asr 代理）。
  endpoint?: string
  onText: (text: string) => void
  onState?: (state: LocalAsrState) => void
  onError?: (message: string) => void
}

const SAMPLE_RATE = 16000
const FRAME_SIZE = 1024 // 64ms @16k
const PREROLL_FRAMES = 3 // 起头保护，约 190ms
const CALIBRATE_FRAMES = 5 // 前 320ms 只量底噪，不判定
const ONSET_FRAMES = 2 // 连超阈值 2 帧才算开口
const SILENCE_FRAMES = 8 // 连续静音 520ms 收句
const MIN_SPEECH_MS = 300 // 太短的多半是咳嗽/桌面响动
const MAX_SPEECH_MS = 12000 // 说太久强制切，免得一直不提交

function rms(frame: Float32Array) {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

function encodeWav(samples: Float32Array, sampleRate: number) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }
  return new Blob([view], { type: 'audio/wav' })
}

export async function startLocalAsr(options: LocalAsrOptions): Promise<LocalAsrHandle> {
  const endpoint = (options.endpoint ?? '/api/asr').replace(/\/$/, '')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  // 指定 16k 让浏览器自己重采样，省掉一段手写重采样代码。
  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  await context.resume()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(FRAME_SIZE, 1, 1)
  // 处理器必须挂在通往 destination 的链路上才会被驱动；用 0 增益静音输出，
  // 否则麦克风原声会被放出来形成啸叫。
  const mute = context.createGain()
  mute.gain.value = 0
  source.connect(processor)
  processor.connect(mute)
  mute.connect(context.destination)

  let stopped = false
  let frames = 0
  let noiseFloor = 0
  let calibrationSum = 0
  let threshold = 0.012
  let speaking = false
  let onsetRun = 0
  let silenceRun = 0
  const preRoll: Float32Array[] = []
  let collected: Float32Array[] = []
  let speechMs = 0

  // 串行提交：whisper-server 单实例，并发发过去只会互相排队还把顺序打乱。
  let sending: Promise<void> = Promise.resolve()

  function flush() {
    const durationMs = speechMs
    const chunks = collected
    collected = []
    speaking = false
    speechMs = 0
    onsetRun = 0
    silenceRun = 0
    if (durationMs < MIN_SPEECH_MS || !chunks.length) return
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const merged = new Float32Array(total)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
    const wav = encodeWav(merged, SAMPLE_RATE)
    options.onState?.('recognizing')
    sending = sending.then(async () => {
      if (stopped) return
      try {
        const form = new FormData()
        form.append('file', wav, 'speech.wav')
        form.append('response_format', 'json')
        form.append('language', 'zh')
        form.append('temperature', '0')
        const response = await fetch(`${endpoint}`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) })
        if (!response.ok) {
          // 服务端会把原因写在 error 里（格式不对、上游 4xx、模型没起来各不相同）。
          // 只回一个状态码会把排查方向指错：曾经这句把转发层的 400 说成「识别服务返回 400」，
          // 看上去像 whisper 挂了，实际 whisper 一直好着。
          const detail = (await response.json().catch(() => null)) as { error?: unknown } | null
          const reason = typeof detail?.error === 'string' && detail.error.trim() ? detail.error.trim() : `识别服务返回 ${response.status}`
          throw new Error(reason)
        }
        const payload = await response.json()
        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        if (text && !stopped) options.onText(text)
      } catch (error) {
        if (!stopped) options.onError?.(error instanceof Error ? error.message : '本地识别失败')
      } finally {
        if (!stopped) options.onState?.('listening')
      }
    })
  }

  processor.onaudioprocess = (event) => {
    if (stopped) return
    const frame = new Float32Array(event.inputBuffer.getChannelData(0))
    const level = rms(frame)
    frames++

    if (frames <= CALIBRATE_FRAMES) {
      calibrationSum += level
      noiseFloor = calibrationSum / frames
      // 底噪只是参考，阈值有下限，免得安静房间把呼吸声判定成说话。
      threshold = Math.max(0.010, noiseFloor * 3.2)
      return
    }

    if (!speaking) {
      preRoll.push(frame)
      if (preRoll.length > PREROLL_FRAMES) preRoll.shift()
      onsetRun = level > threshold ? onsetRun + 1 : 0
      if (onsetRun >= ONSET_FRAMES) {
        speaking = true
        collected = [...preRoll]
        speechMs = collected.length * (FRAME_SIZE / SAMPLE_RATE) * 1000
        preRoll.length = 0
        silenceRun = 0
        options.onState?.('speech')
      }
      return
    }

    collected.push(frame)
    speechMs += (FRAME_SIZE / SAMPLE_RATE) * 1000
    silenceRun = level > threshold ? 0 : silenceRun + 1
    if (silenceRun >= SILENCE_FRAMES || speechMs >= MAX_SPEECH_MS) flush()
  }

  const handle: LocalAsrHandle = {
    stop: () => {
      if (stopped) return
      stopped = true
      processor.onaudioprocess = null
      try { source.disconnect() } catch { /* 已断开 */ }
      try { processor.disconnect() } catch { /* 已断开 */ }
      try { mute.disconnect() } catch { /* 已断开 */ }
      for (const track of stream.getTracks()) track.stop()
      void context.close().catch(() => { /* 已关闭 */ })
    },
  }
  options.onState?.('listening')
  return handle
}
