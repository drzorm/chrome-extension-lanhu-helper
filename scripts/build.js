const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { createZip } = require('./zip');

// Concatenate + minify per runtime context: content scripts collapse into
// content.bundle.js and the service worker into background.bundle.js, and the
// copied manifest points at those bundles. Every source file is already an IIFE
// exposing `globalScope.lanhuXxx`, so concatenation keeps the original load
// order without a module graph.
// Files used by *both* contexts stay standalone and are loaded first, so the
// shared code ships once instead of being duplicated into both bundles.
const root = path.resolve(__dirname, '..');
const packageName = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
const distRoot = path.join(root, 'dist');
const dist = path.join(distRoot, packageName);
const zipPath = path.join(distRoot, `${packageName}.zip`);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const readSource = (file) => {
  if (typeof file !== 'string' || !file.trim()) {
    throw new Error(`invalid file reference: ${JSON.stringify(file)}`);
  }
  return fs.readFileSync(path.join(root, file), 'utf8');
};

const transform = (source, loader = 'js') => esbuild.transformSync(source, {
  loader,
  minify: true,
  ...(loader === 'js' ? { define: { __LANHU_ID_DEBUG__: 'false' } } : {}),
  legalComments: 'none',
  target: 'chrome102',
  charset: 'utf8'
}).code;

// Files referenced by *both* contexts are bundled into shared.js, which is
// loaded first by content scripts and pulled in once via importScripts().
const SHARED_BUNDLE = 'shared.js';

// Service Worker helpers are pulled in via importScripts(); inline them at the
// call site so the bundle keeps the original evaluation order, except for the
// shared modules which are hoisted into a single importScripts() call.
const collectImports = (file, seen = new Set()) => {
  const result = [];
  for (const match of readSource(file).matchAll(/importScripts\(([^)]*)\)/g)) {
    for (const arg of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
      const next = arg[1];
      if (seen.has(next)) continue;
      seen.add(next);
      result.push(next, ...collectImports(next, seen));
    }
  }
  return result;
};

const inlineImportScripts = (file, shared, state, seen = new Set()) => {
  if (seen.has(file)) return '';
  seen.add(file);
  return readSource(file).replace(/importScripts\(([^)]*)\);?/g, (_match, args) => {
    const files = [...args.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
    const parts = [];
    for (const next of files) {
      if (shared.has(next)) {
        if (!state.sharedEmitted) {
          state.sharedEmitted = true;
          parts.push(`importScripts('${SHARED_BUNDLE}');`);
        }
        continue;
      }
      parts.push(inlineImportScripts(next, shared, state, seen));
    }
    return parts.join('\n');
  });
};

const sourceBytes = { value: 0 };
const outputs = new Map(); // relative output path -> string | Buffer

const emit = (file, source, loader = 'js') => {
  const code = transform(source, loader);
  if (loader === 'js') {
    new vm.Script(code, { filename: path.join(dist, file) });
  }
  outputs.set(file, code);
  sourceBytes.value += Buffer.byteLength(source);
  console.log(`  ${file} ${(Buffer.byteLength(source) / 1024).toFixed(1)}`
    + ` -> ${(Buffer.byteLength(code) / 1024).toFixed(1)} KiB`);
};

const emitBundle = (file, parts) => {
  if (parts.length === 0) return;
  emit(file, parts.join('\n'));
};

const distManifest = JSON.parse(JSON.stringify(manifest));
const copyFiles = new Set();

// Strip whole-line comments before the DOM scan so prose like
// "the layer document." does not trigger a false positive.
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const usesDomGlobals = (file) => /\b(?:document|window)\.[A-Za-z_$]/.test(stripComments(readSource(file)));

// Files shared by content scripts and the service worker merge into shared.js.
const contentScriptFiles = (manifest.content_scripts || []).flatMap((entry) => entry.js || []);
const backgroundEntry = manifest.background?.service_worker;
const backgroundImports = backgroundEntry ? collectImports(backgroundEntry) : [];
// Ordered by the content_scripts order, so dependencies keep loading first.
const sharedFiles = contentScriptFiles.filter((file) => backgroundImports.includes(file));
const sharedSet = new Set(sharedFiles);
if (sharedFiles.length > 0) {
  console.log(`  ${SHARED_BUNDLE} <- ${sharedFiles.join(', ')}`);
  for (const file of sharedFiles) {
    if (usesDomGlobals(file)) {
      console.warn(`  warning: ${file} is shared but touches DOM globals (unsafe in the service worker)`);
    }
  }
  emitBundle(SHARED_BUNDLE, sharedFiles.map(readSource));
}

// Background service worker.
if (backgroundEntry) {
  emitBundle('background.js', [inlineImportScripts(backgroundEntry, sharedSet, { sharedEmitted: false })]);
  distManifest.background.service_worker = 'background.js';
}

// Content scripts, one bundle per manifest entry so `matches` stay aligned.
const contentEntries = manifest.content_scripts || [];
contentEntries.forEach((entry, index) => {
  const files = entry.js || [];
  if (files.length === 0) return;
  const bundleFile = contentEntries.length === 1
    ? 'content.js'
    : `content-${index}.js`;
  // shared.js loads first so this bundle can read its globals at eval time.
  const bundled = files.filter((file) => !sharedSet.has(file));
  emitBundle(bundleFile, bundled.map(readSource));
  distManifest.content_scripts[index].js = [
    ...(sharedFiles.length > 0 ? [SHARED_BUNDLE] : []),
    ...(bundled.length > 0 ? [bundleFile] : [])
  ];
});

// CSS is minified too; multiple declarations collapse into one content.css.
const cssFiles = contentEntries.flatMap((entry) => entry.css || []);
if (cssFiles.length > 1) {
  const styleFile = 'content.css';
  emit(styleFile, cssFiles.map(readSource).join('\n'), 'css');
  for (const entry of distManifest.content_scripts) {
    if ((entry.css || []).length > 0) entry.css = [styleFile];
  }
} else {
  for (const file of cssFiles) emit(file, readSource(file), 'css');
}

for (const file of Object.values(manifest.icons || {})) {
  copyFiles.add(file);
}

// Manifest is emitted minified; Chrome parses it as JSON regardless of layout.
const manifestSource = `${JSON.stringify(distManifest, null, 2)}\n`;
const manifestOutput = JSON.stringify(distManifest);
outputs.set('manifest.json', manifestOutput);
sourceBytes.value += Buffer.byteLength(manifestSource);
console.log(`  manifest.json ${(Buffer.byteLength(manifestSource) / 1024).toFixed(1)}`
  + ` -> ${(Buffer.byteLength(manifestOutput) / 1024).toFixed(1)} KiB`);

const missing = [...copyFiles].filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length > 0) {
  throw new Error(`missing runtime files: ${missing.join(', ')}`);
}

fs.rmSync(distRoot, { recursive: true, force: true });

let outputBytes = 0;
const runtimeFiles = [...new Set([...outputs.keys(), ...copyFiles])].sort();
for (const file of runtimeFiles) {
  const targetPath = path.join(dist, file);
  let output = outputs.get(file);
  if (!output) {
    // Icons and other binary assets are copied verbatim.
    output = fs.readFileSync(path.join(root, file));
    console.log(`  ${file} ${(output.length / 1024).toFixed(1)} KiB`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, output);
  if (file.endsWith('.js') || file.endsWith('.json') || file.endsWith('.css')) {
    outputBytes += Buffer.byteLength(output);
  }
}

const zipBytes = createZip(dist, zipPath, runtimeFiles);

console.log(
  `build ok -> dist/${packageName} (${runtimeFiles.length} files, `
  + `${(sourceBytes.value / 1024).toFixed(1)} -> ${(outputBytes / 1024).toFixed(1)} KiB)`
);
console.log(`package ok -> dist/${path.basename(zipPath)} (${(zipBytes / 1024).toFixed(1)} KiB)`);