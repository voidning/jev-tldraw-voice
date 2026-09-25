/** Jev chooses meanings. Code supplies IDs, coordinates, exact math and tldraw writes. */
export type ObjectKind='component'|'circle'|'rectangle'|'text'|'diamond';
export type Target='current'|'selected'|'previous'|'first'|'middle'|'last'|'all'|'pageAll'|'sequence'|'kindAll'|'named'|'kind'|'object'|'relation';
/** 创建顺序上的两种指代。序号永远是全局创建顺序，「第几个」说的就是画布上的位置编号；
 *  形状名只是附加校验（第 2 个不是方形就澄清），不会把序号缩成「方形里的第几个」。
 *
 *  单值序号在并列说法下会静默丢项（「第一和第三」只剩下第三），所以这里是数组。 */
export type OrderReference=
  |{kind:'ordinals';ordinals:number[]}
  |{kind:'range';edge:'first'|'last';count:number};
/** Direction of the connection between the target and its relation anchor.
 *  connectedTo: the arrow leaves the target and points at the anchor.
 *  connectedFrom: the arrow leaves the anchor and points at the target.
 *  any: the sentence claims a connection without stating a direction. */
export type RelationKind='connectedTo'|'connectedFrom'|'any';
/** How a group of objects should be ordered relative to each other. Both kinds
 *  belong to the same family: a relation between several objects, which voice
 *  states far more precisely than a pointer. Align moves shapes until one edge or
 *  centre line coincides; layer decides which object covers which. */
export type OrderRelation=
  |{kind:'align';edge:'left'|'right'|'top'|'bottom'|'center-horizontal'|'center-vertical'}
  |{kind:'layer';move:'front'|'back'|'forward'|'backward'};
/** The source object's property read at execution time; it can differ from the target's width or height. */
export type ReferenceProperty='width'|'height'|'color'|'fill'|'stroke'|'textColor';
export type Position='anchor'|'left'|'right'|'above'|'below';
/** 相对落点有两种参照来源。`reference` 走目标解析（代词与会话焦点、序号、形状名都由
 *  执行层现算）；`reference-object` 是语义层已经指名道姓挑出的那个对象——它同时是
 *  「在方形下面建」的落点基准和「移到方形右边」的方向基准，所以合成时先定参照、
 *  再取目标，并把参照占用的序号从目标序号里剔除。 */
export type CreationPosition=
  |{kind:'anchor'}
  |{kind:'relative';reference:Target;direction:Exclude<Position,'anchor'>}
  |{kind:'relative-object';referenceId:string;direction:Exclude<Position,'anchor'>};
/** Creation dimensions come from a real object at execution time, never a model estimate. */
export type CreationSizeReference={kind:'reference-bounds';referenceId:string;axes:'both'|'width'|'height'};
export type Property='size'|'width'|'height'|'cornerRadius'|'color'|'fill'|'stroke'|'textColor'|'strokeWidth'|'layout'|'semanticRole'|'componentOverride'|'content';
export type ChangeMode='set'|'increase'|'decrease'|'restore';
export type NamedColor='red'|'blue'|'gray'|'green'|'yellow'|'orange'|'violet'|'black'|'white'|'primary'|'secondary'|'danger';
export type Role='primary'|'secondary'|'danger';
export type EditValue=
  | {kind:'step';count:1}
  | {kind:'length';amount:number;unit:'px'}
  | {kind:'color';name:NamedColor|`#${string}`;source:'literal'|'semantic'}
  | {kind:'layout';direction:'horizontal'|'vertical'}
  | {kind:'reference';property:ReferenceProperty;targetId:string}
  | {kind:'role';name:Role};
export type TextContent={kind:'text';text:string;source:{start:number;end:number}};
/** Where the camera should look. A view command moves the camera, not the objects:
 *  tldraw performs these on the history-ignored path, so they never enter the undo
 *  stack and are idempotent — repeating one is harmless. `fit` frames the whole page,
 *  `selection` frames only the current selection. */
export type ViewTarget='fit'|'selection';

/** Jev's orthogonal answers always compose into this shape before canvas execution. */
export type EditCommand={
  kind:'edit';operation:'add'|'delete'|'set'|'adjust'|'duplicate'|'move'|'arrange'|'order'|'connect'|'lock'|'unlock'|'undo'|'redo';
  operand:'object'|'text'|'property';target?:Target;
  parameters:{
    expectedLastAction?:'add'|'set'|'adjust'|'move'|'delete'|'duplicate'|'arrange'|'order'|'connect';
    /** 明确说出的序号（已去重升序），与 ordinalRange 二选一。 */
    ordinals?:number[];
    /** 「前三个」「后两个」这种按创建顺序取的一段。 */
    ordinalRange?:{edge:'first'|'last';count:number};
    targetId?:string;
    relationAnchorId?:string;relationKind?:RelationKind;
    order?:OrderRelation;
    connection?:'pair'|'pointed'|'explicit';
    fromId?:string;toId?:string;fromType?:ObjectKind;toType?:ObjectKind;
    /** explicit 连线的另一种说法：「把第一个和第二个连起来」两端都是序号，按创建顺序取对象。 */
    fromOrdinal?:number;toOrdinal?:number;
    object?:ObjectKind;position?:CreationPosition;sizeReference?:CreationSizeReference;semantic?:'button';role?:Role;
    content?:TextContent;value?:EditValue|TextContent;property?:Property;mode?:ChangeMode;
    placement?:'center'|'existing-or-center';expectedObject?:ObjectKind;expectedSemantic?:'button';
    additional?:number;arrangement?:'horizontal'|'vertical';direction?:'horizontal'|'vertical'|'left'|'right'|'above'|'below';
    distance?:{kind:'length';amount:number;unit:'px'};
    /** 移动的方向基准：移到这个对象的某一侧，而不是按像素位移。 */
    referenceId?:string;
  };
};

export type LiveCommand=
  | EditCommand
  | {kind:'control';action:'stopListening'}
  | {kind:'control';action:'view';view:ViewTarget}
  | {kind:'control';action:'selectAll'}
  | {kind:'batch';commands:EditCommand[]}
  | {kind:'sequence';commands:EditCommand[]};

export type LastEditSummary={action:EditCommand['operation'];property?:Property;mode?:ChangeMode};
export type CanvasCandidate={id:string;kind:string;text:string;ordinal:number|null;selected:boolean;focused:boolean;locked:boolean;style?:Record<string,string|number>;bounds:{x:number;y:number;w:number;h:number}};
export type ConversationContext={
  candidates?:CanvasCandidate[];
  connections?:{id:string;from:string;to:string}[];
  candidatesTruncated?:boolean;
  clarification?:{originalTranscript:string;field:string};
  pageId:string;
  activeCount:number;
  activeTextCount?:number;
  ordinalObjectCount?:number;
  objectCounts?:Record<string,number>;
  selectedCount:number;
  selectedMatchesActive:boolean;
  activeObjects:(ObjectKind|'other')[];
  hasAnchor:boolean;
  lastEdit:LastEditSummary|null;
};
