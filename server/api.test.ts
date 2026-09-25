import {once} from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'
import {createApp} from './app.js'
test('missing key has no parser or legacy flag bypass',async()=>{
 const server=createApp(()=>undefined).listen(0,'127.0.0.1')
 await once(server,'listening')
 try{
  const port=(server.address() as {port:number}).port,url=`http://127.0.0.1:${port}`
  assert.equal((await(await fetch(url+'/api/status')).json()).mode,'unconfigured')
  for(const live of [true,false,undefined]){
   const response=await fetch(url+'/api/interpret',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'在这里建一个圆',live})})
   const body=await response.json();assert.equal(response.status,503);assert.equal(body.mode,'unconfigured');assert.equal(body.command,undefined);assert.equal(body.action,undefined)
  }
 }finally{server.close()}
})
