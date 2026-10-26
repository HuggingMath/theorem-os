/** Plain-language meanings of the runtime terms the workbench shows. One entry per term, grouped for the glossary dialog. */
export type TermId = 'statement' | 'environment' | 'candidate' | 'acceptance' | 'conditional' | 'plan' | 'graph' | 'route'
  | 'contract' | 'frontier' | 'blocker' | 'roles' | 'guidance' | 'receipt' | 'recheck' | 'observation' | 'archive'
  | 'modules' | 'coordination' | 'budget';
export type Term = { name: string; short: string; detail: string };
export type TermGroup = { title: string; terms: TermId[] };

export const terms: Record<TermId, Term> = {
  statement: { name: '原题', short: '你提交的 Lean 文件，用 sorry 留出待证明的定理。',
    detail: '每个用 sorry 留空的定理都是一个目标。研究过程中定理的声明不能改，只有证明部分会被填写。' },
  environment: { name: '证明环境', short: '检查证明时使用的固定版本 Lean 和库。',
    detail: 'Lean 标准库或固定版本的 Mathlib。同一道题在同一环境下检查，结果才可重复。' },
  candidate: { name: '候选证明', short: 'Agent 写出、还没经过最终验收的证明。',
    detail: '候选可能已经通过局部检查，但只有独立验收通过后才算证明完成。' },
  acceptance: { name: '独立验收', short: '用干净的 Lean 环境重新检查完整原题，这是唯一算数的结论。',
    detail: '界面里也写作 S3。验收在与 Agent 隔离的环境中进行：检查所有目标定理的声明没有被改动、没有 sorry 或额外公理，并由 Lean 内核确认。Agent 自己的检查不能代替它。' },
  conditional: { name: '有条件结果', short: '证明成立，但依赖一个还没证明的引理。',
    detail: '这类结果不算通过验收。它说明了“只要证明某条引理，原题就成立”，可以作为继续研究的起点。' },
  plan: { name: '任务计划', short: 'Lead 把原题拆成的子任务和它们的先后关系。',
    detail: '每个子任务是一条引理、一次研究或一次审阅。计划会随研究进展更新，你也可以手动编辑。' },
  graph: { name: '依赖图', short: '任务之间“谁要先完成”的关系图。',
    detail: 'AND 表示所有前置都要完成；OR 表示几条路线中完成一条即可。悬停卡片可以看到上下游。' },
  route: { name: '证明路线', short: '通往原题的一种证明思路；几条路线中完成一条即可。', detail: '' },
  contract: { name: '任务合同', short: '一个子任务的具体要求：要证明的 Lean 声明、可用的依赖、负责的 Agent。',
    detail: '合同有版本号。计划修改后合同会换新版本，旧版本上的成果需要重新检查。' },
  frontier: { name: '证明前沿', short: '离原题最近、还没完成的目标。', detail: '前沿上的任务完成后，原题的证明就会向前推进一层。' },
  blocker: { name: '数学阻塞', short: '某个任务卡住的原因记录，比如反复失败或缺少引理。',
    detail: '阻塞会写明作用范围和重开条件；条件满足后任务会重新开放。' },
  roles: { name: 'Agent 角色', short: 'Lead 统筹拆分任务；Researcher 查资料、找思路；Prover 和 Engineer 写证明；Reviewer 审阅候选。',
    detail: '每个 Agent 是一次独立的模型会话，按任务计划领取任务。' },
  guidance: { name: '指导', short: '你在运行中写给 Lead、某个任务或某个 Agent 的提示。',
    detail: '指导会在下一轮交给对方，是否采纳由 Agent 决定，结果会记在回执里。' },
  receipt: { name: '回执', short: '系统收到指导或计划修改后的确认记录。',
    detail: '回执只说明请求是否被接收、校验或应用，不代表相关证明已经重新检查。' },
  recheck: { name: '重新检查', short: '计划修改后，受影响任务的已有证明要按新要求再检查一遍。', detail: '' },
  observation: { name: '观察', short: '研究过程某一时刻的只读快照：计划、任务状态、Agent 和检查记录。',
    detail: '观察记录的是当时的状态，不会重新运行模型或 Lean。' },
  archive: { name: '归档', short: '把这次运行的记录和知识目录打包保存。', detail: '归档里的证据再次使用前需要重新检查。' },
  modules: { name: '模块方案', short: '研究流程中可以替换的策略，例如搜索顺序和上下文大小。',
    detail: 'M2 检查和 S3 独立验收是固定的；M3 决定先做哪些任务，M4 决定给 Agent 多少上下文。' },
  coordination: { name: '协作模式', short: '“任务协作”让 Agent 分工做子任务；“独立并行”让每个 Agent 各自尝试整道题。', detail: '' },
  budget: { name: '预算', short: '轮次、时间和 Token 用量的上限，到达任一上限运行就会停止。',
    detail: '模型调用按服务商价格计入你自己的 API 账户。已检查的成果会保留在报告里。' },
};

export const termGroups: TermGroup[] = [
  { title: '结果', terms: ['statement', 'environment', 'candidate', 'acceptance', 'conditional'] },
  { title: '研究协作', terms: ['plan', 'graph', 'route', 'contract', 'frontier', 'blocker', 'roles'] },
  { title: '你的操作', terms: ['guidance', 'receipt', 'recheck', 'observation', 'archive'] },
  { title: '配置', terms: ['modules', 'coordination', 'budget'] },
];

/** A small "?" button after a term; markup for the string-rendered views, the Preact views use <TermHint>. */
export const termHint = (id: TermId) => `<button type="button" class="term-hint" data-term="${id}" aria-label="${terms[id].name}是什么" aria-expanded="false"><span aria-hidden="true">?</span></button>`;
