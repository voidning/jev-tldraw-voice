import https from 'node:https';

/** Node 内置 fetch（undici）默认 keepAliveTimeout 只有 4s。语音交互的自然停顿必然超过它，
 * 连接被判空闲关闭，下一次调用重付约 5.5s（实测 2026-09-23：空闲 5s 后 5821ms，紧跟上一次则 560ms）。
 * 这段开销主要不在 TLS，而在域名重新解析：代理规则表末尾的 GEOIP,CN,DIRECT 让未命中域名规则的
 * api.typesafe.ai 落到本地解析，而解析用的境外 DoH 是直连的，于是每次白等约 5s。
 * 连接复用时 socket 已指向解析好的 IP，这一步随之省掉。故改用长保活 Agent，闲置连接不再丢弃。 */
const agent=new https.Agent({keepAlive:true,keepAliveMsecs:30000,timeout:300000,maxSockets:16});

export function keepAliveFetch(url,{method='GET',headers={},body,signal}={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);
    const request=https.request({hostname:target.hostname,port:target.port||443,path:target.pathname+target.search,method,headers,agent},response=>{
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('error',reject);
      response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode??502,statusText:response.statusMessage??'',headers:response.headers})));
    });
    request.on('error',reject);
    if(signal){
      const abort=()=>request.destroy(signal.reason instanceof Error?signal.reason:new Error('Jev 请求已中止。'));
      if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    }
    if(body)request.write(body);
    request.end();
  });
}
