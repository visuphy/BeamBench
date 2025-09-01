/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ribbon.js — gaussian beam ribbon mesh
import * as THREE from 'three';

// Build a colored, cylindrical ribbon from centerline samples
export function buildRibbon(points, dirs, widths, amps, beamWidthScale=120, baseColor=0x58a6ff, radialSegments=16){
  if(points.length<2) return null;

  const scale = beamWidthScale;
  
  // Pre-calculate all the circular cross-section vertices (rings)
  const rings = [];
  for(let i=0; i<points.length; i++){
    const currentRing = [];
    const p = points[i];
    const d = dirs[i].clone().normalize();
    const radius = Math.max(1e-6, widths[i]) * scale;

    // Create a stable orthonormal basis (local coordinate system)
    // u is the "right" vector, kept on the XZ plane for stability.
    const u = new THREE.Vector3(-d.z, 0, d.x).normalize();
    // v is the "up" vector, orthogonal to both direction and u.
    const v = d.clone().cross(u).normalize();

    // Generate vertices for the circular ring
    for(let j=0; j<radialSegments; j++){
      const angle = (j / radialSegments) * 2 * Math.PI;
      const cosAngle = Math.cos(angle);
      const sinAngle = Math.sin(angle);

      const offset = u.clone().multiplyScalar(cosAngle).add(v.clone().multiplyScalar(sinAngle));
      const vertex = p.clone().add(offset.multiplyScalar(radius));
      currentRing.push(vertex);
    }
    rings.push(currentRing);
  }


  const base = new THREE.Color(baseColor);
  const verts = [], cols = [];
  const pushTri = (pA, pB, pC, aA, aB, aC) => {
    verts.push(pA.x,pA.y,pA.z, pB.x,pB.y,pB.z, pC.x,pC.y,pC.z);
    // Gaussian falloff for color brightness
    const b = a => 0.06 + 0.94*(a*a);
    const bA=b(aA), bB=b(aB), bC=b(aC);
    cols.push(base.r*bA, base.g*bA, base.b*bA,
              base.r*bB, base.g*bB, base.b*bB,
              base.r*bC, base.g*bC, base.b*bC);
  };

  // Build the cylindrical mesh by connecting the rings
  for(let i=0; i<points.length-1; i++){
    const ring0 = rings[i];
    const ring1 = rings[i+1];
    const amp0 = amps[i];
    const amp1 = amps[i+1];

    for(let j=0; j<radialSegments; j++){
      // Get the 4 vertices that form the quad face on the cylinder's side
      const p0 = ring0[j];
      const p1 = ring0[(j + 1) % radialSegments]; // Wrap around for the last segment
      const p2 = ring1[j];
      const p3 = ring1[(j + 1) % radialSegments];

      // Create two triangles for the quad face, ensuring correct winding order
      // so the normals point outwards.
      pushTri(p0, p1, p2, amp0, amp0, amp1);
      pushTri(p1, p3, p2, amp0, amp1, amp1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts,3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(cols,3));
  geo.computeVertexNormals();

  return new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors:true, transparent:true, opacity:0.9, side:THREE.FrontSide })
  );
}