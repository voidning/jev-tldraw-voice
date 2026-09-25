import { useEffect, useRef, useState } from 'react'
import { ArrowUp, CircleHelp, CornerUpLeft, Mic, MicOff, MousePointer2, PanelLeftClose, PanelLeftOpen, Send, Sparkles } from 'lucide-react'
import { Tldraw, type Editor, type TLComponents, type TLShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import './App.css'
import { LiveEditor, TargetClarificationError } from './live-editor'
import { collectSpeech } from './voice-queue'
import { interpret as validateJev } from './jev-validation'
import { describeCommand } from './command-description'
import { matchDirectCommand } from './fast-path'
import { CanvasOrder } from './canvas-order'
import { canvasRevision } from './canvas-revision'
import { startLocalAsr, type LocalAsrHandle } from './asr'
import { JevMark, TldrawMark } from './brand-marks'
import type { LiveCommand } from './live-command'

type SpeechResult = { isFinal: boolean, 0: { transcript: string } }
type SpeechEvent = { resultIndex: number, results: ArrayLike<SpeechResult> }
type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

// 演示按钮照 README 的三段脚本取句：旧的「把连到“结束”的方框调成和“开始”一样宽」在
// 同句出现第二个引号标签时锚点判定不稳，已换成不带第二个标签的表述。
const examples = ['在这里建一个圆', '在圆下面建一个矩形', '把圆连到矩形', '把第一和第二个连起来', '把连到“结束”的矩形改成和圆一样宽', '把第一个移到圆的右边', '第一和第三个改成红色', '前两个小一点', '全部方形改成绿色', '把第三个删掉', '看全部']

// 演示时屏幕上只留画布本身：tldraw 自带的左上菜单区、底部工具栏、右侧样式面板、
// 左下缩放控件一律不渲染。这样做的理由不是「藏起来更好看」，而是把画面的每一处变化
// 都归因到那句话上——界面上没有任何可以手动点的东西，画布就只能是语音改的。
// 逐项置 null 而不用 hideUi，是为了让「关掉了哪些」留在代码里可读、可逐条恢复；
// 右键菜单、报错提示这类平时不占视觉的部件仍然保留。
const bareCanvas: TLComponents = {
  MenuPanel: null, PageMenu: null, MainMenu: null,
  Toolbar: null, StylePanel: null, NavigationPanel: null, ZoomMenu: null,
  Minimap: null, SharePanel: null, HelperButtons: null,
  ActionsMenu: null, QuickActions: null, CursorChatBubble: null,
  RichTextToolbar: null, ImageToolbar: null, VideoToolbar: null,
  DebugPanel: null, DebugMenu: null,
}
function App() {
  const editorRef = useRef<Editor | null>(null)
  const selectionRef = useRef<TLShapeId[]>([])
  const pointerRef = useRef<{ x: number, y: number } | null>(null)
  const hoveredRef = useRef<TLShapeId | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const localAsrRef = useRef<LocalAsrHandle | null>(null)
  const openPanelButtonRef = useRef<HTMLButtonElement | null>(null)
  const closePanelButtonRef = useRef<HTMLButtonElement | null>(null)
  const busyRef = useRef(false)
  const liveRef = useRef<LiveEditor | null>(null)
  const wantListening = useRef(false)
  const generation = useRef(0)
  const clarificationRef=useRef<{originalTranscript:string;field:string;page:string;revision:string;selected:string}|null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const recognitionRestart = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queue = useRef<Array<{text:string; point:{x:number;y:number}|null; hovered:TLShapeId|null; page:string }>>([])
  const [awaitingClarification,setAwaitingClarification]=useState(false)
  const [pending, setPending] = useState(0)
  const [interim, setInterim] = useState('')
  const [records, setRecords] = useState<string[]>([])
  function record(text:string) { setRecords(items => [...items.slice(-19), text]) }
  const [panelOpen, setPanelOpen] = useState(() => {
    const saved = window.localStorage.getItem('voice-panel-open')
    return saved === null ? !window.matchMedia('(max-width: 760px)').matches : saved === 'true'
  })
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const [mode, setMode] = useState<'available' | 'unconfigured' | 'failed' | 'loading'>('loading')
  const [supported] = useState(() => {
    const speechWindow = window as Window & { SpeechRecognition?: SpeechRecognitionConstructor, webkitSpeechRecognition?: SpeechRecognitionConstructor }
    return Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition)
  })
  // 识别引擎：本地 Whisper 优先（唯一能压「结束/接数」这类同音错字的方案），
  // 探测不到本地服务再退回浏览器内置识别。'probing' 只是开机那一瞬，
  // 免得服务还没探完就先把「浏览器不支持语音识别」这种话甩给用户。
  const [engine, setEngine] = useState<'probing' | 'local' | 'browser'>('probing')
  const [listening, setListening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState('把鼠标移到画布上，然后说出操作。')
  const [feedbackKind, setFeedbackKind] = useState<'neutral' | 'success' | 'error'>('neutral')
  const [lastCommand, setLastCommand] = useState('')
  const [selection, setSelection] = useState(0)
  // onMount 只写 ref，不触发渲染；编号层需要等编辑器真的就绪才能挂上去。
  const [canvasReady, setCanvasReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/asr/status').then(response=>response.json()).then((status:{available?:boolean})=>{if(!cancelled)setEngine(status.available?'local':'browser')}).catch(()=>{if(!cancelled)setEngine('browser')})
    fetch('/api/status').then(response=>{if(!response.ok)throw Error('无法读取 Jev 状态');return response.json()}).then((status:{mode:'available'|'unconfigured'|'failed';reason?:string})=>{setMode(status.mode);if(status.reason){setFeedback(status.reason);setFeedbackKind('error')}}).catch(()=>{setMode('failed');setFeedback('Jev 请求失败：无法连接服务。');setFeedbackKind('error')})
    // Refs intentionally point at the latest active recognizer/request during cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { cancelled = true; wantListening.current = false; generation.current++; queue.current = []; requestRef.current?.abort(); if(recognitionRestart.current) clearTimeout(recognitionRestart.current); recognitionRef.current?.stop(); localAsrRef.current?.stop() }
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const update = (event: MediaQueryListEvent) => setIsNarrow(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  function submit(message: string) {
    const text = message, editor = editorRef.current
    if (!text.trim() || !editor) return
    if (queue.current.length >= 20) { setFeedback('等待指令已达 20 条，请稍后再说。'); return }
    queue.current.push({ text, point: pointerRef.current ? {...pointerRef.current} : null, hovered: hoveredRef.current,
      page: editor.getCurrentPageId() })
    setPending(queue.current.length)
    void drain()
  }

  function stopListening() { wantListening.current = false; if(recognitionRestart.current) clearTimeout(recognitionRestart.current); recognitionRestart.current=null; recognitionRef.current?.stop(); localAsrRef.current?.stop(); localAsrRef.current=null; setListening(false); setInterim('') }
  function cancelPending() {
    generation.current++; clarificationRef.current=null; setAwaitingClarification(false); requestRef.current?.abort(); queue.current = []; setPending(0); stopListening()
    setFeedback('已取消尚未执行的指令。'); setFeedbackKind('neutral')
  }
  function undoFromButton() {
    const live = liveRef.current, editor = editorRef.current
    if (!live || !editor) return
    try {
      const outcome = live.execute({kind:'edit',operation:'undo',operand:'object',parameters:{}},null)
      clarificationRef.current = null; setAwaitingClarification(false)
      selectionRef.current = [...editor.getSelectedShapeIds()]; setSelection(selectionRef.current.length)
      setFeedback(outcome); setFeedbackKind('success'); record('点击撤销 → ' + outcome)
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '撤销未完成'); setFeedbackKind('error')
    }
  }
  async function drain() {
    if (busyRef.current) return
    const editor = editorRef.current, live = liveRef.current
    if (!editor || !live) return
    busyRef.current = true; setBusy(true)
    try {
      while (queue.current.length) {
        const item = queue.current.shift()!; setPending(queue.current.length)
        const token = generation.current
        const command = item.text; setLastCommand(command)
        let clarificationSource=command
        try {
          if (editor.getCurrentPageId() !== item.page) throw Error('页面已切换，请重新发出指令。')
          const selectedBefore = [...editor.getSelectedShapeIds()]
          const context = live.context(item.point)
          const revision = canvasRevision(editor)
          const pendingClarification=clarificationRef.current
          if(pendingClarification?.page===item.page&&pendingClarification.revision===revision&&pendingClarification.selected===JSON.stringify(selectedBefore))context.clarification={originalTranscript:pendingClarification.originalTranscript,field:pendingClarification.field}
          else {clarificationRef.current=null;setAwaitingClarification(false)}
          // 闭集口令（看全部、全选这类）只有一种解释，本地就能定下，不值得为它往返一次模型。
          // 命中即跳过网络、校验与画布快照比对：没有等待窗口，也就没有可被改动的画布。
          const direct=matchDirectCommand(command)
          let parsed:LiveCommand
          if(direct)parsed=direct
          else{
            setFeedback('正在判断：' + command); setFeedbackKind('neutral')
            const controller = new AbortController(); requestRef.current = controller
            const response = await fetch('/api/interpret', { method:'POST', headers:{'Content-Type':'application/json'},
              body:JSON.stringify({message:command,context}), signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)]) }).catch(error=>{if(!controller.signal.aborted)setMode('failed');throw error})
            const payload = await response.json()
            if (token !== generation.current) continue
            if (!response.ok) {setMode(payload.mode==='unconfigured'?'unconfigured':'failed');throw Error(payload.error || 'Jev 请求失败')}
            setMode('available')
            if (editor.getCurrentPageId() !== item.page || canvasRevision(editor) !== revision ||
              JSON.stringify(editor.getSelectedShapeIds()) !== JSON.stringify(selectedBefore)) throw Error('判断期间画布或选区发生变化，请重说这句。')
            if(payload.status==='clarify') {
              queue.current=[];setPending(0)
              const field=payload.clarification?.field
              clarificationRef.current=['negated','unrelated'].includes(field)?null:{originalTranscript:payload.clarification?.originalTranscript||command,field,page:item.page,revision,selected:JSON.stringify(selectedBefore)}
              setAwaitingClarification(!!clarificationRef.current)
              const question=payload.clarification?.question||'请说明含糊的部分。'
              setFeedback(question+(wantListening.current?' 麦克风仍在聆听。':''));setFeedbackKind('neutral');record(command+' → '+question)
              break
            }
            if(payload.clarificationSource===command||payload.clarificationSource===context.clarification?.originalTranscript)clarificationSource=payload.clarificationSource||command
            parsed=(await validateJev(command,context,async()=>({ok:response.ok,status:response.status,payload}))).command
          }
          const understood=describeCommand(parsed,id=>live.label(id))
          let outcome:string
          if(parsed.kind==='control'){
            if(parsed.action==='stopListening'){stopListening();outcome='已停止聆听'}
            else if(parsed.action==='selectAll')outcome=live.selectAll()
            else outcome=live.view(parsed.view)
          }
          else outcome=live.execute(parsed,item.point,item.hovered)
          outcome+='；理解为：'+understood+(direct?'（本地直通）':'')
          clarificationRef.current=null;setAwaitingClarification(false)
          selectionRef.current = [...editor.getSelectedShapeIds()]; setSelection(selectionRef.current.length)
          setFeedback(outcome); setFeedbackKind('success'); record(command + ' → ' + outcome)
        } catch(error) {
          if (token !== generation.current) continue
          const isTargetQuestion=error instanceof TargetClarificationError
          clarificationRef.current=isTargetQuestion?{originalTranscript:clarificationSource,field:'target',page:item.page,revision:canvasRevision(editor),selected:JSON.stringify(editor.getSelectedShapeIds())}:null
          setAwaitingClarification(isTargetQuestion)
          const message = error instanceof Error ? error.message : '操作未完成'
          queue.current=[]; setPending(0)
          setFeedback(message + (wantListening.current ? ' 后续排队指令已清空，麦克风仍在聆听，请继续说。' : ' 后续排队指令已清空，请重新输入。')); setFeedbackKind('error'); record(command + ' → ' + message)
          break
        }
      }
    } finally { busyRef.current=false; setBusy(false) }
  }

  // 本地链路没有「连续聆听 + 自动重连」那套东西：麦克风流一直开着，断句在本地做，
  // 所以这里只需要启动一次和停一次，不存在 onend 重连的窗口。
  async function startLocalListening() {
    if (!navigator.mediaDevices?.getUserMedia) { setFeedback('当前环境无法采集麦克风，请输入文字指令。'); setFeedbackKind('error'); return }
    wantListening.current = true
    setFeedback('正在启动麦克风…'); setFeedbackKind('neutral')
    try {
      const handle = await startLocalAsr({
        onText: text => { if (!wantListening.current) return; setInterim(''); setDraft(text); submit(text) },
        onState: state => { if (wantListening.current) setInterim(state === 'recognizing' ? '正在识别…' : '') },
        onError: message => { if (!wantListening.current) return; setFeedback('本地识别失败：' + message + '，请检查本地识别服务。'); setFeedbackKind('error') },
      })
      if (!wantListening.current) { handle.stop(); return }
      localAsrRef.current = handle
      setListening(true)
      setFeedback('本地 Whisper 聆听中，每说完一个短句自动执行。')
    } catch (error) {
      wantListening.current = false
      setFeedback('麦克风未能启动：' + (error instanceof Error ? error.message : '未知错误') + '；请输入文字指令。')
      setFeedbackKind('error')
    }
  }

  function switchEngine() {
    if (listening) stopListening()
    const next = engine === 'local' ? 'browser' : 'local'
    if (next === 'browser' && !supported) { setFeedback('当前浏览器不支持语音识别。'); setFeedbackKind('error'); return }
    setEngine(next)
    setFeedback(next === 'local' ? '已切换到本地 Whisper 识别。' : '已切换到浏览器识别。'); setFeedbackKind('neutral')
  }

  function toggleRecording() {
    if (wantListening.current) { stopListening(); setFeedback('已停止聆听，已接收的指令继续执行。'); return }
    if (engine === 'probing') { setFeedback('正在检查识别服务，请稍等一下再点麦克风。'); return }
    if (engine === 'local') { void startLocalListening(); return }
    const speechWindow = window as Window & {SpeechRecognition?:SpeechRecognitionConstructor,webkitSpeechRecognition?:SpeechRecognitionConstructor}
    const Constructor = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition
    if(!Constructor) { setFeedback('浏览器不支持语音识别，请输入文字指令。'); return }
    const recognition = new Constructor(); recognitionRef.current=recognition
    recognition.lang='zh-CN'; recognition.continuous=true; recognition.interimResults=true
    const seen = new Set<number>(); wantListening.current=true
    let retryDelay=250
    recognition.onresult = event => {
      if(!wantListening.current) return
      retryDelay=250
      const result=collectSpeech(event.results,event.resultIndex,seen)
      setInterim(result.interim)
      for(const text of result.final) {
        setDraft(text);submit(text)
      }
    }
    recognition.onerror = event => {
      if(!wantListening.current || recognitionRef.current!==recognition) return
      if(['not-allowed','service-not-allowed','audio-capture','language-not-supported'].includes(event.error)) {
        stopListening()
        setFeedback('麦克风或语音服务不可用：' + event.error + '；请检查权限或设备后重新开启。'); setFeedbackKind('error')
        return
      }
      retryDelay=event.error==='no-speech'?250:Math.min(Math.max(retryDelay*2,1000),5000)
      setFeedback(event.error==='no-speech' ? '暂时没听清，麦克风保持开启，请继续说。' : '语音识别暂时中断，正在自动重连，请稍后继续说。')
      setFeedbackKind('neutral')
    }
    recognition.onend = () => {
      if(wantListening.current && recognitionRef.current===recognition) {
        if(recognitionRestart.current) clearTimeout(recognitionRestart.current)
        recognitionRestart.current=setTimeout(() => {
          recognitionRestart.current=null
          if(!wantListening.current || recognitionRef.current!==recognition) return
          seen.clear()
          try { recognition.start();setListening(true) } catch {stopListening();setFeedback('语音服务无法重新启动，请重新点击麦克风。')}
        },retryDelay)
      } else setListening(false)
    }
    try { recognition.start();setListening(true);setFeedback('持续聆听中，每说完一个短句自动执行。') }
    catch {stopListening();setFeedback('麦克风未能启动，请重试。');setFeedbackKind('error')}
  }

  function trackPointer(event: React.PointerEvent<HTMLDivElement>) {
    const editor = editorRef.current
    if (!editor) return
    const point = editor.screenToPage({ x: event.clientX, y: event.clientY })
    pointerRef.current = { x: point.x, y: point.y }
    hoveredRef.current = editor.getShapeAtPoint(point, { hitInside: true, margin: 0 })?.id ?? null
  }

  function syncSelection() {
    requestAnimationFrame(() => {
      selectionRef.current = editorRef.current?.getSelectedShapeIds() ?? []
      setSelection(selectionRef.current.length)
    })
  }

  function togglePanel(open: boolean) {
    setPanelOpen(open)
    window.localStorage.setItem('voice-panel-open', String(open))
    requestAnimationFrame(() => {
      if (open) closePanelButtonRef.current?.focus()
      else openPanelButtonRef.current?.focus()
    })
  }

  return (
    <div className={`app-shell ${panelOpen ? '' : 'panel-collapsed'}`}>
      {panelOpen ? <button className="panel-backdrop" type="button" aria-label="关闭语音面板" onClick={() => togglePanel(false)} /> : null}
      <aside id="voice-panel" className="side-panel" hidden={!panelOpen} aria-label="语音操作面板">
        <header className="brand"><span className="brand-mark"><Sparkles size={19} strokeWidth={2.2} /></span><div><strong>说画</strong><small>Jev × tldraw</small></div><button ref={closePanelButtonRef} className="panel-toggle" type="button" aria-label="收起语音面板" title="收起语音面板" aria-controls="voice-panel" aria-expanded={panelOpen} onClick={() => togglePanel(false)}><PanelLeftClose size={19} /></button></header>
        <div className="panel-content">
          <div className="section-kicker">语音画布 · Jev 理解</div>
          <h1>说一句，<br />画一步。</h1>
          <p className="intro">把鼠标放到目标位置，开启一次麦克风，连续说出短句。画布随每句话更新，说“停”结束聆听。</p>

          <div className="recorder-card">
            <button className={`mic-button ${listening ? 'is-listening' : ''}`} type="button" onClick={toggleRecording} aria-label={listening ? '停止录音' : '开始语音输入'}>
              {listening ? <MicOff size={27} /> : <Mic size={27} />}
            </button>
            <div>
              <strong>{listening ? '正在聆听' : '点击麦克风说话'}</strong>
              <span>{engine === 'probing' ? '正在检查识别服务…' : engine === 'local' ? '本地 Whisper · 短句结束自动执行' : supported ? '浏览器识别 · 连续聆听' : '当前浏览器不支持语音识别'}</span>
              {engine === 'probing' ? null : <button className="engine-switch" type="button" onClick={switchEngine}>{engine === 'local' ? '改用浏览器识别' : '改用本地 Whisper'}</button>}
            </div>
          </div>

          <div className="transcript"><span className="field-label">原始转写 / 输入</span><p>{interim || draft || '你说的话会显示在这里'}</p></div>
          <div className={`feedback ${feedbackKind}`} role="status" aria-live="polite"><span className="feedback-dot" />{feedback}</div>

          <div className="input-group"><label htmlFor="command">文字指令</label><div className="input-row"><input id="command" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit(draft) }} placeholder="或在这里输入指令"  /><button aria-label="执行文字指令" title="执行" type="button" onClick={() => void submit(draft)} disabled={!draft.trim()}><Send size={18} /></button></div></div>

          <div className="queue-status" role="status">{busy ? '正在处理' : '准备就绪'} · 等待 {pending} 条 <button type="button" onClick={cancelPending} disabled={!busy && !pending && !listening && !awaitingClarification}>取消待执行</button></div>
          {records.length ? <ol className="voice-records" aria-label="执行记录">{records.map((item,index)=><li key={index}>{item}</li>)}</ol> : null}
          <div className="examples"><div className="section-heading"><span>可以这样说</span><CircleHelp size={15} /></div>{examples.map((example) => <button key={example} type="button" onClick={() => setDraft(example)}>{example}<ArrowUp size={13} /></button>)}</div>
        </div>
        <footer className="panel-footer"><span className={`mode-indicator ${mode}`} />{mode==='available'?'Jev 可用':mode==='unconfigured'?'Jev 未配置':mode==='failed'?'Jev 请求失败':'正在检查 Jev…'}<span className="footer-separator" />选中 {selection} 个</footer>
      </aside>
      <main className="workspace" inert={panelOpen && isNarrow}>
        <div className="workspace-bar">
          <div className="workspace-heading">
            {!panelOpen ? <button ref={openPanelButtonRef} className="panel-toggle open-panel-toggle" type="button" aria-label="展开语音面板" title="展开语音面板" aria-controls="voice-panel" aria-expanded={panelOpen} onClick={() => togglePanel(true)}><PanelLeftOpen size={19} /></button> : null}
            <span className="workspace-title">画布</span><span className="workspace-subtitle brand-pair" role="img" aria-label="Jev 与 tldraw" title="理解来自 Jev，图形来自 tldraw"><JevMark /><span className="brand-times" aria-hidden="true">×</span><TldrawMark /></span>
          </div>
          <div className="workspace-actions">
            {!panelOpen ? <><span className={`compact-feedback ${feedbackKind}`} role="status" aria-live="polite">{feedback}</span><button className={`compact-mic ${listening ? 'is-listening' : ''}`} type="button" aria-label={listening ? '停止录音' : '开始语音输入'} title={listening ? '停止录音' : '开始语音输入'} onClick={toggleRecording}>{listening ? <MicOff size={18} /> : <Mic size={18} />}<span>{listening ? '停止' : '说话'}</span></button></> : null}
            <button type="button" className="undo-button" onClick={undoFromButton}><CornerUpLeft size={16} />撤销</button>
          </div>
        </div>
        <div className="canvas-wrap" onPointerMove={trackPointer} onPointerUp={syncSelection}>
          <Tldraw components={bareCanvas} persistenceKey="jev-tldraw-voice-canvas" onMount={(editor) => { editorRef.current = editor; liveRef.current = new LiveEditor(editor); selectionRef.current = editor.getSelectedShapeIds(); setSelection(selectionRef.current.length); setCanvasReady(true) }} />
          {canvasReady && editorRef.current && liveRef.current ? <CanvasOrder editor={editorRef.current} live={liveRef.current} /> : null}
        </div>
        <div className="canvas-hint"><MousePointer2 size={15} /><span>画布上的编号是创建顺序：可以说“第二个大一点”“把第一个移到圆的右边”。</span>{lastCommand ? <span className="last-command">上次：{lastCommand}</span> : null}</div>
      </main>
    </div>
  )
}

export default App
