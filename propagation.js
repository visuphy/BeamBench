/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// propagation.js - handles ray marching, Gaussian beam physics, and ribbon generation
import * as THREE from 'three';
import { Complex, jNorm } from './optics.js?v=1.0.15';
import { buildRibbon } from './ribbon.js?v=1.0.15';
import { buildTransverseBasis } from './beam-frame.js?v=1.0.15';
import * as pol from './polarization.js?v=1.0.15';

const POL_SPACING = 0.005;
const LAMBDA_KEY = "\u03bb";
const MAX_RAY_SEEDS = 800;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/* ========= Wavelength to Color Helper ========= */
function wavelengthNmToHex(nm){
  const min = 400, max = 800, span = max - min;
  if (!Number.isFinite(nm)) nm = 550;
  const lambdaNm = min + ((nm - min) % span + span) % span;
  let R=0, G=0, B=0;
  if (lambdaNm < 450) { R=(450-lambdaNm)/50; B=1; }
  else if (lambdaNm < 490) { G=(lambdaNm-450)/40; B=1; }
  else if (lambdaNm < 540) { G=1; B=(540-lambdaNm)/50; }
  else if (lambdaNm < 590) { R=(lambdaNm-540)/50; G=1; }
  else if (lambdaNm < 650) { R=1; G=(650-lambdaNm)/60; }
  else { R=1; }
  const g=v=>Math.pow(Math.max(0,v),0.8), b=x=>Math.round(g(x)*255);
  return (b(R)<<16)|(b(G)<<8)|b(B);
}

/* ========= Polarization Helpers ========= */
function jonesFrom(preset, exStr, eyStr){
  const parseC=(s)=>{
    const m=s.trim().match(/^([+\-]?\d*\.?\d+)([+\-]\d*\.?\d+)i$/i);
    if(m) return new Complex(parseFloat(m[1]), parseFloat(m[2]));
    const n=s.trim().match(/^([+\-]?\d*\.?\d+)$/); if(n) return new Complex(parseFloat(n[1]),0);
    return new Complex(1,0);
  };
  if(preset==="Linear X") return [new Complex(1,0), new Complex(0,0)];
  if(preset==="Linear Y") return [new Complex(0,0), new Complex(1,0)];
  if(preset==="+45Â°" || preset==="+45°"){ const a=1/Math.sqrt(2); return [new Complex(a,0), new Complex(a,0)]; }
  if(preset==="-45Â°" || preset==="-45°"){ const a=1/Math.sqrt(2); return [new Complex(a,0), new Complex(-a,0)]; }
  if(preset==="RHC"){ const a=1/Math.sqrt(2); return [new Complex(a,0), new Complex(0,-a)]; }
  if(preset==="LHC"){ const a=1/Math.sqrt(2); return [new Complex(a,0), new Complex(0,a)]; }
  return [parseC(exStr), parseC(eyStr)];
}

function polEllipseAngles(J){
  const a = J[0], b = J[1];
  const ax2 = a.re*a.re + a.im*a.im, ay2 = b.re*b.re + b.im*b.im;
  const re_abStar = a.re*b.re + a.im*b.im, im_abStar = -a.re*b.im + a.im*b.re;
  const S0 = ax2 + ay2, S1 = ax2 - ay2, S2 = 2 * re_abStar, S3 = 2 * im_abStar;
  return {
    psiDeg: 0.5 * Math.atan2(S2, S1) * 180/Math.PI,
    chiDeg: 0.5 * Math.asin(Math.max(-1, Math.min(1, S0 ? S3/S0 : 0))) * 180/Math.PI
  };
}

/* ========= Physics Helpers ========= */
function _elementWorldNormal(el){
  const worldQ = el.mesh.getWorldQuaternion(new THREE.Quaternion());
  return new THREE.Vector3(0,0,1).applyQuaternion(worldQ).normalize();
}

function reflectAcrossElementNormal(dirv, el){
  const nWorld = _elementWorldNormal(el);
  return dirv.clone().sub(nWorld.clone().multiplyScalar(2 * dirv.dot(nWorld))).normalize();
}
function _hitWorldNormal(hit, el){
  if (hit && hit.face && hit.object) {
    const n = hit.face.normal.clone();
    n.transformDirection(hit.object.matrixWorld).normalize();
    return n;
  }
  // Fallback: element's +z normal in world space
  return _elementWorldNormal(el);
}

function reflectAcrossHitNormal(dirv, hit, el){
  const nWorld = _hitWorldNormal(hit, el);
  const n = nWorld.clone();
  // Ensure normal points against incoming direction
  if (dirv.dot(n) > 0) n.multiplyScalar(-1);
  return dirv.clone().sub(n.multiplyScalar(2 * dirv.dot(n))).normalize();
}

function refractAcrossHitNormal(dirv, hit, n1, n2, el){
  const nWorld = _hitWorldNormal(hit, el);
  let n = nWorld.clone();
  // Normal should point against incoming ray
  if (dirv.dot(n) > 0) n.multiplyScalar(-1);

  const eta  = n1 / n2;
  const cosI = -dirv.dot(n);               // > 0 by construction
  const sin2T = eta * eta * (1 - cosI * cosI);

  if (sin2T > 1) {
    // Total internal reflection: return *reflected* direction and flag it.
    const reflDir = dirv.clone()
      .sub(n.multiplyScalar(2 * dirv.dot(n)))
      .normalize();
    return { dir: reflDir, tir: true };
  }

  const cosT = Math.sqrt(1 - sin2T);
  const dirOut = dirv.clone().multiplyScalar(eta)
    .add(n.multiplyScalar(eta * cosI - cosT))
    .normalize();

  return { dir: dirOut, tir: false };
}

function _reflectVectorAcrossNormal(vec, normal){
  return vec.clone().sub(normal.clone().multiplyScalar(2 * vec.dot(normal)));
}

function _cloneBasisUp(path){
  return path?.basisUp?.isVector3 ? path.basisUp.clone() : WORLD_UP.clone();
}

function _projectBasisUp(dir, basisUp){
  return buildTransverseBasis(dir, basisUp || WORLD_UP).u.clone();
}

function _jonesToWorldField(J, dir, basisUp){
  const { u, v } = buildTransverseBasis(dir, basisUp);
  return {
    real: new THREE.Vector3()
      .addScaledVector(v, J[0].re)
      .addScaledVector(u, J[1].re),
    imag: new THREE.Vector3()
      .addScaledVector(v, J[0].im)
      .addScaledVector(u, J[1].im)
  };
}

function _worldFieldToJones(field, dir, basisUp){
  const { u, v } = buildTransverseBasis(dir, basisUp);
  return [
    new Complex(field.real.dot(v), field.imag.dot(v)),
    new Complex(field.real.dot(u), field.imag.dot(u))
  ];
}

function _reflectJonesWithBasis(J, inDir, outDir, normal, amplitude=1, inBasisUp=null){
  const inBasis = buildTransverseBasis(inDir, inBasisUp || WORLD_UP);
  const field = _jonesToWorldField(J, inDir, inBasis.u);
  const outBasisUp = _reflectVectorAcrossNormal(inBasis.u, normal);
  const reflectedField = {
    real: _reflectVectorAcrossNormal(field.real, normal).multiplyScalar(-amplitude),
    imag: _reflectVectorAcrossNormal(field.imag, normal).multiplyScalar(-amplitude)
  };
  return {
    J: _worldFieldToJones(reflectedField, outDir, outBasisUp),
    basisUp: _projectBasisUp(outDir, outBasisUp)
  };
}


/**
 * Main propagation function.
 * @param {object} context - An object containing all necessary scene and state info.
 */
export function recompute(context) {
  const {
    sources, elements, params,
    beamGroup, polGroup, tcontrols,
    ribbonMeshes, gratingLastInfo, meterLastInfo, elementLastInfo,
    addSource, removeSourceByGroup, syncSourceW0ZR,
    clampToPlaneXZ, refreshAfterRecompute
  } = context;

  let _meterUpdated = false;
  elementLastInfo.clear();
  // clear old ribbons & pol markers
  ribbonMeshes.forEach(m => { beamGroup.remove(m); m.geometry.dispose(); m.material.dispose(); });
  ribbonMeshes.length = 0; // Clear the array in place
  pol.beginFrame(polGroup);

  // If no sources, add a temporary one
  const activeSources = sources.length ? sources : [addSource({ position:new THREE.Vector3(0.0, 0.0, -0.0004), yawRad:0 })];
  const removeImplicitAfter = sources.length===0 ? activeSources[0] : null;

  const meshes = [];
  for (const e of elements) {
    if ((e.type === "thickLens" || (e.type === "mirror" && !e.props.flat)) &&
        Array.isArray(e._surfaceMeshes) &&
        e._surfaceMeshes.length) {

      meshes.push(...e._surfaceMeshes);
    } else {
      meshes.push(e.mesh);
    }
  }


  const maxSteps = params.maxSegments;

  const completedPaths = [];
  const queue = [];

  const freeSpace = (qIn, L)=> {
    const Aq = qIn.clone().mul(new Complex(1,0));
    const num = Aq.add(L);
    const den = qIn.clone().mul(new Complex(0,0)).add(1);
    return num.div(den);
  };
  const wFromQ = (qval, wavelength, M2=1.0)=>{
    const inv = qval.inv();
    const denom = Math.abs(inv.im) * Math.PI || 1e-18;
    return Math.sqrt(M2) * Math.sqrt( wavelength / denom );
  };
  const getPathLambda = (p) => {
    const lambda = p?.[LAMBDA_KEY];
    return Number.isFinite(lambda) ? lambda : 532e-9;
  };
  const widthFor = (p, qOverride = null) => {
    if (p?.beamModel === "rays") {
      return Math.max(1e-9, Number(p.rayRadius_m) || 1e-6);
    }
    const q = qOverride || p.q;
    return wFromQ(q, getPathLambda(p), p.M2);
  };
  const computeBeamMetrics = (p) => {
    const aRel = jNorm(p.J) / p.Jnorm;
    const Irel = aRel * aRel;
    const polAngles = polEllipseAngles(p.J);

    if (p?.beamModel === "rays") {
      const w_um = widthFor(p) * 1e6;
      return {
        w_um,
        w0_um: w_um,
        R_mm: Infinity,
        Irel,
        psi_deg: polAngles.psiDeg,
        chi_deg: polAngles.chiDeg,
        z_to_waist_mm: Infinity,
        zR_mm: Infinity
      };
    }

    const invq = p.q.inv();
    const zR_m = p.q.im;
    const lambda = getPathLambda(p);
    const w_um = widthFor(p) * 1e6;
    const w0_um = Math.sqrt(zR_m * lambda * p.M2 / Math.PI) * 1e6;
    const R_mm = (Math.abs(invq.re) < 1e-12) ? Infinity : (1 / invq.re) * 1e3;
    return {
      w_um,
      w0_um,
      R_mm,
      Irel,
      psi_deg: polAngles.psiDeg,
      chi_deg: polAngles.chiDeg,
      z_to_waist_mm: p.q.re * 1e3,
      zR_mm: zR_m * 1e3
    };
  };
  const beamReadout = (p, metrics, extra = {}) => ({
    x_mm: p.pos.x * 1e3,
    y_mm: p.pos.y * 1e3,
    z_mm: p.pos.z * 1e3,
    w_um: metrics.w_um,
    w0_um: metrics.w0_um,
    R_mm: metrics.R_mm,
    psi_deg: metrics.psi_deg,
    chi_deg: metrics.chi_deg,
    z_to_waist_mm: metrics.z_to_waist_mm,
    zR_mm: metrics.zR_mm,
    outgoingDir: p.dir.clone(),
    basisUp: _projectBasisUp(p.dir, _cloneBasisUp(p)),
    jones: [p.J[0].clone(), p.J[1].clone()],
    ...extra
  });
  const buildRayOffsets = (apertureRadiusM, spacingM) => {
    const r = Math.max(0, Number(apertureRadiusM));
    const s = Math.max(1e-9, Number(spacingM));
    if (r <= 0) return [{ x: 0, y: 0 }];

    const out = [];
    for (let y = -r; y <= r + 1e-12; y += s) {
      for (let x = -r; x <= r + 1e-12; x += s) {
        if ((x * x + y * y) <= (r * r + 1e-15)) out.push({ x, y });
      }
    }
    if (!out.length) out.push({ x: 0, y: 0 });
    return out;
  };
  const capOffsets = (offsets, maxCount) => {
    if (offsets.length <= maxCount) return offsets;
    const n = Math.max(1, maxCount);
    const step = offsets.length / n;
    const out = [];
    for (let i = 0; i < n; i++) out.push(offsets[Math.floor(i * step)]);
    return out;
  };

  // Seed paths per source (forward & backward) â€” with broadband spectral sampling
  for (const s of activeSources) {
    clampToPlaneXZ(s.group);
    syncSourceW0ZR(s);

    const beamMode = (s.props.beamMode === "rays") ? "rays" : "gaussian";
    const lambda0 = Number(s.props.wavelength_nm) * 1e-9;
    const bandwidthNm = Math.max(0, Number(s.props.bandwidth_nm || 0));
    const intensityRel = Math.max(0, Number(s.props.intensity_rel ?? 1));
    const m2 = Math.max(1.0, Number(s.props.M2 ?? 1.0));
    const jSrc0 = jonesFrom(s.props.polPreset, s.props.customPolEx, s.props.customPolEy);
    const jNorm0 = Math.max(1e-12, jNorm(jSrc0));

    const originCenter = s.group.position.clone();
    const qSrc = s.group.getWorldQuaternion(new THREE.Quaternion());
    const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(qSrc).normalize();
    const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(qSrc).normalize();
    const dirF = new THREE.Vector3(0, 0, 1).applyQuaternion(qSrc).normalize();
    const dirB = dirF.clone().multiplyScalar(-1);

    // Build spectral samples
    let sampleCount = Math.max(1, Math.floor(Number(s.props.specSamples || 1)));
    if (bandwidthNm > 0 && (sampleCount % 2 === 0)) sampleCount += 1;
    const samples = [];
    if (bandwidthNm <= 0 || sampleCount === 1) {
      samples.push({ lambda: lambda0, weight: 1 });
    } else {
      const half = (sampleCount - 1) / 2;
      for (let i = 0; i < sampleCount; i++) {
        const frac = (i - half) / half;
        const dnm = frac * bandwidthNm * 0.5;
        const lambdaNm = (lambda0 * 1e9) + dnm;
        const lambda = Math.max(1e-12, lambdaNm * 1e-9);
        const w = Math.exp(-4 * Math.log(2) * Math.pow(dnm / bandwidthNm, 2));
        samples.push({ lambda, weight: w });
      }
      const sumW = samples.reduce((a, b) => a + b.weight, 0) || 1;
      samples.forEach(smp => smp.weight /= sumW);
    }

    const forwardLen = Math.max(0, Number(s.props.forward_cm) * 0.01);
    const backwardLen = Math.max(0, Number(s.props.backward_cm) * 0.01);
    const dirCount = (forwardLen > 0 ? 1 : 0) + (backwardLen > 0 ? 1 : 0);
    if (dirCount === 0) continue;

    if (beamMode === "rays") {
      const apertureRadiusM = Math.max(0, Number(s.props.rays_aperture_radius_mm ?? 1.0)) * 1e-3;
      const spacingM = Math.max(1, Number(s.props.rays_spacing_um ?? 600)) * 1e-6;
      const rayRadiusM = Math.max(1, Number(s.props.rays_radius_um ?? 50)) * 1e-6;

      let offsets = buildRayOffsets(apertureRadiusM, spacingM);
      const maxOffsets = Math.max(1, Math.floor(MAX_RAY_SEEDS / Math.max(1, dirCount * samples.length)));
      offsets = capOffsets(offsets, maxOffsets);
      const raysUsed = Math.max(1, offsets.length);

      const makeRaySeed = (rayOrigin, dir, maxLen, sample) => {
        const jScaled = [
          jSrc0[0].mul(Math.sqrt(sample.weight * intensityRel / raysUsed)),
          jSrc0[1].mul(Math.sqrt(sample.weight * intensityRel / raysUsed))
        ];
        const amp0 = jNorm(jScaled) / jNorm0;
        return {
          pos: rayOrigin.clone(),
          dir: dir.clone(),
          q: new Complex(0, 1e9), // placeholder q; rays mode keeps fixed radius
          J: [jScaled[0].clone(), jScaled[1].clone()],
          Jnorm: jNorm0,
          [LAMBDA_KEY]: sample.lambda,
          M2: m2,
          beamModel: "rays",
          rayRadius_m: rayRadiusM,
          traveled: 0,
          lastHit: null,
          maxLen,
          pts: [rayOrigin.clone()],
          dirs: [dir.clone()],
          widths: [rayRadiusM],
          amps: [amp0],
          polSamples: [],
          polSampleCountdown: POL_SPACING / 2.0,
          nMedium: 1.0,
          basisUp: axisY.clone(),
        };
      };

      for (const sample of samples) {
        for (const off of offsets) {
          const rayOrigin = originCenter.clone()
            .add(axisX.clone().multiplyScalar(off.x))
            .add(axisY.clone().multiplyScalar(off.y));
          if (forwardLen > 0) queue.push(makeRaySeed(rayOrigin, dirF, forwardLen, sample));
          if (backwardLen > 0) queue.push(makeRaySeed(rayOrigin, dirB, backwardLen, sample));
        }
      }
      continue;
    }

    const w0M = Math.max(1e-9, Number(s.props.waist_w0_um) * 1e-6);
    const zRCenterM = Math.max(1e-12, Number(s.props.rayleigh_mm) * 1e-3);
    const makeGaussianSeed = (dir, maxLen, sample) => {
      const zR = (s.lastEdited === 'w0') ? (Math.PI * w0M * w0M / sample.lambda) / m2 : zRCenterM;
      const q0 = new Complex(0, zR);
      const jScaled = [
        jSrc0[0].mul(Math.sqrt(sample.weight * intensityRel)),
        jSrc0[1].mul(Math.sqrt(sample.weight * intensityRel))
      ];
      const amp0 = jNorm(jScaled) / jNorm0;
      return {
        pos: originCenter.clone(),
        dir: dir.clone(),
        q: q0.clone(),
        J: [jScaled[0].clone(), jScaled[1].clone()],
        Jnorm: jNorm0,
        [LAMBDA_KEY]: sample.lambda,
        M2: m2,
        beamModel: "gaussian",
        rayRadius_m: 0,
        traveled: 0,
        lastHit: null,
        maxLen,
        pts: [originCenter.clone()],
        dirs: [dir.clone()],
        widths: [wFromQ(q0.clone(), sample.lambda, m2)],
        amps: [amp0],
        polSamples: [],
        polSampleCountdown: POL_SPACING / 2.0,
        nMedium: 1.0,
        basisUp: axisY.clone(),
      };
    };

    for (const sample of samples) {
      if (forwardLen > 0) queue.push(makeGaussianSeed(dirF, forwardLen, sample));
      if (backwardLen > 0) queue.push(makeGaussianSeed(dirB, backwardLen, sample));
    }
  }
const AMP_CUTOFF = 0.02;
  const MAX_BEAMS  = 600;

  // Grating orders using demo convention: sin(beta) = sin(alpha) - m * lambda / d
  function computeGratingOrders(el, inDir, lambda){
    const qW = el.mesh.getWorldQuaternion(new THREE.Quaternion());
    const n = new THREE.Vector3(0,0,1).applyQuaternion(qW).normalize(); // full normal
    let t  = new THREE.Vector3(1,0,0).applyQuaternion(qW);              // local +X
    t = t.sub(n.clone().multiplyScalar(t.dot(n))).normalize();          // Gramâ€“Schmidt into the grating plane
    const sinAlpha = THREE.MathUtils.clamp(inDir.dot(t), -1, 1);
    const cosAlpha = Math.abs(THREE.MathUtils.clamp(inDir.dot(n), -1, 1));
    const alpha = Math.atan2(sinAlpha, cosAlpha);
    const alphaDeg = THREE.MathUtils.radToDeg(alpha);

    const d = el.props.d_um * 1e-6;
    const M = Math.max(0, Math.floor(el.props.orders));
    const fromSide = Math.sign(inDir.dot(n)) || 1;

    const out = [];
    for(let m=-M; m<=M; m++){
      const sinBeta = sinAlpha - (m * lambda / d);
      if(Math.abs(sinBeta) > 1) continue;
      const cosBeta = Math.sqrt(Math.max(0, 1 - sinBeta*sinBeta));
      const beta = Math.atan2(sinBeta, cosBeta);
      const betaDeg = THREE.MathUtils.radToDeg(beta);
      const nComp = (el.props.mode === "reflective" ? -fromSide : fromSide) * cosBeta;
      const dirOut = n.clone().multiplyScalar(nComp).add( t.clone().multiplyScalar(sinBeta) ).normalize();
      const disp_deg_per_nm = (cosBeta > 1e-12) ? Math.abs(-m / (d * cosBeta)) * (180/Math.PI) * 1e-9 : Infinity;
      out.push({ m, dir: dirOut, betaDeg, disp_deg_per_nm });
    }
    gratingLastInfo.set(el.id, {
      alphaDeg,
      entries: out.map(o => ({ m:o.m, thetaDeg:o.betaDeg, disp_deg_per_nm:o.disp_deg_per_nm }))
    });
    return { orders: out };
  }

  while(queue.length && (completedPaths.length + queue.length) < MAX_BEAMS){
    const path = queue.shift();

    for(let step=0; step<maxSteps && path.traveled < path.maxLen; step++){
      const rc = new THREE.Raycaster(path.pos, path.dir, 1e-8, Math.max(1e-5, path.maxLen - path.traveled));
      const hits = rc.intersectObjects(meshes, false).filter(h => {
  // Only skip the *immediate* self-intersection at the same point
  if (!path.lastHit) return true;
  if (h.object !== path.lastHit) return true;
  return h.distance > 1e-7;  // tweak epsilon if needed
});

      // Split a free-space segment [0, L] at the waist if it sits inside
      const sampleSegment = (L)=>{
        // Uniformly sample polarization markers based on distance
        if (params.showPolarization) {
            path.polSampleCountdown -= L;
            while(path.polSampleCountdown <= 0){
                const sampleDistInSeg = L + path.polSampleCountdown;
                const p = path.pos.clone().add(path.dir.clone().multiplyScalar(sampleDistInSeg));
                const k_phase = (2 * Math.PI) / getPathLambda(path);
                const totalDist = path.traveled + sampleDistInSeg;
                const spatialPhase = k_phase * totalDist;
                path.polSamples.push({
                  p,
                  dir: path.dir.clone(),
                  basisUp: _cloneBasisUp(path),
                  j: [path.J[0].clone(), path.J[1].clone()],
                  phase: spatialPhase,
                  wavelength: getPathLambda(path)
                });
                path.polSampleCountdown += POL_SPACING;
            }
        }

        // q(z) = q0 + z in free space for Gaussian mode. Rays mode keeps fixed radius.
        const q0 = path.q;
        const cuts = [0, L];
        if (path.beamModel !== "rays") {
          const zWaist = -Number(q0.re);
          if (Number.isFinite(zWaist) && zWaist > 0 && zWaist < L){
            const eps = Math.max(L*1e-4, 1e-6);   // tiny guard to avoid a degenerate strip
            cuts.push(Math.max(0, zWaist - eps));
            cuts.push(zWaist);
            cuts.push(Math.min(L, zWaist + eps));
          }
        }
        cuts.sort((a,b)=>a-b);

        const aHere = jNorm(path.J) / path.Jnorm;

        for (let k=0; k<cuts.length-1; k++){
          const a = cuts[k], b = cuts[k+1];
          const subL = Math.max(0, b - a);
          if (subL <= 0) continue;

          const N = Math.min(160, Math.max(10, Math.floor(subL*50)));
          for (let i=1; i<=N; i++){
            const t = a + (i/N)*subL;               // distance from current path.pos
            const qHere = (path.beamModel === "rays") ? q0 : freeSpace(q0, t);
            const p = path.pos.clone().add(path.dir.clone().multiplyScalar(t));
            path.pts.push(p);
            path.dirs.push(path.dir.clone());
            path.widths.push(widthFor(path, qHere));
            path.amps.push(aHere);
          }
        }
      };


      if(!hits.length){
        const L = path.maxLen - path.traveled;
        sampleSegment(L);
        path.traveled += L;
        break;
      }

      const hit = hits[0];
      const L = hit.distance;

      // propagate to plane
      sampleSegment(L);
      path.traveled += L;
      path.pos = hit.point.clone();
      if (path.beamModel !== "rays") {
        path.q = freeSpace(path.q, L);
      }

      const el = hit.object.userData.element;

      // Calculate Angle of Incidence (AOI) for any element hit
      const qW_hit = el.mesh.getWorldQuaternion(new THREE.Quaternion());
      const nWorld_hit = new THREE.Vector3(0,0,1).applyQuaternion(qW_hit).normalize();
      const cosTheta = Math.abs(path.dir.dot(nWorld_hit));
      // Clamp to avoid Math.acos domain errors from floating point inaccuracies
      const aoi_deg_hit = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(cosTheta, 0, 1)));
      const incomingDir_hit = path.dir.clone();

      /* ---------- Beam Block ---------- */
      if(el.type === "beamBlock"){ break; }

      /* ---------- Beam Splitter / PBS ---------- */
      if(el.type === "beamSplitter"){
        const isPBS = !!el.props.polarizing;
        const wantTransmit = (el.props.polTransmit === "Vertical");

        const cloneBase = () => ({
          pos: path.pos.clone(), q: path.q.clone(), traveled: path.traveled, lastHit: null,
          maxLen: path.maxLen, [LAMBDA_KEY]: getPathLambda(path), Jnorm: path.Jnorm, M2: path.M2,
          beamModel: path.beamModel, rayRadius_m: path.rayRadius_m,
          pts: path.pts.slice(), dirs: path.dirs.slice(), widths: path.widths.slice(),
          amps: path.amps.slice(), polSamples: path.polSamples.slice(),
          polSampleCountdown: path.polSampleCountdown,
          nMedium: path.nMedium,
          basisUp: _cloneBasisUp(path)
        });

        const transmitted = cloneBase();
        transmitted.dir = path.dir.clone();
        transmitted.lastHit = hit.object; // Prevent back-face reflection
        if(isPBS){
          transmitted.J = wantTransmit ? [ new Complex(0,0), path.J[1].clone() ]
                                       : [ path.J[0].clone(), new Complex(0,0) ];
        } else {
          const R = Math.min(1, Math.max(0, el.props.R ?? 0.5));
          const T = 1 - R;
          transmitted.J = [ path.J[0].mul(Math.sqrt(T)), path.J[1].mul(Math.sqrt(T)) ];
        }
        transmitted.pts.push(transmitted.pos.clone());
        transmitted.dirs.push(transmitted.dir.clone());
        transmitted.widths.push(widthFor(transmitted));
        transmitted.amps.push( jNorm(transmitted.J) / transmitted.Jnorm );
        transmitted.pos.add(transmitted.dir.clone().multiplyScalar(1e-6));

        const reflected = cloneBase();
        reflected.dir = reflectAcrossElementNormal(path.dir, el);
        reflected.lastHit = hit.object;
        const reflectNormal = _elementWorldNormal(el);
        if(isPBS){
          const reflectedInputJ = wantTransmit ? [ path.J[0].clone(), new Complex(0,0) ]
                                               : [ new Complex(0,0), path.J[1].clone() ];
          const reflectedPol = _reflectJonesWithBasis(reflectedInputJ, path.dir, reflected.dir, reflectNormal, 1, _cloneBasisUp(path));
          reflected.J = reflectedPol.J;
          reflected.basisUp = reflectedPol.basisUp;
        } else {
          const R = Math.min(1, Math.max(0, el.props.R ?? 0.5));
          const reflectedPol = _reflectJonesWithBasis(path.J, path.dir, reflected.dir, reflectNormal, Math.sqrt(R), _cloneBasisUp(path));
          reflected.J = reflectedPol.J;
          reflected.basisUp = reflectedPol.basisUp;
        }
        reflected.pts.push(reflected.pos.clone());
        reflected.dirs.push(reflected.dir.clone());
        reflected.widths.push(widthFor(reflected));
        reflected.amps.push( jNorm(reflected.J) / reflected.Jnorm );
        reflected.pos.add(reflected.dir.clone().multiplyScalar(1e-6));

        // Record the stronger output branch for this splitter element
        try {
          const tI = Math.pow(jNorm(transmitted.J) / transmitted.Jnorm, 2);
          const rI = Math.pow(jNorm(reflected.J)   / reflected.Jnorm,   2);
          const best = (tI >= rI) ? transmitted : reflected;
          const metrics = computeBeamMetrics(best);
          elementLastInfo.set(el.id, beamReadout(best, metrics, {
            aoi_deg: aoi_deg_hit,
            incomingDir: incomingDir_hit,
            Irel: (tI >= rI) ? tI : rI,
          }));
        } catch(e) {}


        if((jNorm(transmitted.J) / transmitted.Jnorm) >= AMP_CUTOFF) queue.push(transmitted);
        if((jNorm(reflected.J)   / reflected.Jnorm)   >= AMP_CUTOFF) queue.push(reflected);
        break;
      }

      /* ---------- Unified Mirror (flat/spherical) with dichroic bands ---------- */
      if (el.type === "mirror") {
      const isCurvedMirror = !el.props.flat && Number.isFinite(el.props.R);
      const nMirror = el.props.n ?? 1.5;
      const nCurr = path.nMedium ?? 1.0;
      const isInsideMirror = isCurvedMirror && (Math.abs(nCurr - nMirror) < 1e-6);
      const surfaceKind = isCurvedMirror ? (hit.object?.userData?.surfaceKind || null) : 'front';
      const isFront = (surfaceKind === 'front');

      // NEW: side wall of a spherical mirror is purely opaque (absorbing)
      if (isCurvedMirror && surfaceKind === 'side') {
        // Do not reflect or transmit; just terminate this path.
        break;
      }

  // Base reflectance from slider
  let refl = Math.min(1, Math.max(0, el.props.refl ?? 1));
  let T = 1 - refl;

  // Dichroic behavior (still defined the same way)
  if (el.props.dichroic) {
    const nm = getPathLambda(path) * 1e9;
    const inBand = (nm, band) => Number.isFinite(nm) && band && nm >= band.min && nm <= band.max;
    if (inBand(nm, el.props.reflBand_nm))      { refl = 1; T = 0; }
    else if (inBand(nm, el.props.transBand_nm)){ refl = 0; T = 1; }
    else                                       { refl = 0; T = 1; } // outside bands -> transmit
  }

  // === Only the front **curved** surface uses refl slider ===
  if (isCurvedMirror) {
    // Back and side surfaces: 100% transmissive
    // Also: front surface hit from *inside* -> no coating, transmit only
    if (!isFront || isInsideMirror) {
      refl = 0;
      T = 1;
    }
  }
  // Flat mirrors keep their original behavior (they use panel normal & refl).

  const cloneBase = () => ({
    pos: path.pos.clone(), q: path.q.clone(), traveled: path.traveled, lastHit: null,
    maxLen: path.maxLen, [LAMBDA_KEY]: getPathLambda(path), Jnorm: path.Jnorm, M2: path.M2,
    beamModel: path.beamModel, rayRadius_m: path.rayRadius_m,
    pts: path.pts.slice(), dirs: path.dirs.slice(), widths: path.widths.slice(),
    amps: path.amps.slice(), polSamples: path.polSamples.slice(),
    polSampleCountdown: path.polSampleCountdown,
    nMedium: path.nMedium,
    basisUp: _cloneBasisUp(path)
  });

  let transmitted, reflected;

  // ===== Transmitted branch (Snell) =====
    if (T > 0) {
  transmitted = cloneBase();

  if (isCurvedMirror) {
    // Use Snell's law through the local spherical surface,
    // but handle total internal reflection when it occurs.
    const n2 = isInsideMirror ? 1.0 : nMirror; // inside->air or air->mirror
    const { dir: newDir, tir } = refractAcrossHitNormal(path.dir, hit, nCurr, n2, el);
    transmitted.dir = newDir;

    if (tir) {
      // TIR: stay in the same medium (inside the mirror substrate)
      transmitted.nMedium = nCurr;
      // No transmission ABCD here because there is no transmitted beam.
    } else {
      transmitted.nMedium = n2;

      // Gaussian-beam update at EACH physical surface, with proper n1/n2 and R sign
      if (path.beamModel !== "rays" && typeof el.abcdTransmit === "function") {
        transmitted.q = el.abcdTransmit(transmitted.q, {
          surfaceKind: surfaceKind,
          n1: nCurr,   // index on incident side of this surface
          n2: n2       // index on transmitted side
        });
      }
    }
  } else {
    // Flat mirror transmission: no refraction or focusing
    transmitted.dir = path.dir.clone();
    transmitted.nMedium = path.nMedium;
  }

  transmitted.basisUp = _projectBasisUp(transmitted.dir, transmitted.basisUp);
  transmitted.lastHit = hit.object;
  transmitted.J = [
    path.J[0].mul(Math.sqrt(T)),
    path.J[1].mul(Math.sqrt(T))
  ];
  transmitted.pts.push(transmitted.pos.clone());
  transmitted.dirs.push(transmitted.dir.clone());
    transmitted.widths.push(widthFor(transmitted));
    transmitted.amps.push( jNorm(transmitted.J) / transmitted.Jnorm );
    transmitted.pos.add(transmitted.dir.clone().multiplyScalar(1e-6));
    if ((jNorm(transmitted.J) / transmitted.Jnorm) >= AMP_CUTOFF) queue.push(transmitted);
  }


  // ===== Reflected branch =====
  if (refl > 0) {
    reflected = cloneBase();
    let reflectNormal;

    if (isCurvedMirror) {
      // Reflect around local surface normal
      reflectNormal = _hitWorldNormal(hit, el);
      reflected.dir = reflectAcrossHitNormal(path.dir, hit, el);
      reflected.nMedium = nCurr; // stay in same medium
    } else {
      // Flat mirror: keep old planar normal behavior
      reflectNormal = _elementWorldNormal(el);
      reflected.dir = reflectAcrossElementNormal(path.dir, el);
      reflected.nMedium = path.nMedium;
    }

    reflected.lastHit = hit.object;
    if (!el.props.flat && path.beamModel !== "rays") reflected.q = el.abcd(reflected.q);

    const reflectedPol = _reflectJonesWithBasis(path.J, path.dir, reflected.dir, reflectNormal, Math.sqrt(refl), _cloneBasisUp(path));
    reflected.J = reflectedPol.J;
    reflected.basisUp = reflectedPol.basisUp;
    reflected.pts.push(reflected.pos.clone());
    reflected.dirs.push(reflected.dir.clone());
    reflected.widths.push(widthFor(reflected));
    reflected.amps.push( jNorm(reflected.J) / reflected.Jnorm );
    reflected.pos.add(reflected.dir.clone().multiplyScalar(1e-6));
    if ((jNorm(reflected.J) / reflected.Jnorm) >= AMP_CUTOFF) queue.push(reflected);
  }

  // ===== Record strongest branch (unchanged logic) =====
  try {
    let best = null, bestI = -1;
    if (transmitted) {
      const It = Math.pow(jNorm(transmitted.J) / transmitted.Jnorm, 2);
      if (It > bestI) { best = transmitted; bestI = It; }
    }
    if (reflected) {
      const Ir = Math.pow(jNorm(reflected.J) / path.Jnorm, 2);
      if (Ir > bestI) { best = reflected; bestI = Ir; }
    }
    if (best) {
      const metrics = computeBeamMetrics(best);
      elementLastInfo.set(el.id, beamReadout(best, metrics, {
        aoi_deg: aoi_deg_hit,
        incomingDir: incomingDir_hit,
        Irel: bestI,
      }));
    }
  } catch (e) {}
  break;
}

      /* ---------- Thick Lens (transmissive; side absorbed) ---------- */
      if (el.type === "thickLens") {
        const surfaceKind = hit.object?.userData?.surfaceKind || "front";
        if (surfaceKind === "side") {
          break;
        }

        const nLensRaw = Number(el.props.n ?? 1.5);
        const nLens = (Number.isFinite(nLensRaw) && nLensRaw > 0) ? nLensRaw : 1.5;
        const nCurr = path.nMedium ?? 1.0;
        const isInsideLens = Math.abs(nCurr - nLens) < 1e-6;
        const n2 = isInsideLens ? 1.0 : nLens;

        const qW = el.mesh.getWorldQuaternion(new THREE.Quaternion());
        const lensPlusZ = new THREE.Vector3(0, 0, 1).applyQuaternion(qW).normalize();
        const dirSign = (path.dir.dot(lensPlusZ) >= 0) ? 1 : -1;

        const { dir: newDir, tir } = refractAcrossHitNormal(path.dir, hit, nCurr, n2, el);
        path.dir.copy(newDir);
        path.basisUp = _projectBasisUp(path.dir, _cloneBasisUp(path));

        if (!tir) {
          path.nMedium = n2;
          if (path.beamModel !== "rays" && typeof el.abcdTransmit === "function") {
            path.q = el.abcdTransmit(path.q, {
              surfaceKind: surfaceKind,
              n1: nCurr,
              n2: n2,
              dirSign: dirSign
            });
          }
        } else {
          path.nMedium = nCurr;
        }

        try {
          const metrics = computeBeamMetrics(path);
          elementLastInfo.set(el.id, beamReadout(path, metrics, {
            aoi_deg: aoi_deg_hit,
            incomingDir: incomingDir_hit,
            Irel: metrics.Irel,
          }));
        } catch (e) {}

        path.lastHit = hit.object;
        path.pts.push(path.pos.clone());
        path.dirs.push(path.dir.clone());
        path.widths.push(widthFor(path));
        path.amps.push(jNorm(path.J) / path.Jnorm);
        path.pos.add(path.dir.clone().multiplyScalar(1e-6));
        continue;
      }


      /* ---------- Diffraction grating ---------- */
      if (el.type === "grating") {
        const { orders } = computeGratingOrders(el, path.dir, getPathLambda(path));
        if (!orders.length) { break; }

        const isReflective = (el.props.mode === "reflective");
        const gain = 1 / Math.sqrt(orders.length);

        const cloneBase = () => ({
          pos: path.pos.clone(), q: path.q.clone(), traveled: path.traveled, lastHit: null,
          maxLen: path.maxLen, [LAMBDA_KEY]: getPathLambda(path), Jnorm: path.Jnorm, M2: path.M2,
          beamModel: path.beamModel, rayRadius_m: path.rayRadius_m,
          pts: path.pts.slice(), dirs: path.dirs.slice(), widths: path.widths.slice(),
          amps: path.amps.slice(), polSamples: path.polSamples.slice(),
          polSampleCountdown: path.polSampleCountdown,
          nMedium: path.nMedium,
          basisUp: _cloneBasisUp(path)
        });

        let _bestForThisGrating = null;
        for (const o of orders) {
          // If the visibility for this order is explicitly set to false, skip it.
          // If it's undefined, it defaults to visible.
          if (el.props.visibleOrders?.[o.m] === false) {
              continue;
          }
          const branch = cloneBase();
          branch.dir = o.dir.clone();
          branch.basisUp = _projectBasisUp(branch.dir, branch.basisUp);
          branch.lastHit = hit.object; // Prevent back-face reflection/transmission

          if (isReflective) {
            // Mirror-like polarization behavior on reflection:
            // Ex gets a - sign, Ey gets a + sign (same as your mirror block)
            const phase = 1;
            branch.J = [
              path.J[0].mul(gain * phase),
              path.J[1].mul(gain * (-1 * phase))
            ];
          } else {
            // Transmissive: pass Jones unchanged (just scale amplitude)
            branch.J = [
              path.J[0].mul(gain),
              path.J[1].mul(gain)
            ];
          }

          branch.pts.push(branch.pos.clone());
          branch.dirs.push(branch.dir.clone());
          branch.widths.push(widthFor(branch));
          branch.amps.push(jNorm(branch.J) / branch.Jnorm);
          branch.pos.add(branch.dir.clone().multiplyScalar(1e-6));

          // track strongest branch for element readout
          try {
            const I = Math.pow(jNorm(branch.J) / branch.Jnorm, 2);
            if(!_bestForThisGrating || I > _bestForThisGrating.Irel){
              const metrics = computeBeamMetrics(branch);
              _bestForThisGrating = beamReadout(branch, metrics, { Irel: I });
            }
          } catch(e) {}


          if ((jNorm(branch.J) / branch.Jnorm) >= AMP_CUTOFF) queue.push(branch);
        }
        try{
          if(_bestForThisGrating){
            const infoToSet = {
              ..._bestForThisGrating,
              aoi_deg: aoi_deg_hit,
              incomingDir: incomingDir_hit,
            };
            elementLastInfo.set(el.id, infoToSet);
          }
        } catch(e) {}
        break;
      }
      
      /* ---------- Multimeter (read-only; pass-through) ---------- */
      if(el.type === "multimeter"){
        const metrics = computeBeamMetrics(path);
        const lambdaNm = getPathLambda(path) * 1e9;

        meterLastInfo.set(el.id, beamReadout(path, metrics, {
          aoi_deg: aoi_deg_hit,
          incomingDir: incomingDir_hit,
          Irel: metrics.Irel,
          wavelength_nm: lambdaNm,
        }));
        _meterUpdated = true;
        // continue propagation straight through (no change to q or J)
        path.lastHit = hit.object;
        path.pts.push(path.pos.clone());
        path.dirs.push(path.dir.clone());
        path.widths.push(widthFor(path));
        path.amps.push( jNorm(path.J) / path.Jnorm );
        path.pos.add(path.dir.clone().multiplyScalar(1e-6));
        continue; // next step
      }
      
      /* ---------- Lens (thin): symmetric 2D angular kick + q-update ---------- */
      if (el.type === "lens") {
        // Update Gaussian envelope (keep your thin-lens ABCD)
        if (path.beamModel !== "rays") {
          path.q = el.abcd(path.q);
        }

        // World-space orthonormal frame tied to the lens: (u,v) in-plane, n = normal
        const qW = el.mesh.getWorldQuaternion(new THREE.Quaternion());
        const n  = new THREE.Vector3(0,0,1).applyQuaternion(qW).normalize();

        // Pick an in-plane "seed" that isn't parallel to n, then Gram-Schmidt it
        let uSeed = new THREE.Vector3(0,1,0);                       // prefer world +Y
        if (Math.abs(uSeed.dot(n)) > 0.999) uSeed.set(1,0,0);       // fallback if near-parallel
        const u = uSeed.clone().sub(n.clone().multiplyScalar(uSeed.dot(n))).normalize();
        const v = new THREE.Vector3().crossVectors(n, u).normalize(); // completes the triad

        // Signed in-plane hit coordinates (meters) from lens center
        const c  = el.mesh.getWorldPosition(new THREE.Vector3());
        const r  = path.pos.clone().sub(c);
        const ru = r.dot(u);
        const rv = r.dot(v);

        // Paraxial slopes referenced to |dirÂ·n|  (this is what fixes the side/yaw asymmetry)
        const denom = path.dir.dot(n);
        const denomAbs = Math.max(1e-6, Math.abs(denom));
        const sgn = (denom >= 0 ? 1 : -1);     // keeps the ray going the same physical way through the plate
        const su = path.dir.dot(u) / denomAbs;
        const sv = path.dir.dot(v) / denomAbs;

        // Thin-lens map: s' = s - x/f in BOTH in-plane directions
        const f = el.props.f || 1.0;           // meters; sign handles converging/diverging
        const su2 = su - (ru / f);
        const sv2 = sv - (rv / f);

        // Rebuild a unit direction; only the n-component gets the sign
        const newDir = n.clone().multiplyScalar(sgn)
          .add(u.clone().multiplyScalar(su2))
          .add(v.clone().multiplyScalar(sv2))
          .normalize();
        path.dir.copy(newDir);
        path.basisUp = _projectBasisUp(path.dir, _cloneBasisUp(path));

        
        // Record output beam state for lens
        try{
          const metrics = computeBeamMetrics(path);
          elementLastInfo.set(el.id, beamReadout(path, metrics, {
            aoi_deg: aoi_deg_hit,
            incomingDir: incomingDir_hit,
            Irel: metrics.Irel,
          }));
        } catch(e){}

        // Record + tiny step to avoid immediately re-hitting the same plane
        path.lastHit = hit.object;
        path.pts.push(path.pos.clone());
        path.dirs.push(path.dir.clone());
        path.widths.push(widthFor(path));
        path.amps.push(jNorm(path.J) / path.Jnorm);
        path.pos.add(path.dir.clone().multiplyScalar(1e-6));
        continue; // skip the generic block
      }


      /* ---------- Other elements ---------- */
      if (path.beamModel !== "rays") {
        path.q = el.abcd(path.q);
      }
      path.J = (el.jones ? el.jones(path.J, { dir: path.dir.clone(), basisUp: _cloneBasisUp(path) }) : path.J);

      // Record output beam state for this element
      try {
        const metrics = computeBeamMetrics(path);
        elementLastInfo.set(el.id, beamReadout(path, metrics, {
          aoi_deg: aoi_deg_hit,
          incomingDir: incomingDir_hit,
          Irel: metrics.Irel,
        }));
      } catch(e) {}

      path.lastHit = null;
      path.pts.push(path.pos.clone());
      path.dirs.push(path.dir.clone());
      path.widths.push(widthFor(path));
      path.amps.push( jNorm(path.J) / path.Jnorm );
    }

    completedPaths.push(path);
  }

  // Draw ribbons
  completedPaths.forEach(p=>{
    const nm = getPathLambda(p) * 1e9;
    const colorHex = wavelengthNmToHex(nm);
    const mesh = buildRibbon(p.pts, p.dirs, p.widths, p.amps, params.beamWidthScale, colorHex);
    if(mesh){ ribbonMeshes.push(mesh); beamGroup.add(mesh); }
    if(params.showPolarization){
      for (const s of p.polSamples){
        if (!pol.addMarker(polGroup, s.p, s.dir, s.j, { phase: s.phase, wavelength: s.wavelength, basisUp: s.basisUp })) break;
      }
    }
  });

  // If a meter got a fresh reading and it's selected, refresh its panel
  if (_meterUpdated && tcontrols.object && tcontrols.object.userData.element?.type === 'multimeter') {
    refreshAfterRecompute();
  }

  if(removeImplicitAfter){
    removeSourceByGroup(removeImplicitAfter.group);
    tcontrols.detach();
  }
}

