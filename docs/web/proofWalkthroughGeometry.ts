import type { ProofWalkthrough } from './proofWalkthroughTypes';

export const geometryProofWalkthroughs: ProofWalkthrough[] = [
  {
    recordId: 'openai_brennan_sharp',
    runId: '885e367e-04a9-49ca-b82f-d7367b12c10b',
    proofSha256: '63bc780a8b0092517aba26c608eb9c58dc1033600a800a35fb1d5693b8c86e4d',
    title: { zh: '由 Koebe 映射的两处边界奇性得到端点发散', en: 'Obtain endpoint divergence from two boundary singularities of the Koebe map' },
    goal: {
      zh: '证明 k(z)=z/(1−z)² 是归一化单叶函数，且 ∫_D|k′|⁻²、∫_D|k′|²ᐟ³ 均为无穷；其逆映射 g 在 k(D) 上的 |g′|⁴、|g′|⁴ᐟ³ 也均不可积。',
      en: 'Prove that k(z)=z/(1−z)² is normalized and univalent, that ∫_D|k′|⁻² and ∫_D|k′|²ᐟ³ are infinite, and that |g′|⁴ and |g′|⁴ᐟ³ are not integrable on k(D) for its inverse g.',
    },
    notation: {
      zh: 'D={z∈ℂ:|z|<1}；g=koebeInverse 是 k 在 D 上的逆；面积矩 M(t)=∫_D|k′(z)|ᵗ dA。⊤ 表示非负扩展实数积分为无穷。',
      en: 'D={z∈ℂ:|z|<1}; g=koebeInverse is the inverse of k on D; M(t)=∫_D|k′(z)|ᵗ dA. The value ⊤ denotes an infinite nonnegative extended-real integral.',
    },
    steps: [
      {
        id: 'establish-the-koebe-map-and-inverse',
        title: { zh: '先证明 Koebe 映射单叶且归一化', en: 'Establish univalence and normalization of the Koebe map' },
        given: { zh: '取 k(z)=z/(1−z)²，定义域为开单位圆盘 D，因此分母在 D 内不为零。', en: 'Take k(z)=z/(1−z)² on the open unit disk D, where its denominator does not vanish.' },
        claim: { zh: 'k′(z)=(1+z)/(1−z)³，且 k 在 D 上单射、k(0)=0、k′(0)=1；所以 k 是 Schlicht。', en: 'k′(z)=(1+z)/(1−z)³, k is injective on D, k(0)=0 and k′(0)=1. Thus k is Schlicht.' },
        because: {
          zh: '商法则把导数化成上述有理式。若 k(z)=k(w)，清分母并因式分解得 (z−w)(1−zw)=0。第一因子为零即 z=w；第二因子为零则 |z||w|=1，与 |z|,|w|<1 矛盾。导数公式也给出 D 内处处可微，代入 0 得两个归一化等式。',
          en: 'The quotient rule gives the displayed derivative. If k(z)=k(w), clearing denominators and factoring yields (z−w)(1−zw)=0. The first factor gives z=w; the second would give |z||w|=1, impossible inside D. The derivative formula also gives differentiability throughout D, and evaluation at zero supplies the two normalization equations.',
        },
        next: { zh: '接着建立一个可重复使用的边界发散模型，分别应用到边界点 +1 与 −1。', en: 'Build a reusable boundary-divergence model, to be applied at +1 and −1.' },
        evidence: {
          theorems: ['OAI.Brennan.Sharp.schlicht_hasDerivAt_koebeMap', 'OAI.Brennan.Sharp.koebe_schlicht'],
          taskIds: ['schlicht'], deliveryIds: ['019284bf-c95f-400d-996c-6e6f9235a8bb'], checkIds: ['check-a0ab44da88d0a9350a69'],
          source: { name: 'Submission.lean', line: 121, endLine: 137 },
        },
      },
      {
        id: 'sum-disjoint-boundary-balls',
        title: { zh: '用每个都贡献固定正面积积分的圆盘制造发散', en: 'Force divergence with disjoint balls of fixed positive integral contribution' },
        given: { zh: '固定 |a|=1，令 rₙ=2⁻ⁿ，并取 Bₙ=B((1−rₙ)a,rₙ/4)。', en: 'Fix |a|=1, put rₙ=2⁻ⁿ and take Bₙ=B((1−rₙ)a,rₙ/4).' },
        claim: { zh: '这些圆盘位于 D 内且互不相交；若非负可测 F 在 Bₙ 上满足 F≥c(5rₙ/4)⁻²、c>0，则 ∫_D F=∞。特别地 ∫_D|z−a|⁻²=∞。', en: 'The balls lie in D and are pairwise disjoint. If a nonnegative measurable F satisfies F≥c(5rₙ/4)⁻² on Bₙ for c>0, then ∫_D F=∞. In particular ∫_D|z−a|⁻²=∞.' },
        because: {
          zh: '在 Bₙ 上 |z|<1−rₙ+rₙ/4<1，且 |z−a|≤5rₙ/4。若 n<m，则 rₘ≤rₙ/2，中心距 rₙ−rₘ≥rₙ/2，大于半径和≤3rₙ/8，所以圆盘不交。每个圆盘的面积为 π(rₙ/4)²，积分至少 c(5rₙ/4)⁻²π(rₙ/4)²=cπ/25；把无穷多个固定正贡献相加，积分必发散。',
          en: 'On Bₙ, |z|<1−rₙ+rₙ/4<1 and |z−a|≤5rₙ/4. For n<m, rₘ≤rₙ/2, so center distance rₙ−rₘ≥rₙ/2 exceeds the sum of radii, at most 3rₙ/8. Each ball has area π(rₙ/4)² and integral at least c(5rₙ/4)⁻²π(rₙ/4)²=cπ/25. Summing infinitely many disjoint, fixed positive contributions forces divergence.',
        },
        next: { zh: '在 a=+1 附近把 |k′|²ᐟ³ 与这个临界 |z−1|⁻² 模型比较。', en: 'Near a=+1, compare |k′|²ᐟ³ with the critical model |z−1|⁻².' },
        evidence: {
          theorems: ['OAI.Brennan.Sharp.lintegral_eq_top_of_ball_ge', 'OAI.Brennan.Sharp.lintegral_norm_sub_unit_top'],
          taskIds: ['divergence_model'], deliveryIds: ['3d548645-5fec-44b5-89bd-c82fbe9c5be8'], checkIds: ['check-a0ab44da88d0a9350a69'],
          source: { name: 'Submission.lean', line: 180, endLine: 201 },
        },
      },
      {
        id: 'make-the-positive-endpoint-diverge',
        title: { zh: '在 +1 处得到 2/3 次面积矩发散', en: 'Obtain divergence of the 2/3 moment at +1' },
        given: { zh: '第 1 步给出 |k′|²ᐟ³=|1+z|²ᐟ³/|1−z|²，第 2 步给出 ∫_D|z−1|⁻²=∞。', en: 'Step 1 gives |k′|²ᐟ³=|1+z|²ᐟ³/|1−z|², and Step 2 gives ∫_D|z−1|⁻²=∞.' },
        claim: { zh: 'M(2/3)=∫_D|k′|²ᐟ³=∞。', en: 'M(2/3)=∫_D|k′|²ᐟ³=∞.' },
        because: {
          zh: '在 U=D∩{|z−1|≤1/2} 上，反三角不等式给出 |1+z|≥2−|1−z|≥3/2≥1，因此 |k′|²ᐟ³≥|z−1|⁻²。在 D 中 U 以外，模型函数 |z−1|⁻²≤4，而 D 面积有限，所以这部分积分有限。总模型积分无穷，故 U 上模型积分无穷；再用逐点比较，|k′|²ᐟ³ 的圆盘积分也无穷。',
          en: 'On U=D∩{|z−1|≤1/2}, the reverse triangle inequality gives |1+z|≥2−|1−z|≥3/2≥1, hence |k′|²ᐟ³≥|z−1|⁻². On D outside U, the model is at most four and D has finite area, so that part has finite integral. Its total integral is infinite, forcing the integral over U to be infinite. Pointwise comparison then gives the claimed moment divergence.',
        },
        next: { zh: '另一个指数 −2 对应导数在 −1 的零点，改在 a=−1 的圆盘上取下界。', en: 'The exponent −2 instead detects the derivative’s zero at −1; estimate it on the balls with a=−1.' },
        evidence: {
          theorems: ['OAI.Brennan.Sharp.two_thirds_pointwise_bound_near_one', 'OAI.Brennan.Sharp.areaMoment_two_thirds_top'],
          taskIds: ['area_two_thirds'], deliveryIds: ['6ee1f355-1859-48a7-93f7-6d51edc176e0'], checkIds: ['check-a0ab44da88d0a9350a69'],
          source: { name: 'Submission.lean', line: 435, endLine: 456 },
        },
      },
      {
        id: 'make-the-negative-endpoint-diverge',
        title: { zh: '在 −1 处得到 −2 次面积矩发散', en: 'Obtain divergence of the −2 moment at −1' },
        given: { zh: '在朝向 a=−1 的 Bₙ 上有 |1+z|≤5rₙ/4，且 rₙ≤1。导数公式给出 |k′|⁻²=|1−z|⁶/|1+z|²。', en: 'On Bₙ directed toward a=−1, |1+z|≤5rₙ/4 and rₙ≤1. The derivative formula gives |k′|⁻²=|1−z|⁶/|1+z|².' },
        claim: { zh: 'M(−2)=∫_D|k′|⁻²=∞。', en: 'M(−2)=∫_D|k′|⁻²=∞.' },
        because: {
          zh: '由 2=|(1−z)+(1+z)|≤|1−z|+|1+z| 及 |1+z|≤5/4，得到 |1−z|≥3/4。因此 |k′|⁻²≥(3/4)⁶(5rₙ/4)⁻²。第 2 步的发散引理可取固定 c=(3/4)⁶>0，每个不交圆盘贡献至少 cπ/25，故负端点面积矩无穷。',
          en: 'Since 2=|(1−z)+(1+z)|≤|1−z|+|1+z| and |1+z|≤5/4, we have |1−z|≥3/4. Therefore |k′|⁻²≥(3/4)⁶(5rₙ/4)⁻². Apply Step 2 with the fixed positive constant c=(3/4)⁶: every disjoint ball contributes at least cπ/25, forcing this moment to be infinite.',
        },
        next: { zh: '两个面积矩都已发散；接下来通过逆导数公式和实 Jacobian 把它们转成逆映射的积分。', en: 'With both moments divergent, use the inverse derivative and real Jacobian to transfer them to integrals of the inverse map.' },
        evidence: {
          theorems: ['OAI.Brennan.Sharp.neg_two_uniform_bound', 'OAI.Brennan.Sharp.areaMoment_neg_two_top'],
          taskIds: ['area_neg_two'], deliveryIds: ['94fab87b-a43e-46c7-8a33-fc29303a7bec'], checkIds: ['check-a0ab44da88d0a9350a69'],
          source: { name: 'Submission.lean', line: 507, endLine: 526 },
        },
      },
      {
        id: 'compute-the-inverse-jacobian-weights',
        title: { zh: '换元权重把逆映射的 p 次幂变为 2−p 次面积矩', en: 'The change-of-variable weight turns the inverse pth power into moment 2−p' },
        given: { zh: 'k 在 D 内单射，且 k′(z)≠0，因为 ±1 均不在 D 内。令 g 为它在 k(D) 上的逆。', en: 'The map k is injective on D and k′(z)≠0 because ±1 lie outside D. Let g be its inverse on k(D).' },
        claim: { zh: 'g′(k(z))=1/k′(z)，而 |det Dℝk(z)|=|k′(z)|²。因此 Jacobian 乘 |g′(k(z))|ᵖ 等于 |k′(z)|²⁻ᵖ。', en: 'g′(k(z))=1/k′(z), while |det Dℝk(z)|=|k′(z)|². Thus the Jacobian times |g′(k(z))|ᵖ equals |k′(z)|²⁻ᵖ.' },
        because: {
          zh: '单射性给出 g(k(z))=z，局部逆函数求导得到 g′(k(z))=(1−z)³/(1+z)。复数乘法 k′=u+iv 在实平面上的矩阵为 ((u,−v),(v,u))，行列式 u²+v²=|k′|²。相乘后指数相减：p=4 时为 2−4=−2；p=4/3 时为 2−4/3=2/3，正好是前两步已发散的面积矩。',
          en: 'Injectivity gives g(k(z))=z, and the local inverse theorem gives g′(k(z))=(1−z)³/(1+z). Multiplication by k′=u+iv has real matrix ((u,−v),(v,u)), whose determinant is u²+v²=|k′|². Multiplying powers gives exponent 2−p: −2 for p=4 and 2/3 for p=4/3, exactly the two divergent moments above.',
        },
        next: { zh: '将这些逐点权重等式放进面积换元公式，证明两个逆导数积分均为无穷。', en: 'Insert these pointwise weights into the area change-of-variable formula to obtain two infinite inverse-derivative integrals.' },
        evidence: {
          theorems: ['OAI.Brennan.Sharp.deriv_koebeInverse', 'OAI.Brennan.Sharp.inv43_jacobian_weight_mul', 'OAI.Brennan.Sharp.inv4_jacobian_weight_mul'],
          taskIds: ['inverse_deriv_formula', 'inv_p4_cov', 'inv_p43'],
          deliveryIds: ['27c19c66-f31c-4efb-9326-e36498295882', 'daa8ff25-e9e6-4a06-90a7-d2bfb12fdf49', '8afd2b12-8a2d-4377-980f-8845a4a9c210'], checkIds: ['check-a0ab44da88d0a9350a69'],
          source: { name: 'Submission.lean', line: 995, endLine: 1008 },
        },
      },
      {
        id: 'transfer-divergence-and-assemble-the-endpoints',
        title: { zh: '换元排除可积性，汇合五个结论', en: 'Transfer divergence, exclude integrability and assemble the five conclusions' },
        given: { zh: 'k 在可测开集 D 上可微且单射；第 5 步给出两种 Jacobian 权重，第 3、4 步给出相应面积矩无穷。', en: 'The map k is differentiable and injective on measurable open D. Step 5 gives both Jacobian weights, and Steps 3–4 give the corresponding infinite moments.' },
        claim: { zh: '|g′|⁴ 与 |g′|⁴ᐟ³ 在 k(D) 上都不可积；结合 Schlicht 与两个面积矩发散，得到 sharp_endpoints。', en: '|g′|⁴ and |g′|⁴ᐟ³ are both nonintegrable on k(D). Together with Schlicht and the two moment divergences, this proves sharp_endpoints.' },
        because: {
          zh: '实二维面积换元公式给出 ∫_{k(D)}|g′(w)|ᵖdA(w)=∫_D|det Dℝk(z)|·|g′(k(z))|ᵖdA(z)=M(2−p)。p=4、4/3 时右端分别为 M(−2)、M(2/3)，均是无穷。若对应函数 IntegrableOn，其非负积分必须有限，与无穷矛盾。最终定理把单叶归一化、两次面积矩发散和两次不可积性组成定义所需的五个合取项。',
          en: 'The real two-dimensional change-of-variable formula gives ∫_{k(D)}|g′(w)|ᵖdA(w)=∫_D|det Dℝk(z)|·|g′(k(z))|ᵖdA(z)=M(2−p). For p=4 and 4/3, these are M(−2) and M(2/3), both infinite. IntegrableOn would make the nonnegative integral finite, a contradiction. The final theorem combines normalization and univalence, two infinite moments and two nonintegrability results into the five required conjuncts.',
        },
        next: { zh: '完成 Koebe 映射的端点反例结论：两个给定面积矩发散，逆映射的两个给定幂不可积。', en: 'This completes the Koebe endpoint result: the two specified area moments diverge and the two specified inverse-derivative powers are nonintegrable.' },
        evidence: {
          theorems: ['OAI.Brennan.Sharp.inv_deriv_four_not_integrable', 'OAI.Brennan.Sharp.inv_deriv_four_thirds_not_integrable', 'OAI.Brennan.Sharp.sharp_endpoints'],
          taskIds: ['inv_p4', 'inv_p43', 'goal'],
          deliveryIds: ['085ff033-6f63-4009-ac8d-99dabc748a80', 'd33743b4-9767-427e-a7bf-7adca1b0ff79'], checkIds: ['check-a0ab44da88d0a9350a69'],
          source: { name: 'Submission.lean', line: 1042, endLine: 1056 },
        },
      },
    ],
  },
  {
    recordId: 'openai_finite_congruence_graph',
    runId: '24910705-72c7-4d57-9d54-d8c3d6cb4e2e',
    proofSha256: '6b32441db35b95aed73a9f7acdb44c57bc0f5c3e1556113478e96f921b022a3f',
    title: { zh: '在有限代数的同余格与带颜色图见证之间往返', en: 'Pass between finite congruence representations and colored graph witnesses' },
    goal: {
      zh: '对有限带底格 L，证明它可表示为某个非空有限代数的全部同余组成的格，当且仅当 L 存在满足五条公理的非空有限带颜色图见证。',
      en: 'For a finite lattice L with bottom, prove that L is the full congruence lattice of a nonempty finite algebra exactly when it has a nonempty finite colored graph witness satisfying the five stated axioms.',
    },
    notation: {
      zh: 'Cg(x,y) 表示包含 (x,y) 的最小同余；c(x,y)∈L 是边色；admissible 指 c(fx,fy)≤c(x,y)。Marked 边是种子边经 admissible 映射的像，Connected 是这些边的等价闭包。PolyCompatible 在此定义为保持每一个同余的一元映射。',
      en: 'Cg(x,y) is the least congruence containing (x,y); c(x,y)∈L is an edge color. An admissible f satisfies c(fx,fy)≤c(x,y). Marked edges are admissible images of seeds, and Connected is their equivalence closure. Here PolyCompatible means a unary map preserving every congruence.',
    },
    steps: [
      {
        id: 'read-principal-congruences-as-colors',
        title: { zh: '用主同余给有限代数的点对着色', en: 'Color pairs of a finite algebra by principal congruences' },
        given: { zh: '先设有非空有限代数 A 与序同构 e:L≃oCon(A)。定义 c(x,y)=e⁻¹(Cg(x,y))。', en: 'Suppose a nonempty finite algebra A has an order isomorphism e:L≃oCon(A). Set c(x,y)=e⁻¹(Cg(x,y)).' },
        claim: {
          zh: '这个颜色满足对称、零色当且仅当两点相等、三角 join 界，以及区分 a≰b 的边色见证。',
          en: 'These colors satisfy symmetry, color zero exactly on the diagonal, the triangle join bound, and separation of any a≰b by an edge color.',
        },
        because: {
          zh: 'Cg(x,y) 是所有包含 (x,y) 的同余之交，故 Cg(x,y)≤θ 当且仅当 x θ y。交换 x,y 不改变这个交，底同余是相等关系。包含 (x,z)、(z,y) 的 join 由传递性包含 (x,y)，给出三角界。若 a≰b，则 e(a) 中存在 e(b) 不含的点对；它的主同余在 e(a) 以下却不在 e(b) 以下。经 e⁻¹ 拉回即得四条颜色性质。',
          en: 'Cg(x,y) intersects all congruences containing (x,y), so Cg(x,y)≤θ iff x θ y. Swapping the pair preserves this intersection, and the bottom congruence is equality. The join containing (x,z) and (z,y) contains (x,y) by transitivity. If a≰b, some pair belongs to e(a) but not e(b); its principal congruence lies below e(a) but not e(b). Applying e⁻¹ gives the four color properties.',
        },
        next: { zh: '第五条要求颜色的 join 界产生一条连接链；先构造能实现生成同余的链关系。', en: 'The fifth axiom must turn a join bound into a connecting chain; construct a chain relation that captures generated congruences.' },
        evidence: {
          theorems: ['OAI.FiniteCongruence.principal_rel_iff', 'OAI.FiniteCongruence.Principal_le_iff', 'OAI.FiniteCongruence.principal_bot_iff', 'OAI.FiniteCongruence.principal_isGraphWitness'],
          taskIds: ['principal_def', 'principal_rel_iff', 'principal_bot_iff', 'principal_isGraphWitness'],
          deliveryIds: ['05d4dd1c-ddaa-4d48-bbb3-0c7f0b403e68', '0f2ec26c-53da-4cfb-b620-72cbe64fc9d1'], checkIds: ['check-f5280639624cff185d94'],
          source: { name: 'Submission.lean', line: 59, endLine: 80 },
        },
      },
      {
        id: 'turn-generated-congruence-into-chains',
        title: { zh: '证明种子的兼容像边所成等价闭包本身是同余', en: 'Show that the equivalence closure of compatible seed images is a congruence' },
        given: { zh: '给定有限种子集 S，把每条种子经保持所有同余的一元映射 f 的像收集为 TranslateRel。', en: 'For a finite seed set S, TranslateRel consists of images of its pairs under unary maps f preserving every congruence.' },
        claim: { zh: '若每个包含 S 的同余都包含 (x,y)，则 x,y 在 TranslateRel 的等价闭包中相连。', en: 'If every congruence containing S contains (x,y), then the equivalence closure of TranslateRel connects x to y.' },
        because: {
          zh: '恒等映射使种子边进入 TranslateRel，映射复合使其对兼容一元映射封闭，等价闭包也继承这种封闭。对任意原代数操作，固定其他输入只改变一个坐标得到兼容一元映射；依次替换有限个坐标，再用传递性，就证明这个等价闭包对原操作兼容。因此它本身是包含 S 的同余，可直接代入给定的“每个同余”条件。',
          en: 'Identity places seeds in TranslateRel; composition makes it closed under compatible unary maps, and its equivalence closure retains that closure. For any basic operation, fixing all but one input gives a compatible unary map. Replace the finitely many coordinates one at a time and use transitivity: the closure respects every operation. It is therefore itself a congruence containing S, so the assumed universal condition applies to it.',
        },
        next: { zh: '把颜色的 join 上界转成“所有包含种子的同余都包含目标点对”，再应用这个链引理。', en: 'Convert the color join bound into the universal congruence condition and apply this chain lemma.' },
        evidence: {
          theorems: ['OAI.FiniteCongruence.coord_map_polyCompatible', 'OAI.FiniteCongruence.eqvGenTranslate_compatible', 'OAI.FiniteCongruence.poly_generated_eqvGen'],
          taskIds: ['polyCompatible_def', 'polyCompatible_sanity', 'poly_generated_eqvGen'],
          deliveryIds: ['98d82b3f-448e-434c-810a-e07e8e0b9fae'], checkIds: ['check-f5280639624cff185d94'],
          source: { name: 'Submission.lean', line: 236, endLine: 250 },
        },
      },
      {
        id: 'obtain-the-fifth-color-axiom',
        title: { zh: '从种子颜色的上界得到 Marked 连接链', en: 'Obtain a Marked chain from the seed-color join bound' },
        given: { zh: '设 T=∨_{(u,v)∈S}c(u,v)，且 c(x,y)≤T；颜色仍由主同余经 e⁻¹ 定义。', en: 'Let T=∨_{(u,v)∈S}c(u,v) and assume c(x,y)≤T, using the principal-congruence colors.' },
        claim: { zh: 'x,y 满足 Connected c S；五条图公理因而全部成立，表示可推出图见证。', en: 'Connected c S holds for x,y. All five graph axioms follow, giving a graph witness from a representation.' },
        because: {
          zh: '任意包含 S 的同余 θ 都满足 Cg(u,v)≤θ，故 T≤e⁻¹θ。由 c(x,y)≤T 得 Cg(x,y)≤θ，即 x θ y。第 2 步给出 TranslateRel 链。对其中每个 f，保持所有同余意味着 (fx,fy)∈Cg(x,y)，所以 Cg(fx,fy)≤Cg(x,y)；经 e⁻¹ 即证明 f admissible。因此每条 TranslateRel 边也是 Marked 边，整条等价闭包链转成 Connected。',
          en: 'Every congruence θ containing S has Cg(u,v)≤θ for each seed, hence T≤e⁻¹θ. The assumed bound gives Cg(x,y)≤θ, or x θ y. Step 2 supplies a TranslateRel chain. For each map f in that chain, preservation of Cg(x,y) gives Cg(fx,fy)≤Cg(x,y); applying e⁻¹ proves f admissible. Each TranslateRel edge is therefore Marked, so the whole equivalence-closure chain is Connected.',
        },
        next: { zh: '转向反方向：从任意满足五条公理的颜色图构造有限代数及其同余。', en: 'For the reverse direction, construct a finite algebra and its congruences from any witness satisfying the five axioms.' },
        evidence: {
          theorems: ['OAI.FiniteCongruence.principal_isGraphWitness', 'OAI.FiniteCongruence.representable_witness'],
          taskIds: ['principal_isGraphWitness', 'representable_witness'],
          deliveryIds: ['4f18a3a4-50f4-4874-8a6d-a06343e7c349', '40755c1d-eb04-45d8-9fe4-4b29c05e9a4a'], checkIds: ['check-f5280639624cff185d94'],
          source: { name: 'Submission.lean', line: 475, endLine: 496 },
        },
      },
      {
        id: 'construct-the-unary-witness-algebra',
        title: { zh: '把所有不增色映射列为一元基本操作', en: 'Use every color-nonincreasing map as a unary basic operation' },
        given: { zh: '现有有限非空顶点集 Fin n 及图见证 c。以全部 admissible 自映射作为代数基本操作；有限顶点集使这些操作的数量也有限。', en: 'Start with a witness c on nonempty Fin n. Take all admissible self-maps as basic unary operations; there are finitely many because the vertex set is finite.' },
        claim: { zh: '对每个 a∈L，关系 ρ(a)(x,y)⇔c(x,y)≤a 是这个有限代数的同余。', en: 'For each a∈L, the relation ρ(a)(x,y) iff c(x,y)≤a is a congruence of this finite algebra.' },
        because: {
          zh: '对角颜色为 ⊥，所以自反；颜色对称给出关系对称。若 c(x,y)≤a、c(y,z)≤a，则三角公理给出 c(x,z)≤c(x,y)∨c(y,z)≤a，故传递。任一基本操作 f 都不增色，所以 c(fx,fy)≤c(x,y)≤a，保证与所有操作兼容。',
          en: 'Diagonal color ⊥ gives reflexivity, and color symmetry gives symmetry. If c(x,y)≤a and c(y,z)≤a, the triangle axiom gives c(x,z)≤c(x,y)∨c(y,z)≤a, establishing transitivity. Each basic operation f is admissible, so c(fx,fy)≤c(x,y)≤a; hence the relation respects every operation.',
        },
        next: { zh: '要得到全部同余组成的格，还需证明任意同余 θ 都能写成某个 ρ(a)。', en: 'To represent the full congruence lattice, show that every congruence θ equals some ρ(a).' },
        evidence: {
          theorems: ['OAI.FiniteCongruence.witnessAlgebra', 'OAI.FiniteCongruence.witnessRho'],
          taskIds: ['witness_representable'], deliveryIds: ['8c7d4186-55b3-4eca-a71b-513139ca896a'], checkIds: ['check-f5280639624cff185d94'],
          source: { name: 'Submission.lean', line: 264, endLine: 285 },
        },
      },
      {
        id: 'recover-every-congruence-from-its-pair-colors',
        title: { zh: '取 θ 内全部点对的颜色 join，恢复 θ', en: 'Recover θ from the join of colors of all its pairs' },
        given: { zh: '任取所构造代数的同余 θ，令 S={(x,y):x θ y}，a=∨_{(x,y)∈S}c(x,y)。n>0 保证 S 含一个对角点对，因而非空。', en: 'For a congruence θ of the constructed algebra, take S={(x,y):x θ y} and a=∨_{(x,y)∈S}c(x,y). Since n>0, S contains a diagonal pair and is nonempty.' },
        claim: { zh: 'x θ y 当且仅当 c(x,y)≤a，所以 θ=ρ(a)，映射 ρ 是满射。', en: 'x θ y iff c(x,y)≤a. Thus θ=ρ(a), and ρ is surjective.' },
        because: {
          zh: '若 x θ y，它的颜色是有限 join 的一项，当然≤a。反之 c(x,y)≤a 时，第五图公理给出由 S 产生的 Marked 连接链。θ 包含所有种子；每条 Marked 边由 admissible 映射得到，而这些映射全是基本操作，故 θ 仍包含其像。θ 的自反、对称、传递性又沿等价闭包传播，最终得到 x θ y。',
          en: 'If x θ y, its color is one term of the finite join and is at most a. Conversely, c(x,y)≤a invokes the fifth graph axiom to give a Marked chain generated by S. The congruence contains every seed and its admissible images, since all such maps are basic operations. Reflexivity, symmetry and transitivity propagate membership through the equivalence closure, yielding x θ y.',
        },
        next: { zh: '满射排除了遗漏同余；最后用颜色分离公理证明 ρ 还准确反映 L 的序。', en: 'Surjectivity accounts for every congruence; use color separation to show that ρ also reflects the order on L.' },
        evidence: {
          theorems: ['OAI.FiniteCongruence.mem_iff_rho_thetaSeeds', 'OAI.FiniteCongruence.witnessRho_surjective'],
          taskIds: ['witness_representable'], deliveryIds: ['8c7d4186-55b3-4eca-a71b-513139ca896a'], checkIds: ['check-f5280639624cff185d94'],
          source: { name: 'Submission.lean', line: 352, endLine: 373 },
        },
      },
      {
        id: 'reflect-order-and-combine-directions',
        title: { zh: '用分离边得到序同构，并合并两方向', en: 'Use separating edges to obtain an order isomorphism and the equivalence' },
        given: { zh: '每个 ρ(a) 是同余，且 ρ 已满射。图的分离公理说 a≰b 时存在 c(x,y)≤a 但 c(x,y)≰b 的边。', en: 'Each ρ(a) is a congruence and ρ is surjective. The separation axiom supplies c(x,y)≤a but c(x,y)≰b whenever a≰b.' },
        claim: { zh: 'ρ(a)≤ρ(b) 当且仅当 a≤b，故 ρ 是 L 与全部同余格的序同构；最终得到 Representable L↔HasGraphWitness L。', en: 'ρ(a)≤ρ(b) iff a≤b. Thus ρ is an order isomorphism onto the full congruence lattice, proving Representable L↔HasGraphWitness L.' },
        because: {
          zh: 'a≤b 时，由 c(x,y)≤a≤b 立即得到关系包含。若 ρ(a)≤ρ(b) 但 a≰b，分离边在 ρ(a) 内却不在 ρ(b) 内，矛盾。因此 ρ 是保序嵌入，再与第 5 步的满射合成序同构，给出图见证到表示的方向。第 1–3 步已证明反向，将二者装入 iff 即是 graph_criterion。',
          en: 'If a≤b, then c(x,y)≤a≤b gives relation inclusion. If ρ(a)≤ρ(b) but a≰b, a separating edge belongs to ρ(a) and not ρ(b), a contradiction. Hence ρ is an order embedding; Step 5 makes it an order isomorphism, giving a representation from the witness. Steps 1–3 gave the other direction, and the two implications form graph_criterion.',
        },
        next: { zh: '完成这个有限格的表示判别：存在表示与存在指定颜色图见证彼此等价。', en: 'This completes the criterion equating finite congruence representability with existence of the specified graph witness.' },
        evidence: {
          theorems: ['OAI.FiniteCongruence.witnessOrderIso', 'OAI.FiniteCongruence.witness_representable', 'OAI.FiniteCongruence.graph_criterion_from_directions', 'OAI.FiniteCongruence.graph_criterion'],
          taskIds: ['witness_representable', 'graph_criterion_from_directions', 'graph_criterion'],
          deliveryIds: ['838735b5-6cc5-42d8-8a05-521869f363d3', 'ac83e39c-d2e6-4025-9f9e-6e3bbb483252'], checkIds: ['check-f5280639624cff185d94'],
          source: { name: 'Submission.lean', line: 377, endLine: 397 },
        },
      },
    ],
  },
  {
    recordId: 'openai_plane_coloring',
    runId: '58e5a793-5940-4b38-aa6a-2a71ae0cac3f',
    proofSha256: '3e842122e50547b602873e71db599cc6782414fec9c60a08c664d43586341d12',
    title: { zh: '用三角格点的模 7 颜色覆盖整个平面', en: 'Extend a seven-color triangular lattice to the whole plane' },
    goal: {
      zh: '构造平面到 Fin 7 的着色，使任意距离恰为 1 的两点颜色不同。',
      en: 'Construct a coloring of the plane by Fin 7 such that points at distance exactly one have different colors.',
    },
    notation: {
      zh: 'P(a,b)=(3a/4+3b/8,3√3b/8)，其中 a,b 为整数；Q(p,q)=p²+pq+q²；覆盖半径 r=3/(4√3)=√3/4。格点颜色取 a−2b 模 7。',
      en: 'For integers a,b, set P(a,b)=(3a/4+3b/8,3√3b/8), Q(p,q)=p²+pq+q² and r=3/(4√3)=√3/4. A lattice point has color a−2b modulo seven.',
    },
    steps: [
      {
        id: 'encode-distance-and-color',
        title: { zh: '把格点距离与同色条件写成整数公式', en: 'Express lattice distances and equal colors arithmetically' },
        given: { zh: '用两个整数坐标定义三角格点 P(a,b)，并取颜色 (a−2b) mod 7。', en: 'Define triangular lattice points P(a,b) and assign the residue (a−2b) mod 7.' },
        claim: {
          zh: '若 p=a−c、q=b−d，则两格点距离的平方为 (9/16)Q(p,q)；两格点同色当且仅当 7 整除 p−2q。',
          en: 'For p=a−c and q=b−d, the squared distance is (9/16)Q(p,q); the colors agree exactly when seven divides p−2q.',
        },
        because: {
          zh: '坐标差为 (3p/4+3q/8,3√3q/8)。平方相加得 9p²/16+9pq/16+(9+27)q²/64=(9/16)Q(p,q)。模 7 的两个剩余类相等，等价于它们的差 p−2q 是 7 的倍数。',
          en: 'The coordinate difference is (3p/4+3q/8,3√3q/8). Summing its squared coordinates gives 9p²/16+9pq/16+36q²/64=(9/16)Q(p,q). Equality of residues means that their difference p−2q is a multiple of seven.',
        },
        next: { zh: '把同色的整除条件代入 Q，得到不同同色格点之间的距离下界。', en: 'Substitute the divisibility condition into Q to bound the distance between distinct points of one color.' },
        evidence: {
          theorems: ['OAI.Problem160.colorOf_sanity', 'OAI.Problem160.triPoint_sanity', 'OAI.Problem160.lattice_norm'],
          taskIds: ['triPoint_def', 'colorOf_def', 'colorOf_sanity', 'triPoint_sanity', 'lattice_norm'],
          deliveryIds: ['eff8c260-1864-4591-92c3-6a8785d25058'], checkIds: ['check-186cf3d786ab8ebb8f82'],
          source: { name: 'Submission.lean', line: 15, endLine: 32 },
        },
      },
      {
        id: 'separate-equal-color-centers',
        title: { zh: '不同同色格点的距离大于 1+2r', en: 'Distinct centers of one color are farther apart than 1+2r' },
        given: { zh: '两个格点同色且坐标对不同，所以 (p,q)≠(0,0)，并有 p−2q=7k。', en: 'The points have one color and different coordinate pairs, so (p,q)≠(0,0) and p−2q=7k.' },
        claim: {
          zh: 'Q(p,q)≥7，因此格点距离的平方至少为 63/16，距离严格大于 1+2r。',
          en: 'Q(p,q)≥7, so the squared distance is at least 63/16 and the distance is strictly greater than 1+2r.',
        },
        because: {
          zh: '由 p=2q+7k，展开得 Q=7(q²+5qk+7k²)。又有 4Q=(2p+q)²+3q²；非零整数对使 Q>0。因此 Q 是正的 7 倍数，至少为 7。距离公式给出 d²≥63/16；r²=3/16 且 (1+2r)²<63/16，取非负平方根便得 d>1+2r。',
          en: 'Substitution of p=2q+7k gives Q=7(q²+5qk+7k²). Also 4Q=(2p+q)²+3q²>0 for a nonzero pair. Thus Q is a positive multiple of seven and is at least seven. The distance formula gives d²≥63/16. Since r²=3/16 and (1+2r)²<63/16, nonnegative square roots give d>1+2r.',
        },
        next: { zh: '为了给任意平面点着色，还需证明每一点距某个格点不超过 r。', en: 'To color arbitrary points, prove that every point lies within r of a lattice center.' },
        evidence: {
          theorems: ['OAI.Problem160.sameColor_norm', 'OAI.Problem160.sameColor_dist_large'],
          taskIds: ['sameColor_norm', 'sameColor_dist_large'],
          deliveryIds: ['43a8be56-4f75-43ae-96f0-e0a40a252dcd'], checkIds: ['check-186cf3d786ab8ebb8f82'],
          source: { name: 'Submission.lean', line: 60, endLine: 81 },
        },
      },
      {
        id: 'cover-with-four-corner-candidates',
        title: { zh: '在斜坐标的四个整数角中找覆盖格点', en: 'Find a covering center among four integer corners' },
        given: { zh: '任取 x=(X,Y)，反解斜坐标 α=4X/3−4Y/(3√3)、β=8Y/(3√3)，取小数部分 p,q∈[0,1)。', en: 'For x=(X,Y), invert the lattice coordinates: α=4X/3−4Y/(3√3), β=8Y/(3√3). Their fractional parts p,q lie in [0,1).' },
        claim: {
          zh: '在 (⌊α⌋,⌊β⌋) 的四个相邻整数角中，存在 (m,n) 使 dist(x,P(m,n))≤r。',
          en: 'One of the four integer corners adjacent to (⌊α⌋,⌊β⌋) satisfies dist(x,P(m,n))≤r.',
        },
        because: {
          zh: '四个候选误差为 (p,q)、(p−1,q)、(p,q−1)、(p−1,q−1)。按 2p+q、p+2q 与 1、2 的比较，再按 p 与 q 的大小分区，四角引理给出其中一个 Q≤1/3。代入 dist²=(9/16)Q(α−m,β−n)，得到 dist²≤3/16=r²，故 dist≤r。',
          en: 'The candidate errors are (p,q), (p−1,q), (p,q−1) and (p−1,q−1). Comparing 2p+q and p+2q with one and two, then comparing p with q, selects a corner with Q≤1/3. Substitution into dist²=(9/16)Q(α−m,β−n) gives dist²≤3/16=r², hence dist≤r.',
        },
        next: { zh: '对每个平面点固定这样一个覆盖格点，并把格点颜色赋给它。', en: 'Choose such a covering center for each point and transfer its color.' },
        evidence: {
          theorems: ['OAI.Problem160.planeEis_corners', 'OAI.Problem160.covering'],
          taskIds: ['covering'], deliveryIds: ['f26f1ed8-7f0f-462c-a1af-fcffd7d3a30a'], checkIds: ['check-186cf3d786ab8ebb8f82'],
          source: { name: 'Submission.lean', line: 231, endLine: 252 },
        },
      },
      {
        id: 'transfer-a-chosen-center-color',
        title: { zh: '定义全平面着色并保留覆盖证据', en: 'Define the plane coloring together with its covering bound' },
        given: { zh: 'covering 已为每个点 x 提供整数 a,b，满足 dist(x,P(a,b))≤r。', en: 'covering supplies integers a,b with dist(x,P(a,b))≤r for every x.' },
        claim: {
          zh: 'triColor(x) 取所选格点的颜色。每个 x 都同时具有距中心不超过 r、颜色等于中心颜色这两条性质；并且 r<1/2。',
          en: 'triColor(x) is its chosen center’s color. Every point is within r of a center of its color, and r<1/2.',
        },
        because: {
          zh: 'triColor 用 Classical.choose 固定 covering 的两个整数见证；Classical.choose_spec 原样保留距离不等式，因此 triColor_sanity 可以把中心、距离、同色一起取出。另由 3²< (2√3)²=12 且两边为正，得到 3<2√3，即 r<1/2。',
          en: 'triColor uses Classical.choose for the two integer witnesses. Classical.choose_spec retains their distance bound, so triColor_sanity returns the center, bound and color equality together. Finally 3²< (2√3)²=12 implies 3<2√3, giving r<1/2.',
        },
        next: { zh: '反设两个单位距离点同色；先排除它们选中了同一个格点的情形。', en: 'Assume two points at distance one have one color; first exclude a shared chosen center.' },
        evidence: {
          theorems: ['OAI.Problem160.triColor', 'OAI.Problem160.triColor_sanity', 'OAI.Problem160.covering_radius_lt_half'],
          taskIds: ['triColor_def', 'triColor_sanity'],
          deliveryIds: ['56b05be2-a8f9-40d4-857c-43b674ff9231', '7c35caac-a955-41e7-a09b-38c1264b4a8e'], checkIds: ['check-186cf3d786ab8ebb8f82'],
          source: { name: 'Submission.lean', line: 253, endLine: 273 },
        },
      },
      {
        id: 'exclude-a-shared-center',
        title: { zh: '同一个覆盖格点容不下单位距离的两点', en: 'A shared covering center excludes distance one' },
        given: { zh: '设 dist(x,y)=1、triColor(x)=triColor(y)，其所选中心分别为 P(a,b)、P(c,d)。', en: 'Assume dist(x,y)=1 and triColor(x)=triColor(y), with chosen centers P(a,b), P(c,d).' },
        claim: { zh: '若 (a,b)=(c,d)，就推出 dist(x,y)<1，与题设矛盾。', en: 'If (a,b)=(c,d), then dist(x,y)<1, contradicting the hypothesis.' },
        because: {
          zh: '坐标对相同给出同一个中心 P。三角不等式将两点距离分成 dist(x,P)+dist(P,y)；由覆盖界和距离对称性，两项均≤r。因此 dist(x,y)≤2r<1，而它又等于 1。',
          en: 'Equal coordinate pairs give a common center P. The triangle inequality yields dist(x,y)≤dist(x,P)+dist(P,y)≤2r<1, using the two covering bounds and symmetry of distance. This contradicts dist(x,y)=1.',
        },
        next: { zh: '剩下中心坐标对不同的情形；此时同色格点的严格分离下界会产生另一矛盾。', en: 'For different center pairs, use the strict separation bound for equal-color lattice points.' },
        evidence: {
          theorems: ['OAI.Problem160.proper_coloring'],
          taskIds: ['proper_coloring'], deliveryIds: ['dd2dd942-d25d-4787-b291-7c46e3936df0'], checkIds: ['check-186cf3d786ab8ebb8f82'],
          source: { name: 'Submission.lean', line: 274, endLine: 290 },
        },
      },
      {
        id: 'exclude-distinct-centers-and-finish',
        title: { zh: '不同同色中心也与单位距离矛盾', en: 'Distinct equal-color centers give the final contradiction' },
        given: { zh: '两个中心不同；triColor 的相等和中心颜色等式给出 colorOf(a,b)=colorOf(c,d)。', en: 'The centers differ. Equality of triColor and the center-color identities imply colorOf(a,b)=colorOf(c,d).' },
        claim: { zh: '单位距离的点必异色，因此 triColor 见证 ProperColoring 7。', en: 'Points at distance one have different colors, so triColor witnesses ProperColoring 7.' },
        because: {
          zh: '第 2 步给出 dist(P(a,b),P(c,d))>1+2r。但沿 P(a,b)→x→y→P(c,d) 两次用三角不等式，得到中心距≤r+1+r=1+2r，矛盾。中心相同与不同已穷尽，所以 proper_coloring 成立；将 triColor 与它配对即得最终存在性结论。',
          en: 'Step 2 gives dist(P(a,b),P(c,d))>1+2r. The route P(a,b)→x→y→P(c,d), with two triangle inequalities, gives the opposite bound r+1+r=1+2r. Both cases are impossible, proving proper_coloring. Pairing it with triColor supplies the required existence statement.',
        },
        next: { zh: '证明完成：结论是存在一种七色着色，所有单位距离点均异色。', en: 'The proof establishes a seven-color plane coloring separating every unit-distance pair.' },
        evidence: {
          theorems: ['OAI.Problem160.sameColor_dist_large', 'OAI.Problem160.proper_coloring', 'OAI.Problem160.properColoring_seven'],
          taskIds: ['proper_coloring', 'goal'], deliveryIds: ['44b4fd5d-6616-468f-932e-dfc787312cfe'], checkIds: ['check-186cf3d786ab8ebb8f82'],
          source: { name: 'Submission.lean', line: 291, endLine: 302 },
        },
      },
    ],
  },
];
