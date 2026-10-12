// Voxel material for the load test: a fresh `createVoxelMaterial()` instance (same colours,
// keep hatch, over-stress pulse and grid lines as the normal view) with a chained
// onBeforeCompile that adds, without touching the shared voxel material:
//   - vertex displacement `transformed += uDeform * aDisp` (grid units, after the base shader
//     has copied the undeformed `position` into its own varyings, so grid lines and hatches
//     stay glued to the voxels while they bend);
//   - normal blend `normalize(normal + uDeformT * aNormalDelta)` for the bent shading;
//   - crack decals on cells with `aCrack > 0` growing with `uCrack` (T-307's tileable
//     crack texture when loaded, a procedural Worley-edge pattern otherwise) and an extra
//     over-stress flash `uFlash`.

import * as THREE from 'three';
import { createVoxelMaterial } from '../voxelMesh.ts';

export interface DeformUniforms {
  /** current exaggeration factor applied to `aDisp` */
  uDeform: { value: number };
  /** 0..1 progress of the deformation (normal blend) */
  uDeformT: { value: number };
  /** crack growth 0..1 */
  uCrack: { value: number };
  /** over-stress flash 0..1 */
  uFlash: { value: number };
  /** RGBA crack tile (alpha = mask), or null for the procedural pattern */
  uCrackMap: { value: THREE.Texture | null };
  uCrackMapOn: { value: number };
}

export function createDeformUniforms(): DeformUniforms {
  return {
    uDeform: { value: 0 },
    uDeformT: { value: 0 },
    uCrack: { value: 0 },
    uFlash: { value: 0 },
    uCrackMap: { value: null },
    uCrackMapOn: { value: 0 },
  };
}

const VERTEX_DECL = /* glsl */ `
attribute vec3 aDisp;
attribute vec3 aNormalDelta;
attribute float aCrack;
uniform float uDeform;
uniform float uDeformT;
varying vec3 vRestPos;
varying vec3 vRestNormal;
varying float vCrack;`;

const VERTEX_NORMAL = /* glsl */ `
objectNormal = normalize(objectNormal + uDeformT * aNormalDelta);`;

const VERTEX_POSITION = /* glsl */ `
vRestPos = position;
vRestNormal = normal;
vCrack = aCrack;
transformed += uDeform * aDisp;`;

const FRAGMENT_DECL = /* glsl */ `
uniform float uCrack;
uniform float uFlash;
uniform sampler2D uCrackMap;
uniform float uCrackMapOn;
varying vec3 vRestPos;
varying vec3 vRestNormal;
varying float vCrack;
vec3 scHash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
// distance to the nearest Worley cell edge (F2 - F1): thin lines = crack network
float scCellEdge(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 r = g + scHash3(i + g) - f;
        float d = dot(r, r);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
  return sqrt(f2) - sqrt(f1);
}
float scCrackMask(float k) {
  vec3 an = abs(vRestNormal);
  vec2 uv = an.x > 0.5 ? vRestPos.yz : (an.y > 0.5 ? vRestPos.zx : vRestPos.xy);
  if (uCrackMapOn > 0.5) {
    // one tile per voxel face, randomly shifted per cell (the tile wraps seamlessly)
    vec2 shift = scHash3(floor(vRestPos - 0.5 * vRestNormal)).xy;
    return textureGrad(uCrackMap, uv + shift, dFdx(uv), dFdy(uv)).a * smoothstep(0.0, 0.6, k);
  }
  float e = scCellEdge(vRestPos * 1.6 + 0.37);
  float w = 0.015 + 0.07 * k;
  return 1.0 - smoothstep(w, w + 1.5 * fwidth(e) + 1e-4, e);
}`;

const FRAGMENT_APPLY = /* glsl */ `
if (vCrack > 0.001) {
  float scK = clamp(uCrack * vCrack, 0.0, 1.0);
  if (scK > 0.001) outgoingLight = mix(outgoingLight, vec3(0.045, 0.035, 0.03), 0.92 * scCrackMask(scK));
  outgoingLight += vec3(1.0, 0.42, 0.9) * (0.75 * uFlash);
}`;

/** Insert `code` right after (or before) the first occurrence of `anchor`; throws if missing. */
export function inject(src: string, anchor: string, code: string, where: 'after' | 'before'): string {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`deform shader: anchor ${anchor} not found`);
  return where === 'after'
    ? src.slice(0, i + anchor.length) + code + src.slice(i + anchor.length)
    : src.slice(0, i) + code + '\n' + src.slice(i);
}

/** Patch already-patched voxel shader sources (exported for the shader-anchor test). */
export function patchShader(shader: { vertexShader: string; fragmentShader: string }): void {
  let v = shader.vertexShader;
  v = inject(v, '#include <common>', VERTEX_DECL, 'after');
  v = inject(v, '#include <defaultnormal_vertex>', VERTEX_NORMAL, 'before');
  v = inject(v, '#include <begin_vertex>', VERTEX_POSITION, 'after');
  shader.vertexShader = v;
  let f = shader.fragmentShader;
  f = inject(f, '#include <common>', FRAGMENT_DECL, 'after');
  f = inject(f, '#include <opaque_fragment>', FRAGMENT_APPLY, 'before');
  shader.fragmentShader = f;
}

export function createDeformMaterial(uniforms: DeformUniforms): THREE.MeshLambertMaterial {
  const mat = createVoxelMaterial();
  const base = mat.onBeforeCompile.bind(mat);
  const baseKey = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    base(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    patchShader(shader);
  };
  mat.customProgramCacheKey = () => `${baseKey}+deform-v1`;
  mat.name = 'load-test-voxel';
  return mat;
}
