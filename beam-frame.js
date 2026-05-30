/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as THREE from 'three';

const BASIS_EPS = 1e-12;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

export function buildTransverseBasis(dir, preferredUp = WORLD_UP){
  const k = dir.clone();
  if (!Number.isFinite(k.lengthSq()) || k.lengthSq() < BASIS_EPS) k.set(0, 0, 1);
  k.normalize();

  let u = null;
  for (const ref of [preferredUp, WORLD_X, WORLD_Z]) {
    const candidate = ref.clone().sub(k.clone().multiplyScalar(ref.dot(k)));
    if (candidate.lengthSq() > BASIS_EPS) {
      u = candidate.normalize();
      break;
    }
  }

  if (!u) {
    const fallback = (Math.abs(k.x) < 0.9 ? WORLD_X : WORLD_Z);
    u = fallback.clone().sub(k.clone().multiplyScalar(fallback.dot(k))).normalize();
  }

  const v = new THREE.Vector3().crossVectors(u, k).normalize();
  return { k, u, v };
}
