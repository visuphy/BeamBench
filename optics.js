/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// optics.js — math + Jones/ABCD utilities
export class Complex{
  constructor(re=0, im=0){ this.re=re; this.im=im; }
  static from(x){ return x instanceof Complex ? x : new Complex(x,0); }
  clone(){ return new Complex(this.re, this.im); }
  add(b){ b=Complex.from(b); return new Complex(this.re+b.re, this.im+b.im); }
  mul(b){ b=Complex.from(b); return new Complex(this.re*b.re - this.im*b.im, this.re*b.im + this.im*b.re); }
  div(b){ b=Complex.from(b); const d=b.re*b.re + b.im*b.im || 1e-18; return new Complex((this.re*b.re + this.im*b.im)/d, (this.im*b.re - this.re*b.im)/d); }
  inv(){ const d=this.re*this.re + this.im*this.im || 1e-18; return new Complex(this.re/d, -this.im/d); }
  static expi(th){ return new Complex(Math.cos(th), Math.sin(th)); }
  get im(){ return this._im ?? this.__proto__._im ?? 0; } // dummy to silence linters if any tooling inspects
  set im(v){ this._im = v; }
}

export class C2{
  constructor(a,b,c,d){ this.a=a; this.b=b; this.c=c; this.d=d; }
  mul(m){
    return new C2(
      this.a.mul(m.a).add(this.b.mul(m.c)),
      this.a.mul(m.b).add(this.b.mul(m.d)),
      this.c.mul(m.a).add(this.d.mul(m.c)),
      this.c.mul(m.b).add(this.d.mul(m.d))
    );
  }
  mulVec(v){ return [ this.a.mul(v[0]).add(this.b.mul(v[1])), this.c.mul(v[0]).add(this.d.mul(v[1])) ]; }
}

// Jones helpers
export function Rtheta(th){
  const c = new Complex(Math.cos(th),0), s = new Complex(Math.sin(th),0);
  return new C2(c, s, new Complex(-s.re,-s.im), c);
}
export function MWaveplate(delta){ return new C2(new Complex(1,0), new Complex(0,0), new Complex(0,0), Complex.expi(delta)); }
export const MPol = new C2(new Complex(1,0), new Complex(0,0), new Complex(0,0), new Complex(0,0));
export function MFaraday(phi){ return Rtheta(phi); } // rotation in beam basis

// ABCD for q
export function abcd(q, A,B,C,D){
  const Aq = Complex.from(A).mul(q);
  const num = Aq.add(B);
  const Cq = Complex.from(C).mul(q);
  const den = Cq.add(D);
  return num.div(den);
}

// norm of Jones vector
export function jNorm(J){
  const s0 = J[0].re*J[0].re + J[0].im*J[0].im;
  const s1 = J[1].re*J[1].re + J[1].im*J[1].im;
  return Math.sqrt(s0 + s1);
}
