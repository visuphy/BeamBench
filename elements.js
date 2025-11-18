/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// elements.js — Three.js optics elements, labels, and helpers
import * as THREE from 'three';
import { Complex, Rtheta, MWaveplate, MPol } from './optics.js';

let ELEMENT_ID = 1;

// Shared materials
const commonSide = THREE.DoubleSide;
const matLens    = new THREE.MeshStandardMaterial({ color:0x9bd8ff, metalness:0.1, roughness:0.35, transparent:true, opacity:0.85, side: commonSide });
const matGlass   = new THREE.MeshStandardMaterial({ color:0xb6ffd9, metalness:0.1, roughness:0.35, transparent:true, opacity:0.85, side: commonSide });
const matWave    = new THREE.MeshStandardMaterial({ color:0xffd6a6, metalness:0.1, roughness:0.35, transparent:true, opacity:0.85, side: commonSide });
const matFaraday = new THREE.MeshStandardMaterial({ color:0xe6c9ff, metalness:0.1, roughness:0.35, transparent:true, opacity:0.85, side: commonSide });
const matMirror  = new THREE.MeshStandardMaterial({ color:0xf0eded, metalness:0.1, roughness:0.15, side: commonSide });
const matMirrorSide = new THREE.MeshStandardMaterial({ color: 0x707070, metalness: 0.1, roughness: 1.0, side: commonSide, transparent: true });
const matBS      = new THREE.MeshStandardMaterial({ color: 0xc7d6ff, metalness:0.2, roughness:0.3,  transparent:true, opacity:0.85, side: THREE.DoubleSide });
const matBlock   = new THREE.MeshStandardMaterial({ color:0x444b5a, metalness:0.2, roughness:0.6, side: THREE.DoubleSide });
const matGrating = new THREE.MeshStandardMaterial({ color:0xdcc2ff, metalness:0.2, roughness:0.35, transparent:true, opacity:0.9, side: THREE.DoubleSide });
const matMeter   = new THREE.MeshStandardMaterial({ color:0xfff3a3, metalness:0.15, roughness:0.4, transparent:true, opacity:0.95, side: THREE.DoubleSide });

function makePanel(w=0.0036, h=0.0036, mat=matGlass){
  const visualThickness = 0.0004; // Visual thickness
  const collisionThickness = 1e-6; // Near-zero for collision
  
  // Create a group to hold both meshes
  const group = new THREE.Group();
  
  // Visual mesh (thick, for display)
  const visualGeometry = new THREE.BoxGeometry(w, h, visualThickness);
  const visualMesh = new THREE.Mesh(visualGeometry, mat);
  visualMesh.castShadow = false;
  visualMesh.receiveShadow = false;
  visualMesh.userData.isVisualOnly = true; // Mark as visual-only
  group.add(visualMesh);
  
  // Collision mesh (thin, invisible, for ray tracing)
  const collisionGeometry = new THREE.BoxGeometry(w, h, collisionThickness);
  const collisionMesh = new THREE.Mesh(
    collisionGeometry,
    new THREE.MeshBasicMaterial({ visible: false })
  );
  collisionMesh.userData.isCollisionMesh = true;
  
  // Return the collision mesh but keep the visual as a child
  collisionMesh.add(group);
  return collisionMesh;
}
// --- helpers: plano-spherical visual geometry ---
function _buildSphericalPatchGeometry(worldW, worldH, R, segs = 96) {
  // worldW/worldH are the *actual* visible size in meters (base size × scale).
  const sgn = (R >= 0 ? 1 : -1);
  const Ra  = Math.abs(R);

  if (!Number.isFinite(Ra) || Ra < 1e-9) {
    // fallback to flat plane if R is not valid
    return new THREE.PlaneGeometry(worldW, worldH, segs, segs);
  }

  const gx = segs, gy = segs;
  const vx = (gx + 1), vy = (gy + 1);
  const positions = new Float32Array(vx * vy * 3);
  const normals   = new Float32Array(vx * vy * 3);
  const uvs       = new Float32Array(vx * vy * 2);

  const halfW = worldW * 0.5, halfH = worldH * 0.5;

  let ip = 0, iu = 0;
  for (let j = 0; j <= gy; j++) {
    const ty = j / gy, y = THREE.MathUtils.lerp(-halfH, halfH, ty);
    for (let k = 0; k <= gx; k++) {
      const tx = k / gx, x = THREE.MathUtils.lerp(-halfW, halfW, tx);
      const r2 = x*x + y*y;
      const inside = r2 <= Ra*Ra + 1e-12;

      // sagitta on the sphere; if outside, place it *on the rim* (projection),
      // so edge is circular even when the grid is rectangular.
      let px = x, py = y, pz = 0;
      if (inside) {
        pz = sgn * (Ra - Math.sqrt(Math.max(0, Ra*Ra - r2)));
      } else {
        // project to rim: scale (x,y) to length R
        const invLen = 1.0 / Math.max(1e-12, Math.hypot(x, y));
        px = x * Ra * invLen;
        py = y * Ra * invLen;
        pz = sgn * Ra; // rim z at hemisphere boundary
      }

      positions[ip+0] = px;
      positions[ip+1] = py;
      positions[ip+2] = pz;

      // normal from sphere center (0,0,sgn*R) to point
      let nx = px, ny = py, nz = (pz - sgn*Ra);
      const inv = 1.0 / Math.max(1e-12, Math.hypot(nx, ny, nz));
      normals[ip+0] = nx * inv;
      normals[ip+1] = ny * inv;
      normals[ip+2] = nz * inv;

      uvs[iu+0] = tx; uvs[iu+1] = ty;
      ip += 3; iu += 2;
    }
  }

  // indices — add a cell's two triangles only if the *cell center* is inside the circle
  const idx = [];
  for (let j = 0; j < gy; j++) {
    for (let k = 0; k < gx; k++) {
      const a = j * (gx+1) + k;
      const b = a + 1;
      const c = a + (gx+1);
      const d = c + 1;

      // cell center (average of its four corners)
      const cx = 0.25 * (positions[3*a] + positions[3*b] + positions[3*c] + positions[3*d]);
      const cy = 0.25 * (positions[3*a+1] + positions[3*b+1] + positions[3*c+1] + positions[3*d+1]);
      if ((cx*cx + cy*cy) <= Ra*Ra + 1e-9) {
        idx.push(a, c, b, b, c, d);
      }
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
  geom.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(idx);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}


export function refreshMirrorVisual(el) {
    if (!el?.mesh) return;
    const collisionMesh = el.mesh;
    const group = collisionMesh.children.find(c => c.isGroup);
    if (!group) return;

    // clear visuals
    while (group.children.length) group.remove(group.children[0]);
    // reset stored physical surfaces for propagation
    el._surfaceMeshes = [];

    // IMPORTANT: reset visual rotation so we don't accumulate transforms
    group.rotation.set(0, 0, 0);

    // base geometry * |scale| = world size
    const base = collisionMesh.geometry?.parameters || {};
    const baseW = base.width  ?? 0.004;
    const baseH = base.height ?? 0.004;

    // Use absolute value so negative scales don't explode
    const sx = collisionMesh.scale.x || 0;
    const sy = collisionMesh.scale.y || 0;
    const sz = collisionMesh.scale.z || 0;

    const absSx = Math.abs(sx);
    const absSy = Math.abs(sy);
    const absSz = Math.abs(sz);

    const worldW = baseW * absSx;
    const worldH = baseH * absSy;

    // Inverse scales to neutralize the parent's non-uniform scaling
    // (use magnitude so negative scales behave like positive)
    const invScaleX = 1 / Math.max(1e-9, absSx);
    const invScaleY = 1 / Math.max(1e-9, absSy);
    const invScaleZ = 1 / Math.max(1e-9, absSz);


    // Flat mirror visual thickness (unchanged)
    const tBackFlat = 0.00012;
    const isCurved = !el.props.flat && Number.isFinite(el.props.R);

    // --- FLAT MIRROR: keep the old rectangular sandwich ---
    if (!isCurved) {
        const back = new THREE.Mesh(new THREE.BoxGeometry(worldW, worldH, tBackFlat), matMirror);
        back.position.z = -tBackFlat * 0.5;
        back.userData.isVisualOnly = true;
        back.scale.set(invScaleX, invScaleY, invScaleZ);
        group.add(back);
        el._surfaceMeshes = []; // no special surfaces for flat mirrors
        const frontFlat = new THREE.Mesh(new THREE.BoxGeometry(worldW, worldH, tBackFlat), matMirror);
        frontFlat.position.z = tBackFlat * 0.5 + 1e-5;
        frontFlat.userData.isVisualOnly = true;
        frontFlat.scale.set(invScaleX, invScaleY, invScaleZ);
        group.add(frontFlat);
        return;
    }

    // --- SPHERICAL MIRROR: curved front + planar back with adjustable thickness ---

    // Thickness bookkeeping (meters): distance along local +z between curved vertex
    // and planar back surface.
    const DEFAULT_THICKNESS = 1.8e-4; // ~0.18 mm (matches previous visual)
    if (!Number.isFinite(el.props.thickness) || el.props.thickness <= 0) {
        el.props.thickness = DEFAULT_THICKNESS;
    }

    // Invert R for visual convention (user wants R>0 concave, R<0 convex)
    const R_visual = -el.props.R;
    const isVisuallyConvex = R_visual > 0;

    // Rotate visuals so that for convex (R<0) the planar back ends up behind
    // the curved face, matching the flat-mirror convention.
    group.rotation.y = isVisuallyConvex ? Math.PI : 0;

    // Create the base curved geometry
    const capGeom = _buildSphericalPatchGeometry(worldW, worldH, R_visual, 128);
    const posAttr = capGeom.getAttribute('position');
    const posArr = posAttr.array;

    // Clone geometry for the flat back before modifying the front
    const backGeom = capGeom.clone();

    let thicknessMin = 1e-6; // geometry-based minimum so surfaces never overlap

    if (isVisuallyConvex) {
        // ==== CONVEX (user R < 0) ====
        // The builder gives z>=0, with z=0 at center (thinnest point). We must flip this profile.
        const normAttr = capGeom.getAttribute('normal');
        const normArr = normAttr.array;
        let z_max = 0;
        for (let i = 2; i < posArr.length; i += 3) {
            if (posArr[i] > z_max) z_max = posArr[i];
        }

        // Transform z -> z_max - z. This puts the peak (z=z_max) at the center
        // and the base (z≈0) at the edge. Also flip normals to match.
        for (let i = 0; i < posArr.length; i += 3) {
            posArr[i + 2] = z_max - posArr[i + 2];
            normArr[i + 2] *= -1;
        }
        posAttr.needsUpdate = true;
        normAttr.needsUpdate = true;

        // Now the front surface lives in [zMin, zMax], with zMax at the vertex
        // along the optical axis and zMin near the rim.
        let zMin = +Infinity, zMax = -Infinity;
        for (let i = 2; i < posArr.length; i += 3) {
            const z = posArr[i];
            if (z < zMin) zMin = z;
            if (z > zMax) zMax = z;
        }

        // To keep the planar back behind the *entire* spherical patch we require:
        //   planeZ <= zMin
        // and thickness = zMax - planeZ  ≥  zMax - zMin
        thicknessMin = Math.max(1e-6, zMax - zMin);
        el.props._thicknessMin = thicknessMin;

        let thickness = el.props.thickness;
        if (!Number.isFinite(thickness) || thickness < thicknessMin) {
            thickness = thicknessMin;
            el.props.thickness = thickness;
        }

        const planeZ = zMax - thickness;
        const safePlaneZ = Math.min(planeZ, zMin); // numeric safety

        const backPosAttr = backGeom.getAttribute('position');
        const backPosArr = backPosAttr.array;
        for (let i = 2; i < backPosArr.length; i += 3) {
            backPosArr[i] = safePlaneZ;
        }
        backPosAttr.needsUpdate = true;
    } else {
        // ==== CONCAVE (user R > 0) ====
        // The builder gives z<=0, with z=0 at the center (vertex) and negative
        // sag towards the rim. Putting the planar back at z = +thickness keeps it
        // behind the entire curved surface for any thickness > 0.
        thicknessMin = 1e-6;
        el.props._thicknessMin = thicknessMin;

        let thickness = el.props.thickness;
        if (!Number.isFinite(thickness) || thickness < thicknessMin) {
            thickness = Math.max(thicknessMin, DEFAULT_THICKNESS);
            el.props.thickness = thickness;
        }

        const backPosAttr = backGeom.getAttribute('position');
        const backPosArr = backPosAttr.array;
        for (let i = 2; i < backPosArr.length; i += 3) {
            backPosArr[i] = thickness; // plane behind vertex at z=0
        }
        backPosAttr.needsUpdate = true;
    }

    // --- Build side wall between front (capGeom) and back (backGeom) ---

    const idxAttr = capGeom.getIndex();
    if (idxAttr) {
        const idx = idxAttr.array;
        const posFront = capGeom.getAttribute('position').array;
        const posBack  = backGeom.getAttribute('position').array;

        // Find boundary edges (edges used by only one triangle)
        const edgeMap = new Map();
        const addEdge = (i1, i2) => {
            const a = Math.min(i1, i2);
            const b = Math.max(i1, i2);
            const key = a + "_" + b;
            const e = edgeMap.get(key);
            if (e) {
                e.count++;
            } else {
                edgeMap.set(key, { a, b, count: 1 });
            }
        };

        for (let i = 0; i < idx.length; i += 3) {
            const a = idx[i], b = idx[i+1], c = idx[i+2];
            addEdge(a, b);
            addEdge(b, c);
            addEdge(c, a);
        }

        const sidePositions = [];
        const sideIndices = [];
        let vBase = 0;

        edgeMap.forEach(e => {
            if (e.count === 1) {
                const a = e.a;
                const b = e.b;

                // Front positions
                const ax = posFront[3*a], ay = posFront[3*a+1], az = posFront[3*a+2];
                const bx = posFront[3*b], by = posFront[3*b+1], bz = posFront[3*b+2];

                // Back positions (same indices in backGeom)
                const axb = posBack[3*a], ayb = posBack[3*a+1], azb = posBack[3*a+2];
                const bxb = posBack[3*b], byb = posBack[3*b+1], bzb = posBack[3*b+2];

                // Quad: (front a, front b, back b, back a)
                sidePositions.push(
                    ax,  ay,  az,   // v0
                    bx,  by,  bz,   // v1
                    axb, ayb, azb,  // v2
                    bxb, byb, bzb   // v3
                );

                // Two triangles for the quad
                sideIndices.push(
                    vBase,     vBase+1, vBase+3,
                    vBase,     vBase+3, vBase+2
                );
                vBase += 4;
            }
        });

        if (sidePositions.length > 0) {
            const sideGeom = new THREE.BufferGeometry();
            sideGeom.setAttribute(
                'position',
                new THREE.BufferAttribute(new Float32Array(sidePositions), 3)
            );
            sideGeom.setIndex(sideIndices);
            sideGeom.computeVertexNormals();
            sideGeom.computeBoundingBox();
            sideGeom.computeBoundingSphere();

            const sideMesh = new THREE.Mesh(sideGeom, matMirrorSide);
            sideMesh.userData.isVisualOnly = true;
            sideMesh.userData.element = el;
            sideMesh.userData.surfaceKind = 'side';
            sideMesh.scale.set(invScaleX, invScaleY, invScaleZ);
            group.add(sideMesh);

            // track as a physical surface
            el._surfaceMeshes.push(sideMesh);
        }
    }

    // --- Finalize and add meshes (front + back) ---

    // Front mesh (curved)
    capGeom.computeBoundingBox();
    capGeom.computeBoundingSphere();
    const cap = new THREE.Mesh(capGeom, matMirror);
    cap.userData.isVisualOnly = true;
    cap.userData.element = el;
    cap.userData.surfaceKind = 'front';
    cap.scale.set(invScaleX, invScaleY, invScaleZ);
    group.add(cap);

    el._surfaceMeshes.push(cap);

    
    // Back mesh (flat, with constant normals)
    const nSign = isVisuallyConvex ? 1 : -1; // Pointing away from the mirror's interior
    const backPosAttrFinal = backGeom.getAttribute('position');
    const nArr = new Float32Array(backPosAttrFinal.array.length);
    for (let i = 0; i < nArr.length; i += 3) {
        nArr[i + 0] = 0;
        nArr[i + 1] = 0;
        nArr[i + 2] = nSign;
    }
    backGeom.setAttribute('normal', new THREE.BufferAttribute(nArr, 3));
    backGeom.computeBoundingBox();
    backGeom.computeBoundingSphere();
    
    const back = new THREE.Mesh(backGeom, matMirror);
    back.userData.isVisualOnly = true;
    back.userData.element = el;
    back.userData.surfaceKind = 'back';
    back.scale.set(invScaleX, invScaleY, invScaleZ);
    group.add(back);

    el._surfaceMeshes.push(back);

}



export function makeLabel(text){
  const c = document.createElement('canvas'); const fs=48;
  const ctx=c.getContext('2d'); ctx.font = `Bold ${fs}px Arial`;
  const w = Math.max(1, ctx.measureText(text).width + 20); const h = fs + 16;
  c.width=w; c.height=h;
  ctx.font = `Bold ${fs}px Arial`;
  ctx.fillStyle="rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0,0,w,h);
  ctx.fillStyle="rgba(255, 255, 255, 0.95)";
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w/2, h/2);
  const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map:tex, depthTest:false, transparent:true }));
  spr.scale.set(w/40000, h/40000, 1);
  spr.position.set(0, 0.0025, 0.00021);
  spr.renderOrder=10;
  return spr;
}

export function clampToPlaneXZ(obj){
  obj.rotation.order = 'YXZ';
  const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ');
  obj.rotation.set(e.x, e.y, 0);
}

function axisAngleInUV(el, ctx, axisDeg){
  const qW = el.mesh.getWorldQuaternion(new THREE.Quaternion());
  const xW = new THREE.Vector3(1,0,0).applyQuaternion(qW).normalize();
  const yW = new THREE.Vector3(0,1,0).applyQuaternion(qW).normalize();
  const thL = THREE.MathUtils.degToRad(axisDeg);
  const aW = xW.clone().multiplyScalar(Math.cos(thL)).add(yW.clone().multiplyScalar(Math.sin(thL))).normalize();
  const k = ctx.dir.clone().normalize();
  const u = new THREE.Vector3(0,1,0);
  const v = new THREE.Vector3().crossVectors(u, k).normalize();
  return Math.atan2(aW.dot(u), aW.dot(v));
}

function attachUGIAxis(el){
  const g = new THREE.Group(); g.name = 'UGI';
  // CHANGED: Increased rod radius and ball size for better visibility
  const zOff = 0.00012, stalkLen = 0.0045, extraReach = 0.0018, rodRad = 0.0001; // Was 0.00004
  const rod = new THREE.Mesh( new THREE.CylinderGeometry(rodRad, rodRad, stalkLen, 16), new THREE.MeshStandardMaterial({ color:0xe6edf3, metalness:0.6, roughness:0.35 }) );
  rod.rotation.z = Math.PI/2; rod.position.set(stalkLen/2, 0, zOff);
  const ball = new THREE.Mesh( new THREE.SphereGeometry(0.0004, 24, 16), new THREE.MeshStandardMaterial({ color:0x7ee787, metalness:0.4, roughness:0.4 }) ); // Was 0.0002
  ball.position.set(stalkLen + extraReach, 0, zOff);
  const hit = new THREE.Mesh( new THREE.SphereGeometry(0.0012, 24, 16), new THREE.MeshBasicMaterial({ transparent:true, opacity:0.0, depthWrite:false }) ); // Was 0.0008
  hit.position.copy(ball.position);
  ball.userData.isUGI = true; ball.userData.element = el; hit.userData.isUGI = true; hit.userData.element = el;
  g.add(rod); g.add(ball); g.add(hit); g.renderOrder = 20;
  el.mesh.add(g);
  const setAngle = (deg)=>{ g.rotation.z = THREE.MathUtils.degToRad(deg||0); };
  setAngle(el.props.axisDeg || 0);
  el.ugi = { group:g, handle:hit, ball, setAngle };
  return el.ugi;
}

/* ----------------- Factories ----------------- */
export function makeLens({f=1.0}={}){
  const mesh = makePanel(0.0036,0.0036, matLens);
  const el = {
    id: ELEMENT_ID++, type:"lens", mesh, props:{ f },
    abcd(q){ const A=1, B=0, C=-1/this.props.f, D=1; const Aq = q.clone().mul(new Complex(A,0)); const num = Aq.add(B); const Cq = q.clone().mul(new Complex(C,0)); const den = Cq.add(D); return num.div(den); },
    jones(j){ return j; }
  };
  mesh.userData.element = el; updateElementLabel(el); return el;
}

export function makeMirror({
  flat = true,
  R = 2.0,
  refl = 1.0,
  n = 1.5,
  dichroic = false,
  reflBand_nm = { min: 400, max: 700 },
  transBand_nm = { min: 700, max: 1100 },
  thickness = 1.8e-4      // NEW: default ~0.18 mm
} = {}) {
  const mesh = makePanel(0.004,0.004, matMirror);
  const el = {
    id: ELEMENT_ID++, type: "mirror", mesh,
    props: { flat, R, refl, n, dichroic, reflBand_nm, transBand_nm, thickness },

    // Reflection on curved surface (unchanged)
    abcd(q){
      if (this.props.flat) return q;
      const C = -2 / this.props.R;   // uses sign of R
      const A = 1, B = 0, D = 1;
      const Aq = q.clone().mul(new Complex(A, 0));
      const num = Aq.add(B);
      const Cq = q.clone().mul(new Complex(C, 0));
      const den = Cq.add(D);
      return num.div(den);
    },

    // Transmission through spherical mirror substrate:
    // - correct sign of R
    // - uses n1 -> n2 at each surface
    // - thickness enters because front/back surfaces are separated in space
    abcdTransmit(q, ctx = {}) {
      if (this.props.flat) return q;

      const R = this.props.R;
      const nGlass = this.props.n ?? 1.5;

      // If no good radius, nothing to do
      if (!Number.isFinite(R) || Math.abs(R) < 1e-9) return q;

      const surfaceKind = ctx.surfaceKind || "front";
      const n1 = Number.isFinite(ctx.n1) ? ctx.n1 : 1.0;
      const n2 = Number.isFinite(ctx.n2) ? ctx.n2 : nGlass;

      let A = 1, B = 0, C = 0, D = 1;

      if (surfaceKind === "front") {
        // Determine direction based on refractive indices
        // We assume "exiting" if we are starting in the dense medium (glass)
        const isExiting = Math.abs(n1 - nGlass) < 1e-6;

        // Entering (Air->Glass): Needs -R (upstream CoC for Concave)
        // Exiting (Glass->Air):  Needs +R (downstream CoC for Concave)
        const effectiveR = isExiting ? R : -R;

        C = (n1 - n2) / (effectiveR * n2);
        D = n1 / n2;
      } else if (surfaceKind === "back") {
        // Planar interface (R = infinity)
        C = 0;
        D = n1 / n2;
      } else {
        // Fallback for old behavior
        C = -((nGlass - 1) / R);
      }

      const Aq = q.clone().mul(new Complex(A, 0));
      const num = Aq.add(B);
      const Cq = q.clone().mul(new Complex(C, 0));
      const den = Cq.add(D);
      return num.div(den);
    },

    jones(j){ return j; }
  };

  mesh.userData.element = el;
  updateElementLabel(el);

  // initial visual shape
  refreshMirrorVisual(el);
  return el;
}

export function makePolarizer({axisDeg=0}={}){
  const mesh = makePanel(0.0036,0.0036, matGlass);
  const el = {
    id: ELEMENT_ID++, type:"polarizer", mesh, props:{ axisDeg },
    abcd(q){ return q; },
    jones(j, ctx){ const th = axisAngleInUV(this, ctx, this.props.axisDeg); return Rtheta(-th).mul(MPol).mul(Rtheta(th)).mulVec(j); }
  };
  mesh.userData.element = el; updateElementLabel(el); attachUGIAxis(el); return el;
}

export function makeWaveplate({type="HWP", delta=Math.PI, axisDeg = 0}={}){
  const mesh = makePanel(0.0036,0.0036, matWave);
  const el = {
    id: ELEMENT_ID++, type:"waveplate", mesh, props:{ delta, type, axisDeg },
    abcd(q){ return q; },
    jones(j, ctx){ const th = axisAngleInUV(this, ctx, this.props.axisDeg); return Rtheta(-th).mul(MWaveplate(this.props.delta)).mul(Rtheta(th)).mulVec(j); }
  };
  mesh.userData.element = el; updateElementLabel(el); attachUGIAxis(el); return el;
}

export function makeFaraday({phiDeg=45}={}){
  const mesh = makePanel(0.0036,0.0036, matFaraday);
  const el = {
    id: ELEMENT_ID++, type:"faraday", mesh, props:{ phiDeg },
    abcd(q){ return q; },
    jones(j, ctx){ const phi = THREE.MathUtils.degToRad(this.props.phiDeg || 0); const qW = this.mesh.getWorldQuaternion(new THREE.Quaternion()); const nW = new THREE.Vector3(0,0,1).applyQuaternion(qW).normalize(); const k  = (ctx && ctx.dir ? ctx.dir.clone().normalize() : new THREE.Vector3(0,0,1)); const sameFace = nW.dot(k) >= 0; const sgn = sameFace ? 1 : -1; return Rtheta(-sgn * phi).mulVec(j); }
  };
  mesh.userData.element = el; updateElementLabel(el); return el;
}

export function makeBeamSplitter({R=0.5, polarizing=false, polTransmit="Vertical"} = {}) {
  const mesh = makePanel(0.0036, 0.0036, matBS);
  const el = {
    id: ELEMENT_ID++, type:"beamSplitter", mesh, props:{ R, polarizing, polTransmit },
    abcd(q){ return q; }, jones(j){ return j; }
  };
  mesh.userData.element = el; updateElementLabel(el); return el;
}

export function makeBeamBlock() {
  const mesh = makePanel(0.0042, 0.0042, matBlock);
  const el = {
    id: ELEMENT_ID++, type:"beamBlock", mesh, props:{},
    abcd(q){ return q; }, jones(j){ return j; }
  };
  mesh.userData.element = el; updateElementLabel(el); return el;
}

export function makeGrating({mode="reflective", d_um=1.0, orders=3} = {}) {
  const mesh = makePanel(0.0042, 0.0042, matGrating);
  const el = {
    id: ELEMENT_ID++, type:"grating", mesh, props:{ mode, d_um, orders },
    abcd(q){ return q; }, jones(j){ return j; }
  };
  mesh.userData.element = el; updateElementLabel(el); return el;
}

export function makeMultimeter(){
  const mesh = makePanel(0.0034, 0.0034, matMeter);
  const el = {
    id: ELEMENT_ID++, type:"multimeter", mesh, props:{},
    abcd(q){ return q; }, jones(j){ return j; }
  };
  mesh.userData.element = el; updateElementLabel(el); return el;
}

export function updateElementLabel(el){
    const customLabel = el.props.label;
    const hasCustomLabel = customLabel != null && customLabel.trim() !== '';

    const defaultText =
        el.type === "lens" ? `Thin Lens f=${(el.props.f * 1000).toFixed(1)} mm` :
        el.type === "mirror" ? (
            el.props.dichroic ?
            (el.props.flat ? `Mirror (Dichroic)` : `Mirror (R=${(el.props.R * 1000).toFixed(1)} mm, Dichroic)`) :
            (el.props.flat ? `Mirror (flat, R=${Math.round((el.props.refl ?? 1) * 100)}%)` : `Mirror (R=${(el.props.R * 1000).toFixed(1)} mm, R=${Math.round((el.props.refl ?? 1) * 100)}%)`)
        ) :
        el.type === "polarizer" ? `Polarizer` :
        el.type === "waveplate" ? (el.props.type === 'Custom' ? `Waveplate (Δ=${THREE.MathUtils.radToDeg(el.props.delta || 0).toFixed(1)}°)`: `Waveplate (${el.props.type})`) :
        el.type === "beamSplitter" ? (el.props.polarizing ? `PBS (T=${el.props.polTransmit[0]})` : `Beam Splitter R=${Math.round(el.props.R * 100)}%`) :
        el.type === "beamBlock" ? `Beam Block` :
        el.type === "grating" ? `Grating (${el.props.mode === "reflective" ? "R" : "T"}, d=${(el.props.d_um).toFixed(3)}µm, ±${el.props.orders|0})` :
        el.type === "multimeter" ? `Detector` :
        el.type === "faraday" ? `Faraday (${el.props.phiDeg}°)` : "";

    const txt = hasCustomLabel ? customLabel : defaultText;

    let spr = el.mesh.children.find(c => c.isSprite);

    if (!spr && !txt) return;
    if (!spr) {
        spr = makeLabel(txt);
        el.mesh.add(spr);
    }
    
    if (!txt) {
        spr.visible = false;
        return;
    }
    spr.visible = true;

    // Create a new canvas to prevent drawing artifacts.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fs = 48;
    ctx.font = `Bold ${fs}px Arial`;
    
    const w = Math.max(1, ctx.measureText(txt).width + 20);
    const h = fs + 16;
    canvas.width = w;
    canvas.height = h;

    // Redraw everything on the new canvas.
    ctx.font = `Bold ${fs}px Arial`;
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, w / 2, h / 2);
    
    // Create a new texture from the new canvas.
    const newTexture = new THREE.CanvasTexture(canvas);
    newTexture.minFilter = THREE.LinearFilter;
    
    // Dispose of the old texture and apply the new one.
    spr.material.map?.dispose();
    spr.material.map = newTexture;
    spr.material.needsUpdate = true;

    // Reset the sprite's scale to match the new texture's aspect ratio.
    spr.scale.set(w / 40000, h / 40000, 1);
    
    // Invalidate the cached world scale so it gets recalculated correctly.
    delete spr.userData.desiredWorldScale;
}