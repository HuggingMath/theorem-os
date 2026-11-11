import { t } from '../i18n';
/** Plain-language meanings of the runtime terms the workbench shows. One entry per term, grouped for the glossary dialog. */
export type TermId = 'statement' | 'environment' | 'candidate' | 'acceptance' | 'conditional' | 'plan' | 'graph' | 'route'
  | 'contract' | 'frontier' | 'blocker' | 'roles' | 'guidance' | 'receipt' | 'recheck' | 'observation' | 'archive'
  | 'modules' | 'coordination' | 'budget';
export type Term = { name: string; short: string; detail: string };
export type TermGroup = { title: string; terms: TermId[] };

export const terms: Record<TermId, Term> = {
  statement: { name: t('原题'), short: t('你提交的 Lean 文件，用 sorry 留出待证明的定理。'),
    detail: t('每个用 sorry 留空的定理都是一个目标。研究过程中定理的声明不能改，只有证明部分会被填写。') },
  environment: { name: t('证明环境'), short: t('检查证明时使用的固定版本 Lean 和库。'),
    detail: t('固定版本 Lean、Mathlib 与 TheoremOS 自有库，供形式化、证明和独立验收共同使用。') },
  candidate: { name: t('候选证明'), short: t('Agent 写出、还没经过最终验收的证明。'),
    detail: t('候选可能已经通过局部检查，但只有独立验收通过后才算证明完成。') },
  acceptance: { name: t('独立验收'), short: t('用干净的 Lean 环境重新检查完整原题，这是唯一算数的结论。'),
    detail: t('验收在与 Agent 隔离的环境中进行：检查所有目标定理的声明没有被改动、没有 sorry 或额外公理，并由 Lean 内核确认。Agent 自己的检查不能代替它。') },
  conditional: { name: t('有条件结果'), short: t('证明成立，但依赖一个还没证明的引理。'),
    detail: t('这类结果不算通过验收。它说明了“只要证明某条引理，原题就成立”，可以作为继续研究的起点。') },
  plan: { name: t('任务计划'), short: t('Lead 把原题拆成的子任务和它们的先后关系。'),
    detail: t('每个子任务是一条引理、一次研究或一次审阅。计划会随研究进展更新，你也可以手动编辑。') },
  graph: { name: t('依赖图'), short: t('任务之间“谁要先完成”的关系图。'),
    detail: t('实线指向的任务要等前面的任务都完成；虚线是几条可选路线，完成一条即可。悬停卡片可以看到上下游，按住 Ctrl 或 ⌘ 滚动可以缩放。') },
  route: { name: t('证明路线'), short: t('通往原题的一种证明思路；几条路线中完成一条即可。'), detail: '' },
  contract: { name: t('任务合同'), short: t('一个子任务的具体要求：要证明的 Lean 声明、可用的依赖、负责的 Agent。'),
    detail: t('合同有版本号。计划修改后合同会换新版本，旧版本上的成果需要重新检查。') },
  frontier: { name: t('证明前沿'), short: t('离原题最近、还没完成的目标。'), detail: t('前沿上的任务完成后，原题的证明就会向前推进一层。') },
  blocker: { name: t('数学阻塞'), short: t('某个任务卡住的原因记录，比如反复失败或缺少引理。'),
    detail: t('阻塞会写明作用范围和重开条件；条件满足后任务会重新开放。') },
  roles: { name: t('Agent 角色'), short: t('Lead 统筹拆分任务；Researcher 查资料、找思路；Prover 和 Engineer 写证明；Reviewer 审阅候选。'),
    detail: t('每个 Agent 是一次独立的模型会话，按任务计划领取任务。') },
  guidance: { name: t('指导'), short: t('你在运行中写给 Lead、某个任务或某个 Agent 的提示。'),
    detail: t('指导会在下一轮交给对方，是否采纳由 Agent 决定，结果会记在回执里。') },
  receipt: { name: t('回执'), short: t('系统收到指导或计划修改后的确认记录。'),
    detail: t('回执只说明请求是否被接收、校验或应用，不代表相关证明已经重新检查。') },
  recheck: { name: t('重新检查'), short: t('计划修改后，受影响任务的已有证明要按新要求再检查一遍。'), detail: '' },
  observation: { name: t('观察'), short: t('研究过程某一时刻的只读快照：计划、任务状态、Agent 和检查记录。'),
    detail: t('观察记录的是当时的状态，不会重新运行模型或 Lean。') },
  archive: { name: t('归档'), short: t('把这次运行的记录和知识目录打包保存。'), detail: t('归档里的证据再次使用前需要重新检查。') },
  modules: { name: t('模块方案'), short: t('研究流程中可以替换的策略，例如搜索顺序和上下文大小。'),
    detail: t('Lean 检查和独立验收是固定的；搜索策略决定先做哪些任务，上下文策略决定给 Agent 多少上下文。') },
  coordination: { name: t('协作模式'), short: t('“任务协作”让 Agent 分工做子任务；“独立并行”让每个 Agent 各自尝试整道题。'), detail: '' },
  budget: { name: t('预算'), short: t('轮次、时间和 Token 用量的上限，到达任一上限运行就会停止。'),
    detail: t('模型调用按服务商价格计入你自己的 API 账户。已检查的成果会保留在报告里。') },
};

export const termGroups: TermGroup[] = [
  { title: t('结果'), terms: ['statement', 'environment', 'candidate', 'acceptance', 'conditional'] },
  { title: t('研究协作'), terms: ['plan', 'graph', 'route', 'contract', 'frontier', 'blocker', 'roles'] },
  { title: t('你的操作'), terms: ['guidance', 'receipt', 'recheck', 'observation', 'archive'] },
  { title: t('配置'), terms: ['modules', 'coordination', 'budget'] },
];

/** A small "?" button after a term; markup for the string-rendered views, the Preact views use <TermHint>. */
export const termHint = (id: TermId) => `<button type="button" class="term-hint" data-term="${id}" aria-label="${t('{0}是什么', terms[id].name)}" aria-expanded="false"><span aria-hidden="true">?</span></button>`;
