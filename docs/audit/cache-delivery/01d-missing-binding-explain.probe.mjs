// K12 — explain().missingBindings / missingInputs for parameters that are required inside the graph
// (by a Service) but never declared/provided as Entry parameters. explainFrom() copies
// error.details.missingInputs / missingBindings, while GraphBuilder's MISSING_INPUT / MISSING_BINDING
// errors carry the id under details.missing only.
import assert from 'node:assert/strict'
import { createRuntime, definePackage } from '../../../packages/core/dist/index.js'
let failures = 0
const report = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failures += 1 }
const check = (name, fn) => { try { fn(); report(name, true) } catch (error) { report(name, false, error instanceof Error ? error.message.split('\n').slice(0, 3).join(' / ') : String(error)) } }

const d = definePackage({ name: '@audit/mb', version: '1.0.0', syna: { id: 'audit.mb' } })
const Cap = d.contract('cap')
const Choice = d.binding('choice', Cap)
const Tenant = d.input('tenant')
const Impl = d.service('impl', { provides: [Cap], setup: () => ({}) })
const NeedsChoice = d.service('needs-choice', { requires: { chosen: Choice }, setup: () => ({}) })
const NeedsTenant = d.service('needs-tenant', { requires: { tenant: Tenant }, setup: () => ({}) })
const DeepBinding = d.entry('deep-binding', { requires: { user: NeedsChoice } })              // Binding never assigned anywhere
const DeepInput = d.entry('deep-input', { requires: { user: NeedsTenant } })                  // Input never provided anywhere
const DeclaredBinding = d.entry('declared-binding', { requires: { user: NeedsChoice }, parameters: { choice: Choice } })
const DeclaredInput = d.entry('declared-input', { requires: { user: NeedsTenant }, parameters: { tenant: Tenant } })
const runtime = createRuntime({ services: [Impl, NeedsChoice, NeedsTenant] })

const deepBinding = await runtime.explain(DeepBinding)
const deepInput = await runtime.explain(DeepInput)
const declaredBinding = await runtime.explain(DeclaredBinding, {})
const declaredInput = await runtime.explain(DeclaredInput, {})
const show = x => `${x.error.code} missingInputs=${JSON.stringify(x.missingInputs)} missingBindings=${JSON.stringify(x.missingBindings)} details.missing=${JSON.stringify(x.error.details.missing)}`
console.log(`declared-but-not-provided Binding: ${show(declaredBinding)}`)
console.log(`declared-but-not-provided Input:   ${show(declaredInput)}`)
console.log(`deep (undeclared) Binding:         ${show(deepBinding)}`)
console.log(`deep (undeclared) Input:           ${show(deepInput)}`)
check('K12 declared-but-unprovided Binding: explain lists it in missingBindings', () => assert.deepEqual(declaredBinding.missingBindings, [Choice.id]))
check('K12 declared-but-unprovided Input: explain lists it in missingInputs', () => assert.deepEqual(declaredInput.missingInputs, [Tenant.id]))
check('K12 deep undeclared Binding: code MISSING_BINDING and explain lists it in missingBindings', () => { assert.equal(deepBinding.error.code, 'MISSING_BINDING'); assert.deepEqual(deepBinding.missingBindings, [Choice.id]) })
check('K12 deep undeclared Input: code MISSING_INPUT and explain lists it in missingInputs', () => { assert.equal(deepInput.error.code, 'MISSING_INPUT'); assert.deepEqual(deepInput.missingInputs, [Tenant.id]) })
await runtime.dispose()
console.log(`${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
