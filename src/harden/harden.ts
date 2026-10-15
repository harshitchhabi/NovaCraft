// Risk-adaptive bounds-check hardening (milestones A1 + A2).
//
// Runs after range analysis. For every BoundsCheck site it computes
// provenance P, proof gap C, write flag W, risk R and loop depth D (see
// config.ts), decides Eliminate / Hoist / Retain / Omit under the selected
// policy, and versions every loop that has hoisted sites (version.ts).
//
// Decision order for the threshold policies (strict, balanced, performance,
// threshold:T): proven -> Eliminate; else R < tau -> Omit; else versionable
// -> Hoist; else Retain. Omit is the only unsound decision and only exists
// when tau > 0 (or under none, budget:F and chuang).
import { IRFunction, IRInstr, IRProgram, Decision } from '../ir';
import { Policy, RiskWeights } from './config';
import { computeProvenance, isExternal, Provenance } from './taint';
import { HoistSite, LoopPattern, guardTerms, hoistSite, markFastPath, matchLoop } from './version';

type WhileInstr = Extract<IRInstr, { op: 'while' }>;
type CheckInstr = Extract<IRInstr, { op: 'boundscheck' }>;

export interface SiteReport {
  id: number;
  function: string;
  line: number;
  column: number;
  access: 'read' | 'write';
  P: number;
  C: number;
  W: number;
  R: number | null; // null for proven sites (eliminated, not scored)
  D: number;
  cost: number;
  proven: boolean;
  versionable: boolean;
  decision: Decision;
}

export interface HardeningReport {
  policy: string;
  tau?: number;
  budgetFraction?: number;
  weights: RiskWeights;
  entryPoints: string[];
  sites: SiteReport[];
}

interface SiteInternal extends SiteReport {
  hoist: HoistSite | null;
}

export function loopCost(depth: number): number {
  return Math.pow(10, Math.min(depth, 3));
}

// Rounded so that e.g. 0.4 + 0.35 compares equal to a threshold of 0.75.
function round(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

function collectSites(fn: IRFunction, prov: Provenance, weights: RiskWeights): SiteInternal[] {
  const out: SiteInternal[] = [];
  const seen = new Set<number>();
  const loops: LoopPattern[] = []; // innermost last; null patterns are skipped
  const walk = (instrs: IRInstr[], depth: number) => {
    for (const i of instrs) {
      if (i.op === 'boundscheck') {
        if (seen.has(i.id)) continue;
        seen.add(i.id);
        out.push(scoreSite(fn, i, depth, prov, weights, loops));
      } else if (i.op === 'if') {
        walk(i.thenBody, depth);
        if (i.elseBody) walk(i.elseBody, depth);
      } else if (i.op === 'while') {
        walk(i.condInstrs, depth);
        const p = matchLoop(i);
        if (p) loops.push(p);
        walk(i.body, depth + 1);
        if (p) loops.pop();
      }
    }
  };
  walk(fn.body, 0);
  return out;
}

function scoreSite(
  fn: IRFunction,
  i: CheckInstr,
  depth: number,
  prov: Provenance,
  weights: RiskWeights,
  loops: LoopPattern[],
): SiteInternal {
  const proven = !!i.eliminated;
  const P = isExternal(prov, fn.name, i.index) ? 1 : 0;
  const C = proven ? 0 : i.provenLo || i.provenHi ? 0.5 : 1;
  const W = i.access === 'write' ? 1 : 0;
  const R = proven ? null : round(weights.wP * P + weights.wC * C + weights.wW * W);
  let hoist: HoistSite | null = null;
  for (let k = loops.length - 1; k >= 0 && !hoist; k--) hoist = hoistSite(loops[k], i);
  return {
    id: i.id,
    function: fn.name,
    line: i.pos.line,
    column: i.pos.column,
    access: i.access,
    P,
    C,
    W,
    R,
    D: depth,
    cost: loopCost(depth),
    proven,
    versionable: hoist !== null,
    decision: 'retain',
    hoist,
  };
}

function decide(sites: SiteInternal[], policy: Policy): void {
  const keep = (s: SiteInternal, hoisting: boolean): Decision => (hoisting && s.versionable ? 'hoist' : 'retain');
  switch (policy.kind) {
    case 'none':
      for (const s of sites) s.decision = 'omit';
      return;
    case 'full':
      for (const s of sites) s.decision = 'retain';
      return;
    case 'proof':
      for (const s of sites) s.decision = s.proven ? 'eliminate' : 'retain';
      return;
    case 'chuang':
      for (const s of sites) s.decision = s.proven ? 'eliminate' : s.access === 'write' ? 'retain' : 'omit';
      return;
    case 'threshold':
      for (const s of sites) {
        if (s.proven) s.decision = 'eliminate';
        else if (s.R! < policy.tau) s.decision = 'omit';
        else s.decision = keep(s, true);
      }
      return;
    case 'budget': {
      // Keep unproven checks in descending R/cost order (ties: lower id
      // first) while the kept cost stays within fraction * (cost of keeping
      // every check); omit the first check that does not fit and all after it.
      const fullCost = sites.reduce((a, s) => a + s.cost, 0);
      const limit = policy.fraction * fullCost;
      const unproven = sites.filter((s) => !s.proven);
      unproven.sort((a, b) => b.R! / b.cost - a.R! / a.cost || a.id - b.id);
      let used = 0;
      let open = true;
      for (const s of unproven) {
        if (open && used + s.cost <= limit + 1e-9) {
          used += s.cost;
          s.decision = keep(s, true);
        } else {
          open = false;
          s.decision = 'omit';
        }
      }
      for (const s of sites) if (s.proven) s.decision = 'eliminate';
      return;
    }
  }
}

function applyDecisions(fn: IRFunction, decisions: Map<number, SiteInternal>): IRFunction {
  let guardCounter = 0;
  const transform = (instrs: IRInstr[]): IRInstr[] => {
    const out: IRInstr[] = [];
    for (const i of instrs) {
      switch (i.op) {
        case 'boundscheck':
          out.push({ ...i, decision: decisions.get(i.id)!.decision });
          break;
        case 'if':
          out.push({ ...i, thenBody: transform(i.thenBody), elseBody: i.elseBody ? transform(i.elseBody) : null });
          break;
        case 'while': {
          const hoisted = [...decisions.values()].filter((s) => s.decision === 'hoist' && s.hoist!.pattern.loop === i);
          const slow: WhileInstr = { ...i, condInstrs: transform(i.condInstrs), body: transform(i.body) };
          if (hoisted.length === 0) {
            out.push(slow);
            break;
          }
          const ids = new Set(hoisted.map((s) => s.id));
          const fast: WhileInstr = {
            ...slow,
            condInstrs: markFastPath(slow.condInstrs, ids),
            body: markFastPath(slow.body, ids),
          };
          const dest = `%guard${guardCounter++}`;
          const terms = guardTerms(
            hoisted[0].hoist!.pattern,
            hoisted.map((s) => s.hoist!),
          );
          out.push({ op: 'guard', dest, terms, pos: i.pos });
          out.push({ op: 'if', cond: { kind: 'reg', name: dest, type: 'bool' }, thenBody: [fast], elseBody: [slow], pos: i.pos });
          break;
        }
        default:
          out.push(i);
      }
    }
    return out;
  };
  return { ...fn, body: transform(fn.body) };
}

export function harden(program: IRProgram, policy: Policy, weights: RiskWeights): { program: IRProgram; report: HardeningReport } {
  const prov = computeProvenance(program);
  const report: HardeningReport = {
    policy: policy.name,
    weights,
    entryPoints: [...prov.entryPoints],
    sites: [],
  };
  if (policy.kind === 'threshold') report.tau = policy.tau;
  if (policy.kind === 'budget') report.budgetFraction = policy.fraction;

  // Sites are scored per function; the budget policy ranks across the whole
  // program, so decisions are made once over all sites.
  const perFn = program.functions.map((fn) => collectSites(fn, prov, weights));
  const all = perFn.flat();
  decide(all, policy);
  const byId = new Map(all.map((s) => [s.id, s]));

  const functions = program.functions.map((fn) => applyDecisions(fn, byId));
  report.sites = all.map(({ hoist: _hoist, ...rest }) => rest);
  return { program: { functions }, report };
}

export function formatHardeningReport(report: HardeningReport): string {
  const head = `Hardening report (policy=${report.policy}${report.tau !== undefined ? `, tau=${report.tau}` : ''}${
    report.budgetFraction !== undefined ? `, budget=${report.budgetFraction}` : ''
  }; wP=${report.weights.wP} wC=${report.weights.wC} wW=${report.weights.wW}; entry points: ${report.entryPoints.join(', ')})`;
  const lines = [head];
  const fns = [...new Set(report.sites.map((s) => s.function))];
  for (const fn of fns) {
    lines.push(`  [${fn}]`);
    lines.push('    site  line:col  access  P  C    W  R     D  decision');
    for (const s of report.sites.filter((x) => x.function === fn)) {
      const R = s.R === null ? '-' : s.R.toFixed(2);
      lines.push(
        `    #${String(s.id).padEnd(4)}${`${s.line}:${s.column}`.padEnd(10)}${s.access.padEnd(8)}${s.P}  ${String(s.C).padEnd(4)} ${s.W}  ${R.padEnd(5)} ${s.D}  ${s.decision}`,
      );
    }
  }
  return lines.join('\n');
}
