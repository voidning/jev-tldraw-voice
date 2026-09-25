# 参照编辑：重构前后代码对照

本文只讨论**修改已有对象的属性，并从另一个已有对象取值**。以“把第一个矩形的宽度调成和第二个圆一样”为例：矩形宽 140，圆宽 220；期望只把矩形宽度改为 220，圆不变。

下方代码是突出关键路径的节选。重构前取自提交 `f72f2e6` 的 `server/live/compose.mjs`；重构后取自编写本文时的工作树。完整逻辑仍需看源文件。

## 重构前：参照值单独找，修改目标仍按整句找

旧代码已经让 Jev 判断 `referenceKind`（同宽或同高），并从画布候选中选择 `propertyReference`。但生成命令时，**被修改的对象**仍交给通用的 `target()`：

```js
const referenced = optional('referenceKind', ['width', 'height'])
let value
if (referenced) {
  if (referenced !== named.property) throw new UncertainChoiceError('referenceKind')
  value = {
    kind: 'reference',
    property: referenced,
    targetId: read('propertyReference', candidateIds()),
  }
}
return result('property', { ...named, mode: change, ...(value ? { value } : {}), ...expected() }, target())
```

`target()` 使用全句的 `target` 判断；当它选中序号路径时，`targetOrder()` 从**整句话**提取序号。于是“第一个”与“第二个”可能一起进入修改目标，即使后者本来只负责提供宽度。旧实现并非没有 Jev，也并非完全没有参照对象；缺口是**目标和参照没有作为两个独立的对象角色解析**。

```text
旧路径：句子 → operation / operand / target / 属性 / referenceKind
                          │                    └→ 参照对象 ID
                          └→ 通用 target() 仍可能看见整句所有序号
```

## 重构后：分别确定对象角色和属性来源

现在的 [Jev 问题](server/live/interpret.mjs) 分别询问：

- `propertyEditTarget`：**谁被修改**；
- `propertyReference`：**谁提供值**；
- `referenceIntent`：值是否来自另一个对象；
- `attributeDetail` 与 `referenceSourceProperty`：分别确定**修改哪个属性**、**来源对象提供哪个属性**。

[命令合成](server/live/compose.mjs) 在参照编辑分支分别读取两个对象 ID，不再调用旧的全句 `target()`：

```js
const referenceId = roleId('propertyReference')
const targetId = roleId('propertyEditTarget')
if (referenceId === targetId) throw Error('参照对象不能是要修改的对象自身；画布未修改。')

value = { kind: 'reference', property: providedProperty, targetId: referenceId }
return {
  command: {
    kind: 'edit', operation: 'set', operand: 'property', target: 'object',
    parameters: { ...named, mode: 'set', value, targetId, expectedObject: targetCandidate.kind },
  },
  confidence: Math.min(...used),
}
```

因此，上面的例子会得到类似命令（ID 仅为示意）：

```js
{
  operation: 'set',
  target: 'object',
  parameters: {
    targetId: 'shape:rectangle',       // 只修改矩形
    property: 'width',
    value: {
      kind: 'reference',
      targetId: 'shape:circle',        // 圆只提供值
      property: 'width',
    },
  },
}
```

[命令校验](src/jev-validation.ts) 检查属性和值的组合；[tldraw 执行层](src/live-editor.ts) 在真正写入前确认两个对象仍有效，从圆的当前画布外接边界读取宽度，再调整矩形。Jev 判断语义角色，**不计算或猜测 220 这个数值**。

## 变化的边界

| 问题 | 重构前 | 重构后 |
| --- | --- | --- |
| 谁被修改？ | 通用 `target()` 从整句判断 | `propertyEditTarget` 单独选择画布对象 |
| 谁提供值？ | `propertyReference` 选择对象 | `propertyReference` 仍独立选择对象，并与修改目标校验不能相同 |
| 取哪个属性？ | `referenceKind` 只判断同宽／同高 | 被修改属性与来源属性分别判断；执行时读取实际值 |
| 序号如何影响目标？ | 通用路径可能把两个序号都当目标 | 参照编辑直接使用两个对象 ID，不把参照序号送进旧 `targetOrder()` |

这是**参照编辑的一段局部重构**，不是所有操作都已换成新架构。当前可参照的属性由命令协议与 tldraw 适配明确列出；不支持的跨属性组合会拒绝，不会凭语言相似就复制任意状态。其他操作仍可能走旧的 `operation`、`operand`、`target()` 合成路径。
