#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { KERNEL_CERTIFICATE_DEFAULTS, KERNEL_CERTIFICATE_LIMITS, planKernelCertificate, writeKernelCertificate } from '../../src/math/kernelCertificate';
import { KERNEL_COMPUTE_LIBRARY } from '../../src/math/kernelComputeLibrary';
import { mathDigest, readMathText } from '../../src/math/mathRuntimeIo';

function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'kernel-certificate') args.shift();
  const { values } = parseArgs({ args, options: { input: { type: 'string' }, json: { type: 'string' },
    workspace: { type: 'string' }, replace: { type: 'boolean' }, print: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: theorem-os kernel-certificate (--input FILE | --json JSON) [--workspace LEAN_PROJECT [--replace]] [--print MODULE.lean]\n'
      + 'Generates Lean modules whose `NAME.holds` is proved by `decide +kernel` over chunks; no native_decide, and the library uses only propext and Quot.sound.\n'
      + 'Box claim: {"schema":"theorem-os.kernel-certificate.v1","claim":"box","name":"Cert.Box","check":"KernelCompute.intLe 0 (x*x - 2*x*y + 2*y*y)",'
      + '"variables":[{"name":"x","lo":-20,"hi":20},{"name":"y","lo":-20,"hi":20}],"modules":["Submission/Certificates/Part01.lean"]}\n'
      + '  proves ∀ x : Int, -20 ≤ x → x ≤ 20 → ∀ y : Int, ... → Cert.Box.check x y = true. Put the largest range first; chunks split it.\n'
      + 'Witness claim: {"schema":"theorem-os.kernel-certificate.v1","claim":"witnesses","name":"Cert.Rep","check":"KernelCompute.intEq (a*a + b*b) n",'
      + '"variable":{"name":"n","lo":1,"hi":2},"witnesses":["a","b"],"rows":[[1,0],[1,1]],"modules":["Submission/Certificates/Part01.lean"]}\n'
      + '  proves ∀ n : Int, 1 ≤ n → n ≤ 2 → ∃ a b : Int, Cert.Rep.check n a b = true. Rows list witnesses for lo, lo+1, ..., hi in order.\n'
      + '`check` is one Bool line over Int variables; use KernelCompute.intLe/intLt/intEq, &&, ||, +, -, * and helpers. Optional `definitions` declare '
      + 'NAME.LOCAL helpers, `imports` adds pinned imports, `kernelModule` places the shared KernelCompute library in its own owned module '
      + '(use the same kernelModule for every certificate in one project; two inline libraries collide; a bootstrapped '
      + 'Submission/Certificates/Kernel.lean already holds it), '
      + `and pointsPerChunk (default ${KERNEL_CERTIFICATE_DEFAULTS.pointsPerChunk}) or rowsPerChunk (default ${KERNEL_CERTIFICATE_DEFAULTS.rowsPerChunk}) sets chunk size.\n`
      + 'With several modules the first holds shared definitions, the middle ones hold chunk theorems that can compile in parallel, and the last proves NAME.holds.\n'
      + 'Integers may be JSON safe integers or decimal strings. Without --workspace the command only reports the plan; --print writes one module source to stdout.\n'
      + 'Generated text is unchecked until Lean accepts it. Bridge NAME.check with KernelCompute.intLe_eq_true, intLt_eq_true, intEq_eq_true and Bool.and_eq_true.\n'
      + `Limits: ${JSON.stringify(KERNEL_CERTIFICATE_LIMITS)}.`);
    return;
  }
  if (Boolean(values.input) === Boolean(values.json)) throw new Error('Supply exactly one of --input or --json');
  const text = values.input ? readMathText(values.input, KERNEL_CERTIFICATE_LIMITS.inputBytes) : values.json!;
  if (Buffer.byteLength(text) > KERNEL_CERTIFICATE_LIMITS.inputBytes) throw new Error('math_kernel_certificate_input_too_large');
  const plan = planKernelCertificate(JSON.parse(text), KERNEL_COMPUTE_LIBRARY);
  if (values.print) {
    const module = plan.modules.find(item => item.path === values.print);
    if (!module) throw new Error('math_kernel_certificate_module_unknown');
    process.stdout.write(module.source);
    return;
  }
  const write = values.workspace ? writeKernelCertificate(fs.realpathSync(path.resolve(values.workspace)), plan, values.replace) : undefined;
  console.log(JSON.stringify({ ...plan, modules: plan.modules.map(({ source: _source, ...item }) => item), inputDigest: mathDigest(text),
    ...(write ? { written: write.written, unchanged: write.unchanged } : { dryRun: true }) }));
}
try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : 'math_kernel_certificate_failed');
  process.exitCode = 1;
}
