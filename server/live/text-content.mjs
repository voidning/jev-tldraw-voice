import {quotedSpans} from './quotes.mjs';
/** Candidate generation is mechanical. No candidate text is invented by Jev. */
export function textCandidates(transcript,limit=24){
  const raw=String(transcript);
  let end=raw.length;
  while(end>0&&/[\s，,。.!！?？；;]/.test(raw[end-1]))end--;
  if(!end)return [];
  const quoted=quotedSpans(raw);
  if(quoted.length)return quoted.slice(0,limit).map((c,i)=>({...c,id:'span_'+i}));
  const starts=new Set();
  // Short trailing spans cover unquoted phrases such as “改成开始使用”.
  for(let start=end-1;start>=Math.max(0,end-18);start--)starts.add(start);
  // Boundaries help preserve longer user text without enumerating every substring.
  for(let index=Math.max(0,end-80);index<end;index++){
    if(/[\s，,：:「“]/.test(raw[index]))starts.add(index+1);
    if(/[成上写为是叫个]/.test(raw[index]))starts.add(index+1);
  }
  const candidates=[...starts].filter(start=>start<end&&end-start<=80&&!/^\s/.test(raw[start]))
    .sort((a,b)=>b-a).slice(0,limit)
    .map((start,index)=>({id:'span_'+index,start,end,text:raw.slice(start,end)}));
  return [...quoted,...candidates].filter((c,i,a)=>a.findIndex(x=>x.start===c.start&&x.end===c.end)===i).slice(0,limit).map((c,i)=>({...c,id:'span_'+i}));
}

/** The model returns only an ID. This function retrieves exact characters. */
export function selectOriginalText(transcript,candidates,answer){
  if(answer?.type!=='choice'||typeof answer.confidence!=='number'||answer.confidence<.8)
    throw Error('Jev 对文字片段的判断不够明确；画布未修改。');
  if(answer.choice==='none')throw Error('没有找到明确要显示的文字；画布未修改。');
  const candidate=candidates.find(item=>item.id===answer.choice);
  if(!candidate)throw Error('Jev 选择的文字候选不在本句转写中；画布未修改。');
  const original=String(transcript).slice(candidate.start,candidate.end);
  if(original!==candidate.text||!original.trim())throw Error('文字候选与原始转写不一致；画布未修改。');
  return {kind:'text',text:original,source:{start:candidate.start,end:candidate.end}};
}

export function contentQuestion(candidates){
  return {type:'choice',instructions:'若用户请求把文字显示在画布上，选择准确的原文片段编号。文字中的同音字、数字、否定词、标点不得改写；不选动作和目标词。没有准确候选或文字边界有歧义选 none。',criteria:{none:'无明确、无歧义的准确原文片段',...Object.fromEntries(candidates.map(c=>[c.id,JSON.stringify(c.text)]))}};
}
