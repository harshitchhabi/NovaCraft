// The README's benchmark figures must be ones actually recorded in the raw
// benchmark output in docs/AUDIT.md, and must carry the caveat that they
// vary by machine.
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
const audit = fs.readFileSync(path.join(root, 'docs', 'AUDIT.md'), 'utf-8');

function benchmarkSection(md: string): string {
  const start = md.indexOf('### Does the elimination actually matter?');
  const end = md.indexOf('\n## ', start);
  return md.slice(start, end);
}

describe('README benchmark claims', () => {
  const section = benchmarkSection(readme);

  test('every benchmark figure in the README appears in the recorded audit output', () => {
    const lines = section.split('\n').filter((l) => /ms\/call avg|Speedup from elimination/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(audit).toContain(l.trim());
  });

  test('every speedup quoted in prose is a recorded one', () => {
    const recorded = new Set(Array.from(audit.matchAll(/Speedup from elimination: ([\d.]+x)/g), (m) => m[1]));
    for (const m of section.matchAll(/\b(\d+\.\d+x)\b/g)) expect(recorded).toContain(m[1]);
  });

  test('the README says the figures vary by machine', () => {
    expect(section).toMatch(/vary by machine/);
  });
});
