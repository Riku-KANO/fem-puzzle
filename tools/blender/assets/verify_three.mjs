// Loads every exported .glb with three.js' GLTFLoader (Node, no DOM: the assets have no
// textures) and checks the conventions the game relies on. Used by `build.sh --check`.
//
//   node tools/blender/assets/verify_three.mjs [apps/web]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(process.argv[2] ?? join(here, '..', '..', '..', 'apps', 'web'));
const threeDir = join(web, 'node_modules', 'three');
if (!existsSync(threeDir)) {
  console.log('[three] skipped: three.js not installed (run pnpm install)');
  process.exit(0);
}
const THREE = await import(pathToFileURL(join(threeDir, 'build', 'three.module.js')).href);
const { GLTFLoader } = await import(pathToFileURL(join(threeDir, 'examples', 'jsm', 'loaders', 'GLTFLoader.js')).href);

const assets = join(web, 'public', 'assets');
const manifest = JSON.parse(readFileSync(join(assets, 'manifest.json'), 'utf8'));
const loader = new GLTFLoader();
const problems = [];
const fail = (msg) => problems.push(msg);

for (const [file, meta] of Object.entries(manifest.files)) {
  if (!file.endsWith('.glb')) continue;
  const buf = readFileSync(join(assets, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let gltf;
  try {
    gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej));
  } catch (e) {
    fail(`${file}: GLTFLoader failed: ${e}`);
    continue;
  }
  const stem = file.replace(/\.glb$/, '');
  const root = gltf.scene.getObjectByName(stem);
  if (!root) fail(`${file}: no root node named ${stem}`);
  else if (root.userData.asset !== stem) fail(`${file}: root userData.asset != ${stem}`);
  for (const name of meta.nodes ?? []) {
    if (!gltf.scene.getObjectByName(name)) fail(`${file}: missing node ${name}`);
  }
  const unlit = stem === 'workbench' || stem === 'workshop';
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m.vertexColors) fail(`${file}: ${o.name} material ${m.name} has no vertex colours`);
      if (unlit !== (m.type === 'MeshBasicMaterial')) fail(`${file}: ${o.name} unexpected ${m.type}`);
    }
  });
  if (stem === 'workbench' && !(root?.userData.colliders?.length > 0)) fail(`${file}: no colliders in extras`);
  if (meta.bounds) {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const [lo, hi] = meta.bounds;
    const off = Math.max(...box.min.toArray().map((v, i) => Math.abs(v - lo[i])),
      ...box.max.toArray().map((v, i) => Math.abs(v - hi[i])));
    if (off > 1e-3) fail(`${file}: bounds differ from the manifest by ${off.toFixed(4)} m (axis conversion?)`);
  }
}

if (problems.length) {
  for (const p of problems) console.log(`[three] FAIL: ${p}`);
  process.exit(1);
}
console.log(`[three] ok: ${Object.keys(manifest.files).filter((f) => f.endsWith('.glb')).length} glb files parse in three.js r${THREE.REVISION}`);
