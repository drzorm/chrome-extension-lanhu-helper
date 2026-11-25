const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Dependency-free syntax checks, not a substitute for semantic/static linting.
const root = path.resolve(__dirname, '..');
const files = [
  ...fs.readdirSync(root).filter(file => file.endsWith('.js')),
  ...fs.readdirSync(__dirname).filter(file => file.endsWith('.js')).map(file => `scripts/${file}`),
  'manifest.json',
  'package.json'
];

for (const file of files) {
  const fullPath = path.join(root, file);
  const source = fs.readFileSync(fullPath, 'utf8');
  if (!source.trim()) throw new Error(`empty file: ${file}`);
  if (file.endsWith('.json')) JSON.parse(source);
  else new vm.Script(source, { filename: fullPath });
}

console.log(`syntax check ok (${files.length} files)`);
