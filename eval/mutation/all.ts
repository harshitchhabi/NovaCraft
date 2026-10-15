// npm run eval:mutation: generate the corpus, evaluate it twice (run 1 into
// results/mutation/raw, run 2 into a temporary directory), check that the
// two runs' detection results are byte-identical, and write the report.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateCorpus } from '../mutate';
import { evaluateCorpus } from './evaluate';
import { generateMutationReport } from './report';

const ROOT = path.join(__dirname, '..', '..');

async function main(): Promise<void> {
  const dir = path.join(ROOT, 'results', 'mutation');
  fs.mkdirSync(dir, { recursive: true });
  const all = await generateCorpus(dir, (s) => console.log(s));
  console.log(`corpus: ${all.length} generated, ${all.filter((v) => v.status === 'kept').length} kept`);
  const run1 = path.join(dir, 'raw');
  const run2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mutation-run2-'));
  console.log('evaluation run 1');
  await evaluateCorpus(run1, () => undefined);
  console.log('evaluation run 2');
  await evaluateCorpus(run2, () => undefined);
  const files = ['cost.csv', 'outcomes.csv', 'silent.csv'];
  const same = files.map((f) => ({ f, same: fs.readFileSync(path.join(run1, f)).equals(fs.readFileSync(path.join(run2, f))) }));
  const text =
    `The evaluation was run twice in separate passes over the same corpus. ` +
    same.map((x) => `\`${x.f}\` ${x.same ? 'byte-identical' : '**DIFFERS**'}`).join(', ') +
    `. ${same.every((x) => x.same) ? 'Detection results are identical between the two runs.' : '**Detection results differ between the two runs.**'}`;
  fs.writeFileSync(path.join(run1, 'determinism.txt'), text + '\n');
  fs.writeFileSync(path.join(dir, 'RESULTS.md'), generateMutationReport(dir, text));
  console.log(text);
  if (!same.every((x) => x.same)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
