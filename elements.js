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

export function makeMirror({ flat = true, R = 2.0, refl = 1.0, n = 1.5, dichroic = false, reflBand_nm = { min: 400, max: 700 }, transBand_nm = { min: 700, max: 1100 } } = {}){
  const mesh = makePanel(0.004,0.004, matMirror);
  const el = {
    id: ELEMENT_ID++, type: "mirror", mesh, props: { flat, R, refl, n, dichroic, reflBand_nm, transBand_nm },
    abcd(q){ if(this.props.flat) return q; const C = -2/this.props.R, A=1, B=0, D=1; const Aq=q.clone().mul(new Complex(A,0)); const num=Aq.add(B); const Cq=q.clone().mul(new Complex(C,0)); const den=Cq.add(D); return num.div(den); },
    abcdTransmit(q){ if (this.props.flat) return q; const A=1, B=0, D=1; const C = -( (this.props.n ?? 1.5) - 1 ) / this.props.R; const Aq = q.clone().mul(new Complex(A,0)); const num = Aq.add(B); const Cq = q.clone().mul(new Complex(C,0)); const den = Cq.add(D); return num.div(den); },
    jones(j){ return j; }
  };
  mesh.userData.element = el; updateElementLabel(el); return el;
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