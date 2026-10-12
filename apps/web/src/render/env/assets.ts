// Lazy loading of the T-307 glbs (`public/assets/*.glb`, plain glTF: no Draco/meshopt
// decoder needed). GLTFLoader itself is imported dynamically, so the first paint never waits
// for it. Parsed scenes are cached per page as templates; every game session instantiates
// its own copies (shared geometry, per-session materials) and disposes those.

import * as THREE from 'three';
import type { AssetName } from './assetSpec.ts';

const templates = new Map<AssetName, Promise<THREE.Object3D>>();

/** URL of an asset under the app's base path. */
export function assetUrl(name: string, base: string = import.meta.env.BASE_URL): string {
  return `${base.endsWith('/') ? base : `${base}/`}assets/${name}`;
}

/** The parsed root node of `<name>.glb` (do not mutate: instantiate it). */
export function loadTemplate(name: AssetName): Promise<THREE.Object3D> {
  let p = templates.get(name);
  if (!p) {
    p = import('three/examples/jsm/loaders/GLTFLoader.js').then(async ({ GLTFLoader }) => {
      const gltf = await new GLTFLoader().loadAsync(assetUrl(`${name}.glb`));
      // the scene holds exactly one root node carrying the asset's extras
      const root = gltf.scene.children.length === 1 ? gltf.scene.children[0]! : gltf.scene;
      root.removeFromParent();
      return root;
    });
    templates.set(name, p);
    p.catch(() => templates.delete(name));
  }
  return p;
}

/**
 * A deep copy of a template: geometry shared, materials cloned once per `materials` map
 * (one map per session, so per-session tweaks such as the env map never leak).
 */
export function instantiate(template: THREE.Object3D, materials: Map<THREE.Material, THREE.Material>): THREE.Object3D {
  const root = template.clone(true);
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const swap = (m: THREE.Material) => {
      let c = materials.get(m);
      if (!c) {
        c = m.clone();
        materials.set(m, c);
      }
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material as THREE.Material);
  });
  return root;
}
