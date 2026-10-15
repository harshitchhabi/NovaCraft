// Hardening configuration: risk weights and the --harden= policies.
//
// Risk of an unproven BoundsCheck site:  R = wP*P + wC*C + wW*W
//   P = 1 if the index is external (src/harden/taint.ts), else 0
//   C = proof gap: 0.5 if exactly one of the two bounds is proven, else 1
//   W = 1 for a store, 0 for a load
// Loop depth D enters only the cost estimate cost = 10^min(D, 3).

export interface RiskWeights {
  wP: number;
  wC: number;
  wW: number;
}

export const DEFAULT_WEIGHTS: RiskWeights = { wP: 0.4, wC: 0.35, wW: 0.25 };

export type Policy =
  | { kind: 'none'; name: string } // no checks at all
  | { kind: 'full'; name: string } // every check, no elimination (= --no-bounds-elim)
  | { kind: 'proof'; name: string } // eliminate proven, retain the rest (the pre-hardening behavior)
  | { kind: 'threshold'; name: string; tau: number } // eliminate proven; omit R < tau; hoist; retain
  | { kind: 'budget'; name: string; fraction: number } // keep by R/cost until cost <= fraction of full
  | { kind: 'chuang'; name: string }; // approximation of Chuang et al. 2007: writes retained, reads omitted

export const DEFAULT_POLICY: Policy = { kind: 'proof', name: 'proof' };

function parseFraction(text: string, what: string): number {
  const v = Number(text);
  if (text.trim() === '' || !Number.isFinite(v)) throw new Error(`invalid ${what} '${text}'`);
  return v;
}

export function parsePolicy(spec: string): Policy {
  switch (spec) {
    case 'none':
    case 'full':
    case 'proof':
    case 'chuang':
      return { kind: spec, name: spec };
    case 'strict':
      return { kind: 'threshold', name: 'strict', tau: 0 };
    case 'balanced':
      return { kind: 'threshold', name: 'balanced', tau: 0.5 };
    case 'performance':
      return { kind: 'threshold', name: 'performance', tau: 0.8 };
  }
  if (spec.startsWith('threshold:')) {
    const tau = parseFraction(spec.slice('threshold:'.length), 'threshold');
    return { kind: 'threshold', name: spec, tau };
  }
  if (spec.startsWith('budget:')) {
    const fraction = parseFraction(spec.slice('budget:'.length), 'budget fraction');
    if (fraction < 0 || fraction > 1) throw new Error(`budget fraction must be in [0, 1], got ${fraction}`);
    return { kind: 'budget', name: spec, fraction };
  }
  throw new Error(
    `unknown --harden policy '${spec}' (expected none, full, proof, strict, balanced, performance, threshold:T, budget:F, chuang)`,
  );
}

export function parseWeights(spec: string): RiskWeights {
  const parts = spec.split(',');
  if (parts.length !== 3) throw new Error(`--risk-weights expects wP,wC,wW, got '${spec}'`);
  const [wP, wC, wW] = parts.map((p) => parseFraction(p, 'risk weight'));
  return { wP, wC, wW };
}
