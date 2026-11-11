const $ = selector => document.querySelector(selector);
const text = (selector, value) => { $(selector).textContent = value; };
const link = (selector, href) => { $(selector).href = href; };
const short = value => value.length > 24 ? `${value.slice(0, 16)}…${value.slice(-6)}` : value;

function metadata(selector, values) {
  $(selector).replaceChildren(...values.flatMap(([label, value]) => {
    const term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label; detail.textContent = value;
    return [term, detail];
  }));
}

try {
  const load = async file => {
    const response = await fetch(file);
    if (!response.ok) throw new Error(`${file} 无法读取（${response.status}）`);
    return response.json();
  };
  const [example, recorded] = await Promise.all([load('case.json'), load('recorded-checks.json')]);
  if (recorded.caseId !== example.caseId || recorded.packageDigest !== example.package.digest ||
      recorded.environmentDigest !== example.environment.digest || example.branches.some(branch =>
        !recorded.checks.some(check => check.branchId === branch.id && check.targetVersion === branch.targetVersion))) {
    throw new Error('检查记录与当前案例版本不匹配，请重新生成配套证据。');
  }
  const storageKey = `theoremos:e02:${example.caseId}:${example.package.digest}`;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); } catch { /* No saved selection yet. */ }
  const state = { branch: example.branches.some(branch => branch.id === saved?.branch) ? saved.branch : 'positive',
    search: typeof saved?.search === 'string' ? saved.search : '', branches: {} };
  for (const branch of example.branches) {
    const previous = saved?.branches?.[branch.id];
    state.branches[branch.id] = previous?.targetVersion === branch.targetVersion ? {
      targetVersion: branch.targetVersion, reference: previous.reference === true,
      attemptId: typeof previous.attemptId === 'string' && previous.attemptId.startsWith('e02-local-') ? previous.attemptId : null,
      showCheck: previous.showCheck === true,
    } : { targetVersion: branch.targetVersion, reference: false, attemptId: null, showCheck: false };
  }
  function save(message) {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); }
    catch { text('#announcement', '浏览器未允许保存；当前页面仍可使用，刷新后选择不会恢复。'); return; }
    if (message) text('#announcement', message);
  }
  const entry = example.entry;
  text('#entry-name', entry.name); text('#result-name', entry.name);
  text('#full-type', entry.fullType); text('#real-type', entry.realType);
  $('#entry-premises').replaceChildren(...entry.premises.map(premise => {
    const li = document.createElement('li'); li.textContent = premise; return li;
  }));
  metadata('#source-metadata', [
    ['条目身份', entry.id], ['条目版本', entry.version],
    ['模块', entry.module], ['声明位置', `${entry.source.file}:${entry.source.line}`],
    ['完整源码 SHA256', entry.source.sha256], ['许可', entry.source.license],
    ['Lean', example.environment.toolchain], ['Mathlib', example.environment.mathlibRevision],
    ['自有模块', String(example.environment.ownModules)], ['环境摘要', example.environment.digest],
    ['包版本', example.package.version], ['包摘要', example.package.digest],
  ]);
  link('#entry-source', entry.source.localPath); link('#entry-license', entry.source.licensePath);
  link('#upstream-source', entry.source.url); link('#counterexample-source', example.counterexample.file);
  text('#counterexample-description', example.counterexample.description);
  text('#counterexample-status', `Lean 编译退出 ${recorded.counterexample.exitCode}`);
  text('#acceptance-reason', '本案例未运行独立 S3 评估，也未生成 evaluated_passed 回执。成功分支的应用检查与直接 Lean 编译记录可分别查看。');
  text('#case-id', example.caseId); text('#package-version', `固定包 ${example.package.version}`);
  $('#search').value = state.search;

  function search() {
    const query = state.search.trim().toLowerCase();
    const matches = `${example.title} 正数上的倒数严格反序 倒数 不等式 reciprocal inverse 正数 严格反序 ${entry.name} ${entry.module}`.toLowerCase().includes(query);
    $('#search-result').hidden = !matches; $('#no-results').hidden = matches;
  }
  function render() {
    const branch = example.branches.find(branch => branch.id === state.branch);
    const local = state.branches[branch.id];
    const check = recorded.checks.find(check => check.branchId === branch.id);
    const hasCheck = Boolean(local.attemptId && local.showCheck);
    document.querySelectorAll('[name="branch"]').forEach(input => { input.checked = input.value === branch.id; });
    text('#branch-label', branch.label); text('#assumptions', branch.assumptions.join('；'));
    text('#target-version', branch.targetVersion); link('#target-source', branch.file);
    text('#reference-status', local.reference ? '已固定版本' : '未加入');
    text('#attempt-status', local.attemptId ? '本地尝试已记录' : '未创建');
    text('#application-status', hasCheck ? check.status === 'elaborated' ? '表达式检查通过' : '应用检查失败' : '未查看');
    text('#reference-summary', local.reference ? `${entry.name}\n${short(entry.version)}` : '尚未加入参考');
    text('#add-reference', local.reference ? '已加入参考' : '加入参考'); $('#add-reference').disabled = local.reference;
    text('#try-application', local.attemptId ? '查看本地尝试' : '尝试应用');
    $('#view-check').disabled = !local.attemptId;
    $('#attempt-panel').hidden = !local.attemptId; $('#check-panel').hidden = !hasCheck;
    text('#attempt-id', local.attemptId ?? ''); text('#application-expression', branch.expression);
    metadata('#attempt-versions', [
      ['记录范围', 'E02 本地演示；没有运行时 runId / receiptId'],
      ['目标版本', branch.targetVersion], ['条目版本', entry.version],
      ['包摘要', example.package.digest], ['环境摘要', example.environment.digest],
    ]);
    $('#obligations').replaceChildren(...branch.obligations.map(obligation => {
      const li = document.createElement('li'); li.dataset.status = obligation.status;
      const statement = document.createElement('strong'), reason = document.createElement('p');
      statement.textContent = `${obligation.status === 'closed' ? '已闭合' : '未闭合'} · ${obligation.statement}`;
      reason.textContent = obligation.reason; li.append(statement, reason); return li;
    }));
    text('#check-badge', check.status === 'elaborated' ? 'elaborated' : 'failed'); $('#check-badge').dataset.status = check.status;
    text('#check-scope', check.status === 'elaborated' ?
      '该表达式对本分支固定类型检查通过；整题 S3 验收未执行。' :
      '同一应用在本分支检查失败：0 ≤ b 不能提供所需的 0 < b。严格结论保持不变。');
    text('#diagnostic', check.diagnostic || `Lean 退出 ${check.compilation.exitCode}；未产生诊断。`);
    text('#declaration-use', check.selectedDeclarationUsed === true ?
      `检查表达式中确实包含 ${entry.name}；这不等同于完整原题已验收。` :
      '本次失败检查未导出完整表达式引用链，不能据此认定实际使用成功。');
    metadata('#check-versions', [
      ['authority', check.authority], ['执行方式', check.execution],
      ['目标版本', check.targetVersion], ['源码摘要', check.sourceDigest], ['投影摘要', check.projectionDigest],
      ['直接编译', `Lean 退出 ${check.compilation.exitCode}`],
      ['proofAcceptance', check.proofAcceptance], ['consumerCoverage', check.consumerCoverage],
    ]);
    $('#check-artifacts').replaceChildren(...Object.entries({ '检查清单': check.artifacts.manifest,
      '实际诊断查询': check.artifacts.query, '标准输出': check.artifacts.stdout,
      '标准错误': check.artifacts.stderr, ...(check.artifacts.export ? { '表达式常量导出': check.artifacts.export } : {}) }).map(([label, href]) => {
      const anchor = document.createElement('a'); anchor.textContent = label; anchor.href = href; return anchor;
    }));
    $('#counterexample').hidden = branch.id !== 'nonnegative';
    search();
  }
  document.querySelectorAll('[name="branch"]').forEach(input => input.addEventListener('change', () => {
    state.branch = input.value; save('已切换目标版本，检查状态按分支单独保存。'); render();
  }));
  $('#search').addEventListener('input', event => { state.search = event.target.value; save(); search(); });
  $('#search-result').addEventListener('click', () => { $('#math-card').focus(); $('#math-card').scrollIntoView({ block: 'start' }); });
  $('#add-reference').addEventListener('click', () => { state.branches[state.branch].reference = true; save('已保存固定条目参考；尚未创建应用尝试。'); render(); });
  $('#try-application').addEventListener('click', () => {
    const local = state.branches[state.branch];
    local.attemptId ??= `e02-local-${crypto.randomUUID()}`;
    save('本地尝试已记录，尚未启动任何后台任务。'); render(); $('#attempt-panel').scrollIntoView({ block: 'start' });
  });
  $('#view-check').addEventListener('click', () => {
    state.branches[state.branch].showCheck = true; save('已打开本分支保存的离线检查。'); render(); $('#check-panel').scrollIntoView({ block: 'start' });
  });
  render(); $('#loading').hidden = true; $('#workspace').hidden = false; $('#app').setAttribute('aria-busy', 'false');
} catch (error) {
  $('#loading').hidden = true; text('#error', `案例未加载：${error.message}`); $('#error').hidden = false;
  $('#app').setAttribute('aria-busy', 'false');
}
