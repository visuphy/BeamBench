/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// propagation.js - handles ray marching, Gaussian beam physics, and ribbon generation
import * as THREE from 'three';
import { Complex, jNorm } from './optics.js';
import { buildRibbon } from './ribbon.js';
import * as pol from './polarization.js';

const POL_SPACING = 0.005;

/* ========= Wavelength to Color Helper ========= */
function wavelengthNmToHex(nm){
  const min = 400, max = 800, span = max - min;
  if (!Number.isFinite(nm)) nm = 550;
  const λ = min + ((nm - min) % span + span) % span;
  let R=0, G=0, B=0;
  if (λ < 450) { R=(450-λ)/50; B=1; }
  else if (λ < 490) { G=(λ-450)/40; B=1; }
  else if (λ < 540) { G=1; B=(540-λ)/50; }
  else if (λ < 590) { R=(λ-540)/50; G=1; }
  else if (λ < 650) { R=1; G=(650-λ)/60; }
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
  if(preset==="+45°"){ const a=1/Math.sqrt(2); return [new Complex(a,0), new Complex(a,0)]; }
  if(preset==="-45°"){ const a=1/Math.sqrt(2); return [new Complex(a,0), new Complex(-a,0)]; }
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
function reflectAcrossElementNormal(dirv, el){
  const worldQ = el.mesh.getWorldQuaternion(new THREE.Quaternion());
  const nWorld = new THREE.Vector3(0,0,1).applyQuaternion(worldQ).normalize();
  return dirv.clone().sub(nWorld.clone().multiplyScalar(2 * dirv.dot(nWorld))).normalize();
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

  const meshes = elements.map(e=>e.mesh);
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

  // Seed paths per source (forward & backward) — with broadband spectral sampling
  for(const s of activeSources){
    clampToPlaneXZ(s.group);
    syncSourceW0ZR(s);

    const λ0 = s.props.wavelength_nm * 1e-9;     // m
    const BW = Math.max(0, Number(s.props.bandwidth_nm || 0)); // nm (FWHM)
    const w0_m = Math.max(1e-9, s.props.waist_w0_um * 1e-6);   // m
    const zR_center = Math.max(1e-12, s.props.rayleigh_mm * 1e-3); // m

    const Jsrc0 = jonesFrom(s.props.polPreset, s.props.customPolEx, s.props.customPolEy);
    const Irel  = Math.max(0, Number(s.props.intensity_rel ?? 1));
    const J0 = Math.max(1e-12, jNorm(Jsrc0));
    const M2 = Math.max(1.0, s.props.M2 ?? 1.0);
    const origin = s.group.position.clone();
    const dirF = new THREE.Vector3(0,0,1).applyQuaternion(s.group.quaternion).normalize();
    const dirB = dirF.clone().multiplyScalar(-1);

    // Build spectral samples
    let N = Math.max(1, Math.floor(Number(s.props.specSamples || 1)));
    if (BW > 0 && (N % 2 === 0)) N += 1;
    const samples = [];
    if (BW <= 0 || N === 1){
      samples.push({ λ: λ0, weight: 1 });
    } else {
      const half = (N-1)/2;
      for(let i=0;i<N;i++){
        const frac = (i - half) / half;
        const dnm  = frac * BW * 0.5;
        const λnm  = (λ0 * 1e9) + dnm;
        const λ    = Math.max(1e-12, λnm * 1e-9);
        const w    = Math.exp(-4*Math.log(2) * Math.pow(dnm / BW, 2));
        samples.push({ λ, weight: w });
      }
      const sumW = samples.reduce((a,b)=>a+b.weight,0) || 1;
      samples.forEach(smp => smp.weight /= sumW);
    }

    const makeSeed = (dir, maxLen, λ, weight) => {
      const zR = (s.lastEdited === 'w0') ? (Math.PI * w0_m * w0_m / λ) / M2 : zR_center;
      const q0 = new Complex(0, zR);
      // Intensity scales |E|^2, so scale the Jones vector by sqrt(Irel)
      const Jscaled = [
        Jsrc0[0].mul(Math.sqrt(weight * Irel)),
        Jsrc0[1].mul(Math.sqrt(weight * Irel))
      ];
      const amp0 = jNorm(Jscaled) / J0;
      return {
        pos: origin.clone(),
        dir: dir.clone(),
        q: q0.clone(),
        J: [ Jscaled[0].clone(), Jscaled[1].clone() ],
        Jnorm: J0,
        λ,
        M2,
        traveled: 0,
        lastHit: null,
        maxLen,
        pts: [ origin.clone() ],
        dirs: [ dir.clone() ],
        widths: [ wFromQ(q0.clone(), λ, M2) ],
        amps: [ amp0 ],
        polSamples: [],
        polSampleCountdown: POL_SPACING / 2.0, // Start sampling partway through the first interval
      };
    };

    const Lf = Math.max(0, s.props.forward_cm  * 0.01);
    const Lb = Math.max(0, s.props.backward_cm * 0.01);
    for(const smp of samples){
      if(Lf>0) queue.push(makeSeed(dirF, Lf, smp.λ, smp.weight));
      if(Lb>0) queue.push(makeSeed(dirB, Lb, smp.λ, smp.weight));
    }
  }

  const AMP_CUTOFF = 0.02;
  const MAX_BEAMS  = 600;

  // Grating orders using demo convention: sinβ = sinα − m λ / d
  function computeGratingOrders(el, inDir, λ){
    const qW = el.mesh.getWorldQuaternion(new THREE.Quaternion());
    const n = new THREE.Vector3(0,0,1).applyQuaternion(qW).normalize(); // full normal
    let t  = new THREE.Vector3(1,0,0).applyQuaternion(qW);              // local +X
    t = t.sub(n.clone().multiplyScalar(t.dot(n))).normalize();          // Gram–Schmidt into the grating plane
    const sinAlpha = THREE.MathUtils.clamp(inDir.dot(t), -1, 1);
    const cosAlpha = Math.abs(THREE.MathUtils.clamp(inDir.dot(n), -1, 1));
    const alpha = Math.atan2(sinAlpha, cosAlpha);
    const alphaDeg = THREE.MathUtils.radToDeg(alpha);

    const d = el.props.d_um * 1e-6;
    const M = Math.max(0, Math.floor(el.props.orders));
    const fromSide = Math.sign(inDir.dot(n)) || 1;

    const out = [];
    for(let m=-M; m<=M; m++){
      const sinBeta = sinAlpha - (m * λ / d);
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
      const hits = rc.intersectObjects(meshes, false).filter(h => h.object !== path.lastHit);

      // Split a free-space segment [0, L] at the waist if it sits inside
      const sampleSegment = (L)=>{
        // Uniformly sample polarization markers based on distance
        if (params.showPolarization) {
            path.polSampleCountdown -= L;
            while(path.polSampleCountdown <= 0){
                const sampleDistInSeg = L + path.polSampleCountdown;
                const p = path.pos.clone().add(path.dir.clone().multiplyScalar(sampleDistInSeg));
                const k_phase = (2 * Math.PI) / path.λ;
                const totalDist = path.traveled + sampleDistInSeg;
                const spatialPhase = k_phase * totalDist;
                path.polSamples.push({ p, dir: path.dir.clone(), j: [path.J[0].clone(), path.J[1].clone()], phase: spatialPhase, wavelength: path.λ });
                path.polSampleCountdown += POL_SPACING;
            }
        }

        // q(z) = q0 + z in free space, so Re(q)=0 ⇒ z = −Re(q0)
        const q0 = path.q;
        const cuts = [0, L];
        const zWaist = -Number(q0.re);
        if (Number.isFinite(zWaist) && zWaist > 0 && zWaist < L){
          const eps = Math.max(L*1e-4, 1e-6);   // tiny guard to avoid a degenerate strip
          cuts.push(Math.max(0, zWaist - eps));
          cuts.push(zWaist);
          cuts.push(Math.min(L, zWaist + eps));
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
            const qHere = freeSpace(q0, t);
            const p = path.pos.clone().add(path.dir.clone().multiplyScalar(t));
            path.pts.push(p);
            path.dirs.push(path.dir.clone());
            path.widths.push(wFromQ(qHere, path.λ, path.M2));
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
      path.q = freeSpace(path.q, L);

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
          maxLen: path.maxLen, λ: path.λ, Jnorm: path.Jnorm, M2: path.M2,
          pts: path.pts.slice(), dirs: path.dirs.slice(), widths: path.widths.slice(),
          amps: path.amps.slice(), polSamples: path.polSamples.slice(),
          polSampleCountdown: path.polSampleCountdown
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
        transmitted.widths.push( wFromQ(transmitted.q, transmitted.λ, transmitted.M2) );
        transmitted.amps.push( jNorm(transmitted.J) / transmitted.Jnorm );
        transmitted.pos.add(transmitted.dir.clone().multiplyScalar(1e-6));

        const reflected = cloneBase();
        reflected.dir = reflectAcrossElementNormal(path.dir, el);
        reflected.lastHit = hit.object;
        if(isPBS){
          reflected.J = wantTransmit ? [ path.J[0].clone(), new Complex(0,0) ]
                                     : [ new Complex(0,0), path.J[1].clone() ];
        } else {
          const R = Math.min(1, Math.max(0, el.props.R ?? 0.5));
          const phase = 1;
          reflected.J = [ path.J[0].mul(Math.sqrt(R)*phase), path.J[1].mul(Math.sqrt(R)*(-1*phase)) ];
        }
        reflected.pts.push(reflected.pos.clone());
        reflected.dirs.push(reflected.dir.clone());
        reflected.widths.push( wFromQ(reflected.q, reflected.λ, reflected.M2) );
        reflected.amps.push( jNorm(reflected.J) / reflected.Jnorm );
        reflected.pos.add(reflected.dir.clone().multiplyScalar(1e-6));

        // Record the stronger output branch for this splitter element
        try {
          const tI = Math.pow(jNorm(transmitted.J) / transmitted.Jnorm, 2);
          const rI = Math.pow(jNorm(reflected.J)   / reflected.Jnorm,   2);
          const best = (tI >= rI) ? transmitted : reflected;
          const invq = best.q.inv();
          const w_um = wFromQ(best.q, best.λ, best.M2) * 1e6;
          const zR_m = best.q.im;
          const w0_um = Math.sqrt(zR_m * best.λ * best.M2 / Math.PI) * 1e6;
          const R_mm = (Math.abs(invq.re) < 1e-12) ? Infinity : (1 / invq.re) * 1e3;
          const polAngles = polEllipseAngles(best.J);
          elementLastInfo.set(el.id, {
            aoi_deg: aoi_deg_hit,
            incomingDir: incomingDir_hit,
            x_mm: best.pos.x * 1e3,
            z_mm: best.pos.z * 1e3,
            w_um,
            w0_um,
            R_mm,
            Irel: (tI >= rI) ? tI : rI,
            psi_deg: polAngles.psiDeg,
            chi_deg: polAngles.chiDeg,
            z_to_waist_mm: best.q.re * 1e3,
            zR_mm: zR_m * 1e3
          });
        } catch(e) {}


        if((jNorm(transmitted.J) / transmitted.Jnorm) >= AMP_CUTOFF) queue.push(transmitted);
        if((jNorm(reflected.J)   / reflected.Jnorm)   >= AMP_CUTOFF) queue.push(reflected);
        break;
      }

      /* ---------- Unified Mirror (flat/spherical) with dichroic bands ---------- */
      if(el.type==="mirror"){
        let refl = Math.min(1, Math.max(0, el.props.refl ?? 1));
        let T = 1 - refl;

        if (el.props.dichroic) {
          const nm = path.λ * 1e9;
          const inBand = (nm, band) => Number.isFinite(nm) && band && nm >= band.min && nm <= band.max;
          if (inBand(nm, el.props.reflBand_nm)) { refl = 1; T = 0; }
          else if (inBand(nm, el.props.transBand_nm)) { refl = 0; T = 1; }
          else { refl = 0; T = 1; } // outside bands -> transmit
        }

        const cloneBase = () => ({
          pos: path.pos.clone(), q: path.q.clone(), traveled: path.traveled, lastHit: null,
          maxLen: path.maxLen, λ: path.λ, Jnorm: path.Jnorm, M2: path.M2,
          pts: path.pts.slice(), dirs: path.dirs.slice(), widths: path.widths.slice(),
          amps: path.amps.slice(), polSamples: path.polSamples.slice(),
          polSampleCountdown: path.polSampleCountdown
        });

        let transmitted, reflected;

        if(T > 0){
          transmitted = cloneBase();
          transmitted.dir = path.dir.clone();
          transmitted.lastHit = hit.object; // Prevent back-face reflection
          transmitted.J = [ path.J[0].mul(Math.sqrt(T)), path.J[1].mul(Math.sqrt(T)) ];
          // Add weak focusing in transmission if the mirror is spherical
          if (!el.props.flat && typeof el.abcdTransmit === 'function') {
            transmitted.q = el.abcdTransmit(transmitted.q);
          }
          transmitted.pts.push(transmitted.pos.clone());
          transmitted.dirs.push(transmitted.dir.clone());
          transmitted.widths.push( wFromQ(transmitted.q, transmitted.λ, transmitted.M2) );
          transmitted.amps.push( jNorm(transmitted.J) / transmitted.Jnorm );
          transmitted.pos.add(transmitted.dir.clone().multiplyScalar(1e-6));
          if((jNorm(transmitted.J)/transmitted.Jnorm) >= AMP_CUTOFF) queue.push(transmitted);
        }

        if(refl > 0){
          reflected = cloneBase();
          reflected.dir = reflectAcrossElementNormal(path.dir, el);
          reflected.lastHit = hit.object;
          if(!el.props.flat) reflected.q = el.abcd(reflected.q);
          const phase = 1;
          reflected.J = [ path.J[0].mul(Math.sqrt(refl)*phase), path.J[1].mul(Math.sqrt(refl)*(-1*phase)) ];
          reflected.pts.push(reflected.pos.clone());
          reflected.dirs.push(reflected.dir.clone());
          reflected.widths.push( wFromQ(reflected.q, reflected.λ, reflected.M2) );
          reflected.amps.push( jNorm(reflected.J) / reflected.Jnorm );
          reflected.pos.add(reflected.dir.clone().multiplyScalar(1e-6));
          if((jNorm(reflected.J)/reflected.Jnorm) >= AMP_CUTOFF) queue.push(reflected);
        }

        // Record strongest branch for mirror (reflect or transmit)
        try{
          let best = null, bestI = -1;
          if(transmitted){
            const It = Math.pow(jNorm(transmitted.J) / transmitted.Jnorm, 2);
            if(It > bestI){ best = transmitted; bestI = It; }
          }
          if(reflected){
            const Ir = Math.pow(jNorm(reflected.J) / path.Jnorm, 2);
            if(Ir > bestI){ best = reflected; bestI = Ir; }
          }
          if(best){
            const invq = best.q.inv();
            const w_um = wFromQ(best.q, best.λ, best.M2) * 1e6;
            const zR_m = best.q.im;
            const w0_um = Math.sqrt(zR_m * best.λ * best.M2 / Math.PI) * 1e6;
            const R_mm = (Math.abs(invq.re) < 1e-12) ? Infinity : (1 / invq.re) * 1e3;
            const polAngles = polEllipseAngles(best.J);
            elementLastInfo.set(el.id, {
              aoi_deg: aoi_deg_hit,
              incomingDir: incomingDir_hit,
              x_mm: best.pos.x * 1e3,
              z_mm: best.pos.z * 1e3,
              w_um,
              w0_um,
              R_mm,
              Irel: bestI,
              psi_deg: polAngles.psiDeg,
              chi_deg: polAngles.chiDeg,
              z_to_waist_mm: best.q.re * 1e3,
              zR_mm: zR_m * 1e3
            });
          }
        } catch(e){}
        break;
      }

      /* ---------- Diffraction grating ---------- */
      if (el.type === "grating") {
        const { orders } = computeGratingOrders(el, path.dir, path.λ);
        if (!orders.length) { break; }

        const isReflective = (el.props.mode === "reflective");
        const gain = 1 / Math.sqrt(orders.length);

        const cloneBase = () => ({
          pos: path.pos.clone(), q: path.q.clone(), traveled: path.traveled, lastHit: null,
          maxLen: path.maxLen, λ: path.λ, Jnorm: path.Jnorm, M2: path.M2,
          pts: path.pts.slice(), dirs: path.dirs.slice(), widths: path.widths.slice(),
          amps: path.amps.slice(), polSamples: path.polSamples.slice(),
          polSampleCountdown: path.polSampleCountdown
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
          branch.widths.push(wFromQ(branch.q, branch.λ, branch.M2));
          branch.amps.push(jNorm(branch.J) / branch.Jnorm);
          branch.pos.add(branch.dir.clone().multiplyScalar(1e-6));

          // track strongest branch for element readout
          try {
            const I = Math.pow(jNorm(branch.J) / branch.Jnorm, 2);
            if(!_bestForThisGrating || I > _bestForThisGrating.I){
              const invq = branch.q.inv();
              const zR_m = branch.q.im;
              const w0_um = Math.sqrt(zR_m * branch.λ * branch.M2 / Math.PI) * 1e6;
              _bestForThisGrating = {
                I,
                x_mm: branch.pos.x * 1e3,
                z_mm: branch.pos.z * 1e3,
                w_um: wFromQ(branch.q, branch.λ, branch.M2) * 1e6,
                w0_um,
                R_mm: (Math.abs(invq.re) < 1e-12) ? Infinity : (1 / invq.re) * 1e3,
                psi_deg: polEllipseAngles(branch.J).psiDeg,
                chi_deg: polEllipseAngles(branch.J).chiDeg,
                z_to_waist_mm: branch.q.re * 1e3,
                zR_mm: zR_m * 1e3
              };
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
        const invq = path.q.inv();
        const w_m  = wFromQ(path.q, path.λ, path.M2);
        const w_um = w_m * 1e6;
        const zR_m = path.q.im;
        const w0_um = Math.sqrt(zR_m * path.λ * path.M2 / Math.PI) * 1e6;
        const R_mm = (Math.abs(invq.re) < 1e-12) ? Infinity : (1 / invq.re) * 1e3; // m -> mm
        const aRel = jNorm(path.J) / path.Jnorm;
        const Irel = aRel * aRel;
        const polAngles = polEllipseAngles(path.J);
        const λnm = path.λ * 1e9;

        meterLastInfo.set(el.id, {
          aoi_deg: aoi_deg_hit,
          incomingDir: incomingDir_hit,
          x_mm: path.pos.x * 1e3,
          z_mm: path.pos.z * 1e3,
          w_um,
          w0_um,
          R_mm,
          Irel,
          psi_deg: polAngles.psiDeg,
          chi_deg: polAngles.chiDeg,
          wavelength_nm: λnm,
          z_to_waist_mm: path.q.re * 1e3,
          zR_mm: zR_m * 1e3
        });
        _meterUpdated = true;
        // continue propagation straight through (no change to q or J)
        path.lastHit = hit.object;
        path.pts.push(path.pos.clone());
        path.dirs.push(path.dir.clone());
        path.widths.push( wFromQ(path.q, path.λ, path.M2) );
        path.amps.push( jNorm(path.J) / path.Jnorm );
        path.pos.add(path.dir.clone().multiplyScalar(1e-6));
        continue; // next step
      }
      
      /* ---------- Lens (thin): symmetric 2D angular kick + q-update ---------- */
      if (el.type === "lens") {
        // Update Gaussian envelope (keep your thin-lens ABCD)
        path.q = el.abcd(path.q);

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

        // Paraxial slopes referenced to |dir·n|  (this is what fixes the side/yaw asymmetry)
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

        
        // Record output beam state for lens
        try{
          const invq = path.q.inv();
          const w_um = wFromQ(path.q, path.λ, path.M2) * 1e6;
          const zR_m = path.q.im;
          const w0_um = Math.sqrt(zR_m * path.λ * path.M2 / Math.PI) * 1e6;
          const R_mm = (Math.abs(invq.re) < 1e-12) ? Infinity : (1 / invq.re) * 1e3;
          const aRel = jNorm(path.J) / path.Jnorm;
          const Irel = aRel * aRel;
          const polAngles = polEllipseAngles(path.J);
          elementLastInfo.set(el.id, {
            aoi_deg: aoi_deg_hit,
            incomingDir: incomingDir_hit,
            x_mm: path.pos.x * 1e3,
            z_mm: path.pos.z * 1e3,
            w_um,
            w0_um,
            R_mm,
            Irel,
            psi_deg: polAngles.psiDeg,
            chi_deg: polAngles.chiDeg,
            z_to_waist_mm: path.q.re * 1e3,
            zR_mm: zR_m * 1e3
          });
        } catch(e){}

        // Record + tiny step to avoid immediately re-hitting the same plane
        path.lastHit = hit.object;
        path.pts.push(path.pos.clone());
        path.dirs.push(path.dir.clone());
        path.widths.push(wFromQ(path.q, path.λ, path.M2));
        path.amps.push(jNorm(path.J) / path.Jnorm);
        path.pos.add(path.dir.clone().multiplyScalar(1e-6));
        continue; // skip the generic block
      }


      /* ---------- Other elements ---------- */
      path.q = el.abcd(path.q);
      path.J = (el.jones ? el.jones(path.J, {dir:path.dir.clone()}) : path.J);

      // Record output beam state for this element
      try {
        const invq = path.q.inv();
        const w_um = wFromQ(path.q, path.λ, path.M2) * 1e6;
        const zR_m = path.q.im;
        const w0_um = Math.sqrt(zR_m * path.λ * path.M2 / Math.PI) * 1e6;
        const R_mm = (Math.abs(invq.re) < 1e-12) ? Infinity : (1 / invq.re) * 1e3;
        const aRel = jNorm(path.J) / path.Jnorm;
        const Irel = aRel * aRel;
        const polAngles = polEllipseAngles(path.J);
        elementLastInfo.set(el.id, {
          aoi_deg: aoi_deg_hit,
          incomingDir: incomingDir_hit,
          x_mm: path.pos.x * 1e3,
          z_mm: path.pos.z * 1e3,
          w_um,
          w0_um,
          R_mm,
          Irel,
          psi_deg: polAngles.psiDeg,
          chi_deg: polAngles.chiDeg,
          z_to_waist_mm: path.q.re * 1e3,
          zR_mm: zR_m * 1e3
        });
      } catch(e) {}

      path.lastHit = null;
      path.pts.push(path.pos.clone());
      path.dirs.push(path.dir.clone());
      path.widths.push( wFromQ(path.q, path.λ, path.M2) );
      path.amps.push( jNorm(path.J) / path.Jnorm );
    }

    completedPaths.push(path);
  }

  // Draw ribbons
  completedPaths.forEach(p=>{
    const nm = p.λ * 1e9;
    const colorHex = wavelengthNmToHex(nm);
    const mesh = buildRibbon(p.pts, p.dirs, p.widths, p.amps, params.beamWidthScale, colorHex);
    if(mesh){ ribbonMeshes.push(mesh); beamGroup.add(mesh); }
    if(params.showPolarization){
      for (const s of p.polSamples){
        if (!pol.addMarker(polGroup, s.p, s.dir, s.j, { phase: s.phase, wavelength: s.wavelength })) break;
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