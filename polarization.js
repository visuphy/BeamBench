/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// polarization.js — pooled, throttled polarization markers
import * as THREE from 'three';

// Define a fixed, nominal wavelength (e.g., 550nm green) for all visualizations.
const NOMINAL_WAVELENGTH_M = 550e-9;

/** Make a group to hold polarization markers (with an internal pool). */
export function createPolGroup(scene){
  const g = new THREE.Group();
  g.name = 'PolarizationMarkers';
  g.userData.pool = [];         // pooled THREE.Line objects
  g.userData.used = 0;          // how many are in-use this frame
  // FIX: Increased the marker limit from 220 to 2200.
  // This allows for visualization along much longer beam paths before the pool is exhausted.
  g.userData.max = 2200;        // hard cap to avoid runaway
  g.userData.updateHz = 30;     // animate markers at 30 fps
  g.userData._lastT = -1e9;
  scene.add(g);
  return g;
}

/** Show/hide all polarization markers. */
export function setVisible(group, visible){
  if (!group) return;
  group.visible = !!visible;
}

/** Optional tuning at runtime */
export function setMaxMarkers(group, n){
  if (!group) return;
  group.userData.max = Math.max(0, Math.floor(n));
}
export function setUpdateHz(group, hz){
  if (!group) return;
  group.userData.updateHz = Math.max(1, Math.floor(hz));
}

/** Begin a new recompute frame: mark all pooled markers as free & hide them. */
export function beginFrame(group){
  if (!group) return;
  group.userData.used = 0;
  for (const c of group.children) c.visible = false;
}

/** Acquire (or create) a marker from the pool. Returns false if over cap. */
export function addMarker(group, pos, dir, J, options = {}){
  if (!group) return false;
  const ud = group.userData;
  if (ud.used >= ud.max) return false;

  let line = ud.pool[ud.used];
  if (!line){
    // Create a new marker line and add to pool & group once
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const mat = new THREE.LineBasicMaterial({ color: 0xe6edf3, transparent:true, opacity:0.9 });
    line = new THREE.Line(geo, mat);
    ud.pool[ud.used] = line;
    group.add(line);
  }

  // Build transverse basis: u = +Y (vertical), v = u × k (horizontal)
  const k = dir.clone().normalize();
  const u = new THREE.Vector3(0,1,0);
  let v = new THREE.Vector3().crossVectors(u, k);
  if (v.lengthSq() < 1e-12) v.set(1,0,0); else v.normalize();

  // --- Wavelength Normalization Logic ---
  const inputPhase = options.phase || 0;
  const inputWavelength = options.wavelength || NOMINAL_WAVELENGTH_M;

  // 1. From the input phase, determine the effective distance traveled.
  //    Given: phase = (2 * PI / lambda) * dist
  //    Solve for dist: dist = phase * lambda / (2 * PI)
  const dist = inputPhase * inputWavelength / (2 * Math.PI);

  // 2. Recalculate the phase using the fixed, nominal wavelength.
  //    This ensures all markers for broadband sources align visually.
  const normalizedPhase = (2 * Math.PI / NOMINAL_WAVELENGTH_M) * dist;
  // --- End of Normalization Logic ---

  // Store state for animation (ticked at ~updateHz)
  line.visible = true;
  line.position.copy(pos);
  line.userData._pol = {
    k, u, v,
    Ex: J[0],              // horizontal component (along v)
    Ey: J[1],              // vertical   component (along u)
    scale: 0.01,
    phase: normalizedPhase, // Store the NORMALIZED spatial phase for the travelling wave
  };
  // Do an immediate update so it shows before the next animate()
  _updateMarker(line, 0);

  ud.used++;
  return true;
}

/** Animate all visible markers at throttled FPS. */
export function animate(group, t){
  if (!group || !group.visible) return;
  const ud = group.userData;
  const dtMin = 1 / (ud.updateHz || 30);
  if ((t - ud._lastT) < dtMin) return;
  ud._lastT = t;

  // Use a smoothly increasing phase; ω is fixed in shader-less world
  const omega = 4.0;
  for (let i = 0; i < ud.used; i++){
    const line = ud.pool[i];
    if (line?.visible) _updateMarker(line, t, omega);
  }
}

/* --------------- internal --------------- */

function _updateMarker(line, t, omega=8.0){
  const s = line.userData?._pol; if (!s) return;

  // Using (kz + ωt) correctly syncs the spatial helix and the temporal
  // rotation so the wave visually "screws" in the forward direction.
  const totalPhase = (s.phase || 0) + omega * t;
  const c = Math.cos(totalPhase), si = Math.sin(totalPhase);
  const Ex_t = s.Ex.re * c + s.Ex.im * si;  // horizontal (v)
  const Ey_t = s.Ey.re * c + s.Ey.im * si;  // vertical   (u)


  const tip = new THREE.Vector3()
    .addScaledVector(s.v, Ex_t * s.scale)
    .addScaledVector(s.u, Ey_t * s.scale);

  const arr = line.geometry.attributes.position.array;
  arr[0] = 0; arr[1] = 0; arr[2] = 0;
  arr[3] = tip.x; arr[4] = tip.y; arr[5] = tip.z;
  line.geometry.attributes.position.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}