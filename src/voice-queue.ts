export class AckQueue<T>{
  private pending:T[]=[];
  private active=false;
  private dispatch:(item:T)=>void;
  constructor(dispatch:(item:T)=>void){this.dispatch=dispatch;}
  enqueue(item:T){this.pending.push(item);this.next();}
  finish(){this.active=false;this.next();}
  private next(){if(this.active||!this.pending.length)return;this.active=true;this.dispatch(this.pending.shift()!);}
}
type Result={isFinal:boolean;[index:number]:{transcript:string}|undefined};
export function collectSpeech(results:ArrayLike<Result>,start:number,seen:Set<number>){
  const final:string[]=[];let interim='';
  for(let i=start;i<results.length;i++){
    const transcript=String(results[i]?.[0]?.transcript||'');
    if(!transcript.trim())continue;
    if(results[i].isFinal){if(seen.has(i))continue;seen.add(i);final.push(transcript);}
    else interim+=transcript+' ';
  }
  return {final,interim:interim.trim()};
}
