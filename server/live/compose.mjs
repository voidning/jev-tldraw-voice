import { parseOrderReference, parseOrdinalSequence, stripOrderReference, parseFamilyOrdinals } from './ordinal.mjs';
const minimumConfidence=.8;
/** Jev 的 confidence 是把完整分布压成一个数的派生值；官方示例的近似是 (N × top − 1) / (N − 1)，
 *  候选项越多，同一个阈值要求的 top 概率越低：4 个候选时 0.8 对应 top ≥ 0.85，
 *  而 canvas.candidates 上限 80 个候选时只对应 top ≥ 0.81——最需要选准的题目反而最宽松。
 *  这里用分布里的 top 概率补一个与候选项数量无关的下限。 */
const minimumTop=.85;
export function certainChoice(answer){
  if(answer?.type!=='choice'||!Number.isFinite(answer.confidence))return false;
  if(answer.confidence<minimumConfidence||answer.confidence>1)return false;
  const probabilities=answer.probabilities;
  // 没有分布时保持既有行为：只按 confidence 门控。
  if(!probabilities||typeof probabilities!=='object')return true;
  const top=probabilities[answer.choice],count=Object.keys(probabilities).length;
  if(!Number.isFinite(top)||count<2)return true;
  return top>=Math.max(minimumTop,(minimumConfidence*(count-1)+1)/count);
}
/** A confident frame cannot be composed with a contradictory old operation/operand.
 *  This is a consistency check on typed Jev answers, not a transcript parser. */
export function semanticFrameConflict(answers){
  const frame=answers?.editFrame;
  if(!certainChoice(frame))return undefined;
  const allowed={create:['add','duplicate'],recolor:['set','add','delete'],connect:['connect']}[frame.choice];
  if(!allowed)return undefined;
  const operation=answers?.operation;
  if(certainChoice(operation)&&!allowed.includes(operation.choice))return 'operation';
  const operand=answers?.operand;
  if(!certainChoice(operand))return undefined;
  if(frame.choice==='create'&&operation?.choice==='add'&&operand.choice!=='object')return 'operand';
  if(frame.choice==='recolor'&&['set','add','delete'].includes(operation?.choice)&&operand.choice!=='property')return 'operand';
  if(frame.choice==='connect'&&operand.choice!=='object')return 'operand';
  return undefined;
}
/** 分布里概率最高的两个选项，用来把「判断不够明确」变成用户可以回答的问题。 */
export function competingOptions(answer){
  const probabilities=answer?.probabilities;
  if(!probabilities||typeof probabilities!=='object')return undefined;
  const ranked=Object.entries(probabilities).filter(([,value])=>Number.isFinite(value))
    .sort((a,b)=>b[1]-a[1]).slice(0,2).map(([option])=>option);
  return ranked.length>1?ranked:undefined;
}
/** 视图控制（看全部／聚焦选中）只移动相机，不编辑画布：tldraw 在忽略历史的路径上执行它，
 *  所以既不进撤销栈，重复执行也无害。它和「撤销」一样在决策层单独判定、命中即短路，
 *  不读操作与属性维度。未明确命中时返回 undefined，正常指令的既有流程完全不变。 */
export function viewAnswer(answers){
  const answer=answers?.viewIntent;
  return certainChoice(answer)&&['fit','selection'].includes(answer.choice)?answer.choice:undefined;
}
const axisNames={connection:'连线端点',operation:'操作',operand:'操作对象',objectFamily:'对象类别',shapeKind:'图形种类',
  componentSemantic:'组件语义',target:'目标对象',position:'位置',
  attributeDetail:'具体属性',change:'变化方式',valueKind:'值类型',semanticColor:'语义颜色',
  role:'组件角色',layout:'排列方向',quantityMode:'数量含义',relationKind:'连接方向',relationAnchor:'关系锚点',
  referenceIntent:'属性值来源',referenceSourceProperty:'参照的属性',propertyReference:'参照对象',propertyEditTarget:'修改目标',placementReference:'方位参照',orderRelation:'秩序关系',viewIntent:'取景范围'};

export class UncertainChoiceError extends Error {
  constructor(axis,options){
    super(`Jev 对“${axisNames[axis]||axis}”的判断不够明确；画布未修改。`);
    this.axis=axis;
    if(options?.length>1)this.options=options;
  }
}

const familyNames={circle:'圆形',rectangle:'方形',diamond:'菱形',text:'文字'};
/** 「第 N 个圆形」里的 N 数的是圆形里的第几个，不是画布上的位置编号——形状名是名词的中心语，
 *  序数数的就是它。画布上真正的位置编号由这里换算：取这一类图形按创建顺序排的第 N 个的序号。
 *
 *  两种读法都成立、又落到不同对象上时（画布上第 2 个是圆形，而第 2 个圆形是第 3 个），
 *  那是真正的歧义：代码不能替用户挑，如实把两个候选摆出来让用户一句话定。
 *  只有一种读法说得通时才换算——家族里没有第 N 个、而位置编号上那一个恰好是同类，
 *  走的就是位置编号；反过来位置编号上那个不是同类，走的才是家族序号。
 *  候选被截断时家族计数不可靠，一律不换算。
 *  返回 Map<口中序号, {ordinal,id,kind,shape}>；读不通时抛 field='target' 的错误，由上层原样说清。 */
function familyOrdinalMap(text,context){
  const phrases=parseFamilyOrdinals(text);
  if(!phrases.length||context.candidatesTruncated)return new Map();
  const candidates=(context.candidates||[]).filter(candidate=>Number.isInteger(candidate.ordinal));
  const resolved=new Map();
  for(const phrase of phrases){
    const name=familyNames[phrase.kind]||'这种图形';
    const family=candidates.filter(candidate=>candidate.kind===phrase.kind).sort((a,b)=>a.ordinal-b.ordinal);
    const hit=family[phrase.ordinal-1];
    const atPlace=candidates.find(candidate=>candidate.ordinal===phrase.ordinal);
    const placeFits=Boolean(atPlace)&&atPlace.kind===phrase.kind;
    if(hit&&placeFits&&atPlace.id!==hit.id)
      // 只补一个序号的回答接不上原句的动作（实测「第三个」会回到「你想执行什么操作？」），
      // 所以要请用户把动作一起说出来，而不是只要一个数字。
      throw Object.assign(Error(`「第 ${phrase.ordinal} 个」是${name}（画布上第 ${family.indexOf(atPlace)+1} 个${name}），而「第 ${phrase.ordinal} 个${name}」是第 ${hit.ordinal} 个——你说的是哪一个？再完整说一遍，把动作一起带上。`),{field:'target'});
    if(hit){resolved.set(phrase.ordinal,{ordinal:hit.ordinal,id:hit.id,kind:phrase.kind,shape:hit});continue;}
    if(placeFits){resolved.set(phrase.ordinal,{ordinal:phrase.ordinal,id:atPlace.id,kind:phrase.kind,shape:atPlace});continue;}
    throw Object.assign(Error(`画布上只有 ${family.length} 个${name}，找不到第 ${phrase.ordinal} 个${name}；画布未修改。`),{field:'target'});
  }
  return resolved;
}
/** 方位词只收多字写法：跟着「往／向」的单字方向（「往下移一点」）说的是目标自己的位移，
 *  不是以另一个对象为参照，收进来会把「把第二个圆形往下移一点」里的目标误当成参照。 */
const familyDirection=/^\s*(?:的)?\s*(?:上面|上边|上方|上头|顶部|下面|下边|下方|底下|底部|左边|左面|左侧|右边|右面|右侧|旁边|附近)/;
/** 句中用「第 N 个 X + 方位词」给别的对象定位时（「在第二个圆形下面画一个圆」），
 *  参照物由代码定：参照物这一角色没有自己的数据通道，模型只能在两种读法之间摇摆
 *  （实测卡在「你是指「第 2 个矩形」还是「第 3 个圆形」？」上）。
 *  只认紧跟方位词的那个短语——「把第二个圆形移到方形右边」里的短语是目标，不是参照。 */
function familyPlacement(text,context){
  // 「把第一个圆形移到第二个圆形右边」里两个短语都是家族说法，只有后面紧跟方位词的那个是参照。
  const directional=parseFamilyOrdinals(text).filter(phrase=>familyDirection.test(phrase.tail));
  if(directional.length!==1)return undefined;
  const resolved=familyOrdinalMap(text,context).get(directional[0].ordinal);
  return resolved?{...resolved,spoken:directional[0].ordinal}:undefined;
}

/** Combine orthogonal judgments into one typed operation × operand × target × parameters command. */
export function compose(answers,utterance,context={},content){
  // 顺序引用（第几个／第一和第三个／前几个）的数值一律从原句读，模型只判断「这句是不是
  // 按创建顺序指代」。所以「第二个」不可能被模型读成别的数字，也不会出现模型选的说法与
  // 原句实际写出的形式对不上的情况——两种形状（序号表／范围）都由这里从原文定。
  const order=()=>parseOrderReference(utterance)??(context.referenceTranscript?parseOrderReference(context.referenceTranscript):undefined);
  const used=[];
  // 「第 N 个 X」的换算只做一次：它是从画布候选里数出来的，和模型判断无关。
  // 补充回答（上一句没说清、本句只补对象名）时原句在 referenceTranscript 里。
  let familyCache;
  const family=()=>familyCache??=familyOrdinalMap(parseFamilyOrdinals(utterance).length||!context.referenceTranscript?utterance:context.referenceTranscript,context);
  // 方位参照（落点或移动的基准对象）在这里缓存，供目标的序号列表剔除用：
  // 「把第一个挪到第二个右边」的「第二个」只是方位，不是第二个要移动的对象。
  let placementRef;
  /** 参照物若是用序号说的，那个序号属于参照而不是目标，要从目标的序号列表里剔掉。
   *  参照物按形状名说的时候（「把第一和第二个挪到方形右边」）不剔除：那个序号里没有它。
   *  「第二个圆形」这类家族说法也占着一个序号（换算后的那一个），同样要剔。 */
  function targetOrder(){
    const parsed=order(),list=parsed?.ordinals;
    if(!list)return parsed;
    // 换算后两个说法可能落到同一个对象上（「第二个圆形和第三个圆形」而画布上只有两个圆），
    // 去重后按升序回到序号表本来的形状。
    const mapped=[...new Set(list.map(value=>family().get(value)?.ordinal??value))].sort((a,b)=>a-b);
    if(mapped.length<2||!placementRef)return {...parsed,ordinals:mapped};
    const candidate=(context.candidates||[]).find(item=>item.id===placementRef);
    let next=mapped;
    if(candidate?.ordinal){
      const occupies=[...family().values()].some(item=>item.ordinal===candidate.ordinal)||!spokenKind(utterance,candidate.kind);
      if(occupies)next=mapped.filter(value=>value!==candidate.ordinal);
    }
    return next.length?{...parsed,ordinals:next}:parsed;
  }
  function read(key,allowed){
    const answer=answers?.[key];
    if(!certainChoice(answer)||!allowed.includes(answer.choice))
      throw new UncertainChoiceError(key,competingOptions(answer));
    used.push(answer.confidence);
    return answer.choice;
  }
  function optional(key,allowed){
    const answer=answers?.[key];
    if(!certainChoice(answer)||!allowed.includes(answer.choice))return undefined;
    return answer.choice;
  }
  const shapeWord=/圆形|圆|矩形|方形|方块|菱形|箭头|连线|三角/;
  /** 句中用内部位置指定了唯一容器时，「加／放／填／添」到底是要写字还是要在里面新建一个图形，
   *  只取决于要放进去的那个词是不是图形名——容器由代码从画布数出来，那个词是原文里写着的，
   *  两件都是事实。模型在这类动词上天生摇摆（实测 operation=write 0.70／operand=object 0.78），
   *  把句中已有的信息再问一遍没有意义；是图形名就如实走新建那条路，让那里的拒绝文案说明
   *  「还不能建在另一个对象内部」。 */
  function insideIntent(){
    if(!textContainer(utterance,content,context))return undefined;
    // 说了「写／写上／标注／改成」这类动词时，后面的词一律是要写的字，哪怕它长得像图形名
    // （「在方形里写上圆形」写的是“圆形”两个字）——动词已经把意图说死了。
    if(content&&/(?:写|写上|写入|写个|写成|标上|标注|记上|输入|打成|改成|换成)/.test(utterance))return 'write';
    // 没有内容（模型认为这句不是写字，因而不提取内容）时看内部位置说法之后剩下的那段话：
    // 「在方形里加一个圆」的“圆”在尾巴上，「方形中间写个字」没有图形名。
    const tail=content?.text??/(?:(?:中间|中央|正中|里面|里边|内部|之内|以内)|(?<!这|那|哪)里)(.*)$/.exec(utterance)?.[1]??'';
    return shapeWord.test(tail)?'add':'write';
  }
  function readOperation(){
    const allowed=['add','write','delete','set','adjust','duplicate','move','arrange','order','connect','lock','unlock','undo','redo','stopListening','unknown'];
    const answer=answers?.operation;
    if(certainChoice(answer)&&allowed.includes(answer.choice)){used.push(answer.confidence);return answer.choice;}
    const frame=answers?.editFrame;
    const framedOperation={create:'add',recolor:'set',connect:'connect'}[frame?.choice];
    // A confirmed connection frame can resolve a weak add/connect reading:
    // creating a line between two existing endpoints is a connection, not a new shape.
    // Confident disagreement was rejected by semanticFrameConflict above.
    if(frame?.choice==='connect'&&certainChoice(frame)&&answer?.choice==='add'&&!certainChoice(answer)){
      used.push(frame.confidence);return 'connect';
    }
    // Other frames still require the general operation to point the same way.
    if(framedOperation&&answer?.choice===framedOperation&&certainChoice(frame)){
      used.push(frame.confidence);return framedOperation;
    }
    // The pre-frame write/add fallback below is retained for unmigrated requests.
    // A confident semantic frame must not be reinterpreted by that older path.
    if(certainChoice(frame)&&framedOperation)throw new UncertainChoiceError('operation',competingOptions(answer));
    const options=competingOptions(answer)||[];
    if(options.includes('write')&&options.includes('add')){
      const intent=insideIntent();
      if(intent){used.push(1);return intent;}
    }
    throw new UncertainChoiceError('operation',competingOptions(answer));
  }
  function readOperand(){
    const answer=answers?.operand;
    if(certainChoice(answer)&&['object','text','property','none'].includes(answer.choice)){used.push(answer.confidence);return answer.choice;}
    // "Create a new object" already fixes the direct role: the existing canvas
    // objects can only be placement references. Do not turn a weak object/none
    // answer into a request to clarify where text should go.
    const frame=answers?.editFrame;
    if(certainChoice(frame)&&frame.choice==='create'&&answers?.operation?.choice==='add'){
      used.push(frame.confidence);return 'object';
    }
    const options=competingOptions(answer)||[];
    if(options.includes('object')&&options.includes('text')){
      const intent=insideIntent();
      if(intent){used.push(1);return intent==='write'?'text':'object';}
    }
    throw new UncertainChoiceError('operand',competingOptions(answer));
  }
  // 视图控制排在所有编辑维度之前：它改变的是相机而不是任何对象，也就没有目标与属性可读。
  // 命中即返回控制命令，未命中不留下任何影响。
  const view=viewAnswer(answers);
  if(view)return {command:{kind:'control',action:'view',view},confidence:answers.viewIntent.confidence};
  // 「撤回刚完成的操作」由 decision 层单独判定：它指向已经生效的历史，
  // 不由操作维度表达，因此不读 operation 与属性，避免与「否定本次请求」混为一谈。
  const decision=answers?.decision;
  if(certainChoice(decision)&&decision.choice==='revert')
    return {command:{kind:'edit',operation:'undo',operand:'object',parameters:{}},confidence:decision.confidence};
  const conflict=semanticFrameConflict(answers);
  if(conflict)throw new UncertainChoiceError(conflict,competingOptions(answers?.[conflict]));
  // 「在方形中间加一个开始」：内部位置已经把容器说死了，而「加／放／填／添」这类动词在
  // 「写字」与「新建图形」之间天生摇摆（实测 operation=write 只有 0.70，回「你是指写字还是新建
  // 图形」是把句中已经给出的信息再问一遍）。容器与内容都由代码定，剩下的那点摇摆不该问用户；
  // 反过来，内容本身是个图形名时（“加一个圆形”）确实是要新建，不按写字兜底。
  const operation=readOperation();
  if(operation==='stopListening')return {command:{kind:'control',action:'stopListening'},confidence:Math.min(...used)};
  if(operation==='unknown')throw Error('没有明确的受支持操作。');
  const candidateIds=()=>(context.candidates||[]).map(c=>c.id);
  /** Ambiguous labels need not cause an ambiguous command: compare what each
   * reading would mean after resolving it against the current canvas or role. */
  const resolvedChoice=(axis,allowed,resolve,valid)=>{
    const answer=answers?.[axis];
    if(certainChoice(answer)&&allowed.includes(answer.choice)){
      used.push(answer.confidence);
      const value=resolve(answer.choice);
      if(valid(value))return value;
    }else{
      const options=competingOptions(answer)||[];
      if(options.length===2&&options.every(option=>allowed.includes(option))){
        const resolved=options.map(resolve);
        if(resolved[0]===resolved[1]&&valid(resolved[0]))return resolved[0];
      }
    }
    throw new UncertainChoiceError(axis,competingOptions(answer));
  };
  /** Object roles always name a current canvas candidate. "placement" and
   * "current" are aliases for an identity, never alternative source values. */
  const roleId=(axis,aliases={})=>{
    const ids=candidateIds();
    return resolvedChoice(axis,[...ids,...Object.keys(aliases)],
      choice=>ids.includes(choice)?choice:aliases[choice]?.(),id=>ids.includes(id));
  };
  const relationKind=()=>optional('relationKind',['connectedTo','connectedFrom','any']);
  // 方位参照多数句子里都是 none，但它不能像别的可选维度那样「读不到就算了」：
  // 一旦模型指出句中有参照、却说不清是哪个（unknown），或者自己没把握，当作没有参照
  // 退回焦点或 16 像素就是静默改错落点。宁可澄清。
  //
  // 只有一处必须放宽：代词（它、这儿）指向的就是会话焦点，模型常把「它」同时给 none
  // 和焦点对象两个答案 —— 两者在执行层落到同一个对象，这时不是歧义，照原路径走。
  const placementReference=()=>{
    const answer=answers?.placementReference;
    const certain=certainChoice(answer)&&['none','unknown',...candidateIds()].includes(answer.choice);
    // 句中用「第 N 个 X + 方位词」说清了参照时，参照由代码定：哪一种读法说得通是画布上的
    // 事实，不是模型的判断（实测它在「第 2 个矩形」与「第 3 个圆形」之间摇摆到澄清）。
    const spoken=familyPlacement(utterance,context);
    if(certain&&answer.choice!=='unknown'){
      used.push(answer.confidence);
      // 模型选中的对象与句中说出的种类不符时以原句为准：形状名是用户说出口的硬约束，
      // 而挑哪一个是模型的推断（实测它会按位置编号挑错）。
      if(answer.choice!=='none'&&spoken&&spoken.id!==answer.choice)return spoken.id;
      return answer.choice==='none'?undefined:answer.choice;
    }
    // 判不准（或明确说“说不清”）而原句其实已经说清了的，照原句走，不再问一遍。
    if(spoken)return spoken.id;
    if(!certain){
      const pair=competingOptions(answer)||[];
      const focus=(context.candidates||[]).filter(c=>c.focused||c.selected).map(c=>c.id);
      // 这条路径不把这次的低置信度计入合成：两个答案在执行层等价，这道题没有给出
      // 任何会影响结果的信息，压低的只是整句的信心。
      if(pair.length===2&&pair.includes('none')&&pair.some(id=>focus.includes(id)))return undefined;
    }
    throw new UncertainChoiceError('placementReference',certain?undefined:competingOptions(answer));
  };
  /** 句中唯一的形状名已经被当作参照物（「把第一个移到第二个圆形右边」的「圆形」）时，
   *  它不能再同时限定目标的类型：那是显式类型题摇摆的根源（实测在「明确指向圆形」与
   *  「没有显式目标类型约束」之间二选一，而句中对目标的限定只有一个「第一个」）。 */
  const explicit=()=>{
    // 句中出现的形状名归属由代码分：紧跟方位词的那个归参照物，剩下的归目标。
    // 这样显式类型题连问都不必问——它会在「明确指向圆形」与「没有显式目标类型约束」之间摇摆。
    const phrases=parseFamilyOrdinals(utterance);
    if(phrases.length){
      const reference=familyPlacement(utterance,context);
      const targets=phrases.filter(phrase=>!reference||phrase.ordinal!==reference.spoken);
      if(targets.length===1)return targets[0].kind;
      if(reference&&!targets.length)return 'none';
    }
    return read('explicitType',['circle','rectangle','diamond','text','none']);
  };
  const target=()=>{
    // 用户用连接关系限定目标时改走关系筛选：代码按真实绑定复核并保证唯一，
    // 而不是只信一个无法复核的对象 ID。明确目标约束仍然优先于选区。
    if(relationKind())return 'relation';
    // 锚点已经明确指到某个对象，说明这就是一句关系限定；此时方向判不定只能澄清。
    // 不能降级成「让模型自由挑一个对象」——那条路径不看真实绑定，会静默改错对象。
    if(optional('relationAnchor',candidateIds()))throw new UncertainChoiceError('relationKind');
    const raw=read('target',['default','current','selected','previous','first','middle','last','all','sequence','kindAll','kind','object']);
    const constraint=explicit();
    if(raw==='kind'&&constraint==='none')throw new UncertainChoiceError('explicitType');
    // 「全部方形」和「全部」是两回事：前者限定图形种类，后者只指一组。没有种类就没有 kindAll 可执行。
    if(raw==='kindAll'&&constraint==='none')throw new UncertainChoiceError('explicitType');
    // 模型只回答「这是按顺序指代」，数字必须真在原句里；读不到就让用户重说，不给默认序号。
    if(raw==='sequence'&&order()===undefined)throw new UncertainChoiceError('target');
    return ['default','current','selected'].includes(raw)?(constraint!=='none'?'kind':'current'):raw;
  };
  const targetParameters=(t)=>{
    if(!t)return {};
    const constraint=explicit();
    const seq=t==='sequence'?targetOrder():undefined;
    if(t==='sequence'&&!seq)throw new UncertainChoiceError('target');
    return {...(constraint!=='none'?{expectedObject:constraint}:{}),
      ...(seq?(seq.range?{ordinalRange:seq.range}:{ordinals:seq.ordinals}):{}),
      ...(t==='object'?{targetId:read('targetObject',candidateIds())}:{}),
      ...(t==='relation'?{relationAnchorId:read('relationAnchor',candidateIds()),relationKind:read('relationKind',['connectedTo','connectedFrom','any'])}:{})};
  };
  /** 文字容器（「方形中间写一个结束」「把方形里写的字删掉」）已经由 textContainer 定下时，
   *  命令不经过模型：序号说的仍走 sequence，执行层按创建顺序取对象、越界如实报错；
   *  形状名说的用那个候选的 ID，并带上类型校验（候选变了就报错而不是改错对象）。 */
  const containerTarget=(c)=>c.ordinal?'sequence':'object';
  const containerParameters=(c)=>c.ordinal
    ?{ordinals:[c.ordinal],...(c.expected?{expectedObject:c.expected}:{})}
    :{expectedObject:c.shape.kind,targetId:c.shape.id};
  const result=(operand,parameters={},target)=>({command:{kind:'edit',operation,operand,
    ...(target?{target}:{}),parameters:{...parameters,...targetParameters(target)}},confidence:Math.min(...used)});
  if(operation==='connect'){
    // 序号端点：「把第一个和第二个连起来」「把第二个连到第一个」两端说的都是序号，而
    // fromObject/toObject 只认画布候选 ID——模型只能猜一个 ID，于是卡在端点类型题上
    // （澄清成「你是指「矩形」还是「未明确类型」？」）。句中出现两个序号就必然是显式
    // 指定两端，连 connection 题都不必读：实测「把第二个连到第一个」会在这题上摇摆到澄清。
    // 方向取原句出现顺序（起点在前），数值由代码读，模型不参与。
    const seq=parseOrdinalSequence(utterance)??(context.referenceTranscript?parseOrdinalSequence(context.referenceTranscript):undefined);
    const endpointIds=candidateIds();
    const resolvedEndpoints=certainChoice(answers?.fromObject)&&certainChoice(answers?.toObject)
      &&endpointIds.includes(answers.fromObject.choice)&&endpointIds.includes(answers.toObject.choice)
      &&answers.fromObject.choice!==answers.toObject.choice;
    const connection=seq?.length>=2||resolvedEndpoints&&certainChoice(answers?.editFrame)
      &&answers.editFrame.choice==='connect'&&answers?.connection?.choice==='explicit'
      ?'explicit':read('connection',['pair','pointed','explicit']);
    if(connection!=='explicit')return result('object',{connection});
    // 「把第一个圆形和第二个圆形连起来」两端都是家族说法，按家族换算成画布上的位置编号。
    if(seq?.length>=2){
      const from=family().get(seq[0])?.ordinal??seq[0],to=family().get(seq[1])?.ordinal??seq[1];
      // 换算后两端撞到同一个对象（「第二个圆形和第三个」而画布上只有两个圆）——
      // 那是「连到它自己」，不是一句能执行的话，说清比交给校验层回一句通用报错好。
      if(from===to)throw Object.assign(Error(`两端指的都是第 ${from} 个对象；连线要两个不同的对象，画布未修改。`),{field:'target'});
      return result('object',{connection,fromOrdinal:from,toOrdinal:to});
    }
    const fromId=roleId('fromObject'),toId=roleId('toObject');
    if(fromId===toId)throw new UncertainChoiceError('connection');
    const fromType=read('fromType',['circle','rectangle','diamond','text','none']),toType=read('toType',['circle','rectangle','diamond','text','none']);
    return result('object',{connection,fromId,toId,...(fromType!=='none'?{fromType}:{}),...(toType!=='none'?{toType}:{})});
  }
  if(operation==='undo'){
    const expectedLastAction=read('undoAction',['none','add','set','adjust','move','delete','duplicate','arrange','order','connect']);
    const constraint=explicit();
    return result('object',{...(expectedLastAction==='none'?{}:{expectedLastAction}),...(constraint==='none'?{}:{expectedObject:constraint})});
  }
  // 重做与锁定不带属性或数值：它们只指向历史，或改变对象的状态。
  if(operation==='redo')return result('object',{});
  if(operation==='lock'||operation==='unlock')return result('object',{},target());
  if(operation==='order'){
    // 对齐与层叠同族：Jev 只挑出一种秩序关系，方向到 tldraw 枚举的映射由代码做。
    const relation=read('orderRelation',['alignLeft','alignRight','alignTop','alignBottom','alignCenterH','alignCenterV','layerFront','layerBack','layerForward','layerBackward']);
    const order=relation.startsWith('align')
      ?{kind:'align',edge:{alignLeft:'left',alignRight:'right',alignTop:'top',alignBottom:'bottom',alignCenterH:'center-horizontal',alignCenterV:'center-vertical'}[relation]}
      :{kind:'layer',move:{layerFront:'front',layerBack:'back',layerForward:'forward',layerBackward:'backward'}[relation]};
    return result('object',{order},target());
  }

  if(operation==='write'){
    if(!content)throw Error('请确认要写的原文文字。');
    // 「方形中间写一个结束」：句中已经用内部位置说法把某个已有对象说成文字的落点，
    // 文字的去处不必再问模型。两条理由：
    //   1) 唯一可行的读法就是写进那个对象——在画布上新建独立文字要鼠标落点，
    //      免手时说不出落点，执行层只会回「请先把鼠标移到画布上的创建位置」；
    //   2) 「写一个」这样的量词说的是文字内容的多少，不是「新建一个对象」的意思。
    // 容器的挑法沿用序号与参照物的既有口径：句中按形状名或序号唯一指名一个候选才兜底，
    // 有多个同名对象时不猜，照旧交给模型去澄清（它会报「找到 2 个同类图形」）。
    const container=textContainer(utterance,content,context);
    if(container)return {command:{kind:'edit',operation:'set',operand:'text',target:containerTarget(container),
      parameters:{value:content,placement:'center',...containerParameters(container)}},
      confidence:Math.min(...used)};
    const where=read('writePlacement',['canvas','label']);
    if(where==='canvas')return {command:{kind:'edit',operation:'add',operand:'object',parameters:{object:'text',position:{kind:'anchor'},content}},confidence:Math.min(...used)};
    const t=target();
    const parameters={value:content,placement:'center',...targetParameters(t)};
    return {command:{kind:'edit',operation:'set',operand:'text',target:t,parameters},confidence:Math.min(...used)};
  }

  const operand=(operation==='adjust'||operation==='set'&&answers?.operand?.choice!=='text')?'property':['duplicate','move','arrange'].includes(operation)?'object':readOperand();
  if(operand==='none')throw Error('无法确定本句要操作的对象、文字或属性。');
  const expected=()=>({});
  const position=()=>read('position',['here','insideCenter','inside','left','right','above','below','none']);
  /** 「在方形里加一个圆」：inside 与 insideCenter 说的是同一件事——新图形落在对象内部，而这件事
   *  目前做不到。两个选项通向同一句拒绝，摆出来让用户挑没有意义，直接说清做不到什么。 */
  const insideStall=()=>{
    const answer=answers?.position,options=competingOptions(answer)||[];
    return !certainChoice(answer)&&options.length===2&&options.every(option=>['inside','insideCenter'].includes(option));
  };

  if(operation==='add'&&operand==='object'){
    const family=read('objectFamily',['component','graphic','text','unknown']);
    let object;
    if(family==='graphic')object=read('shapeKind',['circle','rectangle','diamond']);
    else if(family==='component'){
      const semantic=read('componentSemantic',['button','generic','none']);
      if(semantic!=='button')throw Error('当前只能创建已识别为按钮的组件。');
      object='component';
    }else if(family==='text')object='text';
    else throw Error('请明确要创建的设计对象。');
    if(insideStall())throw Error('还不能把新图形建在另一个对象的内部；可以说“在方形下面／右边建一个圆”，或先建好再把它挪进去。');
    const where=position();
    if(where==='none')throw Error('请说明画布落点或相对位置。');
    // 「在方形中间画一个圆」里的“中间”是一个真实想要、但代码里没有的落点：能做的只有贴到
    // 某一侧。如实说清能做到什么，不要拿“没说落点”搪塞——用户明明说了落点。
    if(where==='inside'||where==='insideCenter')
      throw Error('还不能把新图形建在另一个对象的内部；可以说“在方形下面／右边建一个圆”，或先建好再把它挪进去。');
    // 方位参照优先：说了「在方形下面建」就用那个对象定位，落点由它决定，所以这时
    // 不再读 target 题——「在方形下面」本来就不是对已有目标的引用限定，读它只会把
    // 参照物和新建对象当成两个目标而澄清。只说「在它下面建」时参照来自会话焦点，
    // 由执行层解析，也不需要候选题。
    const referenceId=where==='here'?undefined:placementReference();
    placementRef=referenceId;
    const placement=where==='here'?{kind:'anchor'}
      :referenceId?{kind:'relative-object',referenceId,direction:where}
      :{kind:'relative',reference:target(),direction:where};
    const sizeIntent=read('creationSizeIntent',['none','sameBounds','width','height','ambiguous','unsupported']);
    if(sizeIntent==='ambiguous')throw Error('“一样”可能指大小、颜色或其他属性；请说清要继承哪些属性。画布未修改。');
    if(sizeIntent==='unsupported')throw Error('创建时继承颜色、样式或文字尚未支持；画布未修改。');
    let sizeReference;
    if(sizeIntent!=='none'){
      if(!['circle','rectangle','diamond'].includes(object))throw Error('当前只能为基础图形继承参照尺寸；画布未修改。');
      const candidates=context.candidates||[];
      const uniqueCurrent=()=>{
        const selected=candidates.filter(candidate=>candidate.selected);
        const focused=candidates.filter(candidate=>candidate.focused);
        const matches=selected.length?selected:focused;
        if(matches.length!==1)throw Error('尺寸参照对象不唯一；画布未修改。');
        return matches[0].id;
      };
      const sourceIdForPlacement=()=>placement.kind==='relative-object'?placement.referenceId
          :placement.kind==='relative'&&['current','selected','previous'].includes(placement.reference)?uniqueCurrent()
          :undefined;
      const sourceId=roleId('creationSizeReference',{placement:sourceIdForPlacement,current:uniqueCurrent});
      sizeReference={kind:'reference-bounds',referenceId:sourceId,
        axes:sizeIntent==='sameBounds'?'both':sizeIntent};
    }
    const parameters={object,position:placement,...(sizeReference?{sizeReference}:{}),...(placement.kind==='relative'?targetParameters(placement.reference):{}),...(object==='component'?{semantic:'button'}:{})};
    if(object==='text'&&content)parameters.content=content;
    if(object==='component'){
      const role=optional('role',['primary','secondary','danger','none']);
      if(role&&role!=='none')parameters.role=role;
    }
    return result('object',parameters);
  }

  if(operation==='delete'){
    if(operand==='property')return result(operand,{...attribute(answers,read),...expected()},target());
    // 「清空画布」「清空所有内容」把画布本身当宾语，模型容易读成「没有额外引用限定」而落到
    // 当前焦点上——那是静默只删一个对象，用户却以为画布空了。宾语指向整块画布时一律按全部走。
    // 带序号或图形名限定的说法（「把第三个的填充清空」「清空所有方形」）不受影响。
    const wipe=!/[0-9二两三四五六七八九十]|方形|方框|圆形|椭圆|矩形|菱形|箭头|文字/.test(utterance)
      &&(/清空|清光|清干净/.test(utterance)&&/画布|画面|画板|全部|所有|一切|都/.test(utterance)
        ||/^(?:全部删除|删除全部|都删掉)[。！!\s]*$/.test(utterance));
    if(wipe)return result(operand,expected(),'pageAll');
    // 删除某个对象里的文字时，那个对象就是靶子（「把方形里写的字删掉」删的是方形的文字）。
    // 这和「写进去」是一件事的两面：容器由代码定，免得模型在“靶子是文字还是那个对象”之间
    // 摇摆（实测 target 只有 0.61–0.67，卡在澄清上）。要求句中出现文字相关词，免得把
    // 「把方形里的圆删掉」这种“删容器里的另一个对象”也套进来。
    const container=operand==='text'&&/字|文字|标签|内容|写的/.test(utterance)?textContainer(utterance,undefined,context):undefined;
    if(container)return {command:{kind:'edit',operation:'delete',operand:'text',target:containerTarget(container),
      parameters:{...containerParameters(container)}},confidence:Math.min(...used)};
    return result(operand,expected(),target());
  }
  if((operation==='add'||operation==='set')&&operand==='text'){
    if(!content)throw Error('没有明确的原文文字片段；画布未修改。');
    const where=position();
    if(!['insideCenter','inside','none'].includes(where))throw Error('请说明文字在目标内部的位置。');
    return result('text',{value:content,placement:where==='insideCenter'?'center':'existing-or-center',...expected()},target());
  }
  if((operation==='add'||operation==='set'||operation==='adjust')&&operand==='property'){
    const named=attribute(answers,read);
    const change=operation==='adjust'?read('change',['increase','decrease','restore']):'set';
    const source=answers?.referenceIntent;
    if(certainChoice(source)&&source.choice==='unknown'||!certainChoice(source)&&source?.choice==='yes')
      throw new UncertainChoiceError('referenceIntent',competingOptions(source));
    const referenced=certainChoice(source)&&source.choice==='yes';
    let value;
    if(referenced){
      // 参照编辑有两个独立的对象角色。旧 target()/targetOrder() 会把整句里
      // “第一个”和“第二个”一起当成修改目标，因此这里直接读取两个候选 ID，
      // 不让参照短语里的序号流入目标解析；实际尺寸仍由执行层读取。
      if(!['width','height','color','fill','stroke','textColor'].includes(named.property))
        throw Error('这个属性暂不支持参照编辑；画布未修改。');
      if(operation!=='set'||change!=='set')throw new UncertainChoiceError('change');
      const referenceProperties=['width','height','color','fill','stroke','textColor'];
      const providedProperty=resolvedChoice('referenceSourceProperty',['same',...referenceProperties],
        choice=>choice==='same'?named.property:choice,property=>referenceProperties.includes(property));
      if(providedProperty!==named.property&&!(['width','height'].includes(providedProperty)&&['width','height'].includes(named.property)))
        throw Error('当前仅支持宽度与高度互相参照；其他跨属性参照尚未支持，画布未修改。');
      const referenceId=roleId('propertyReference');
      const targetId=roleId('propertyEditTarget');
      if(referenceId===targetId)throw Error('参照对象不能是要修改的对象自身；画布未修改。');
      const targetCandidate=(context.candidates||[]).find(candidate=>candidate.id===targetId);
      if(!targetCandidate||!['circle','rectangle','diamond','text'].includes(targetCandidate.kind))
        throw Error('无法确定参照编辑的目标对象；画布未修改。');
      value={kind:'reference',property:providedProperty,targetId:referenceId};
      return {command:{kind:'edit',operation:'set',operand:'property',target:'object',parameters:{
        ...named,mode:'set',value,targetId,expectedObject:targetCandidate.kind,
      }},confidence:Math.min(...used)};
    }else if(operation==='add'&&named.property==='stroke'){
      // A plain “add stroke” uses the executor's documented default.
      const kind=optional('valueKind',['literalColor','semanticColor','none']);
      if(kind==='literalColor'||kind==='semanticColor')value=colorValue(kind,utterance,read);
    }else if(change!=='restore')value=propertyValue(named.property,change,utterance,read);
    return result('property',{...named,mode:change,...(value?{value}:{}),...expected()},target());
  }
  if(operation==='duplicate'){
    const quantityMode=read('quantityMode',['additional','total']);
    // An unspecified arrangement uses the plugin's visible horizontal default.
    // An uncertain Jev answer still triggers a focused question instead of guessing.
    const layout=read('layout',['horizontal','vertical','none']);
    const direction=layout==='none'?'horizontal':layout;
    return result('object',{additional:additionalCopies(utterance,1,quantityMode),
      arrangement:direction,...expected()},target());
  }
  if(operation==='move'){
    const direction=position();
    if(direction==='here')return result('object',{position:{kind:'anchor'},...expected()},target());
    if(!['left','right','above','below'].includes(direction))throw Error('请说明移动方向。');
    // 参照物在取目标之前定下：目标序号里要剔除被参照占用的那一个。
    const referenceId=placementReference();
    placementRef=referenceId;
    const distance=parseDistance(utterance);
    // 「挪到最右边」说的是位置极值，不是相对位移：代码没有可贴的边界，模型也只给得出方向。
    // 没有参照物时它会落到默认 16 像素上，看上去执行了、其实只挪了一点点——
    // 这一族说法必须如实说清，不能拿最小档冒充。
    if(!referenceId&&/(?:最|贴|靠)(?:到|着)?[左右上下顶底]/.test(utterance))
      throw Error('还不支持移到画布的极值位置（最边／最上／最下）；改成“往右移动 100”这样的具体位移，或框选多个对象后用“排成一行”“顶对齐”。');
    const moved=target();
    // 有参照物时目标是移到它旁边，不再叠加一个像素位移；没有时才用幅度（默认最小档）。
    return result('object',{direction,
      ...(referenceId?{referenceId}:{}),
      ...(distance?{distance}:referenceId?{}:{distance:{kind:'length',amount:16,unit:'px'}}),
      ...expected()},moved);
  }
  if(operation==='arrange'){
    const direction=read('layout',['horizontal','vertical']);
    return result('object',{direction,...expected()},target());
  }
  throw Error('这个操作与操作对象的组合尚不支持；画布未修改。');
}

const properties=['size','width','height','cornerRadius','fill','color','textColor','stroke','strokeWidth',
  'layout','semanticRole','componentOverride','content'];
function attribute(answers,read){
  let property;
  if(certainChoice(answers?.editFrame)&&answers.editFrame.choice==='recolor'
    &&!certainChoice(answers?.attributeDetail)&&certainChoice(answers?.colorRole)
    &&['whole','fill'].includes(answers.colorRole.choice)){
    property=answers.colorRole.choice==='whole'?'color':'fill';
    read('colorRole',['whole','fill']);
  }else property=read('attributeDetail',properties);
  return {property};
}
function propertyValue(property,change,utterance,read){
  if(['size','width','height','cornerRadius','strokeWidth'].includes(property)){
    const kind=read('valueKind',['length','step','none']);
    const exact=parseLength(utterance);
    if(kind==='length'&&exact)return exact;
    if(kind==='step'&&change!=='set'&&property!=='strokeWidth')return {kind:'step',count:1};
    throw Error('请给出明确的尺寸档位或带单位数值。');
  }
  if(['color','fill','stroke','textColor'].includes(property)){
    return colorValue('literalColor',utterance,read);
  }
  if(property==='semanticRole'){
    read('valueKind',['role']);
    const role=read('role',['primary','secondary','danger']);
    return {kind:'role',name:role};
  }
  if(property==='layout'){
    read('valueKind',['layout']);
    return {kind:'layout',direction:read('layout',['horizontal','vertical'])};
  }
  throw Error('该属性缺少可执行的值；画布未修改。');
}
function colorValue(kind,utterance,read){
  if(kind==='semanticColor')return {kind:'color',source:'semantic',name:read('semanticColor',['primary','secondary','danger'])};
  return {kind:'color',source:'literal',name:read('literalColor',['red','blue','gray','green','yellow','orange','violet','black','white'])};
}

// Jev decides whether the count is additional or total. Code reads the exact
// numeral from the transcript, without adding a rule for each spoken number.
const maxDuplicateObjects=20;
const countToken='(?:\\d+|[零一二两三四五六七八九十百千]+)';
function parseCount(token){
  if(/^\d+$/.test(token))return Number(token);
  const normalized=token.replaceAll('两','二');
  const digits='一二三四五六七八九';
  if(normalized.length===1)return digits.includes(normalized)?digits.indexOf(normalized)+1:NaN;
  const tens=normalized.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if(!tens)return NaN;
  return (tens[1]?digits.indexOf(tens[1])+1:1)*10+
    (tens[2]?digits.indexOf(tens[2])+1:0);
}
function transcriptCount(text){
  const transcript=stripOrderReference(text);
  if(/[-−~～至或]|两三|三四|四五|五六|六七|七八|八九|十几|几十|[0-9]\.[0-9]/.test(transcript))throw Error('复制数量有歧义，请确认一个整数；画布未修改。');
  const counted=[...transcript.matchAll(new RegExp(`(${countToken})\\s*(?:个|份)`,'g'))];
  let matches=counted;
  if(counted.length===0)matches=[...transcript.matchAll(new RegExp(countToken,'g'))];
  if(matches.length!==1)throw Error('无法从原文读取唯一明确的复制数量；画布未修改。');
  return parseCount(matches[0][1]||matches[0][0]);
}
export function additionalCopies(text,currentCount,quantityMode){
  const value=transcriptCount(text);
  if(!Number.isSafeInteger(value)||value<1)throw Error('请说清楚要复制几个对象。');
  const additional=quantityMode==='additional'?value:quantityMode==='total'?value-currentCount:NaN;
  if(additional===0)throw Error('当前对象数量已经符合要求；画布未修改。');
  if(additional<0)throw Error('复制不能减少当前对象数量；画布未修改。');
  if(!Number.isSafeInteger(additional)||currentCount+additional>maxDuplicateObjects)
    throw Error(`一次最多支持 ${maxDuplicateObjects} 个对象；画布未修改。`);
  return additional;
}
/** 移动幅度：有精确像素就用它；没有数字的相对说法分两档，避免「挪远一点」静默退回
 *  最小的 16px —— 用户以为移动了很远，实际只动了一点。 */
const distanceSteps=[{pattern:/远(?:一点|点|一些|些)|挪远|移远|离远|往远处|多(?:移|挪|动|走)?(?:一点|点|一些|些)|大(?:一点|点|一些|些)/,amount:80},
  {pattern:/一点点|一丁点|稍微|稍稍|略(?:微)?/,amount:8}];
export function parseDistance(text){
  const exact=parseLength(text);
  if(exact)return exact;
  const raw=stripOrderReference(text);
  for(const step of distanceSteps)if(step.pattern.test(raw))return {kind:'length',amount:step.amount,unit:'px'};
  return null;
}

/** 参照物是按形状名说的吗？按形状说的参照不占用序号，所以它出现在句中时，
 *  不能拿它的序号去剔目标的序号列表（「把第一和第二个挪到方形右边」要动两个）。 */
const kindWords={circle:['圆'],rectangle:['矩形','方形','方框','正方形','长方形'],diamond:['菱形'],text:['文字']};
function spokenKind(utterance,kind){
  const raw=String(utterance);
  return (kindWords[kind]||[]).some(word=>raw.includes(word));
}

/** 「方形中间写一个结束」「在菱形里边写上开始」里的内部位置说法：那个已有对象就是文字的
 *  接收容器，返回它。判不准时返回 undefined，交给模型（写要读 writePlacement，删走 target 题）。
 *  「把方形里写的字删掉」是同一件事的另一面——删的是那个对象里的文字，靶子同样是容器。
 *
 *  只有唯一指名才兜底——形状名在候选里对应多个对象，或序号越界/多个序号，都不猜：
 *  那种时候用户想要的可能是其中一个，静默挑一个比澄清更糟。
 *  文字内容要先从原句里挖掉，否则「在方形里写上圆形」的内容「圆形」会被当成容器。
 *  “这里／那里／哪里”的“里”不是内部位置，排除掉。 */
function textContainer(utterance,content,context){
  const raw=String(utterance);
  const start=content?.source?.start,end=content?.source?.end;
  const spoken=Number.isInteger(start)&&Number.isInteger(end)&&end>start
    ?raw.slice(0,start)+' '.repeat(end-start)+raw.slice(end):raw;
  const inside=/(?:中间|中央|正中|里面|里边|内部|之内|以内)|(?<![这那哪])里/.test(spoken);
  // 「在方形中间新建一个独立文字」是明确要求另立一个文字对象，不按容器兜底。
  // 判据要看原句（spoken 已把文字内容挖掉），且必须与「新建」连用——只说「写一个独立文字」
  // 时「独立文字」本身就是内容，不是要求。
  if(!inside||/(?:新建|另建|另立|创建)[^，。]{0,4}(?:独立|单独)/.test(raw))return undefined;
  const candidates=(context.candidates||[]).filter(candidate=>['circle','rectangle','diamond','text'].includes(candidate.kind));
  const ordinals=parseOrderReference(spoken)?.ordinals;
  // 序号说的容器仍按序号回答（执行层按创建顺序取对象），形状名说的才给 ID：
  // 序号本身就是位置编号，把它降级成一个快照里的 ID 会丢掉“第几个”这层含义。
  // 「第二个圆形中间写一个结束」里的序号是家族序号，同样由代码换算成画布上的位置编号。
  if(ordinals?.length){
    const spokenOne=ordinals.length===1?ordinals[0]:undefined;
    const resolved=spokenOne===undefined?undefined:familyOrdinalMap(spoken,context).get(spokenOne);
    const hit=resolved?[resolved.shape]:spokenOne===undefined?[]:candidates.filter(candidate=>candidate.ordinal===spokenOne);
    return hit.length===1?{shape:hit[0],ordinal:hit[0].ordinal,...(resolved?{expected:resolved.kind}:{})}:undefined;
  }
  const named=candidates.filter(candidate=>spokenKind(spoken,candidate.kind));
  return named.length===1?{shape:named[0]}:undefined;
}

export function parseLength(text){
  const raw=stripOrderReference(text);
  const matches=[...raw.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*(px|像素)/gi)];
  if(!matches.length){
    if(/[0-9]|厘米|毫米|公分|倍|百分|[%％]|[二两三四五六七八九十百千]/.test(raw)){const error=Error('请确认具体数字与像素单位；画布未修改。');error.field='unit';throw error;}
    return null;
  }
  const remainder=raw.replace(/([0-9]+(?:\.[0-9]+)?)\s*(px|像素)/gi,'');
  if(matches.length!==1||/[0-9]|[二两三四五六七八九十百千]|[-−~～至到或]|厘米|毫米|公分|[%％]/.test(remainder))throw Error('数字或单位有歧义，请确认一个明确的像素数值；画布未修改。');
  const amount=Number(matches[0][1]);
  if(!Number.isFinite(amount)||amount<0||amount>10000)throw Error('数值须在 0–10000 px 之间。');
  return {kind:'length',amount,unit:'px'};
}
