// Pulsing glow over hint cells in the 3D view (design doc リスク: 低応力域を光らせるヒント).
// Lives in the scene's `domain` group, which is in grid units (one unit = one voxel).

import * as THREE from 'three';
import { cellCoords, type Grid } from '../../game/grid.ts';

const COLOR = 0xa8e6ff;
const OPACITY_MIN = 0.1;
const OPACITY_MAX = 0.6;
const PERIOD_S = 1.6;

export class HintGlow {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private raf = 0;
  private disposed = false;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly grid: Grid,
    private readonly reducedMotion = false,
  ) {
    this.material = new THREE.MeshBasicMaterial({
      color: COLOR,
      transparent: true,
      opacity: (OPACITY_MIN + OPACITY_MAX) / 2,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.06, 1.06, 1.06), this.material, grid.n);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'tutorial-hint-glow';
    parent.add(this.mesh);
  }

  /** Show the glow on these cells (empty hides it). */
  set(cells: readonly number[]): void {
    if (this.disposed) return;
    const m = new THREE.Matrix4();
    const n = Math.min(cells.length, this.grid.n);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = cellCoords(this.grid, cells[i]!);
      m.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = n > 0;
    if (n > 0) this.startPulse();
    else this.stopPulse();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPulse();
    this.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }

  private startPulse(): void {
    if (this.raf || this.reducedMotion || typeof requestAnimationFrame !== 'function') return;
    const tick = (t: number) => {
      const phase = (Math.sin((t / 1000 / PERIOD_S) * 2 * Math.PI) + 1) / 2;
      this.material.opacity = OPACITY_MIN + (OPACITY_MAX - OPACITY_MIN) * phase;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopPulse(): void {
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
