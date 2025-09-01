/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// main.js — scene, GUI, multi-source Gaussian propagation with multimeter, gratings, PBS, unified mirror, dichroic, blocks, broadband sources
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.18/+esm';

// Import local modules
import * as GizmoUI from './gizmo-ui.js';
import * as Ruler from './ruler.js';
import * as State from './state.js';
import * as Sources from './sources.js';
import {
  clampToPlaneXZ,
  makeLens, makeMirror, makeMultimeter,
  makePolarizer, makeWaveplate, makeFaraday,
  makeBeamSplitter, makeBeamBlock, makeGrating,
  updateElementLabel
} from './elements.js';
import * as pol from './polarization.js';
import * as Propagation from './propagation.js';

/* ========= Scene ========= */
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x535353, 1);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x535353, 0.3, 1.2);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0.06, 0.04, 0.08);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

/* ========= Transform Controls & Gizmo Mode UI ========= */
GizmoUI.setup({
    camera,
    domElement: renderer.domElement,
    scene,
    orbit,
    recomputeFn: doRecompute,
    pushHistoryFn: () => State.pushHistory(),
    refreshSelectedUIFn: refreshSelectedUI
});
const tcontrols = GizmoUI.tcontrols.main;

// Ground grid and axes
const grid = new THREE.GridHelper(120, 12000, 0xFFFFFF, 0xFFFFFF);
grid.material.transparent = true; grid.material.opacity = 0.2;
scene.add(grid);
const axes = new THREE.AxesHelper(0.025);
scene.add(axes);

// Lights
scene.add(new THREE.HemisphereLight(0xffffff, 0x9ca3af, 0.9));
const dir = new THREE.DirectionalLight(0xffffff, 0.7);
dir.position.set(0.04, 0.07, 0.05);
scene.add(dir);

/* ========= Polarization Group ========= */
const polGroup = pol.createPolGroup(scene);

/* ========= App params ========= */
const params = {
    maxSegments: 60,
    beamWidthScale: 1,
    showPolarization: true,
    showGrid: true,
    showLabels: true,
    labelFontSize: 1.0,
    resetView: () => { camera.position.set(0.06, 0.04, 0.08); camera.lookAt(0, 0, 0); orbit.update(); }
};

// Track pointer for click-vs-drag selection
let _ptrDown = { x: 0, y: 0, active: false };
let _viewDragging = false;
const _dragPX_THRESH2 = 16;

/* ========= UI helpers ========= */
let _recomputePending = false;
function doRecompute() {
    if (_recomputePending) return;
    _recomputePending = true;
    requestAnimationFrame(() => {
        _recomputePending = false;
        // REFACTORED: Call the propagation module
        Propagation.recompute({
            sources: Sources.sources, elements, params,
            beamGroup, polGroup, tcontrols,
            ribbonMeshes, gratingLastInfo, meterLastInfo, elementLastInfo,
            addSource: Sources.addSource, removeSourceByGroup: Sources.removeSourceByGroup, syncSourceW0ZR: Sources.syncSourceW0ZR,
            clampToPlaneXZ, refreshAfterRecompute
        });
    });
}

let _uiRefreshTimer = null;
function refreshAfterRecompute() {
    if (_uiRefreshTimer) clearTimeout(_uiRefreshTimer);
    _uiRefreshTimer = setTimeout(() => { _uiRefreshTimer = null; refreshSelectedUI(); }, 120);
}

function live(ctrl, handler) {
    ctrl.onChange(handler);
    ctrl.onFinishChange(v => { handler(v); refreshAfterRecompute(); State.pushHistory(); });
    return ctrl;
}

/* ========= GUI ========= */
let outFolder = null;
const gui = new GUI({ title: "Controls", width: 360 });

const fileButtonContainer = document.createElement('div');
fileButtonContainer.style.cssText = 'display:flex; justify-content:space-around; gap:8px; padding:8px 4px; border-bottom:1px solid var(--widget-color)';
gui.domElement.querySelector('.title').after(fileButtonContainer);

const dummyGui = new GUI({ autoPlace: false });
const saveBtnCtrl = dummyGui.add({ save: State.saveState }, 'save').name("Save State");
const loadBtnCtrl = dummyGui.add({ load: State.loadState }, 'load').name("Load State");
saveBtnCtrl.domElement.querySelector('button').style.width = '100%';
loadBtnCtrl.domElement.querySelector('button').style.width = '100%';
fileButtonContainer.appendChild(saveBtnCtrl.domElement.querySelector('button'));
fileButtonContainer.appendChild(loadBtnCtrl.domElement.querySelector('button'));
dummyGui.destroy();

let beamWidthScaleController, showGridController, showLabelsController, labelFontSizeController;

const fViz = gui.addFolder("Visualization");
live(fViz.add(params, "maxSegments", 4, 200, 1).name("Max Interactions"), doRecompute);
beamWidthScaleController = live(fViz.add(params, "beamWidthScale", 0.01, 300, 0.01).name("Beam Width Scale"), doRecompute);
fViz.add(params, "showPolarization").name("Show Polarization").onChange(v => { pol.setVisible(polGroup, v); doRecompute(); });
showGridController = fViz.add(params, 'showGrid').name('Show Grid').onChange(v => { grid.visible = v; });
showLabelsController = fViz.add(params, 'showLabels').name('Show Labels').onChange(v => {
    elements.forEach(el => {
        const label = el.mesh.children.find(c => c.isSprite);
        if (label) {
            label.visible = v;
        }
    });
});
labelFontSizeController = fViz.add(params, 'labelFontSize', 0.1, 5, 0.1).name('Label Font Size').onChange(v => {
    params.labelFontSize = v;
    elements.forEach(el => GizmoUI.correctLabelScale(el.mesh, params.labelFontSize));
});

gui.addFolder("Transform Gizmo").add(params, "resetView").name("Reset Camera");

/* ========= Drag & Drop Palette ========= */
function screenToWorldOnXZ(clientX, clientY) {
    const rc = new THREE.Raycaster();
    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    rc.setFromCamera({ x, y }, camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    return rc.ray.intersectPlane(plane, hit) ? hit : new THREE.Vector3(0, 0, 0);
}

function spawnAt(type, pos) {
    pos = pos || new THREE.Vector3(0, 0, 0);
    switch (type) {
        case 'source': Sources.addSource({ position: pos.clone(), yawRad: 0 }); break;
        case 'lens': addElement(makeLens({ f: 1.0 }), pos); break;
        case 'mirror': addElement(makeMirror({ flat: true, R: 2.0, refl: 1.0 }), pos); break;
        case 'polarizer': addElement(makePolarizer({ axisDeg: 0 }), pos); break;
        case 'waveplate': addElement(makeWaveplate({ type: 'HWP', delta: Math.PI }), pos); break;
        case 'faraday': addElement(makeFaraday({ phiDeg: 45 }), pos); break;
        case 'pbs': addElement(makeBeamSplitter({ R: 0.5, polarizing: false, polTransmit: 'Vertical' }), pos); break;
        case 'beamblock': addElement(makeBeamBlock(), pos); break;
        case 'grating':
            const el = makeGrating({ mode: 'reflective', d_um: 1.0, orders: 3 });
            el.props.visibleOrders = {};
            addElement(el, pos);
            break;
        case 'multimeter': addElement(makeMultimeter(), pos); break;
        case 'ruler':
            if (!Ruler.doesRulerExist()) {
                const rulerContext = { scene, selectable, tcontrols, pushHistory: State.pushHistory, isRestoringState: State.isRestoring() };
                const newRuler = Ruler.addRuler(rulerContext, pos);
                if (newRuler) {
                    tcontrols.attach(newRuler.points.p2);
                }
            }
            break;
    }
}

document.getElementById('palette')?.querySelectorAll('.pal-item').forEach(btn => {
    btn.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', btn.getAttribute('data-type'));
        e.dataTransfer.effectAllowed = 'copy';
    });
});

renderer.domElement.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
renderer.domElement.addEventListener('drop', e => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if (type) spawnAt(type, screenToWorldOnXZ(e.clientX, e.clientY));
});

/* ========= Elements & selection ========= */
const elements = [];
const selectable = [];
const ugiPickables = [];

// Initialize Sources module
Sources.init({ scene, selectable, tcontrols, doRecompute, refreshAfterRecompute, State });

function addElement(el, pos) {
    elements.push(el);
    selectable.push(el.mesh);
    scene.add(el.mesh);
    el.mesh.scale.set(2, 2, 2);
    if (pos) {
        el.mesh.position.copy(pos);
        clampToPlaneXZ(el.mesh);
    } else if (el.mesh.position.lengthSq() === 0) {
        const k = elements.length;
        el.mesh.position.set((k % 3 - 1) * 0.006, 0, -0.01 + 0.009 * k);
    }
    tcontrols.attach(el.mesh);
    if (el.ugi?.handle) { ugiPickables.push(el.ugi.handle); }

    GizmoUI.correctLabelScale(el.mesh, params.labelFontSize);

    doRecompute();
    refreshAfterRecompute();
    if (!State.isRestoring()) State.pushHistory();

    return el;
}

// Raycast selection
let _ugiActive = false;
let _ugiDrag = null;

function _raycasterFromEvent(e) {
    const rc = new THREE.Raycaster();
    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    rc.setFromCamera({ x, y }, camera);
    return rc;
}

function _computeAngleDeg(el, worldPoint) {
    const pLocal = el.mesh.worldToLocal(worldPoint.clone());
    return THREE.MathUtils.radToDeg(Math.atan2(pLocal.y, pLocal.x));
}

function _updateUGIAngleFromEvent(e) {
    if (!_ugiActive || !_ugiDrag) return;
    const rc = _raycasterFromEvent(e);
    const hitPoint = new THREE.Vector3();
    if (!rc.ray.intersectPlane(_ugiDrag.plane, hitPoint)) return;
    const deg = _computeAngleDeg(_ugiDrag.el, hitPoint);
    _ugiDrag.el.props.axisDeg = deg;
    _ugiDrag.el.ugi?.setAngle?.(deg);
    doRecompute();
}

renderer.domElement.addEventListener('pointerdown', e => {
    const hits = _raycasterFromEvent(e).intersectObjects(ugiPickables, true);
    if (hits.length) {
        const el = hits[0].object?.userData?.element;
        if (el?.mesh) {
            const q = el.mesh.getWorldQuaternion(new THREE.Quaternion());
            const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
            const c = el.mesh.getWorldPosition(new THREE.Vector3());
            _ugiDrag = { el, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, c) };
            _ugiActive = true;
            orbit.enabled = false;
            _updateUGIAngleFromEvent(e);
            e.preventDefault(); e.stopPropagation();
        }
    }
}, { capture: true });

window.addEventListener('pointermove', e => { if (_ugiActive) { _updateUGIAngleFromEvent(e); e.preventDefault(); } }, { capture: true });
window.addEventListener('pointerup', e => {
    if (_ugiActive) {
        _ugiActive = false; _ugiDrag = null; orbit.enabled = true;
        refreshAfterRecompute(); State.pushHistory();
        e.preventDefault(); e.stopPropagation();
    }
}, { capture: true });

renderer.domElement.addEventListener('pointerdown', e => {
    _ptrDown.x = e.clientX; _ptrDown.y = e.clientY; _ptrDown.active = true; _viewDragging = false;
});
renderer.domElement.addEventListener('pointermove', e => {
    if (!_ptrDown.active) return;
    const dx = e.clientX - _ptrDown.x, dy = e.clientY - _ptrDown.y;
    if ((dx * dx + dy * dy) > _dragPX_THRESH2) _viewDragging = true;
});
renderer.domElement.addEventListener('pointerup', e => {
    const wasDragging = _viewDragging; _ptrDown.active = false; _viewDragging = false;
    if (GizmoUI.isGizmoPointerDown() || _ugiActive || wasDragging) { setTimeout(refreshSelectedUI, 0); return; }
    const hits = _raycasterFromEvent(e).intersectObjects(selectable, false);
    if (hits.length) {
        const target = hits[0].object.userData.attachTarget || hits[0].object;
        tcontrols.attach(target);
    } else {
        tcontrols.detach();
    }
    setTimeout(refreshSelectedUI, 0);
});

Object.values(GizmoUI.tcontrols).forEach(ctrl => {
    ctrl.addEventListener('change', () => {
        if (ctrl.object) {
            if (ctrl.object.userData?.isRulerPoint) {
                Ruler.updateRuler();
            } else {
                clampToPlaneXZ(ctrl.object);
                if (ctrl.mode === 'scale') {
                    ctrl.object.scale.z = 2;
                    GizmoUI.correctLabelScale(ctrl.object, params.labelFontSize);
                }
            }
            refreshSelectedUI();
            doRecompute();
        }
    });
    ctrl.addEventListener('mouseDown', refreshSelectedUI);
    ctrl.addEventListener('mouseUp', () => {
        if (ctrl.object?.userData?.isRulerPoint) Ruler.updateRuler();
        refreshSelectedUI();
        State.pushHistory();
    });
});

window.addEventListener('keydown', e => {
    if (e.target.tagName.toLowerCase() === 'input') return;

    if ((e.key === 'Delete' || e.key === 'Backspace') && tcontrols.object) {
        if (tcontrols.object.userData?.isRulerPoint) {
            const rulerContext = { scene, selectable, tcontrols, pushHistory: State.pushHistory, isRestoringState: State.isRestoring() };
            Ruler.removeRuler(rulerContext);
        } else {
            deleteSelectedElement();
        }
    }
    if (e.ctrlKey) {
        if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? State.redo() : State.undo(); }
    }
});

function deleteSelectedElement() {
    if (!tcontrols.object) return;
    const obj = tcontrols.object;

    if (obj.userData?.element?.type === 'source') {
        Sources.removeSourceByGroup(obj);
    } else {
        const i = elements.findIndex(el => el.mesh === obj);
        if (i >= 0) {
            scene.remove(obj);
            selectable.splice(selectable.indexOf(obj), 1);
            const uh = elements[i]?.ugi?.handle;
            if (uh) ugiPickables.splice(ugiPickables.indexOf(uh), 1);
            elements.splice(i, 1);
        }
    }
    tcontrols.detach();
    doRecompute();
    refreshAfterRecompute();
    State.pushHistory();
}

function duplicateSelectedElement() {
    if (!tcontrols.object) return;
    const obj = tcontrols.object;
    const tag = obj.userData?.element;
    if (!tag) return;

    const offset = new THREE.Vector3(0.01, 0, 0.005);

    if (tag.type === 'source') {
        const src = Sources.sources.find(s => s.group === obj);
        if (src) {
            const newPosition = src.group.position.clone().add(offset);
            const newSource = Sources.addSource({ position: newPosition, yawRad: src.group.rotation.y });
            Object.assign(newSource.props, JSON.parse(JSON.stringify(src.props)));
            Sources.syncSourceW0ZR(newSource);
            newSource.group.scale.copy(src.group.scale);
        }
    } else {
        const el = elements.find(e => e.mesh === obj);
        if (el) {
            let newEl;
            const newProps = JSON.parse(JSON.stringify(el.props));
            switch (el.type) {
                case 'lens': newEl = makeLens(newProps); break;
                case 'mirror': newEl = makeMirror(newProps); break;
                case 'polarizer': newEl = makePolarizer(newProps); break;
                case 'waveplate': newEl = makeWaveplate(newProps); break;
                case 'faraday': newEl = makeFaraday(newProps); break;
                case 'beamSplitter': newEl = makeBeamSplitter(newProps); break;
                case 'beamBlock': newEl = makeBeamBlock(); break;
                case 'grating': newEl = makeGrating(newProps); break;
                case 'multimeter': newEl = makeMultimeter(); break;
                default: return;
            }
            if (newEl) {
                const newPos = el.mesh.position.clone().add(offset);
                addElement(newEl, newPos);
                newEl.mesh.quaternion.copy(el.mesh.quaternion);
                newEl.mesh.scale.copy(el.mesh.scale);
                GizmoUI.correctLabelScale(newEl.mesh, params.labelFontSize);
            }
        }
    }
}

function centerSelectedElementToBeam() {
    const selObj = tcontrols.object;
    if (!selObj) return;

    const tag = selObj.userData.element;
    if (!tag) return;

    const info = elementLastInfo.get(tag.id) || meterLastInfo.get(tag.id);

    if (info && info.x_mm !== undefined && info.z_mm !== undefined) {
        // Position info from propagation is in mm (world coords), object position is in meters.
        selObj.position.set(info.x_mm / 1000, 0, info.z_mm / 1000);

        // The clampToPlaneXZ is implicitly handled by the user interaction flows,
        // but good practice to ensure it if ever called programmatically.
        // clampToPlaneXZ(selObj);
        doRecompute();
        refreshAfterRecompute(); // Refreshes UI panels, including gizmo inputs
        State.pushHistory();
    }
}

/* ========= Ribbons & Readouts ========= */
let ribbonMeshes = [];
const beamGroup = new THREE.Group(); scene.add(beamGroup);
const gratingLastInfo = new Map();
const meterLastInfo = new Map();
const elementLastInfo = new Map();

/* ========= Polarization ellipse helper ========= */
function svgPolEllipse(psiDeg, chiDeg) {
    const a = 46, chiRad = (chiDeg || 0) * Math.PI / 180, b = Math.max(1, a * Math.abs(Math.tan(chiRad)));
    return `<svg width="160" height="120" viewBox="-80 -60 160 120" xmlns="http://www.w3.org/2000/svg"><style>.axis{stroke:#7d8590;stroke-width:1}.ell{stroke:#e6edf3;stroke-width:2;fill:none}.box{fill:none;stroke:#30363d;stroke-width:1}</style><line class="axis" x1="-64" y1="0" x2="64" y2="0"/><line class="axis" x1="0" y1="-44" x2="0" y2="44"/><g transform="rotate(${(-(psiDeg || 0)).toFixed(2)})"><ellipse class="ell" cx="0" cy="0" rx="${a}" ry="${b}"/></g><rect class="box" x="-75" y="-55" width="150" height="110" rx="6" ry="6"/></svg>`;
}

/* ========= Selected element panel ========= */
let elFolder = gui.addFolder("Selected Element");
const ui = { kind: "--" };

function refreshSelectedUI() {
    elFolder.destroy();
    elFolder = gui.addFolder("Selected Element");
    elFolder.open();

    outFolder?.destroy?.(); outFolder = null;
    Ruler.destroyRulerUI();

    const selObj = tcontrols.object;

    // Update the values in the gizmo UI inputs
    if (selObj) {
        document.getElementById('gizmo-pos-x').value = (selObj.position.x * 1000).toFixed(1);
        document.getElementById('gizmo-pos-y').value = (selObj.position.y * 1000).toFixed(1);
        document.getElementById('gizmo-pos-z').value = (selObj.position.z * 1000).toFixed(1);

        selObj.rotation.order = 'YXZ';
        document.getElementById('gizmo-rot-yaw').value = THREE.MathUtils.radToDeg(selObj.rotation.y).toFixed(1);
        document.getElementById('gizmo-rot-tilt').value = THREE.MathUtils.radToDeg(selObj.rotation.x).toFixed(1);

        document.getElementById('gizmo-scale-width').value = selObj.scale.x.toFixed(2);
        document.getElementById('gizmo-scale-height').value = selObj.scale.y.toFixed(2);
    }

    if (!selObj) {
        elFolder.close();
        return;
    }

    if (selObj.userData.isRulerPoint) {
        elFolder.close();
        const rulerContext = { scene, selectable, tcontrols, pushHistory: State.pushHistory, isRestoringState: State.isRestoring() };
        Ruler.buildRulerUI(gui, State.pushHistory, rulerContext);
        Ruler.updateRuler();
        return;
    }

    // --- Standard Element and Source UI ---
    outFolder = gui.addFolder("Output Beam Characteristics");
    outFolder.open();
    try {
        gui.domElement.insertBefore(outFolder.domElement, elFolder.domElement.nextSibling);
    } catch (e) { }

    const tag = selObj.userData.element || null;
    ui.kind = selObj ? (tag?.type ?? "--") : "--";
    elFolder.add(ui, "kind").name("Type").disable?.();
    const e = elements.find(x => x.mesh === selObj) || (tag?.type === 'source' ? null : elements.find(x => x.id === tag?.id));
    const info = e ? (elementLastInfo.get(e.id) || meterLastInfo.get(e.id)) : null;

    if (e) {
        ui.label = e.props.label || '';
        elFolder.add(ui, 'label').name('Label').onFinishChange(value => {
            e.props.label = value;
            updateElementLabel(e);
            GizmoUI.correctLabelScale(e.mesh, params.labelFontSize);
            State.pushHistory();
        });
    }
    {
        const fr = outFolder;

        const mk = (name, val) => {
            const row = { txt: val };
            const ctrl = fr.add(row, "txt").name(name);
            const dom = ctrl.domElement?.closest?.(".controller");
            if (dom) { dom.style.pointerEvents = "none"; dom.style.opacity = "0.9"; }
        };

        if (info) {
            // Special display for Multimeter
            if (tag?.type === 'multimeter') {
                mk("Beam Radius w (µm)", (isFinite(info.w_um) ? info.w_um.toFixed(3) : "—"));
                mk("Radius of Curvature (mm)", (isFinite(info.R_mm) ? info.R_mm.toFixed(2) : "—"));
                mk("Wavelength (nm)", (isFinite(info.wavelength_nm) ? info.wavelength_nm.toFixed(2) : "—"));
                mk("Relative Intensity", (isFinite(info.Irel) ? info.Irel.toFixed(3) : "—"));
            } else {
                // Standard display for all other elements
                mk("Relative Intensity", (isFinite(info.Irel) ? info.Irel.toFixed(3) : "—"));
                mk("Waist w₀ (µm)", (isFinite(info.w0_um) ? info.w0_um.toFixed(3) : "—"));
                mk("Distance to Waist (mm)", (isFinite(info.z_to_waist_mm) ? info.z_to_waist_mm.toFixed(2) : "—"));
                mk("Rayleigh zR (mm)", (isFinite(info.zR_mm) ? info.zR_mm.toFixed(2) : "—"));
            }

            // Polarization angles and ellipse graphic (common to all)
            const psi = info.psi_deg ?? info.psiDeg;
            const chi = info.chi_deg ?? info.chiDeg;
            mk("Polarization Ψ (deg)", isFinite(psi) ? psi.toFixed(2) : "—");
            mk("Ellipticity χ (deg)", isFinite(chi) ? chi.toFixed(2) : "—");
            
            const holder = document.createElement('div');
            holder.className = 'pol-ellipse-holder';
            holder.style.padding = '8px 8px 2px 8px';
            holder.style.display = 'flex';
            holder.style.justifyContent = 'center';
            holder.style.alignItems = 'center';
            holder.innerHTML = svgPolEllipse(psi, chi);

            // Remove previous holders we added (if any) and append
            try {
                for (const el of Array.from(fr.domElement.querySelectorAll('.pol-ellipse-holder'))) el.remove();
            } catch (e) { }
            fr.domElement.appendChild(holder);
        } else {
            outFolder.close();
        }
    }

    // ----- Angle of Incidence (editable if beam is hitting) -----
    if (info && info.aoi_deg !== undefined && info.incomingDir) {
        ui.aoi_deg = Number(info.aoi_deg.toFixed(2));
        live(
            elFolder.add(ui, "aoi_deg", 0, 90, 0.1).name("Incidence (deg)"),
            v => {
                // Find the most up-to-date info, as it might have changed since the panel was built
                const currentInfo = elementLastInfo.get(tag.id) || meterLastInfo.get(tag.id);
                if (!currentInfo || !currentInfo.incomingDir || !tcontrols.object) return;

                const selObj = tcontrols.object;
                const deltaAngleRad = THREE.MathUtils.degToRad(v - currentInfo.aoi_deg);

                // Get current normal in world space
                const nOld = new THREE.Vector3(0, 0, 1).applyQuaternion(selObj.quaternion);
                // Rotation axis is perpendicular to incoming ray and current normal
                const axis = new THREE.Vector3().crossVectors(currentInfo.incomingDir, nOld).normalize();

                // Handle case where vectors are parallel (axis is zero vector)
                if (axis.lengthSq() < 1e-6) {
                    // This happens at near-normal incidence. Any rotation axis in the element's plane is valid.
                    // We'll use the element's local X-axis (world-transformed) as a stable default.
                    axis.set(1, 0, 0).applyQuaternion(selObj.quaternion).normalize();
                }

                const rotQuat = new THREE.Quaternion().setFromAxisAngle(axis, deltaAngleRad);

                // Apply rotation: q_new = rotQuat * q_old
                selObj.quaternion.premultiply(rotQuat);

                // Ensure there's no "roll" (rotation about Z in local YXZ frame)
                const euler = new THREE.Euler().setFromQuaternion(selObj.quaternion, 'YXZ');
                euler.z = 0;
                selObj.setRotationFromEuler(euler);

                // This is handled by the live() wrapper's onFinishChange
                // clampToPlaneXZ(selObj);
                doRecompute();
            }
        );
    }

    // ----- Source: per-source controls (bandwidth included) -----
    if (tag?.type === 'source') {
        const src = Sources.sources.find(s => s.group === selObj);
        if (src) {
            Sources.buildSourceUI(elFolder, src, live, ui);
        }
    }

    // Lens
    if (tag?.type === "lens") {
        const e = elements.find(x => x.mesh === selObj); if (e) {
            ui.f_mm = e.props.f * 1e3;
            live(elFolder.add(ui, "f_mm", -10000, 10000, 0.1).name("f (mm)"),
                v => { e.props.f = Number(v) * 1e-3; updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize); doRecompute(); });
        }
    }

    // Unified Mirror + Dichroic UI
    if (tag?.type === "mirror") {
        const e = elements.find(x => x.mesh === selObj); if (e) {
            ui.m_flat = !!e.props.flat;
            ui.R_mm = e.props.R * 1e3;
            ui.m_refl = (e.props.refl ?? 1);
            ui.m_dich = !!e.props.dichroic;

            ui.reflMin_nm = e.props.reflBand_nm?.min ?? 400;
            ui.reflMax_nm = e.props.reflBand_nm?.max ?? 700;
            ui.transMin_nm = e.props.transBand_nm?.min ?? 700;
            ui.transMax_nm = e.props.transBand_nm?.max ?? 1100;

            let rCtrl;

            elFolder.add(ui, "m_flat").name("Flat (R = ∞)")
                .onChange(v => {
                    e.props.flat = !!v;
                    updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize);
                    doRecompute(); refreshAfterRecompute();
                    const row = rCtrl?.domElement?.closest?.(".controller");
                    if (row) { row.style.opacity = v ? "0.5" : "1.0"; row.style.pointerEvents = v ? "none" : "auto"; }
                    State.pushHistory();
                });

            rCtrl = elFolder.add(ui, "R_mm", -20000, 20000, 0.1).name("Radius R (mm)")
                .onFinishChange(v => { e.props.R = Number(v) * 1e-3; updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize); doRecompute(); refreshAfterRecompute(); State.pushHistory(); });

            const reflCtrl = live(elFolder.add(ui, "m_refl", 0, 1, 0.01).name("Reflectance"),
                v => { e.props.refl = Math.min(1, Math.max(0, Number(v))); updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize); doRecompute(); });

            elFolder.add(ui, "m_dich").name("Dichroic")
                .onChange(v => {
                    e.props.dichroic = !!v;
                    updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize);
                    if (v) { reflCtrl.disable?.(); } else { reflCtrl.enable?.(); }
                    const row = reflCtrl.domElement?.closest?.(".controller");
                    if (row) { row.style.opacity = v ? "0.5" : "1.0"; row.style.pointerEvents = v ? "none" : "auto"; }
                    doRecompute(); refreshAfterRecompute();
                    State.pushHistory();
                });

            const fr = elFolder.addFolder("Dichroic Bands (nm)");
            const enableBands = (on) => { fr.domElement.style.opacity = on ? "1.0" : "0.5"; fr.domElement.style.pointerEvents = on ? "auto" : "none"; };
            const clampRange = (minKey, maxKey, apply) => (() => {
                const minV = Number(ui[minKey]), maxV = Number(ui[maxKey]);
                if (Number.isFinite(minV) && Number.isFinite(maxV)) {
                    if (minV > maxV) { const t = ui[minKey]; ui[minKey] = ui[maxKey]; ui[maxKey] = t; }
                    apply();
                }
            });

            fr.add(ui, "reflMin_nm").name("Reflect min")
                .onFinishChange(clampRange("reflMin_nm", "reflMax_nm", () => {
                    e.props.reflBand_nm = { min: Number(ui.reflMin_nm), max: Number(ui.reflMax_nm) };
                    updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize); doRecompute(); refreshAfterRecompute(); State.pushHistory();
                }));
            fr.add(ui, "reflMax_nm").name("Reflect max")
                .onFinishChange(clampRange("reflMin_nm", "reflMax_nm", () => {
                    e.props.reflBand_nm = { min: Number(ui.reflMin_nm), max: Number(ui.reflMax_nm) };
                    updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize); doRecompute(); refreshAfterRecompute(); State.pushHistory();
                }));
            fr.add(ui, "transMin_nm").name("Transmit min")
                .onFinishChange(clampRange("transMin_nm", "transMax_nm", () => {
                    e.props.transBand_nm = { min: Number(ui.transMin_nm), max: Number(ui.transMax_nm) };
                    updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize); doRecompute(); refreshAfterRecompute(); State.pushHistory();
                }));
            fr.add(ui, "transMax_nm").name("Transmit max")
                .onFinishChange(clampRange("transMin_nm", "transMax_nm", () => {
                    e.props.transBand_nm = { min: Number(ui.transMin_nm), max: Number(ui.transMax_nm) };
                    updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize); doRecompute(); refreshAfterRecompute(); State.pushHistory();
                }));

            if (e.props.flat) {
                const row = rCtrl?.domElement?.closest?.(".controller");
                if (row) { row.style.opacity = "0.5"; row.style.pointerEvents = "none"; }
            }
            if (e.props.dichroic) {
                reflCtrl.disable?.();
                const row = reflCtrl.domElement?.closest?.(".controller");
                if (row) { row.style.opacity = "0.5"; row.style.pointerEvents = "none"; }
            }
            enableBands(!!e.props.dichroic);
        }
    }

    // Polarization elements
    if (tag?.type === "polarizer") {
        const e = elements.find(x => x.mesh === selObj); if (e) {
            ui.axis_deg = e.props.axisDeg;
            live(elFolder.add(ui, "axis_deg", -180, 180, 1).name("Axis angle (deg)"),
                v => {
                    e.props.axisDeg = Number(v);
                    if (e.ugi && e.ugi.setAngle) e.ugi.setAngle(Number(v));
                    doRecompute();
                });
        }
    }
    if (tag?.type === "waveplate") {
        const e = elements.find(x => x.mesh === selObj); if (e) {
            ui.axis_deg = e.props.axisDeg;
            ui.waveplate_type = e.props.type || "HWP";
            ui.delta_deg = THREE.MathUtils.radToDeg(e.props.delta);

            live(elFolder.add(ui, "axis_deg", -180, 180, 1).name("Fast-axis (deg)"),
                v => {
                    e.props.axisDeg = Number(v);
                    if (e.ugi && e.ugi.setAngle) e.ugi.setAngle(Number(v));
                    doRecompute();
                });

            const deltaCtrl = live(elFolder.add(ui, "delta_deg", 0, 720, 1).name("Retardance Δ (deg)"),
                v => {
                    e.props.delta = THREE.MathUtils.degToRad(Number(v));
                    updateElementLabel(e);
                    GizmoUI.correctLabelScale(e.mesh, params.labelFontSize);
                    doRecompute();
                });

            const toggleDeltaControl = (enabled) => {
                if (deltaCtrl) {
                    const row = deltaCtrl.domElement?.closest?.(".controller");
                    if (row) {
                        row.style.opacity = enabled ? "1.0" : "0.5";
                        row.style.pointerEvents = enabled ? "auto" : "none";
                    }
                }
            };

            elFolder.add(ui, "waveplate_type", ["HWP", "QWP", "Custom"]).name("Type")
                .onChange(v => {
                    e.props.type = v;
                    if (v === "HWP") {
                        e.props.delta = Math.PI;
                        toggleDeltaControl(false);
                    } else if (v === "QWP") {
                        e.props.delta = Math.PI / 2;
                        toggleDeltaControl(false);
                    } else {
                        toggleDeltaControl(true);
                    }

                    ui.delta_deg = THREE.MathUtils.radToDeg(e.props.delta);
                    deltaCtrl.updateDisplay();

                    updateElementLabel(e);
                    GizmoUI.correctLabelScale(e.mesh, params.labelFontSize);
                    doRecompute();
                    refreshAfterRecompute();
                    State.pushHistory();
                });

            toggleDeltaControl(e.props.type === 'Custom');
        }
    }
    if (tag?.type === "faraday") {
        const e = elements.find(x => x.mesh === selObj); if (e) {
            ui.faraday_deg = e.props.phiDeg;
            live(elFolder.add(ui, "faraday_deg", -180, 180, 1).name("Rotation (deg)"),
                v => { e.props.phiDeg = Number(v); updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize); doRecompute(); });
        }
    }

    // Beam Splitter / PBS
    if (tag?.type === "beamSplitter") {
        const e = elements.find(x => x.mesh === selObj); if (!e) return;
        ui.bs_polarizing = e.props.polarizing;
        ui.bs_transmit = e.props.polTransmit || "Vertical";
        ui.bs_R = e.props.R ?? 0.5;

        ui._bsRController = live(elFolder.add(ui, "bs_R", 0, 1, 0.01).name("Reflectance R"),
            v => { e.props.R = Math.min(1, Math.max(0, Number(v))); updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize); doRecompute(); });

        const polCtrl = elFolder.add(ui, "bs_polarizing").name("Polarizing (PBS)");

        const transmitCtrl = elFolder.add(ui, "bs_transmit", ["Vertical", "Horizontal"]).name("PBS transmits")
            .onChange(v => { e.props.polTransmit = v; updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize); doRecompute(); refreshAfterRecompute(); State.pushHistory(); });

        const toggleTransmitControl = (enabled) => {
            if (transmitCtrl) {
                const row = transmitCtrl.domElement?.closest?.(".controller");
                if (row) {
                    row.style.opacity = enabled ? "1.0" : "0.5";
                    row.style.pointerEvents = enabled ? "auto" : "none";
                }
            }
        };

        polCtrl.onChange(v => {
            e.props.polarizing = !!v;
            updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize);
            v ? ui._bsRController.disable() : ui._bsRController.enable();
            toggleTransmitControl(!!v);
            doRecompute(); refreshAfterRecompute(); State.pushHistory();
        });

        if (e.props.polarizing) {
            ui._bsRController.disable?.();
        }
        toggleTransmitControl(e.props.polarizing);
    }

    // ----- Diffraction Grating -----
    if (tag?.type === "grating") {
        const e = elements.find(x => x.mesh === selObj); if (!e) return;

        ui.gr_mode = (e.props.mode === "transmissive") ? "Transmissive" : "Reflective";
        ui.gr_d_um = e.props.d_um;
        ui.gr_orders = e.props.orders;

        elFolder.add(ui, "gr_mode", ["Reflective", "Transmissive"]).name("Type")
            .onChange(v => {
                e.props.mode = (v === "Transmissive" ? "transmissive" : "reflective");
                updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize);
                doRecompute(); refreshAfterRecompute();
                State.pushHistory();
            });

        const cD = elFolder.add(ui, "gr_d_um", 0.05, 50, 0.001).name("Spacing d (µm)");
        live(cD, v => {
            e.props.d_um = Math.max(1e-6, Number(v));
            updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize);
            doRecompute();
        });

        const cM = elFolder.add(ui, "gr_orders", 0, 10, 1).name("± Orders");
        live(cM, v => {
            e.props.orders = Math.max(0, Math.floor(Number(v)));
            updateElementLabel(e); GizmoUI.correctLabelScale(e.mesh, params.labelFontSize);
            doRecompute();
        });

        const info = gratingLastInfo.get(e.id);
        const fr = elFolder.addFolder("Orders (Show, θ, Dispersion)");
        if (info) {
            const hdr = { text: `Incidence α ≈ ${info.alphaDeg.toFixed(2)}°` };
            fr.add(hdr, "text").name("α (deg)").disable?.();

            if (!e.props.visibleOrders) e.props.visibleOrders = {};

            for (const ent of info.entries) {
                const m = String(ent.m);
                if (e.props.visibleOrders[m] === undefined) {
                    e.props.visibleOrders[m] = true;
                }
                const label = `m=${m}: θ=${ent.thetaDeg.toFixed(2)}°, D=${(ent.disp_deg_per_nm === Infinity ? '∞' : ent.disp_deg_per_nm.toFixed(4))} °/nm`;
                fr.add(e.props.visibleOrders, m).name(label)
                    .onFinishChange(() => {
                        doRecompute();
                        State.pushHistory();
                    });
            }
        } else {
            const none = { hint: "(Aim a beam at this grating to populate angles)" };
            fr.add(none, "hint").name("—");
        }
    }

    const actionsFolder = elFolder.addFolder('Actions');
    const buttonActions = {
        'Duplicate': duplicateSelectedElement,
        'Delete': deleteSelectedElement,
        'Center to Beam': centerSelectedElementToBeam,
    };

    const dupCtrl = actionsFolder.add(buttonActions, 'Duplicate');
    const delCtrl = actionsFolder.add(buttonActions, 'Delete');
    const centerCtrl = actionsFolder.add(buttonActions, 'Center to Beam');

    // Disable the center button if no beam information is available
    if (!info) {
        centerCtrl.disable();
    }
    
    // Use CSS to style the buttons horizontally
    const container = actionsFolder.domElement.querySelector('.children');
    if (container) {
        container.style.display = 'flex';
        container.style.justifyContent = 'space-around';
        container.style.gap = '4px';
        container.style.padding = '4px';
        
        // Make individual button containers flexible
        [dupCtrl, delCtrl, centerCtrl].forEach(ctrl => {
            if (ctrl && ctrl.domElement) {
                ctrl.domElement.style.flex = '1';
                const button = ctrl.domElement.querySelector('button');
                if (button) {
                    button.style.width = '100%';
                }
            }
        });
    }

    // Hide the folder title to make it look like a seamless part of the panel
    const titleElement = actionsFolder.domElement.querySelector('.title');
    if (titleElement) {
        titleElement.style.display = 'none';
    }
}

// A map of functions for recreating elements from their type string, needed by state.js
const recreateFuncs = {
    'lens': makeLens, 'mirror': makeMirror, 'polarizer': makePolarizer,
    'waveplate': makeWaveplate, 'faraday': makeFaraday, 'beamSplitter': makeBeamSplitter,
    'beamBlock': makeBeamBlock, 'grating': makeGrating, 'multimeter': makeMultimeter
};

State.init({
    params, sources: Sources.sources, elements, selectable, ugiPickables, scene, grid, tcontrols,
    addSource: Sources.addSource, addElement, removeSourceByGroup: Sources.removeSourceByGroup, syncSourceW0ZR: Sources.syncSourceW0ZR,
    doRecompute, refreshSelectedUI,
    Ruler, GizmoUI,
    beamWidthScaleController, showGridController, showLabelsController, labelFontSizeController,
    recreateFuncs
});

/* ========= Demo ========= */
addElement(makeLens({ f: 0.05 }), new THREE.Vector3(0, 0, 0.05));
const mirrorEl = addElement(makeMirror({ flat: true, refl: 1.0 }), new THREE.Vector3(0, 0, 0.135));
mirrorEl.mesh.rotation.y = Math.PI / 4;
const source = Sources.addSource({ position: new THREE.Vector3(0, 0, 0) });
source.props.wavelength_nm = 530;
source.props.waist_w0_um = 200;
Sources.syncSourceW0ZR(source);
refreshSelectedUI();

/* ========= First compute ========= */
doRecompute();
State.pushHistory();

/* ========= Animation ========= */
const clock = new THREE.Clock();
function animate() {
    pol.animate(polGroup, clock.getElapsedTime());
    orbit.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}
animate();

/* ========= Resize ========= */
window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});

/* ========= Warn Before Unload ========= */
window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = ''; });