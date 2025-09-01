/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// gizmo-ui.js — Manages TransformControls and the associated bottom HUD.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

let currentGizmoMode = 'translate'; // 'translate', 'rotate', or 'scale'
let gizmoControlsUI = null;
let _gizmoPointerDown = false;

// All transform controls are created here but exported for main.js to use
export const tcontrols = {};

/**
 * Corrects the scale of a child label sprite so it maintains a constant
 * apparent size in the world, regardless of its parent's scale.
 * @param {THREE.Object3D} scaledObject - The object whose label needs correction.
 * @param {number} globalFontSize - A global font size multiplier.
 */
export function correctLabelScale(scaledObject, globalFontSize = 1.0) {
    if (!scaledObject) return;

    const label = scaledObject.children.find(child => child.isSprite);
    if (label) {
        // Store the desired world-space scale on first run
        if (!label.userData.desiredWorldScale) {
             const initialParentScale = new THREE.Vector3(2, 2, 2); // Default initial scale
             label.userData.desiredWorldScale = label.scale.clone().multiply(initialParentScale);
        }

        scaledObject.updateMatrixWorld(true);

        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        scaledObject.matrixWorld.decompose(position, quaternion, worldScale);

        const desired = label.userData.desiredWorldScale.clone().multiplyScalar(globalFontSize);

        // Avoid division by zero if scale is tiny
        if (Math.abs(worldScale.x) > 1e-9 && Math.abs(worldScale.y) > 1e-9) {
             label.scale.x = desired.x / worldScale.x;
             label.scale.y = desired.y / worldScale.y;
        }
    }
}

/**
 * Sets up and injects the HTML and CSS for the gizmo control UI.
 * This should be called once on initialization.
 * @param {function} recomputeFn - The main recompute function to call on changes.
 * @param {function} pushHistoryFn - The function to call to save an undo state.
 * @param {function} refreshSelectedUIFn - The function to refresh the main GUI panel.
 */
function setupGizmoUI(recomputeFn, pushHistoryFn, refreshSelectedUIFn) {
    // Inject CSS for the buttons and input fields
    const styles = `
        #gizmo-controls {
            position: absolute;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            display: none; /* Initially hidden */
            gap: 10px;
            background: rgba(40, 40, 40, 0.7);
            padding: 8px;
            border-radius: 8px;
            z-index: 100;
            flex-direction: column;
            align-items: center;
        }
        .gizmo-btn-container {
            display: flex;
            gap: 10px;
        }
        .gizmo-btn {
            background-color: #333;
            color: #eee;
            border: 1px solid #555;
            padding: 8px 16px;
            border-radius: 5px;
            cursor: pointer;
            font-family: sans-serif;
            font-size: 14px;
        }
        .gizmo-btn.active {
            background-color: #5a5a5a;
            border-color: #888;
            color: white;
        }
        .gizmo-input-container {
            display: flex;
            gap: 15px;
            padding-top: 8px;
            align-items: center;
        }
        .gizmo-input-group {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .gizmo-input-group label {
            color: #ccc;
            font-family: sans-serif;
            font-size: 12px;
        }
        .gizmo-input-group input {
            width: 60px;
            background: #222;
            border: 1px solid #555;
            color: #eee;
            border-radius: 3px;
            padding: 4px;
            font-family: monospace;
            text-align: right;
        }
    `;
    const styleSheet = document.createElement("style");
    styleSheet.innerText = styles;
    document.head.appendChild(styleSheet);

    // Create HTML elements
    const container = document.createElement('div');
    container.id = 'gizmo-controls';
    gizmoControlsUI = container;

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'gizmo-btn-container';

    const translateBtn = document.createElement('button');
    translateBtn.id = 'gizmo-btn-translate';
    translateBtn.className = 'gizmo-btn active';
    translateBtn.innerText = 'Translate';
    translateBtn.onclick = () => setGizmoMode('translate');

    const rotateBtn = document.createElement('button');
    rotateBtn.id = 'gizmo-btn-rotate';
    rotateBtn.className = 'gizmo-btn';
    rotateBtn.innerText = 'Rotate';
    rotateBtn.onclick = () => setGizmoMode('rotate');
    
    const scaleBtn = document.createElement('button');
    scaleBtn.id = 'gizmo-btn-scale';
    scaleBtn.className = 'gizmo-btn';
    scaleBtn.innerText = 'Resize';
    scaleBtn.onclick = () => setGizmoMode('scale');

    buttonContainer.appendChild(translateBtn);
    buttonContainer.appendChild(rotateBtn);
    buttonContainer.appendChild(scaleBtn);
    container.appendChild(buttonContainer);

    // --- Translate Inputs ---
    const translateInputs = document.createElement('div');
    translateInputs.id = 'gizmo-translate-inputs';
    translateInputs.className = 'gizmo-input-container';
    ['X', 'Y', 'Z'].forEach(axis => {
        const group = document.createElement('div');
        group.className = 'gizmo-input-group';
        const label = document.createElement('label');
        label.innerText = `${axis} (mm)`;
        const input = document.createElement('input');
        input.id = `gizmo-pos-${axis.toLowerCase()}`;
        input.type = 'number';
        input.step = 0.1;
        input.onchange = () => {
            const selObj = tcontrols.main.object;
            if (!selObj) return;
            const val = parseFloat(input.value) / 1000;
            if (Number.isFinite(val)) {
                selObj.position[axis.toLowerCase()] = val;
                // clampToPlaneXZ is handled in main.js via event listener
                recomputeFn();
                pushHistoryFn();
            }
        };
        group.appendChild(label);
        group.appendChild(input);
        translateInputs.appendChild(group);
    });
    container.appendChild(translateInputs);

    // --- Rotate Inputs ---
    const rotateInputs = document.createElement('div');
    rotateInputs.id = 'gizmo-rotate-inputs';
    rotateInputs.className = 'gizmo-input-container';
    
    // Yaw
    const yawGroup = document.createElement('div');
    yawGroup.className = 'gizmo-input-group';
    const yawLabel = document.createElement('label');
    yawLabel.innerText = 'Yaw (deg)';
    const yawInput = document.createElement('input');
    yawInput.id = 'gizmo-rot-yaw';
    yawInput.type = 'number';
    yawInput.step = 1;
    yawInput.onchange = () => {
        const selObj = tcontrols.main.object;
        if (!selObj) return;
        const val = parseFloat(yawInput.value);
        if (Number.isFinite(val)) {
            const e = new THREE.Euler().setFromQuaternion(selObj.quaternion, 'YXZ');
            e.y = THREE.MathUtils.degToRad(val);
            selObj.setRotationFromEuler(e);
            recomputeFn();
            pushHistoryFn();
        }
    };
    yawGroup.appendChild(yawLabel);
    yawGroup.appendChild(yawInput);
    rotateInputs.appendChild(yawGroup);

    // Tilt
    const tiltGroup = document.createElement('div');
    tiltGroup.className = 'gizmo-input-group';
    const tiltLabel = document.createElement('label');
    tiltLabel.innerText = 'Tilt (deg)';
    const tiltInput = document.createElement('input');
    tiltInput.id = 'gizmo-rot-tilt';
    tiltInput.type = 'number';
    tiltInput.step = 1;
    tiltInput.onchange = () => {
        const selObj = tcontrols.main.object;
        if (!selObj) return;
        const val = parseFloat(tiltInput.value);
        if (Number.isFinite(val)) {
            const e = new THREE.Euler().setFromQuaternion(selObj.quaternion, 'YXZ');
            e.x = THREE.MathUtils.degToRad(val);
            selObj.setRotationFromEuler(e);
            recomputeFn();
            pushHistoryFn();
        }
    };
    tiltGroup.appendChild(tiltLabel);
    tiltGroup.appendChild(tiltInput);
    rotateInputs.appendChild(tiltGroup);
    
    container.appendChild(rotateInputs);

    // --- Scale Inputs ---
    const scaleInputs = document.createElement('div');
    scaleInputs.id = 'gizmo-scale-inputs';
    scaleInputs.className = 'gizmo-input-container';

    // Width
    const widthGroup = document.createElement('div');
    widthGroup.className = 'gizmo-input-group';
    const widthLabel = document.createElement('label');
    widthLabel.innerText = 'Width';
    const widthInput = document.createElement('input');
    widthInput.id = 'gizmo-scale-width';
    widthInput.type = 'number';
    widthInput.step = 0.1;
    widthInput.onchange = () => {
        const selObj = tcontrols.main.object;
        if (!selObj) return;
        const val = parseFloat(widthInput.value);
        if (Number.isFinite(val) && val > 0) {
            selObj.scale.x = val;
            correctLabelScale(selObj); // Assumes default font size
            recomputeFn();
            pushHistoryFn();
        }
    };
    widthGroup.appendChild(widthLabel);
    widthGroup.appendChild(widthInput);
    scaleInputs.appendChild(widthGroup);

    // Height
    const heightGroup = document.createElement('div');
    heightGroup.className = 'gizmo-input-group';
    const heightLabel = document.createElement('label');
    heightLabel.innerText = 'Height';
    const heightInput = document.createElement('input');
    heightInput.id = 'gizmo-scale-height';
    heightInput.type = 'number';
    heightInput.step = 0.1;
    heightInput.onchange = () => {
        const selObj = tcontrols.main.object;
        if (!selObj) return;
        const val = parseFloat(heightInput.value);
        if (Number.isFinite(val) && val > 0) {
            selObj.scale.y = val;
            correctLabelScale(selObj); // Assumes default font size
            recomputeFn();
            pushHistoryFn();
        }
    };
    heightGroup.appendChild(heightLabel);
    heightGroup.appendChild(heightInput);
    scaleInputs.appendChild(heightGroup);

    // Reset Size Button
    const resetSizeBtn = document.createElement('button');
    resetSizeBtn.className = 'gizmo-btn';
    resetSizeBtn.innerText = 'Reset Size';
    resetSizeBtn.onclick = () => {
        const selObj = tcontrols.main.object;
        if (selObj) {
            selObj.scale.set(2, 2, 2);
            correctLabelScale(selObj); // Assumes default font size
            recomputeFn();
            pushHistoryFn();
            refreshSelectedUIFn(); // To update the input values
        }
    };
    scaleInputs.appendChild(resetSizeBtn);
    container.appendChild(scaleInputs);
    document.body.appendChild(container);
}

/**
 * Updates the visibility and enabled state of all gizmos and the UI panel.
 * Called when the selection changes or the mode is switched.
 */
export function updateGizmoState() {
    const objectIsAttached = !!tcontrols.main.object;

    // Show/hide the entire UI container
    if (gizmoControlsUI) {
        gizmoControlsUI.style.display = objectIsAttached ? 'flex' : 'none';
    }

    // Determine visibility of the 3D gizmos based on current mode
    const isTranslateMode = currentGizmoMode === 'translate';
    const isRotateMode = currentGizmoMode === 'rotate';
    const isScaleMode = currentGizmoMode === 'scale';

    // Main Translation Gizmo
    tcontrols.main.enabled = objectIsAttached && isTranslateMode;
    tcontrols.main.visible = objectIsAttached && isTranslateMode;

    // Yaw and Tilt Gizmos (only visible in Rotate mode)
    const rotateEnabled = objectIsAttached && isRotateMode;
    tcontrols.yaw.enabled = rotateEnabled;
    tcontrols.yaw.visible = rotateEnabled;
    tcontrols.tilt.enabled = rotateEnabled;
    tcontrols.tilt.visible = rotateEnabled;

    // Scale Gizmo
    const scaleEnabled = objectIsAttached && isScaleMode;
    tcontrols.scale.enabled = scaleEnabled;
    tcontrols.scale.visible = scaleEnabled;

    // Show/hide the input containers based on the current mode
    document.getElementById('gizmo-translate-inputs').style.display = isTranslateMode ? 'flex' : 'none';
    document.getElementById('gizmo-rotate-inputs').style.display = isRotateMode ? 'flex' : 'none';
    document.getElementById('gizmo-scale-inputs').style.display = isScaleMode ? 'flex' : 'none';
}


/**
 * Changes the active gizmo mode ('translate', 'rotate', or 'scale').
 * @param {string} mode - The new mode to activate.
 */
export function setGizmoMode(mode) {
    if (mode === currentGizmoMode) return;
    currentGizmoMode = mode;
    
    document.getElementById('gizmo-btn-translate').classList.toggle('active', mode === 'translate');
    document.getElementById('gizmo-btn-rotate').classList.toggle('active', mode === 'rotate');
    document.getElementById('gizmo-btn-scale').classList.toggle('active', mode === 'scale');

    updateGizmoState();
}

/**
 * Initializes all TransformControls gizmos and attaches them to the scene.
 * @param {THREE.Camera} camera - The main scene camera.
 * @param {HTMLElement} domElement - The renderer's DOM element.
 * @param {THREE.Scene} scene - The main scene.
 * @param {THREE.OrbitControls} orbit - The orbit controls instance.
 */
export function initGizmos(camera, domElement, scene, orbit) {
    // Main Translation Gizmo (handles X, Y, Z translation)
    const mainControls = new TransformControls(camera, domElement);
    mainControls.setMode('translate');
    mainControls.addEventListener('dragging-changed', e => orbit.enabled = !e.value);
    scene.add(mainControls);

    // Yaw Rotation Gizmo (handles World Y rotation)
    const yawControls = new TransformControls(camera, domElement);
    yawControls.setMode('rotate');
    yawControls.setSpace('world');
    yawControls.showX = false; yawControls.showZ = false; yawControls.showY = true;
    yawControls.addEventListener('dragging-changed', e => orbit.enabled = !e.value);
    scene.add(yawControls);

    // Tilt Rotation Gizmo (handles Local X rotation)
    const tiltControls = new TransformControls(camera, domElement);
    tiltControls.setMode('rotate');
    tiltControls.setSpace('local');
    tiltControls.showX = true; tiltControls.showZ = false; tiltControls.showY = false;
    tiltControls.addEventListener('dragging-changed', e => orbit.enabled = !e.value);
    scene.add(tiltControls);

    // Scaling Gizmo (handles Local X and Y scaling)
    const scaleControls = new TransformControls(camera, domElement);
    scaleControls.setMode('scale');
    scaleControls.setSpace('local');
    scaleControls.showZ = false; // Disable thickness scaling
    scaleControls.addEventListener('dragging-changed', e => orbit.enabled = !e.value);
    scene.add(scaleControls);

    // Assign to exported object
    tcontrols.main = mainControls;
    tcontrols.yaw = yawControls;
    tcontrols.tilt = tiltControls;
    tcontrols.scale = scaleControls;

    // Mark gizmo interaction to suppress click-based deselection
    const setGizmoPointerDown = () => { _gizmoPointerDown = true; };
    const setGizmoPointerUp = () => { _gizmoPointerDown = false; };

    Object.values(tcontrols).forEach(ctrl => {
        ctrl.addEventListener('mouseDown', setGizmoPointerDown);
        ctrl.addEventListener('mouseUp', setGizmoPointerUp);
    });
    window.addEventListener('pointerup', setGizmoPointerUp);

    // Keep all gizmos in sync with selection, then update their visibility
    const _attach0 = tcontrols.main.attach.bind(tcontrols.main);
    tcontrols.main.attach = function(obj) {
      if (obj?.rotation) obj.rotation.order = 'YXZ';
      _attach0(obj);
      try { tcontrols.yaw.attach(obj); } catch(e) {}
      try { tcontrols.tilt.attach(obj); } catch(e) {}
      try { tcontrols.scale.attach(obj); } catch(e) {}
      updateGizmoState();
    };
    
    const _detach0 = tcontrols.main.detach.bind(tcontrols.main);
    tcontrols.main.detach = function() {
        try { tcontrols.yaw.detach(); } catch(e) {}
        try { tcontrols.tilt.detach(); } catch(e) {}
        try { tcontrols.scale.detach(); } catch(e) {}
        _detach0();
        updateGizmoState();
    };
}

/**
 * Returns whether a gizmo is currently being interacted with.
 * Used to prevent deselection during a gizmo drag.
 * @returns {boolean}
 */
export function isGizmoPointerDown() {
    return _gizmoPointerDown;
}

/**
 * A wrapper to initialize the entire UI module.
 * @param {object} options - Contains camera, domElement, scene, orbit, and callback functions.
 */
export function setup({ camera, domElement, scene, orbit, recomputeFn, pushHistoryFn, refreshSelectedUIFn }) {
    initGizmos(camera, domElement, scene, orbit);
    setupGizmoUI(recomputeFn, pushHistoryFn, refreshSelectedUIFn);
    updateGizmoState(); // Initial call to ensure gizmos and UI are hidden
}