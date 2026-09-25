/** 目标集合与状态翻转的两处判定，抽成不依赖 tldraw 的纯函数。
 *  tldraw 在 Node 下加载不了（需要 DOM），不抽出来这两处无法回归。 */

/** 目标集合是否够用；不够时该说哪句话。
 *  空集合与「数量不符」是两回事：空集合说明用户还没框选，提示要说清该框选什么，
 *  而不是笼统地要一个目标——对齐、排列、锁定都需要多个对象。
 *  「全部」「它们」「前三个」「全部方形」这些说法本身就是指一批，数量由说法决定，
 *  不该再要求它们恰好一个。 */
export function targetCountError(ids:string[],target:string,allowMany:boolean,emptyHint?:string):string|null{
  if(!ids.length) return emptyHint||'请明确选中一个目标，或说“全部”。'
  if(!['all','pageAll','previous','sequence','kindAll'].includes(target)&&!allowMany&&ids.length!==1) return '请明确选中一个目标，或说“全部”。'
  return null
}

/** tldraw 的 toggleLock 是统一翻转：只要不是全都已处于目标状态，它就会把它们全部翻转。
 *  所以必须先按真实状态筛出需要翻转的那些，否则「锁上」会把已锁定的一批解锁。
 *  返回空数组表示这条指令与画布状态不符——调用方必须报错，不能当成成功。 */
export function lockNeed<T extends string>(ids:T[],lockedOf:(id:T)=>boolean|undefined,toLock:boolean):T[]{
  return ids.filter(id=>{const locked=lockedOf(id);return locked!==undefined&&locked!==toLock})
}

/** 锁定类指令没有可翻转对象时的反馈。抽出来是为了让「空操作不能算成功」这条契约可测。 */
export function lockNoopError(toLock:boolean):string{
  return toLock?'这些对象已经锁定，无需重复锁定。':'这些对象没有锁定，无需解锁。'
}
