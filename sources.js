/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// sources.js - Manages source creation, visuals, state sync, and source UI
import * as THREE from 'three';

// Module-level context, initialized from main.js
let scene, selectable, tcontrols;
let doRecompute, refreshAfterRecompute, State;

// Internal state
const sources = [];
let sourceCounter = 0;

const SOURCE_COLOR = 0x7ee787;
const DISK_BASE_RADIUS_M = 0.0005;

function init(context) {
    scene = context.scene;
    selectable = context.selectable;
    tcontrols = context.tcontrols;
    doRecompute = context.doRecompute;
    refreshAfterRecompute = context.refreshAfterRecompute;
    State = context.State;
}

function _sanitizeSourceProps(src) {
    const p = src.props || (src.props = {});

    p.beamMode = (p.beamMode === 'rays') ? 'rays' : 'gaussian';

    p.wavelength_nm = Number.isFinite(Number(p.wavelength_nm)) ? Number(p.wavelength_nm) : 632.8;
    if (p.wavelength_nm <= 0) p.wavelength_nm = 632.8;
    p.bandwidth_nm = Math.max(0, Number(p.bandwidth_nm ?? 0));
    p.specSamples = Math.max(1, Math.floor(Number(p.specSamples ?? 9)));
    p.forward_cm = Math.max(0, Number(p.forward_cm ?? 100));
    p.backward_cm = Math.max(0, Number(p.backward_cm ?? 0));
    p.intensity_rel = Math.max(0, Number(p.intensity_rel ?? 1.0));

    p.waist_w0_um = Math.max(1, Number(p.waist_w0_um ?? 200));
    p.rayleigh_mm = Math.max(1e-9, Number(p.rayleigh_mm ?? 0));
    p.M2 = Math.max(1.0, Number(p.M2 ?? 1.0));

    p.rays_aperture_radius_mm = Math.max(0, Number(p.rays_aperture_radius_mm ?? 1.0));
    p.rays_spacing_um = Math.max(1, Number(p.rays_spacing_um ?? 600));
    p.rays_radius_um = Math.max(1, Number(p.rays_radius_um ?? 50));

    p.polPreset = String(p.polPreset ?? "Linear X");
    p.customPolEx = String(p.customPolEx ?? "1+0i");
    p.customPolEy = String(p.customPolEy ?? "0+0i");

    if (src.lastEdited !== 'w0' && src.lastEdited !== 'zR') src.lastEdited = 'w0';
}

function _ensureSourceVisuals(src) {
    if (!src.sphere) {
        src.sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.0005, 32, 16),
            new THREE.MeshStandardMaterial({ color: SOURCE_COLOR })
        );
        src.group.add(src.sphere);
    }

    if (!src.disk) {
        src.disk = new THREE.Mesh(
            new THREE.CircleGeometry(DISK_BASE_RADIUS_M, 64),
            new THREE.MeshStandardMaterial({
                color: SOURCE_COLOR,
                transparent: true,
                opacity: 0.4,
                side: THREE.DoubleSide
            })
        );
        src.disk.visible = false;
        src.group.add(src.disk);
    }
}

function refreshSourceVisual(src) {
    if (!src?.group) return;
    _sanitizeSourceProps(src);
    _ensureSourceVisuals(src);

    const isRays = src.props.beamMode === 'rays';
    src.sphere.visible = !isRays;
    src.disk.visible = isRays;

    const diskRadiusM = Math.max(1e-7, Number(src.props.rays_aperture_radius_mm) * 1e-3);
    const scale = diskRadiusM / DISK_BASE_RADIUS_M;
    src.disk.scale.set(scale, scale, 1);
}

function _countDiskRays(apertureRadiusM, spacingM) {
    const r = Math.max(0, Number(apertureRadiusM));
    const s = Math.max(1e-9, Number(spacingM));
    if (r <= 0) return 1;

    let count = 0;
    for (let y = -r; y <= r + 1e-12; y += s) {
        for (let x = -r; x <= r + 1e-12; x += s) {
            if ((x * x + y * y) <= (r * r + 1e-15)) count++;
        }
    }
    return Math.max(1, count);
}

function getDerivedRayCount(src) {
    if (!src?.props) return 1;
    const r = Math.max(0, Number(src.props.rays_aperture_radius_mm ?? 1.0)) * 1e-3;
    const s = Math.max(1, Number(src.props.rays_spacing_um ?? 600)) * 1e-6;
    return _countDiskRays(r, s);
}

function addSource({ position = new THREE.Vector3(0, 0, -0.04), yawRad = 0, mode = 'gaussian' } = {}) {
    const group = new THREE.Group();
    group.position.copy(position);
    group.rotation.set(0, yawRad, 0);
    group.userData.element = { type: 'source', id: ++sourceCounter };
    group.scale.set(2, 2, 2);

    const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0, 0, 0),
        0.006,
        SOURCE_COLOR
    );
    group.add(arrow);

    const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0012, 0.0012, 6e-05, 32),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.01, depthWrite: false })
    );
    handle.rotation.x = Math.PI / 2;
    handle.position.set(0.0, 3e-05, 0.0);
    handle.userData.attachTarget = group;
    handle.userData.element = group.userData.element;
    group.add(handle);

    scene.add(group);
    selectable.push(handle);

    const props = {
        beamMode: (mode === 'rays') ? 'rays' : 'gaussian',
        wavelength_nm: 632.8,
        bandwidth_nm: 0,
        specSamples: 9,
        waist_w0_um: 200,
        rayleigh_mm: 0,
        forward_cm: 100,
        backward_cm: 0,
        intensity_rel: 1.0,
        M2: 1.0,
        rays_aperture_radius_mm: 1.0,
        rays_spacing_um: 600,
        rays_radius_um: 50,
        polPreset: "Linear X",
        customPolEx: "1+0i",
        customPolEy: "0+0i"
    };

    const src = { group, handle, arrow, sphere: null, disk: null, props, lastEdited: 'w0' };
    syncSourceW0ZR(src);
    sources.push(src);
    tcontrols.attach(group);
    doRecompute();
    refreshAfterRecompute();
    if (!State.isRestoring()) State.pushHistory();
    return src;
}

function removeSourceByGroup(group) {
    const i = sources.findIndex(s => s.group === group);
    if (i < 0) return;
    const s = sources[i];
    const si = selectable.indexOf(s.handle);
    if (si >= 0) selectable.splice(si, 1);
    scene.remove(s.group);
    s.group.traverse(obj => {
        obj.geometry?.dispose?.();
        obj.material?.dispose?.();
    });
    sources.splice(i, 1);
}

function syncSourceW0ZR(src) {
    _sanitizeSourceProps(src);
    const p = src.props;

    if (p.beamMode === 'gaussian') {
        const m2 = Math.max(1.0, p.M2 ?? 1.0);
        const wavelengthM = p.wavelength_nm * 1e-9;
        if (src.lastEdited === 'w0') {
            const w0 = Math.max(1e-9, p.waist_w0_um * 1e-6);
            p.rayleigh_mm = (Math.PI * w0 * w0 / wavelengthM) / m2 * 1e3;
        } else {
            const zR = Math.max(1e-12, p.rayleigh_mm * 1e-3);
            p.waist_w0_um = Math.sqrt(zR * wavelengthM * m2 / Math.PI) * 1e6;
        }
    }

    refreshSourceVisual(src);
}

function buildSourceUI(elFolder, src, live, ui) {
    _sanitizeSourceProps(src);
    refreshSourceVisual(src);

    ui.beam_model = (src.props.beamMode === 'rays') ? "Rays" : "Gaussian";
    ui.wavelength_nm = src.props.wavelength_nm;
    ui.bandwidth_nm = src.props.bandwidth_nm ?? 0;
    ui.specSamples = src.props.specSamples ?? 9;
    ui.waist_w0_um = src.props.waist_w0_um;
    ui.rayleigh_mm = src.props.rayleigh_mm;
    ui.M2 = src.props.M2 ?? 1.0;
    ui.forward_cm = src.props.forward_cm;
    ui.backward_cm = src.props.backward_cm;
    ui.intensity_rel = src.props.intensity_rel;
    ui.rays_aperture_radius_mm = src.props.rays_aperture_radius_mm;
    ui.rays_spacing_um = src.props.rays_spacing_um;
    ui.rays_radius_um = src.props.rays_radius_um;
    ui.polPreset = src.props.polPreset;
    ui.customPolEx = src.props.customPolEx;
    ui.customPolEy = src.props.customPolEy;

    const setCtrlVisible = (ctrl, visible) => {
        const row = ctrl?.domElement?.closest?.(".controller");
        if (row) row.style.display = visible ? "" : "none";
    };
    const setCtrlEnabled = (ctrl, enabled) => {
        const row = ctrl?.domElement?.closest?.(".controller");
        if (row) {
            row.style.opacity = enabled ? "1.0" : "0.5";
            row.style.pointerEvents = enabled ? "auto" : "none";
        }
    };

    let w0Ctrl, zrCtrl;
    const gaussianCtrls = [];
    const raysCtrls = [];

    const beamModeCtrl = elFolder.add(ui, "beam_model", ["Gaussian", "Rays"]).name("Beam Model")
        .onChange(v => {
            src.props.beamMode = (v === "Rays") ? "rays" : "gaussian";
            syncSourceW0ZR(src);

            ui.waist_w0_um = src.props.waist_w0_um;
            ui.rayleigh_mm = src.props.rayleigh_mm;
            ui.M2 = src.props.M2;
            ui.rays_aperture_radius_mm = src.props.rays_aperture_radius_mm;
            ui.rays_spacing_um = src.props.rays_spacing_um;
            ui.rays_radius_um = src.props.rays_radius_um;

            w0Ctrl?.updateDisplay();
            zrCtrl?.updateDisplay();
            refreshDerivedRays();
            syncModelRows();
            doRecompute();
            refreshAfterRecompute();
            State.pushHistory();
        });

    w0Ctrl = live(
        elFolder.add(ui, "waist_w0_um", 1, 20000, 1).name("Waist w0 (um)"),
        v => {
            src.lastEdited = 'w0';
            src.props.waist_w0_um = Number(v);
            syncSourceW0ZR(src);
            ui.rayleigh_mm = src.props.rayleigh_mm;
            zrCtrl?.updateDisplay();
            doRecompute();
        }
    );
    gaussianCtrls.push(w0Ctrl);

    zrCtrl = live(
        elFolder.add(ui, "rayleigh_mm", 1, 200000, 1).name("Rayleigh zR (mm)"),
        v => {
            src.lastEdited = 'zR';
            src.props.rayleigh_mm = Number(v);
            syncSourceW0ZR(src);
            ui.waist_w0_um = src.props.waist_w0_um;
            w0Ctrl?.updateDisplay();
            doRecompute();
        }
    );
    gaussianCtrls.push(zrCtrl);

    const m2Ctrl = live(
        elFolder.add(ui, "M2", 1, 10, 0.01).name("Beam Quality M2"),
        v => {
            src.props.M2 = Math.max(1, Number(v));
            syncSourceW0ZR(src);
            if (src.lastEdited === 'w0') {
                ui.rayleigh_mm = src.props.rayleigh_mm;
                zrCtrl?.updateDisplay();
            } else {
                ui.waist_w0_um = src.props.waist_w0_um;
                w0Ctrl?.updateDisplay();
            }
            doRecompute();
        }
    );
    gaussianCtrls.push(m2Ctrl);

    const intensityCtrl = live(
        elFolder.add(ui, "intensity_rel", 0, 5, 0.01).name("Intensity (x)"),
        v => { src.props.intensity_rel = Math.max(0, Number(v)); doRecompute(); }
    );

    elFolder.add(ui, "wavelength_nm").name("Wavelength (nm)")
        .onFinishChange(v => {
            const n = Number(v);
            if (!Number.isFinite(n)) return;
            src.props.wavelength_nm = n;
            syncSourceW0ZR(src);
            ui.waist_w0_um = src.props.waist_w0_um;
            ui.rayleigh_mm = src.props.rayleigh_mm;
            w0Ctrl?.updateDisplay();
            zrCtrl?.updateDisplay();
            doRecompute();
            refreshAfterRecompute();
            State.pushHistory();
        });

    const bandwidthCtrl = live(
        elFolder.add(ui, "bandwidth_nm", 0, 2000, 1).name("Bandwidth (nm)"),
        v => { src.props.bandwidth_nm = Math.max(0, Number(v)); doRecompute(); }
    );
    const specSamplesCtrl = live(
        elFolder.add(ui, "specSamples", 1, 31, 1).name("Spectral Samples"),
        v => { src.props.specSamples = Math.max(1, Math.floor(Number(v))); doRecompute(); }
    );
    const forwardCtrl = live(
        elFolder.add(ui, "forward_cm", 0, 2000, 10).name("Forward Path (cm)"),
        v => { src.props.forward_cm = Math.max(0, Number(v)); doRecompute(); }
    );
    const backwardCtrl = live(
        elFolder.add(ui, "backward_cm", 0, 2000, 10).name("Backward Path (cm)"),
        v => { src.props.backward_cm = Math.max(0, Number(v)); doRecompute(); }
    );

    const raysApertureCtrl = live(
        elFolder.add(ui, "rays_aperture_radius_mm", 0, 200, 0.01).name("Aperture Radius (mm)"),
        v => {
            src.props.rays_aperture_radius_mm = Math.max(0, Number(v));
            refreshSourceVisual(src);
            refreshDerivedRays();
            doRecompute();
        }
    );
    raysCtrls.push(raysApertureCtrl);

    const raysSpacingCtrl = live(
        elFolder.add(ui, "rays_spacing_um", 1, 5000, 1).name("Ray Spacing (um)"),
        v => {
            src.props.rays_spacing_um = Math.max(1, Number(v));
            refreshDerivedRays();
            doRecompute();
        }
    );
    raysCtrls.push(raysSpacingCtrl);

    const raysRadiusCtrl = live(
        elFolder.add(ui, "rays_radius_um", 1, 1000, 1).name("Ray Radius (um)"),
        v => {
            src.props.rays_radius_um = Math.max(1, Number(v));
            doRecompute();
        }
    );
    raysCtrls.push(raysRadiusCtrl);

    const derivedObj = { rays_count: getDerivedRayCount(src) };
    const derivedCtrl = elFolder.add(derivedObj, "rays_count").name("Derived Rays");
    const derivedRow = derivedCtrl.domElement?.closest?.(".controller");
    if (derivedRow) {
        derivedRow.style.pointerEvents = "none";
        derivedRow.style.opacity = "0.9";
    }
    raysCtrls.push(derivedCtrl);

    function refreshDerivedRays() {
        derivedObj.rays_count = getDerivedRayCount(src);
        derivedCtrl.updateDisplay();
    }

    const polPresetCtrl = elFolder.add(ui, "polPreset", ["Linear X", "Linear Y", "+45°", "-45°", "RHC", "LHC", "Custom"]).name("Pol Preset")
        .onChange(v => {
            src.props.polPreset = v;
            doRecompute();
            refreshAfterRecompute();
            syncPolRows();
        });
    const exCtrl = elFolder.add(ui, "customPolEx").name("E_x (a+bi)")
        .onFinishChange(v => {
            src.props.customPolEx = String(v);
            onExEyChanged();
            doRecompute();
            refreshAfterRecompute();
            State.pushHistory();
        });
    const eyCtrl = elFolder.add(ui, "customPolEy").name("E_y (a+bi)")
        .onFinishChange(v => {
            src.props.customPolEy = String(v);
            onExEyChanged();
            doRecompute();
            refreshAfterRecompute();
            State.pushHistory();
        });

    ui.psi_deg = src.props.psi_deg ?? 0;
    ui.chi_deg = src.props.chi_deg ?? 0;
    const psiCtrl = elFolder.add(ui, "psi_deg", -180, 180, 0.1).name("Psi (deg)")
        .onFinishChange(v => {
            src.props.psi_deg = Number(v);
            onPsiChiChanged();
            doRecompute();
            refreshAfterRecompute();
            State.pushHistory();
        });
    const chiCtrl = elFolder.add(ui, "chi_deg", -45, 45, 0.1).name("Chi (deg)")
        .onFinishChange(v => {
            src.props.chi_deg = Number(v);
            onPsiChiChanged();
            doRecompute();
            refreshAfterRecompute();
            State.pushHistory();
        });

    function parseComplex(s) {
        const txt = String(s || "").trim();
        const m = txt.match(/^([+\-]?\d*\.?\d+)([+\-]\d*\.?\d+)i$/i);
        if (m) return { re: parseFloat(m[1]), im: parseFloat(m[2]) };
        const n = txt.match(/^([+\-]?\d*\.?\d+)$/);
        if (n) return { re: parseFloat(n[1]), im: 0 };
        return { re: 1, im: 0 };
    }

    function formatComplex(z) {
        const re = Math.round(z.re * 1e6) / 1e6;
        const im = Math.round(z.im * 1e6) / 1e6;
        const sign = im >= 0 ? "+" : "";
        return `${re}${sign}${im}i`;
    }

    function jonesToPsiChi(ex, ey) {
        const mag2 = (ex.re * ex.re + ex.im * ex.im) + (ey.re * ey.re + ey.im * ey.im);
        if (mag2 <= 1e-18) return { psi_deg: 0, chi_deg: 0 };
        const exEyConjRe = ex.re * ey.re + ex.im * ey.im;
        const exEyConjIm = ex.im * ey.re - ex.re * ey.im;
        const s1 = (ex.re * ex.re + ex.im * ex.im) - (ey.re * ey.re + ey.im * ey.im);
        const s2 = 2 * exEyConjRe;
        const s3 = 2 * exEyConjIm;
        const psi = 0.5 * Math.atan2(s2, s1);
        const chi = 0.5 * Math.asin(Math.max(-1, Math.min(1, s3 / Math.max(1e-12, mag2))));
        return { psi_deg: psi * 180 / Math.PI, chi_deg: chi * 180 / Math.PI };
    }

    function psiChiToJones(psiDeg, chiDeg) {
        const psi = (Number(psiDeg) || 0) * Math.PI / 180;
        const chi = (Number(chiDeg) || 0) * Math.PI / 180;
        const cPsi = Math.cos(psi), sPsi = Math.sin(psi);
        const cChi = Math.cos(chi), sChi = Math.sin(chi);
        return {
            ex: { re: cPsi * cChi, im: sPsi * sChi },
            ey: { re: sPsi * cChi, im: -cPsi * sChi }
        };
    }

    function onPsiChiChanged() {
        const pair = psiChiToJones(src.props.psi_deg, src.props.chi_deg);
        ui.customPolEx = formatComplex(pair.ex);
        ui.customPolEy = formatComplex(pair.ey);
        src.props.customPolEx = ui.customPolEx;
        src.props.customPolEy = ui.customPolEy;
        exCtrl.updateDisplay();
        eyCtrl.updateDisplay();
    }

    function onExEyChanged() {
        const ex = parseComplex(src.props.customPolEx);
        const ey = parseComplex(src.props.customPolEy);
        const ang = jonesToPsiChi(ex, ey);
        src.props.psi_deg = ang.psi_deg;
        src.props.chi_deg = ang.chi_deg;
        ui.psi_deg = src.props.psi_deg;
        ui.chi_deg = src.props.chi_deg;
        psiCtrl.updateDisplay();
        chiCtrl.updateDisplay();
    }

    function syncPolRows() {
        const isCustom = (src.props.polPreset === "Custom");
        setCtrlEnabled(psiCtrl, isCustom);
        setCtrlEnabled(chiCtrl, isCustom);
        setCtrlEnabled(exCtrl, isCustom);
        setCtrlEnabled(eyCtrl, isCustom);
        if (isCustom) onExEyChanged();
    }

    function syncModelRows() {
        const isRays = src.props.beamMode === 'rays';
        gaussianCtrls.forEach(ctrl => setCtrlVisible(ctrl, !isRays));
        raysCtrls.forEach(ctrl => setCtrlVisible(ctrl, isRays));
    }

    // keep lint-friendly references alive
    void beamModeCtrl;
    void intensityCtrl;
    void bandwidthCtrl;
    void specSamplesCtrl;
    void forwardCtrl;
    void backwardCtrl;
    void polPresetCtrl;

    refreshDerivedRays();
    syncPolRows();
    syncModelRows();
}

export {
    init,
    sources,
    addSource,
    removeSourceByGroup,
    syncSourceW0ZR,
    buildSourceUI,
    refreshSourceVisual,
    getDerivedRayCount
};
