/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// sources.js — Manages Gaussian-beam emitters (creation, state, W₀↔zᵣ sync, GUI)
import * as THREE from 'three';

// Module-level context, initialized from main.js
let scene, selectable, tcontrols;
let doRecompute, refreshAfterRecompute, State;

// Internal state
const sources = [];
let sourceCounter = 0;

/**
 * Initializes the module with context from main.js.
 * @param {object} context - An object containing shared scene, state, and functions.
 */
function init(context) {
    scene = context.scene;
    selectable = context.selectable;
    tcontrols = context.tcontrols;
    doRecompute = context.doRecompute;
    refreshAfterRecompute = context.refreshAfterRecompute;
    State = context.State;
}

/**
 * Creates a new source, adds it to the scene, and returns it.
 * @param {object} [options={}] - Optional parameters for the new source.
 * @param {THREE.Vector3} [options.position=new THREE.Vector3(0,0,-0.04)] - Initial position.
 * @param {number} [options.yawRad=0] - Initial yaw rotation in radians.
 * @returns {object} The newly created source object.
 */
function addSource({ position = new THREE.Vector3(0, 0, -0.04), yawRad = 0 } = {}) {
    const group = new THREE.Group();
    group.position.copy(position);
    group.rotation.set(0, yawRad, 0);
    group.userData.element = { type: 'source', id: ++sourceCounter };
    group.scale.set(2, 2, 2);

    const sph = new THREE.Mesh(new THREE.SphereGeometry(0.0005, 32, 16),
        new THREE.MeshStandardMaterial({ color: 0x7ee787 }));
    group.add(sph);

    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 0.006, 0x7ee787);
    group.add(arrow);

    const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0012, 0.0012, 6e-05, 32),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.01, depthWrite: false })
    );
    handle.rotation.x = Math.PI / 2; handle.position.set(0.0, 3e-05, 0.0);
    handle.userData.attachTarget = group; handle.userData.element = group.userData.element;
    group.add(handle);

    scene.add(group);
    selectable.push(handle);

    const props = {
        wavelength_nm: 632.8, bandwidth_nm: 0, specSamples: 9, waist_w0_um: 200,
        rayleigh_mm: 0, forward_cm: 100, backward_cm: 0, intensity_rel: 1.0, M2: 1.0,
        polPreset: "Linear X", customPolEx: "1+0i", customPolEy: "0+0i"
    };
    const src = { group, handle, arrow, props, lastEdited: 'w0' };
    syncSourceW0ZR(src);
    sources.push(src);
    tcontrols.attach(group);
    doRecompute();
    refreshAfterRecompute();
    if (!State.isRestoring()) State.pushHistory();
    return src;
}

/**
 * Removes a source from the scene and internal state, disposing of its resources.
 * @param {THREE.Group} group - The group object of the source to remove.
 */
function removeSourceByGroup(group) {
    const i = sources.findIndex(s => s.group === group);
    if (i < 0) return;
    const s = sources[i];
    selectable.splice(selectable.indexOf(s.handle), 1);
    scene.remove(s.group);
    s.group.traverse(obj => { obj.geometry?.dispose?.(); obj.material?.dispose?.(); });
    sources.splice(i, 1);
}

/**
 * Synchronizes a source's waist (w₀) and Rayleigh range (zᵣ) based on which was last edited.
 * @param {object} src - The source object to synchronize.
 */
function syncSourceW0ZR(src) {
    const M2 = Math.max(1.0, src.props.M2 ?? 1.0);
    const λ = src.props.wavelength_nm * 1e-9;
    if (src.lastEdited === 'w0') {
        const w0 = Math.max(1e-9, src.props.waist_w0_um * 1e-6);
        src.props.rayleigh_mm = (Math.PI * w0 * w0 / λ) / M2 * 1e3;
    } else {
        const zR = Math.max(1e-12, src.props.rayleigh_mm * 1e-3);
        src.props.waist_w0_um = Math.sqrt(zR * λ * M2 / Math.PI) * 1e6;
    }
}

/**
 * Builds the lil-gui user interface for the selected source's properties.
 * @param {GUI} elFolder - The lil-gui folder to add controls to.
 * @param {object} src - The source object being edited.
 * @param {Function} live - The live-update wrapper function from main.js.
 * @param {object} ui - The UI state object from main.js.
 */
function buildSourceUI(elFolder, src, live, ui) {
    ui.wavelength_nm = src.props.wavelength_nm;
    ui.bandwidth_nm = src.props.bandwidth_nm ?? 0;
    ui.specSamples = src.props.specSamples ?? 9;
    ui.waist_w0_um = src.props.waist_w0_um;
    ui.rayleigh_mm = src.props.rayleigh_mm;
    ui.M2 = src.props.M2 ?? 1.0;
    ui.forward_cm = src.props.forward_cm;
    ui.backward_cm = src.props.backward_cm;
    ui.intensity_rel = src.props.intensity_rel,
    ui.polPreset = src.props.polPreset;
    ui.customPolEx = src.props.customPolEx;
    ui.customPolEy = src.props.customPolEy;

    let w0Ctrl, zrCtrl;

    w0Ctrl = live(elFolder.add(ui, "waist_w0_um", 1, 20000, 1).name("Waist w0 (µm)"),
        v => { src.lastEdited = 'w0'; src.props.waist_w0_um = Number(v); syncSourceW0ZR(src); ui.rayleigh_mm = src.props.rayleigh_mm; zrCtrl?.updateDisplay(); doRecompute(); });
    zrCtrl = live(elFolder.add(ui, "rayleigh_mm", 1, 200000, 1).name("Rayleigh zR (mm)"),
        v => { src.lastEdited = 'zR'; src.props.rayleigh_mm = Number(v); syncSourceW0ZR(src); ui.waist_w0_um = src.props.waist_w0_um; w0Ctrl?.updateDisplay(); doRecompute(); });
    live(elFolder.add(ui, "M2", 1, 10, 0.01).name("Beam Quality M²"),
        v => {
            src.props.M2 = Math.max(1, Number(v));
            syncSourceW0ZR(src);
            if (src.lastEdited === 'w0') {
                ui.rayleigh_mm = src.props.rayleigh_mm; zrCtrl?.updateDisplay();
            } else {
                ui.waist_w0_um = src.props.waist_w0_um; w0Ctrl?.updateDisplay();
            }
            doRecompute();
        });
    live(elFolder.add(ui, "intensity_rel", 0, 5, 0.01).name("Intensity (×)"),
        v => { src.props.intensity_rel = Math.max(0, Number(v)); doRecompute(); });
    elFolder.add(ui, "wavelength_nm").name("Wavelength (nm)")
        .onFinishChange(v => {
            const n = Number(v); if (!Number.isFinite(n)) return;
            src.props.wavelength_nm = n; syncSourceW0ZR(src);
            ui.waist_w0_um = src.props.waist_w0_um; ui.rayleigh_mm = src.props.rayleigh_mm;
            w0Ctrl.updateDisplay(); zrCtrl.updateDisplay();
            doRecompute(); refreshAfterRecompute(); State.pushHistory();
        });

    live(elFolder.add(ui, "bandwidth_nm", 0, 2000, 1).name("Bandwidth (nm)"),
        v => { src.props.bandwidth_nm = Math.max(0, Number(v)); doRecompute(); });
    live(elFolder.add(ui, "specSamples", 1, 31, 1).name("Spectral Samples"),
        v => { src.props.specSamples = Math.max(1, Math.floor(Number(v))); doRecompute(); });

    live(elFolder.add(ui, "forward_cm", 0, 2000, 10).name("Forward Path (cm)"),
        v => { src.props.forward_cm = Math.max(0, Number(v)); doRecompute(); });
    live(elFolder.add(ui, "backward_cm", 0, 2000, 10).name("Backward Path (cm)"),
        v => { src.props.backward_cm = Math.max(0, Number(v)); doRecompute(); });

    elFolder.add(ui, "polPreset", ["Linear X", "Linear Y", "+45°", "-45°", "RHC", "LHC", "Custom"]).name("Pol Preset")
        .onChange(v => { src.props.polPreset = v; doRecompute(); refreshAfterRecompute(); try { syncPolRowsPol(); } catch (e) { } });
    elFolder.add(ui, "customPolEx").name("E_x (a+bi)")
        .onFinishChange(v => { src.props.customPolEx = String(v); _onExEyChangedPol(); doRecompute(); refreshAfterRecompute(); State.pushHistory(); });
    elFolder.add(ui, "customPolEy").name("E_y (a+bi)")
        .onFinishChange(v => { src.props.customPolEy = String(v); _onExEyChangedPol(); doRecompute(); refreshAfterRecompute(); State.pushHistory(); });


    // ψ/χ controls (only in Custom) — update on Enter (finish), not on each keystroke
    ui.psi_deg = src.props.psi_deg ?? 0;
    ui.chi_deg = src.props.chi_deg ?? 0;
    const psiCtrl = elFolder.add(ui, "psi_deg", -180, 180, 0.1).name("ψ (deg)")
        .onFinishChange(v => { src.props.psi_deg = Number(v); _onPsiChiChangedPol(); doRecompute(); refreshAfterRecompute(); State.pushHistory(); });
    const chiCtrl = elFolder.add(ui, "chi_deg", -45, 45, 0.1).name("χ (deg)")
        .onFinishChange(v => { src.props.chi_deg = Number(v); _onPsiChiChangedPol(); doRecompute(); refreshAfterRecompute(); State.pushHistory(); });

    // Helpers for coupling Ex/Ey <-> (ψ, χ)
    function _parseCPol(s) {
        s = String(s || "").trim();
        const m = s.match(/^([+\-]?\d*\.?\d+)([+\-]\d*\.?\d+)i$/i);
        if (m) return { re: parseFloat(m[1]), im: parseFloat(m[2]) };
        const n = s.match(/^([+\-]?\d*\.?\d+)$/);
        if (n) return { re: parseFloat(n[1]), im: 0 };
        return { re: 1, im: 0 };
    }
    function _fmtCPol(z) {
        const re = Math.round(z.re * 1e6) / 1e6;
        const im = Math.round(z.im * 1e6) / 1e6;
        const sign = im >= 0 ? "+" : "";
        return `${re}${sign}${im}i`;
    }
    function _jonesToPsiChiPol(Ex, Ey) {
        const mag2 = (Ex.re * Ex.re + Ex.im * Ex.im) + (Ey.re * Ey.re + Ey.im * Ey.im);
        if (mag2 <= 1e-18) return { psi_deg: 0, chi_deg: 0 };
        const ExEy_conj_re = Ex.re * Ey.re + Ex.im * Ey.im;
        const ExEy_conj_im = Ex.im * Ey.re - Ex.re * Ey.im; // Im(Ex Ey*)
        const s1 = (Ex.re * Ex.re + Ex.im * Ex.im) - (Ey.re * Ey.re + Ey.im * Ey.im);
        const s2 = 2 * ExEy_conj_re;
        const s3 = 2 * ExEy_conj_im;
        const psi = 0.5 * Math.atan2(s2, s1);
        const chi = 0.5 * Math.asin(Math.max(-1, Math.min(1, s3 / Math.max(1e-12, mag2))));
        return { psi_deg: psi * 180 / Math.PI, chi_deg: chi * 180 / Math.PI };
    }
    function _psiChiToJonesPol(psi_deg, chi_deg) {
        const ψ = (Number(psi_deg) || 0) * Math.PI / 180;
        const χ = (Number(chi_deg) || 0) * Math.PI / 180;
        const cψ = Math.cos(ψ), sψ = Math.sin(ψ);
        const cχ = Math.cos(χ), sχ = Math.sin(χ);
        return {
            Ex: { re: cψ * cχ, im: sψ * sχ },
            Ey: { re: sψ * cχ, im: -cψ * sχ }
        };
    }

    function _onPsiChiChangedPol() {
        const pair = _psiChiToJonesPol(src.props.psi_deg, src.props.chi_deg);
        ui.customPolEx = _fmtCPol(pair.Ex);
        ui.customPolEy = _fmtCPol(pair.Ey);
        src.props.customPolEx = ui.customPolEx;
        src.props.customPolEy = ui.customPolEy;
        try { elFolder.controllers.find(c => c._name === "E_x (a+bi)")?.updateDisplay(); } catch (e) { }
        try { elFolder.controllers.find(c => c._name === "E_y (a+bi)")?.updateDisplay(); } catch (e) { }
    }
    function _onExEyChangedPol() {
        const Ex = _parseCPol(src.props.customPolEx);
        const Ey = _parseCPol(src.props.customPolEy);
        const ang = _jonesToPsiChiPol(Ex, Ey);
        src.props.psi_deg = ang.psi_deg;
        src.props.chi_deg = ang.chi_deg;
        ui.psi_deg = src.props.psi_deg;
        ui.chi_deg = src.props.chi_deg;
        try { elFolder.controllers.find(c => c._name === "ψ (deg)")?.updateDisplay(); } catch (e) { }
        try { elFolder.controllers.find(c => c._name === "χ (deg)")?.updateDisplay(); } catch (e) { }
    }

    function _togglePol(ctrl, enabled) {
        if (!ctrl) return;
        const row = ctrl.domElement?.closest?.(".controller");
        if (row) {
            row.style.opacity = enabled ? "1.0" : "0.5";
            row.style.pointerEvents = enabled ? "auto" : "none";
        }
    }
    function syncPolRowsPol() {
        const mode = src.props.polPreset || "";
        const isCustom = (mode === "Custom");
        _togglePol(psiCtrl, isCustom);
        _togglePol(chiCtrl, isCustom);
        const ex = elFolder.controllers.find(c => c._name === "E_x (a+bi)");
        const ey = elFolder.controllers.find(c => c._name === "E_y (a+bi)");
        _togglePol(ex, isCustom);
        _togglePol(ey, isCustom);
        if (isCustom) { _onExEyChangedPol(); }
    }
    syncPolRowsPol();
}

export {
    init,
    sources,
    addSource,
    removeSourceByGroup,
    syncSourceW0ZR,
    buildSourceUI
};