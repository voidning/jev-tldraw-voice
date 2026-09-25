import {maskQuotes} from './quotes.mjs';

/** 中文数字 → 数值；不认识的形式返回 NaN。 */
const digits='一二三四五六七八九';
function toNumber(raw){
  if(/^\d+$/.test(raw))return Number(raw);
  const normalized=raw.replaceAll('两','二');
  // 十位要先试：「十」本身是 10，而它不是一个数字字符，长度检查会把它误判成不认识。
  const tens=normalized.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if(tens)return (tens[1]?digits.indexOf(tens[1])+1:1)*10+(tens[2]?digits.indexOf(tens[2])+1:0);
  if(normalized.length===1)return digits.includes(normalized)?digits.indexOf(normalized)+1:NaN;
  return NaN;
}

/** 「第一和第三个」里第一个「第」后面没有量词——并列时量词只在最后一项出现。
 *  所以词尾要求量词，后面紧接连接词时也认。 */
const numeral='\\d+|[零一二两三四五六七八九十百]+';
const ordinalToken=new RegExp(`第\\s*(${numeral})\\s*(?:个|号|张|幅|(?=[和与跟及、,，]))`,'g');
/** 范围说法。数量可以是「几」——那是相对范围，不是精确数量，和「大一点」折算 10% 同一种处理。 */
const countToken='\\d+|[零一二两三四五六七八九十百]+|几';
const rangeToken=new RegExp(`(最后|前|后)\\s*(?:面\\s*)?(?:的\\s*)?(${countToken})?\\s*(?:个|号|张|幅)`,'g');

/** 「前几个」不给数字时的默认档位；「最后一个」不说数字就是 1 个。 */
export const defaultRangeCount=3;
const maxOrdinal=99;

/** 从原句读出具指的创建顺序引用。模型只判断「这句是不是按创建顺序指代」，
 *  数值一律由这里从原文读，不经过模型——所以「第几个」不可能被模型估错。
 *
 *  返回值只有两种形状，二选一：
 *    {ordinals:[1,3]}                     明确说出的序号，去重升序
 *    {range:{edge:'first'|'last',count}}  前几个／后几个
 *  没有顺序引用时返回 undefined。 */
export function parseOrderReference(text){
  const masked=maskQuotes(String(text));
  const ordinals=[...masked.matchAll(ordinalToken)].map(match=>toNumber(match[1]));
  const ranges=[...masked.matchAll(rangeToken)];
  if(ordinals.length&&ranges.length)throw Error('一句话里请只用一种序号说法。');
  if(ordinals.length){
    for(const value of ordinals)
      if(!Number.isInteger(value)||value<1||value>maxOrdinal)throw Error(`序号须为 1–${maxOrdinal}。`);
    return {ordinals:[...new Set(ordinals)].sort((a,b)=>a-b)};
  }
  if(ranges.length){
    if(ranges.length>1)throw Error('一次只能指定一段范围，请分成两句说。');
    const [,edge,rawCount]=ranges[0];
    const count=rawCount===undefined||rawCount.includes('几')?(edge==='最后'?1:defaultRangeCount):toNumber(rawCount);
    if(!Number.isInteger(count)||count<1||count>maxOrdinal)throw Error(`范围数量须为 1–${maxOrdinal}。`);
    return {range:{edge:edge==='前'?'first':'last',count}};
  }
  return undefined;
}

/** 连线端点专用的序号扫描，保持出现顺序、不排序不去重——「把第二个连到第一个」是 2→1，
 *  而 parseOrderReference 的 ordinals 是升序的，方向会被抹掉。
 *
 *  这里用的是比 ordinalToken 更松的规则：口语里量词常被省掉（「把第三和第二连起来」），
 *  而 ordinalToken 要求词尾是量词或连接词，「第二连」就落在缝里。连线的两端本来就只有
 *  序号这一种来历，扫出「第 + 数字」就够定端点，不必再等量词。 */
const endpointToken=new RegExp(`第\\s*(${numeral})`,'g');
export function parseOrdinalSequence(text){
  const masked=maskQuotes(String(text));
  const values=[...masked.matchAll(endpointToken)].map(match=>toNumber(match[1]));
  if(!values.length)return undefined;
  for(const value of values)
    if(!Number.isInteger(value)||value<1||value>maxOrdinal)throw Error(`序号须为 1–${maxOrdinal}。`);
  return values;
}

/** 形状名按家族归类。「第二个圆形」里的形状名决定了序数量的是哪一类，
 *  所以这里的词表要覆盖口语里真正会说的写法（椭圆算圆形、方框算矩形）。 */
export const shapeFamilyWords={circle:['圆形','椭圆形','椭圆','圆'],rectangle:['正方形','长方形','矩形','方形','方框'],diamond:['菱形'],text:['文字']};
/** 长词要排在前面：「圆形」不能被「圆」抢先匹配掉。 */
const familyWords=Object.values(shapeFamilyWords).flat().sort((a,b)=>b.length-a.length);
/** 序数与形状名连着说（「第二个圆形」「第二菱形」）：数的是这一类图形里的第几个。
 *  量词在口语里常被省掉，所以「个／号／张／幅」可选；「的」也算连着（「第二个的圆形」）。
 *  只认紧跟形状名的那种写法——「在第二个下面画一个圆」里的「圆」是新建对象，
 *  中间隔着方位词，不匹配，所以它不会把参照物的序数误读成家族序号。
 *  返回项带 tail（匹配后紧接的几个字），供调用方判断这个短语后面是不是方位词。 */
const familyToken=new RegExp(`第\\s*(${numeral})\\s*(?:个|号|张|幅)?\\s*(?:的)?\\s*(${familyWords.join('|')})`,'g');
/** Tail 只取 8 个字：够判断后面是不是方位词，又不至于把整句都带出来。 */
const tailLength=8;
export function parseFamilyOrdinals(text){
  const masked=maskQuotes(String(text));
  const found=[];
  for(const match of masked.matchAll(familyToken)){
    const value=toNumber(match[1]);
    // 越界的序号不在这里判：parseOrderReference 会照旧报「序号须为 1–99」。
    if(!Number.isInteger(value)||value<1||value>maxOrdinal)continue;
    const kind=Object.keys(shapeFamilyWords).find(key=>shapeFamilyWords[key].includes(match[2]));
    if(!kind)continue;
    const end=match.index+match[0].length;
    found.push({ordinal:value,kind,word:match[2],end,tail:masked.slice(end,end+tailLength)});
  }
  return found;
}

/** 去掉原句里的顺序引用，供读数字的地方使用。
 *  「前两个小一点」里的「两」是序号不是尺寸，「前两个再复制三个」里的「三」也不是复制数量——
 *  在读长度和数量之前必须先摘掉，否则序号会被当成尺寸数字报「缺单位」。 */
export function stripOrderReference(text){
  return maskQuotes(String(text))
    .replace(new RegExp(ordinalToken.source,'g'),'')
    .replace(new RegExp(rangeToken.source,'g'),'');
}
