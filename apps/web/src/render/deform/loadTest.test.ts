import type { ResultMsg } from '@stress-carve/protocol';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CarveState } from '../../game/carveState.ts';
import { buildDemoStage } from '../../game/demoStage.ts';
import { cellIndex } from '../../game/grid.ts';
import { buildMockModel, computeMockFields } from '../../solver/mockPhysics.ts';
import { buildJigs } from '../jigs.ts';
import { createDeformMaterial, createDeformUniforms } from './deformMaterial.ts';
import { IDLE_LOAD_TEST, LoadTest, MAX_BREAKS, type LoadTestStatus } from './loadTest.ts';
import { breakDuration, DURATION, timelineDuration } from './timeline.ts';

function solve(state: CarveState, seq = 1): ResultMsg {
  const f = computeMockFields(buildMockModel(state.stage), state.solid);
  return {
    type: 'result',
    seq,
    converged: true,
    iterations: 1,
    relResidual: 0,
    elapsedMs: 0,
    cases: f.cases,
    floating: f.floating,
    loadsConnected: f.loadsConnected,
  };
}

/** Demo cantilever with a deep notch near the clamp: over-stressed on the mock. */
function notched(): CarveState {
  const state = new CarveState(buildDemoStage());
  const g = state.grid;
  const cut: number[] = [];
  for (let y = 2; y < g.ny; y++) for (let z = 0; z < g.nz; z++) cut.push(cellIndex(g, 6, y, z));
  state.carve(cut);
  return state;
}

function setup(state: CarveState, reducedMotion = false) {
  const domain = new THREE.Group();
  const voxels = new THREE.Group();
  domain.add(voxels);
  const jigs = buildJigs(state.stage);
  const lt = new LoadTest({
    state,
    domain,
    voxels,
    jigs,
    palette: 'stress',
    reducedMotion,
    floorY: -16,
  });
  const statuses: LoadTestStatus[] = [];
  lt.onStatus = (s) => statuses.push(s);
  const loads = jigs.children.filter((o) => o.name === 'load');
  return { lt, domain, voxels, jigs, loads, statuses };
}

/** Run the show with 60 Hz timestamps up to `seconds`. */
function play(lt: LoadTest, from: number, seconds: number): number {
  let t = from;
  const end = from + seconds * 1000;
  for (; t <= end; t += 1000 / 60) lt.update(t);
  return t;
}

describe('load test (headless)', () => {
  it('within limits: hides the voxel view, bends to the auto scale, then restores everything', () => {
    const state = new CarveState(buildDemoStage());
    const { lt, voxels, loads, statuses } = setup(state);
    const result = solve(state);
    expect(result.cases[0]!.maxUtilization).toBeLessThan(1);
    lt.setResult(result);
    const rest = loads.map((o) => o.position.clone());
    expect(rest.length).toBe(1);

    lt.toggle({ current: true });
    expect(lt.active).toBe(true);
    expect(voxels.visible).toBe(false);
    expect(lt.view.group.visible).toBe(true);
    expect(lt.view.meshCount).toBeGreaterThan(0);
    const st = lt.current;
    expect(st).toMatchObject({ state: 'playing', overstressed: 0, broken: 0, runs: 1 });
    expect(st.scale).toBeGreaterThan(0);

    lt.update(0);
    expect(loads[0]!.position.equals(rest[0]!)).toBe(true); // no jump at the start
    play(lt, 0, DURATION.lift);
    // lifted clear along −F̂ (F̂ = −y): above the rest position
    expect(loads[0]!.position.y).toBeGreaterThan(rest[0]!.y + 0.01);

    // fully loaded: factor = scale, jig follows the (downward) load-point displacement
    const tLoaded = DURATION.lift + DURATION.descend + DURATION.load + 0.2;
    play(lt, 0, tLoaded);
    expect(lt.view.uniforms.uDeform.value).toBeCloseTo(st.scale, 6);
    expect(lt.view.uniforms.uCrack.value).toBe(0);
    expect(loads[0]!.position.y).toBeLessThan(rest[0]!.y);
    // shown tip deflection ≤ 10 % of the smallest extent (4 voxels × 1 cm)
    expect(rest[0]!.y - loads[0]!.position.y).toBeLessThanOrEqual(0.1 * 0.04 + 1e-9);
    expect(rest[0]!.y - loads[0]!.position.y).toBeGreaterThan(0.05 * 0.04 * 0.5);

    play(lt, tLoaded * 1000, timelineDuration({ breaks: 0, reducedMotion: false }));
    expect(lt.active).toBe(false);
    expect(voxels.visible).toBe(true);
    expect(lt.view.group.visible).toBe(false);
    expect(lt.view.meshCount).toBe(0);
    expect(loads[0]!.position.equals(rest[0]!)).toBe(true);
    expect(lt.current).toEqual({ ...IDLE_LOAD_TEST, runs: 1 });
    // phases were reported, ending idle
    expect(statuses.map((s) => s.phase)).toContain('hold');
    expect(statuses.at(-1)!.state).toBe('idle');
    lt.dispose();
  });

  it('over-stressed: breaks elements in order, drops the cut-off part, restores the state', () => {
    const state = notched();
    const solidBefore = new Uint8Array(state.solid);
    const { lt, voxels, loads, statuses } = setup(state);
    const result = solve(state);
    expect(result.cases[0]!.maxUtilization).toBeGreaterThan(1);
    lt.setResult(result);
    lt.toggle({ current: true });
    const st = lt.current;
    expect(st.overstressed).toBeGreaterThan(0);
    const n = Math.min(st.overstressed, MAX_BREAKS);
    const quads0 = lt.view.quadCount;

    const total = timelineDuration({ breaks: n, reducedMotion: false });
    const tSettle = DURATION.lift + DURATION.descend + DURATION.load + DURATION.crack + breakDuration(n) + 0.1;
    const t = play(lt, 0, tSettle);
    expect(lt.current.broken).toBe(n);
    expect(lt.view.uniforms.uCrack.value).toBe(1);
    expect(lt.debris.chipCount).toBe(n);
    // the notch only keeps the bottom two rows; breaking them cuts the beam → collapse
    expect(lt.current.collapsed).toBeGreaterThan(0);
    expect(lt.debris.pieceCount).toBe(lt.current.collapsed);
    expect(lt.view.quadCount).toBeLessThan(quads0);
    // the load jig side fell off: shown flags lost the far end
    expect(lt.view.shown[cellIndex(state.grid, 23, 7, 0)]).toBe(0);
    // the game state is untouched
    expect(state.solid).toEqual(solidBefore);
    expect(voxels.visible).toBe(false);

    play(lt, t, total - tSettle + 0.1);
    expect(lt.active).toBe(false);
    expect(voxels.visible).toBe(true);
    expect(lt.debris.chipCount).toBe(0);
    expect(lt.debris.pieceCount).toBe(0);
    expect(state.solid).toEqual(solidBefore);
    expect(statuses.some((s) => s.phase === 'break')).toBe(true);
    void loads;
    lt.dispose();
  });

  it('chips land on the bench and stay above it', () => {
    const state = notched();
    const { lt } = setup(state);
    lt.setResult(solve(state));
    lt.toggle({ current: true });
    const n = Math.min(lt.current.overstressed, MAX_BREAKS);
    play(lt, 0, DURATION.lift + DURATION.descend + DURATION.load + DURATION.crack + breakDuration(n) + DURATION.settle - 0.05);
    const mesh = lt.debris.group.children.find((o) => o instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      expect(p.y).toBeGreaterThanOrEqual(-16);
      expect(p.y).toBeLessThan(-14); // settled near the floor, not hanging in the air
    }
    lt.dispose();
  });

  it('cancel (solid changed) restores immediately; Space again stops', () => {
    const state = notched();
    const { lt, voxels, loads } = setup(state);
    const rest = loads[0]!.position.clone();
    lt.setResult(solve(state));
    lt.toggle({ current: true });
    play(lt, 0, 4);
    lt.cancel();
    expect(lt.active).toBe(false);
    expect(voxels.visible).toBe(true);
    expect(loads[0]!.position.equals(rest)).toBe(true);
    expect(lt.debris.chipCount).toBe(0);

    lt.toggle({ current: true });
    expect(lt.active).toBe(true);
    lt.toggle({ current: true });
    expect(lt.active).toBe(false);
    expect(lt.current.runs).toBe(2);
    lt.dispose();
  });

  it('waits for the next result when the latest one is stale', () => {
    const state = new CarveState(buildDemoStage());
    const { lt } = setup(state);
    lt.toggle({ current: false });
    expect(lt.current.state).toBe('waiting');
    expect(lt.active).toBe(false);
    lt.cancel(); // a carve while waiting keeps waiting
    expect(lt.current.state).toBe('waiting');
    lt.setResult(solve(state));
    expect(lt.active).toBe(false); // starts on the next frame, after any debris removal
    lt.update(16);
    expect(lt.active).toBe(true);
    expect(lt.current.state).toBe('playing');
    lt.dispose();
  });

  it('reduced motion: static frame, everything applied at once, no flying debris', () => {
    const state = notched();
    const { lt, loads } = setup(state, true);
    const rest = loads[0]!.position.clone();
    lt.setResult(solve(state));
    lt.toggle({ current: true });
    expect(lt.current.state).toBe('holding');
    lt.update(0);
    const n = Math.min(lt.current.overstressed, MAX_BREAKS);
    expect(lt.current.broken).toBe(n);
    expect(lt.debris.chipCount).toBe(0);
    expect(lt.debris.pieceCount).toBe(0);
    expect(lt.view.uniforms.uFlash.value).toBe(0);
    expect(lt.view.uniforms.uCrack.value).toBe(1);
    const u0 = lt.view.uniforms.uDeform.value;
    expect(u0).toBe(lt.current.scale);
    // nothing moves over time
    const jigY = loads[0]!.position.y;
    play(lt, 0, 10);
    expect(lt.active).toBe(true);
    expect(lt.view.uniforms.uDeform.value).toBe(u0);
    expect(loads[0]!.position.y).toBe(jigY);
    lt.toggle();
    expect(lt.active).toBe(false);
    expect(loads[0]!.position.equals(rest)).toBe(true);
    lt.dispose();
  });

  it('section mask limits the shown cells', () => {
    const state = new CarveState(buildDemoStage());
    const { lt } = setup(state);
    lt.setResult(solve(state));
    lt.toggle({ current: true });
    const full = lt.view.quadCount;
    lt.stop();
    const mask = new Uint8Array(state.grid.n);
    for (let e = 0; e < state.grid.n; e++) mask[e] = Math.floor(e / (24 * 8)) < 2 ? 1 : 0; // z < 2
    lt.sectionMask = () => mask;
    lt.toggle({ current: true });
    expect(lt.view.shown.reduce((a, b) => a + b, 0)).toBe(24 * 8 * 2);
    expect(lt.view.quadCount).not.toBe(full);
    lt.update(0);
    expect(lt.active).toBe(true);
    // moving the section (or leaving section view) ends the show
    mask[0] = 0;
    lt.update(16);
    expect(lt.active).toBe(false);
    lt.toggle({ current: true });
    lt.sectionMask = () => null;
    lt.update(32);
    expect(lt.active).toBe(false);
    lt.dispose();
  });
});

describe('deform material', () => {
  it('patches the voxel shader at anchors that exist in this three.js version', () => {
    const uniforms = createDeformUniforms();
    const mat = createDeformMaterial(uniforms);
    const shader = {
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
      uniforms: {} as Record<string, { value: unknown }>,
    };
    mat.onBeforeCompile(shader as never, null as never);
    const v = shader.vertexShader;
    const f = shader.fragmentShader;
    expect(v).toContain('transformed += uDeform * aDisp;');
    expect(v).toContain('attribute vec3 aDisp;');
    // the base voxel shader keeps reading the undeformed position for grid lines/hatches
    expect(v).toContain('vGridPos = position;');
    // bent normals are applied after the base copied the rest normal for its grid lines
    const blend = v.indexOf('objectNormal = normalize(objectNormal + uDeformT * aNormalDelta);');
    expect(blend).toBeGreaterThan(v.indexOf('vObjNormal = objectNormal;'));
    expect(blend).toBeLessThan(v.indexOf('#include <defaultnormal_vertex>'));
    expect(f.indexOf('scCrackMask(scK)')).toBeLessThan(f.indexOf('#include <opaque_fragment>'));
    expect(f.indexOf('scCrackMask(scK)')).toBeGreaterThan(0);
    for (const k of ['uDeform', 'uDeformT', 'uCrack', 'uFlash', 'uCrackMap', 'uCrackMapOn', 'uTime']) {
      expect(shader.uniforms[k]).toBeDefined();
    }
    expect(shader.uniforms['uDeform']).toBe(uniforms.uDeform);
    expect(mat.customProgramCacheKey()).toMatch(/\+deform-v1$/);
    mat.dispose();
  });
});
