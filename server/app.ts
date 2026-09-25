import express from 'express'
import { interpretWithJev, ClarificationError } from './live/interpret.mjs'

// 本地 Whisper 服务（whisper-server）地址。放在项目 server 后面转发一次，
// 而不是让浏览器直连：端口只在服务端出现一次，前端换环境不用改。
const whisperUrl=()=>(process.env.WHISPER_URL||'http://127.0.0.1:8788').replace(/\/+$/,'')

/** 把裸 WAV 字节补成 whisper-server 要的 multipart 壳。前端走 FormData 时用不上，
 *  留给 curl 直接调试转发链路。 */
function asUpload(audio:Buffer){
  const form=new FormData()
  form.append('file',new Blob([new Uint8Array(audio)],{type:'audio/wav'}),'speech.wav')
  form.append('response_format','json')
  form.append('language','zh')
  form.append('temperature','0')
  return form
}

export function createApp(getKey:()=>string|undefined=()=>process.env.TYPESAFE_API_KEY){
  const app=express()
  app.use(express.json({limit:'256kb'}))
  let failure:string|null=null
  const state=()=>!getKey()?.trim()?{mode:'unconfigured',reason:'Jev 未配置：请设置 TYPESAFE_API_KEY 并重启服务。'}:failure?{mode:'failed',reason:failure}:{mode:'available'}
  app.get('/api/status',(_request,response)=>response.json(state()))
  // 前端开机探测：决定这次用本地 Whisper 还是退回浏览器识别。
  app.get('/api/asr/status',async(_request,response)=>{
    try{
      const probe=await fetch(whisperUrl(),{signal:AbortSignal.timeout(1200)})
      response.json({available:probe.ok,target:whisperUrl()})
    }catch{response.json({available:false,target:whisperUrl()})}
  })
  // 语音识别转发：把请求体原样搬给 whisper.cpp 的 /inference，这一层不解析音频。
  //
  // 为什么用 `type:()=>true` 收原始字节，而不是按 Content-Type 收 WAV：前端发的是
  // multipart/form-data（FormData 带 file 字段），和 whisper-server 的 /inference 是同一个
  // 容器格式，本该原样转发。原先这里写死 `express.raw({type:'audio/wav'})`——Content-Type
  // 一不匹配就跳过解析，`request.body` 是空对象，于是稳定 400，而错误文案又把它说成
  // 「识别服务返回 400」，把排查方向指向一直好着的 whisper。转发层退回成字节搬运工后，
  // 两端各自的容器格式可以独立演进，只要都对准同一个上游协议。
  // 示例句偏置挂在服务启动参数上，这里不逐次覆盖，免得两处 prompt 打架。
  app.post('/api/asr',express.raw({type:()=>true,limit:'16mb'}),async(request,response)=>{
    const audio=request.body
    if(!Buffer.isBuffer(audio)||!audio.length){response.status(400).json({error:'请提供音频数据。'});return}
    // 前端发的 multipart 原样透传；裸 WAV（Content-Type: audio/wav）在本地补上上游要的
    // multipart 壳，让 curl 直接调试这条链路时仍然可用。
    const contentType=request.headers['content-type']||''
    const passthrough=contentType.includes('multipart/form-data')
    try{
      const upstream=await fetch(`${whisperUrl()}/inference`,{
        method:'POST',
        headers:passthrough?{'content-type':contentType}:undefined,
        body:passthrough?audio:asUpload(audio),
        signal:AbortSignal.timeout(30000),
      })
      const text=await upstream.text()
      // 上游的失败原因要原样带回来：只回一个状态码会让使用者分不清是格式不对、
      // 模型没起来还是采样率不对，本轮这个问题就是被含糊的状态码掩盖了半天。
      if(!upstream.ok){response.status(upstream.status).json({error:text.trim().slice(0,300)||`本地识别服务返回 ${upstream.status}。`});return}
      let payload:{text?:string}
      try{payload=JSON.parse(text) as {text?:string}}catch{response.status(502).json({error:'本地识别服务返回了非 JSON 响应。'});return}
      response.json({text:(payload.text||'').trim()})
    }catch(error){response.status(502).json({error:error instanceof Error?error.message:'本地识别服务不可用。'})}
  })
  app.post('/api/interpret',async(request,response)=>{
    const message=request.body?.message,key=getKey()?.trim()
    if(!key){response.status(503).json({...state(),error:'Jev 未配置：没有密钥，画布未修改。'});return}
    if(typeof message!=='string'||!message.trim()||message.length>500){response.status(400).json({error:'请提供 1–500 字的指令。'});return}
    try{
      // One typed Jev entry point, regardless of obsolete client flags. No local parser.
      const result=await interpretWithJev(message,key,request.body.context||{})
      failure=null;response.json(result)
    }catch(error){
      if(error instanceof ClarificationError){
        failure=null
        response.json({source:'jev',decision:'clarify',status:'clarify',clarification:{field:error.field,question:error.message,originalTranscript:error.originalTranscript||message},originalTranscript:message,metrics:error.metrics});return
      }
      failure=error instanceof Error?error.message:'Jev 请求失败'
      response.status(502).json({mode:'failed',error:failure,originalTranscript:message})
    }
  })
  return app
}
