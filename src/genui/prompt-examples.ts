// These complete documents are both prompt examples and executable contract fixtures.
export const GENUI_PROMPT_EXAMPLES = [
  {name:'紧凑分叉与汇合',spec:{title:'并行处理',items:[
    {type:'text',content:'原始资料',size:'h2',center:true},
    {type:'arrow',dir:'down',length:20},
    {type:'grid',cols:2,items:[
      {type:'card',title:'文字处理',items:[{type:'text',content:'提取概念与关键结论'}]},
      {type:'card',title:'图形处理',items:[{type:'text',content:'识别图表与空间关系'}]},
    ]},
    {type:'arrow',dir:'down',length:20,label:'合并上下文'},
    {type:'card',title:'综合理解',items:[{type:'text',content:'结合文字与图形解释问题'}]},
  ]}},
  {name:'参数与计算',spec:{title:'圆面积',computed:[{id:'area',expr:'pi*radius^2',format:{maximumFractionDigits:2}}],items:[
    {type:'card',title:'调节半径',items:[
      {type:'slider',id:'radius',label:'半径（米）',value:2,min:0.1,max:10,step:0.1},
      {type:'stat',label:'面积',value:'{{area}} 平方米'},
    ]},
  ]}},
  {name:'连续曲线',spec:{title:'振幅与正弦曲线',items:[
    {type:'plot',xMin:-6.28,xMax:6.28,yMin:-3,yMax:3,series:[{expr:'a*sin(x)',label:'y=a sin(x)',params:[{name:'a',value:1,min:0.1,max:3,step:0.1}]}]},
    {type:'text',content:'调节 a，观察振幅变化；x 以弧度计。'},
  ]}},
  {name:'多选测验',spec:{title:'偶数练习',items:[
    {type:'choices',title:'哪些是偶数？',mode:'multi',items:[{label:'2'},{label:'3'},{label:'4'}],answer:['2','4'],explanation:'2 和 4 都能被 2 整除。'},
  ]}},
  {name:'选择后发送',spec:{title:'学习方向',items:[
    {type:'choices',title:'关注哪些方面？',mode:'multi',max:2,items:[{label:'概念'},{label:'例子'},{label:'练习'}],submit:'按这些方向讲解'},
  ]}},
  {name:'热力图',spec:{title:'学习时长（示例数据，分钟）',items:[
    {type:'echart',preset:'heatmap',series:[
      {label:'数学',data:[{label:'周一',value:30},{label:'周二',value:45}]},
      {label:'英语',data:[{label:'周一',value:20},{label:'周二',value:30}]},
    ]},
  ]}},
  {name:'桑基图',spec:{title:'任务分配（示例数据，项）',items:[
    {type:'echart',preset:'sankey',links:[{from:'总任务',to:'阅读',value:6},{from:'总任务',to:'练习',value:4}]},
  ]}},
  {name:'单词卡',spec:{title:'词汇',items:[
    {type:'vocabulary',word:'analytics',phonetic:'/ˌænəˈlɪtɪks/',meaning:'n. 数据分析；分析学',example:'We use analytics to understand learning progress.'},
  ]}},
] as const
