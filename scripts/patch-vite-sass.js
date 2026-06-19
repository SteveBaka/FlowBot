const fs = require('fs');
const path = require('path');

const vitePath = path.join(__dirname, '..', 'node_modules', 'vite', 'dist', 'node', 'chunks', 'node.js');
let code = fs.readFileSync(vitePath, 'utf8');

const idx = code.indexOf('function loadPreprocessorPath');
if (idx < 0) {
    console.log('loadPreprocessorPath not found');
    process.exit(1);
}

let depth = 0;
let end = idx;
let started = false;
for (let i = idx; i < code.length; i++) {
    if (code[i] === '{') { depth++; started = true; }
    if (code[i] === '}') { depth--; }
    if (started && depth === 0) { end = i + 1; break; }
}

const sassMjsPath = path.join(__dirname, '..', 'node_modules', 'sass', 'sass.node.mjs').replace(/\\/g, '/');

const newFn = `function loadPreprocessorPath(lang, root) {
\tconst cached = loadedPreprocessorPath[lang];
\tif (cached) return cached;
\tif (lang === "sass" || lang === "sass-embedded") {
\t\tconst resolved = "${sassMjsPath}";
\t\treturn loadedPreprocessorPath[lang] = resolved;
\t}
\tconst resolved = nodeResolveWithVite(lang, void 0, { root }) ?? nodeResolveWithVite(lang, _dirname, { root });
\tif (resolved) return loadedPreprocessorPath[lang] = resolved;
\tconst installCommand = getPackageManagerCommand("install");
\tthrow new Error(\`Preprocessor dependency "\${lang}" not found. Did you install it? Try \\\`\${installCommand} -D \${lang}\\\`.\`);
}`;

code = code.substring(0, idx) + newFn + code.substring(end);
fs.writeFileSync(vitePath, code);
console.log('Patched loadPreprocessorPath with sass.mjs path:', sassMjsPath);
