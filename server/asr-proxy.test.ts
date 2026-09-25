// /api/asr 转发层的契约测试。
//
// 这一层此前完全没有测试，于是藏着一个稳定复现的 400：前端发 multipart/form-data，
// 服务端按 audio/wav 收原始字节，Content-Type 不匹配就跳过解析、body 为空，
// 每次语音都被拒，而错误文案把责任写成了「识别服务返回 400」。
// 下面第一条用例就是那个 bug 的回归锁——它在旧实现下必然是红的。

import {once} from 'node:events'
import {createServer,type Server} from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'
import {createApp} from './app.js'

/** 一段最小的合法 WAV：44 字节 RIFF 头 + 0.1s 静音样本，用来确认音频字节真的过了转发层。 */
function probeWav(){
  const samples=1600
  const buffer=Buffer.alloc(44+samples*2)
  buffer.write('RIFF',0);buffer.writeUInt32LE(36+samples*2,4);buffer.write('WAVE',8)
  buffer.write('fmt ',12);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22)
  buffer.writeUInt32LE(16000,24);buffer.writeUInt32LE(32000,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34)
  buffer.write('data',36);buffer.writeUInt32LE(samples*2,40)
  return new Uint8Array(buffer)
}

type Received={contentType:string|undefined,body:Buffer}

/** 假 whisper-server：记下收到的原始请求，并按给定策略回应。 */
async function fakeWhisper(reply:(body:Buffer)=>[number,string]=(()=>[200,JSON.stringify({text:'把第三个删除'})])){
  const received:Received[]=[]
  const server:Server=createServer((request,response)=>{
    const chunks:Buffer[]=[]
    request.on('data',(chunk:Buffer)=>chunks.push(chunk))
    request.on('end',()=>{
      const body=Buffer.concat(chunks)
      received.push({contentType:request.headers['content-type'],body})
      const [status,text]=reply(body)
      response.writeHead(status,{'content-type':'application/json'})
      response.end(text)
    })
  })
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  const {port}=server.address() as {port:number}
  return {server,received,url:`http://127.0.0.1:${port}`}
}

/** 起真 app 并把 whisper 地址指向假上游；close 时一并还原环境变量。 */
async function startApp(whisperUrl:string){
  const previous=process.env.WHISPER_URL
  process.env.WHISPER_URL=whisperUrl
  const app=createApp(()=>undefined).listen(0,'127.0.0.1')
  await once(app,'listening')
  const {port}=app.address() as {port:number}
  return {
    url:`http://127.0.0.1:${port}`,
    close:()=>{
      app.close()
      if(previous===undefined)delete process.env.WHISPER_URL
      else process.env.WHISPER_URL=previous
    },
  }
}

/** 前端 asr.ts 的发法：FormData（multipart/form-data）。 */
function browserForm(){
  const form=new FormData()
  form.append('file',new Blob([probeWav()],{type:'audio/wav'}),'speech.wav')
  form.append('response_format','json')
  form.append('language','zh')
  form.append('temperature','0')
  return form
}

test('the browser multipart body reaches whisper with its audio intact',async()=>{
  const whisper=await fakeWhisper()
  const app=await startApp(whisper.url)
  try{
    const response=await fetch(`${app.url}/api/asr`,{method:'POST',body:browserForm()})
    assert.equal(response.status,200)
    assert.deepEqual(await response.json(),{text:'把第三个删除'})
    assert.equal(whisper.received.length,1)
    // 原样透传：boundary 由浏览器生成，转发层不重编码，上游看到的就是它。
    assert.match(String(whisper.received[0].contentType),/^multipart\/form-data; boundary=.+/)
    assert.ok(whisper.received[0].body.includes(Buffer.from('RIFF')),'上游应收到原始 WAV 字节，而不只是空壳')
  }finally{app.close();whisper.server.close()}
})

test('a bare WAV body is wrapped into the shell whisper expects',async()=>{
  const whisper=await fakeWhisper()
  const app=await startApp(whisper.url)
  try{
    const response=await fetch(`${app.url}/api/asr`,{
      method:'POST',headers:{'content-type':'audio/wav'},body:probeWav(),
    })
    assert.equal(response.status,200)
    assert.match(String(whisper.received[0].contentType),/^multipart\/form-data; boundary=.+/)
    assert.ok(whisper.received[0].body.includes(Buffer.from('RIFF')))
  }finally{app.close();whisper.server.close()}
})

test('an upstream rejection keeps its status and reason',async()=>{
  const whisper=await fakeWhisper(()=>[400,'{"error":"no audio file"}'])
  const app=await startApp(whisper.url)
  try{
    const response=await fetch(`${app.url}/api/asr`,{method:'POST',body:browserForm()})
    assert.equal(response.status,400)
    // 上游的措辞要原样回来：含糊的状态码曾把排查方向指向一直好着的 whisper。
    assert.match(String((await response.json() as {error?:string}).error),/no audio file/)
  }finally{app.close();whisper.server.close()}
})

test('an empty body is refused before anything reaches whisper',async()=>{
  const whisper=await fakeWhisper()
  const app=await startApp(whisper.url)
  try{
    const response=await fetch(`${app.url}/api/asr`,{
      method:'POST',headers:{'content-type':'audio/wav'},body:'',
    })
    assert.equal(response.status,400)
    assert.equal(whisper.received.length,0)
  }finally{app.close();whisper.server.close()}
})
