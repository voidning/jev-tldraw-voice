// Matched quote pairs, not a semantic parser. Apostrophes inside “…” stay literal.
export function quotedSpans(text){
  return [...String(text).matchAll(/“([^”]*)”|「([^」]*)」|『([^』]*)』|"([^"]*)"|'([^']*)'/g)].map(m=>({start:m.index+1,end:m.index+m[0].length-1,text:m.slice(1).find(v=>v!==undefined)}));
}
export function maskQuotes(text){
  let result='',start=0;
  for(const span of quotedSpans(text)){result+=text.slice(start,span.start-1)+'〈文字内容〉';start=span.end+1;}
  return result+text.slice(start);
}
