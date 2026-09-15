#!/usr/bin/env node
require('ts-node/register');
const { compileAndRun } = require('../src/cli.ts');

compileAndRun(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
