import {
  createIcons, ArrowDown, ArrowDownRight, ArrowRight, ArrowUpRight, Blocks, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, Code2,
  Download, ExternalLink, FileCheck2, FileCode2, FileJson2, Files, FlaskConical, FolderOpen, GitFork, Globe, History, Info,
  KeyRound, Maximize2, Menu, Network, Pause, Play, Plus, RotateCcw, ScanLine, ShieldCheck, Wallet, X, ZoomIn, ZoomOut,
} from 'lucide';
import { gsap } from 'gsap';
import { createSelectionIndicator } from './selectionIndicator';
import { initializeHumanDecision } from './humanDecision';
import { keepHashOnLanguageSwitch, localeOf } from './site';

const iconSet = { ArrowDown, ArrowDownRight, ArrowRight, ArrowUpRight, Blocks, Check, ChevronLeft, ChevronRight, Clock, Code2,
  ChevronDown, Download, ExternalLink, FileCheck2, FileCode2, FileJson2, Files, FlaskConical, FolderOpen, GitFork, Globe, History, Info, KeyRound, Maximize2, Menu, Network, Pause, Play, Plus,
  RotateCcw, ScanLine, ShieldCheck, Wallet, X, ZoomIn, ZoomOut };
const icons = () => createIcons({ icons: iconSet, attrs: { 'aria-hidden': 'true' } });
const element = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing landing page element: ${selector}`);
  return result;
};
const locale = localeOf(document.documentElement.lang);
const text = {
  zh: {
    closeMenu: '关闭导航', openMenu: '打开导航',
  },
  en: {
    closeMenu: 'Close navigation', openMenu: 'Open navigation',
  },
}[locale];
icons();
document.documentElement.classList.add('js');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
if (matchMedia('(max-width: 600px)').matches) {
  document.querySelectorAll<HTMLDetailsElement>('[data-mobile-disclosure]').forEach(disclosure => { disclosure.open = false; });
}
const selectionTargets = new Set<Element>();
function animateSelection(targets: Element[], distance = 7) {
  for (const target of targets) selectionTargets.add(target);
  gsap.killTweensOf(targets);
  if (reducedMotion.matches) {
    gsap.set(targets, { clearProps: 'opacity,transform' });
    return;
  }
  gsap.set(targets, { opacity: .45, y: distance });
  gsap.to(targets, {
    opacity: 1, y: 0, duration: .28, stagger: .035, ease: 'power2.out', clearProps: 'opacity,transform',
  });
}

let introPlayed = false;
const revealed = new WeakSet<Element>();
const entranceMotion = gsap.matchMedia();
entranceMotion.add('(prefers-reduced-motion: no-preference)', context => {
  if (!introPlayed) {
    introPlayed = true;
    gsap.set('.hero-name', { yPercent: 110 });
    gsap.set('.hero-category, .hero-description', { opacity: 0, y: 12 });
    gsap.set('.hero-actions', { opacity: 0, y: 10 });
    gsap.timeline({ defaults: { duration: .65, ease: 'power3.out', clearProps: 'opacity,transform' } })
      .to('.hero-name', { yPercent: 0, duration: .85, stagger: .1 }, 0)
      .to('.hero-category, .hero-description', { opacity: 1, y: 0, stagger: .06 }, .16)
      .to('.hero-actions', { opacity: 1, y: 0 }, .28);
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting || revealed.has(entry.target)) continue;
      revealed.add(entry.target);
      observer.unobserve(entry.target);
      context.add(() => {
        const target = entry.target;
        const settle = { duration: .6, ease: 'power2.out', clearProps: 'opacity,transform' };
        if (target.matches('.proof-row')) {
          gsap.fromTo(target.children, { opacity: .4, x: 16 }, { ...settle, opacity: 1, x: 0, stagger: .06 });
        } else if (target.matches('.component-explorer')) {
          gsap.fromTo(target.querySelectorAll('.component-tab'), { opacity: .35, x: -20 },
            { ...settle, opacity: 1, x: 0, stagger: .07 });
        } else if (target.matches('.faq-list')) {
          gsap.fromTo(target.children, { opacity: .4, x: 20 },
            { ...settle, opacity: 1, x: 0, stagger: .08 });
        } else if (target.matches('.section-heading, .record-notes, .start-copy, .audience-grid')) {
          gsap.fromTo(target.children, { opacity: .4, y: 18 },
            { ...settle, opacity: 1, y: 0, stagger: .08 });
        } else {
          gsap.fromTo(target, { opacity: .4, y: 20 }, { ...settle, opacity: 1, y: 0 });
        }
      });
    }
  }, { rootMargin: '0px 0px -35px 0px', threshold: .08 });
  document.querySelectorAll('.section-heading, .workflow-steps li, .proof-row, .featured-proof, .component-explorer, .component-panel, .module-media, .archive-footer, .start-copy, .faq-list')
    .forEach(target => observer.observe(target));
  return () => observer.disconnect();
});

const components = {
  zh: {
  m1: { contract: 'M1 · 证明构造接口', title: '构造与修复候选',
    description: '调用模型会话，在隔离工作区中构造和修复 Lean 候选。研究你的生成方式、提示和修复策略。',
    input: '题目 · 上下文 · 操作 · 模型会话', output: '候选记录 · 工作区中的证明' },
  m2: { contract: 'M2 · 检查反馈接口', title: '整理 Lean 诊断',
    description: '检查候选与辅助证明，把 Lean 诊断交还研究过程。局部检查之后，集成结果仍需接受完整原题的独立验收。',
    input: '固定题目 · 候选源码 · 检查环境', output: '绑定源码摘要的检查与诊断' },
  m3: { contract: 'M3 · 搜索接口', title: '选择下一步任务',
    description: '选择就绪任务，决定继续、重试或停止，结合路线与共享预算安排尝试。',
    input: '研究状态 · 候选操作 · 共享预算', output: '下一步操作 · 有序就绪任务' },
  m4: { contract: 'M4 · 上下文接口', title: '选择研究上下文',
    description: '从题目、已有成果与失败记录中整理上下文。比较信息选择、上下文压缩和检索策略。',
    input: '题目 · 当前任务 · 可见证据', output: '带来源身份的上下文包' },
  m5: { contract: 'M5 · 协作复用接口', title: '分工与复用证明',
    description: '组织隔离工作区、任务分配与独立审阅。比较单 Agent、独立并行与任务协作的研究方法。',
    input: '就绪任务 · Worker · 路线约束', output: '工作区配置 · 任务与审阅分配' },
  },
  en: {
  m1: { contract: 'M1 · Proof construction', title: 'Build and repair candidates',
    description: 'Calls a model session to build and repair Lean candidates in an isolated workspace. Study your generation method, prompts and repair strategy.',
    input: 'Statement · context · operation · model session', output: 'Candidate record · proof in the workspace' },
  m2: { contract: 'M2 · Check feedback', title: 'Inspect Lean diagnostics',
    description: 'Checks candidates and helper proofs and returns Lean diagnostics to the research process. After local checks, the integrated result still has to pass independent verification of the full original statement.',
    input: 'Fixed statement · candidate source · check environment', output: 'Checks and diagnostics bound to a source digest' },
  m3: { contract: 'M3 · Search', title: 'Choose the next task',
    description: 'Select ready tasks and decide whether to continue, retry or stop within route constraints and a shared budget.',
    input: 'Research state · candidate operations · shared budget', output: 'Next operation · ordered ready tasks' },
  m4: { contract: 'M4 · Context', title: 'Select the research context',
    description: 'Assembles context from the statement, earlier results and failure records. Compare information selection, context compression and retrieval strategies.',
    input: 'Statement · current task · visible evidence', output: 'Context bundle with source identities' },
  m5: { contract: 'M5 · Collaboration and reuse', title: 'Assign tasks and review results',
    description: 'Organizes isolated workspaces, task assignment and independent review. Compare single-agent, independent parallel and task-collaboration methods.',
    input: 'Ready tasks · workers · route constraints', output: 'Workspace configuration · task and review assignment' },
  },
}[locale];
type Component = keyof typeof components;
const componentTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-component]'));
const componentIndicator = createSelectionIndicator(element('.component-tabs'), reducedMotion);
const graphNodes = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-graph-component]'));
const graphEdges = Array.from(document.querySelectorAll<SVGPathElement>('[data-graph-from]'));
const graphRoutes = {
  zh: {
    m1: 'M1 → M2 · 候选证明交给 Lean 检查。',
    m2: 'M2 → M3 · 诊断反馈用于下一轮决策，集成结果交给 S3 独立验收。',
    m3: 'M3 → M4 · 根据就绪任务，整理下一步所需的上下文。',
    m4: 'M4 → M1 · 将带来源的上下文交给证明构造。',
    m5: 'M5 · 为研究循环分配任务、隔离工作区与独立审阅。',
  },
  en: {
    m1: 'M1 → M2 · Lean checks the candidate proof.',
    m2: 'M2 → M3 · Diagnostics guide the next decision. The integrated proof goes to S3.',
    m3: 'M3 → M4 · Ready tasks guide the context selection.',
    m4: 'M4 → M1 · Context with source identities informs proof construction.',
    m5: 'M5 · Assign tasks, isolated workspaces and independent review across the research loop.',
  },
}[locale];
function selectComponent(id: Component, focus = false) {
  const content = components[id];
  if (!content) return;
  const changed = element('#component-panel').getAttribute('aria-labelledby') !== `tab-${id}`;
  for (const tab of componentTabs) {
    const selected = tab.dataset.component === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  element('#component-panel').setAttribute('aria-labelledby', `tab-${id}`);
  for (const [key, value] of Object.entries({ kicker: content.contract, title: content.title,
    description: content.description, input: content.input, output: content.output })) {
    element(`#module-${key}`).textContent = value;
  }
  for (const node of graphNodes) node.setAttribute('aria-pressed', String(node.dataset.graphComponent === id));
  for (const edge of graphEdges) {
    const active = edge.dataset.graphFrom === id || edge.dataset.graphTo === id;
    edge.dataset.active = String(active);
    edge.setAttribute('marker-end', `url(#module-graph-arrow${active ? '-active' : ''})`);
  }
  element('#module-graph-route').textContent = graphRoutes[id];
  componentIndicator.update();
  if (changed) animateSelection([element('.module-details')]);
}
componentTabs.forEach(tab => tab.addEventListener('click', () => selectComponent(tab.dataset.component as Component)));

function handleTabKeys(event: KeyboardEvent, tabs: HTMLButtonElement[], select: (tab: HTMLButtonElement) => void) {
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  let next: number;
  if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % tabs.length;
  else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else return;
  event.preventDefault();
  select(tabs[next]);
}

for (const node of graphNodes) {
  node.disabled = false;
  node.addEventListener('click', () => selectComponent(node.dataset.graphComponent as Component));
}
element('.module-graph').addEventListener('keydown', event => handleTabKeys(event, graphNodes, node => {
  selectComponent(node.dataset.graphComponent as Component);
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
}));
const graphCanvas = element('.module-graph-canvas');
const graphSvg = graphCanvas.querySelector<SVGSVGElement>('.module-graph-edges')!;
function drawGraphEdges() {
  const canvas = graphCanvas.getBoundingClientRect();
  if (!canvas.width || !canvas.height) return;
  const bounds = (id: string) => {
    const node = id === 's3' ? element('[data-graph-terminal="s3"]') : element(`[data-graph-component="${id}"]`);
    const rect = node.getBoundingClientRect();
    return { left: rect.left - canvas.left, right: rect.right - canvas.left,
      top: rect.top - canvas.top, bottom: rect.bottom - canvas.top,
      x: rect.left + rect.width / 2 - canvas.left, y: rect.top + rect.height / 2 - canvas.top };
  };
  graphSvg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
  for (const edge of graphEdges) {
    const fromId = edge.dataset.graphFrom!;
    const toId = edge.dataset.graphTo!;
    const from = bounds(fromId), to = bounds(toId);
    let path: string;
    if (fromId === 'm5') path = `M ${to.x} ${from.bottom + 7} V ${to.top - 9}`;
    else if (toId === 's3') path = `M ${from.x} ${from.bottom + 7} V ${to.top - 9}`;
    else if (fromId === 'm3' && toId === 'm4' || fromId === 'm1' && toId === 'm2') {
      const forward = to.x > from.x;
      path = `M ${forward ? from.right + 7 : from.left - 7} ${from.y} H ${forward ? to.left - 9 : to.right + 9}`;
    } else {
      const forward = to.y > from.y;
      path = `M ${from.x} ${forward ? from.bottom + 7 : from.top - 7} V ${forward ? to.top - 9 : to.bottom + 9}`;
    }
    edge.setAttribute('d', path);
  }
  graphSvg.dataset.ready = 'true';
}
new ResizeObserver(drawGraphEdges).observe(graphCanvas);
document.fonts.ready.then(drawGraphEdges);
selectComponent('m3');

drawGraphEdges();

initializeHumanDecision(locale);
reducedMotion.addEventListener('change', () => {
  if (selectionTargets.size) {
    gsap.killTweensOf([...selectionTargets]);
    gsap.set([...selectionTargets], { clearProps: 'opacity,transform' });
  }
});

element('.component-tabs').addEventListener('keydown', event => handleTabKeys(event, componentTabs, tab => selectComponent(tab.dataset.component as Component, true)));
const componentGrid = matchMedia('(max-width: 900px)');
const orientComponents = () => {
  element('.component-tabs').setAttribute('aria-orientation', componentGrid.matches ? 'horizontal' : 'vertical');
};
orientComponents();
componentGrid.addEventListener('change', orientComponents);


const menuButton = element<HTMLButtonElement>('.menu-toggle');
const mobileNav = element('#mobile-nav');
function setMenu(open: boolean, restoreFocus = false) {
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? text.closeMenu : text.openMenu);
  mobileNav.hidden = !open;
  if (restoreFocus) menuButton.focus();
}
menuButton.addEventListener('click', () => setMenu(menuButton.getAttribute('aria-expanded') !== 'true'));
mobileNav.addEventListener('click', event => { if ((event.target as HTMLElement).closest('a')) setMenu(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !mobileNav.hidden) setMenu(false, true); });
document.addEventListener('click', event => { if (!(event.target as HTMLElement).closest('.site-header') && !mobileNav.hidden) setMenu(false); });
const desktop = matchMedia('(min-width: 901px)');
desktop.addEventListener('change', () => { if (desktop.matches) setMenu(false); });
const indicators = [componentIndicator];
document.addEventListener('visibilitychange', () => {
  if (document.hidden) indicators.forEach(indicator => indicator.update(false));
});
window.addEventListener('pagehide', event => indicators.forEach(indicator => {
  if (event.persisted) indicator.update(false);
  else indicator.destroy();
}));
window.addEventListener('pageshow', () => indicators.forEach(indicator => indicator.update(false)));
// Workbench stage: a fixed 1120×660 canvas of real HTML, scaled to its container. The markup is the finished
// run — collaboration feed, roadmap and explanation — so it reads fully without scripts; this function steps
// back to the confirmed statement and replays the run while the stage is visible.
function initializeProofStage() {
  const stage = document.querySelector<HTMLElement>('[data-proof-stage]');
  if (!stage) return;
  const canvas = stage.querySelector<HTMLElement>('.proof-stage-canvas');
  if (!canvas) return;
  const setScale = (width: number) => stage.style.setProperty('--stage-scale', String(width / 1120));
  setScale(stage.getBoundingClientRect().width);
  if ('ResizeObserver' in window) {
    new ResizeObserver(entries => entries.forEach(entry => setScale(entry.contentRect.width))).observe(stage);
  } else {
    window.addEventListener('resize', () => setScale(stage.getBoundingClientRect().width));
  }
  // Every pane element is tagged with the step it appears at; the roadmap additionally advances node state.
  const revealed = Array.from(canvas.querySelectorAll<HTMLElement>('[data-step]'));
  // A node may appear before it starts work: T2 becomes visible with the plan but waits for T1.
  const nodes = Array.from(canvas.querySelectorAll<HTMLElement>('.proof-node')).map(node => ({
    node,
    start: Number(node.dataset.start ?? node.dataset.step ?? 0),
    step: Number(node.dataset.step ?? 0),
    fail: Number(node.dataset.fail ?? -1),
    done: Number(node.dataset.done ?? node.dataset.step ?? 0),
  }));
  const tabCount = canvas.querySelector<HTMLElement>('[data-tab-count]');
  const paint = (step: number) => {
    stage.dataset.step = String(step);
    revealed.forEach(item => { item.hidden = Number(item.dataset.step) > step; });
    let finished = 0;
    nodes.forEach(({ node, start, fail, done }) => {
      // A failed node stays failed until it finishes, so the red state persists while the repair runs.
      const state = step >= done ? 'done' : step >= fail && fail > 0 ? 'failed' : step >= start ? 'running' : 'waiting';
      node.dataset.state = state;
      if (state === 'done') finished += 1;
    });
    // The roadmap tab counter shows how many roadmap nodes have finished, matching the workbench.
    if (tabCount) tabCount.textContent = `${finished}/${nodes.length}`;
  };
  // [delay before the step, step]: statement confirmed, split into two tasks, omega fails on the parity
  // lemma, the case split passes, your descent guidance, both lemmas pass and the statement closes.
  const steps: Array<[number, number]> = [[900, 1], [1100, 2], [1200, 3], [1400, 4], [1200, 5], [1300, 6]];
  const finalStep = steps[steps.length - 1]![1]!;
  let timer = 0;
  let next = 0;
  let visible = false;
  let finished = false;
  const run = () => {
    timer = 0;
    paint(steps[next++]![1]);
    if (next < steps.length) timer = window.setTimeout(run, steps[next]![0]);
    else finished = true;
  };
  const sync = () => {
    clearTimeout(timer);
    timer = 0;
    if (reducedMotion.matches) {
      stage.classList.remove('is-prepared');
      paint(finalStep);
      next = steps.length;
      finished = true;
      return;
    }
    if (finished) return;
    if (next === 0) {
      stage.classList.add('is-prepared');
      paint(0);
    }
    if (visible && !document.hidden && next < steps.length) timer = window.setTimeout(run, steps[next]![0]);
  };
  reducedMotion.addEventListener('change', () => {
    if (!reducedMotion.matches) { finished = false; next = 0; }
    sync();
  });
  document.addEventListener('visibilitychange', sync);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      const now = entries[0]!.isIntersecting && entries[0]!.intersectionRatio >= .25;
      if (now !== visible) { visible = now; sync(); }
    }, { threshold: .25 }).observe(stage);
  } else {
    visible = true;
  }
  sync();
}
initializeProofStage();

keepHashOnLanguageSwitch();
document.documentElement.dataset.landingReady = 'true';
