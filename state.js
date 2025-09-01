/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// state.js — Manages history (undo/redo) and save/load functionality.
import * as THREE from 'three';

const history = [];
let historyIndex = -1;
const MAX_HISTORY = 50;
let isRestoringState = false;
let fileInput = null;

// This context object will be populated by main.js on initialization.
// It holds all the necessary functions and references to manipulate the scene.
let _context = {};

/**
 * Initializes the state manager with the application's context.
 * This must be called once from main.js after the scene is set up.
 * @param {object} context - An object containing functions and data arrays from the main app.
 */
export function init(context) {
    _context = context;

    // Create the hidden file input for loading states
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const state = JSON.parse(e.target.result);
                restoreState(state);
                pushHistory(); // Make the loaded state an undoable step
            } catch (error) {
                alert('Error loading file. Make sure it is a valid setup JSON file.');
                console.error(error);
            }
        };
        reader.readAsText(file);
        fileInput.value = ''; // Reset input so the same file can be loaded again
    });
}

/**
 * Returns true if the application is currently in the process of restoring a state.
 * This is used to prevent actions like pushing to history during a restore.
 * @returns {boolean}
 */
export function isRestoring() {
    return isRestoringState;
}

/**
 * Captures the current state of the entire simulation.
 * @returns {object} A serializable object representing the scene state.
 */
function captureState() {
    const state = {
        params: {
            beamWidthScale: _context.params.beamWidthScale,
            showGrid: _context.params.showGrid,
            showLabels: _context.params.showLabels,
            labelFontSize: _context.params.labelFontSize
        },
        sources: [],
        elements: [],
        ruler: null
    };
    
    const ruler = _context.Ruler.getRuler();
    if (ruler) {
        state.ruler = {
            p1: ruler.points.p1.position.toArray(),
            p2: ruler.points.p2.position.toArray(),
            p3: ruler.points.p3.position.toArray()
        };
    }

    _context.sources.forEach(src => {
        state.sources.push({
            props: JSON.parse(JSON.stringify(src.props)),
            position: src.group.position.toArray(),
            quaternion: src.group.quaternion.toArray(),
            scale: src.group.scale.toArray()
        });
    });

    _context.elements.forEach(el => {
        state.elements.push({
            type: el.type,
            props: JSON.parse(JSON.stringify(el.props)),
            position: el.mesh.position.toArray(),
            quaternion: el.mesh.quaternion.toArray(),
            scale: el.mesh.scale.toArray()
        });
    });

    return state;
}

/**
 * Restores the simulation to a previously captured state.
 * @param {object} state - A state object created by captureState.
 */
function restoreState(state) {
    if (!state) return;
    isRestoringState = true;

    // Restore global parameters
    if (state.params) {
        Object.assign(_context.params, state.params);
        _context.beamWidthScaleController?.updateDisplay();
        _context.showGridController?.updateDisplay();
        _context.showLabelsController?.updateDisplay();
        _context.labelFontSizeController?.updateDisplay();
    }
    _context.grid.visible = _context.params.showGrid;

    // Clear the scene
    _context.tcontrols.detach();
    while (_context.sources.length) _context.removeSourceByGroup(_context.sources[0].group);
    while (_context.elements.length) {
        const el = _context.elements[0];
        const obj = el.mesh;
        _context.scene.remove(obj);
        _context.selectable.splice(_context.selectable.indexOf(obj), 1);
        const uh = el.ugi?.handle;
        if (uh) _context.ugiPickables.splice(_context.ugiPickables.indexOf(uh), 1);
        _context.elements.shift();
    }
    
    // Re-create sources
    state.sources.forEach(sState => {
        const newSource = _context.addSource({ 
            position: new THREE.Vector3().fromArray(sState.position),
        });
        newSource.group.quaternion.fromArray(sState.quaternion);
        Object.assign(newSource.props, sState.props);
        if (sState.scale) newSource.group.scale.fromArray(sState.scale);
        _context.syncSourceW0ZR(newSource);
    });

    // Re-create elements
    state.elements.forEach(eState => {
        const newEl = _context.recreateFuncs[eState.type](eState.props);
        if (newEl) {
            if (newEl.type === 'grating') newEl.props.visibleOrders = eState.props.visibleOrders || {};
            const newPos = new THREE.Vector3().fromArray(eState.position);
            _context.addElement(newEl, newPos);
            newEl.mesh.quaternion.fromArray(eState.quaternion);
            if (eState.scale) {
                newEl.mesh.scale.fromArray(eState.scale);
                _context.GizmoUI.correctLabelScale(newEl.mesh, _context.params.labelFontSize);
            }
        }
    });

    // Restore ruler
    const rulerContext = { scene: _context.scene, selectable: _context.selectable, tcontrols: _context.tcontrols, pushHistory, isRestoringState: true };
    if (_context.Ruler.doesRulerExist() && !state.ruler) {
        _context.Ruler.removeRuler(rulerContext);
    } else if (!_context.Ruler.doesRulerExist() && state.ruler) {
        _context.Ruler.addRuler(rulerContext, new THREE.Vector3().fromArray(state.ruler.p2));
    }
    const currentRuler = _context.Ruler.getRuler();
    if (currentRuler && state.ruler) {
        currentRuler.points.p1.position.fromArray(state.ruler.p1);
        currentRuler.points.p2.position.fromArray(state.ruler.p2);
        currentRuler.points.p3.position.fromArray(state.ruler.p3);
        _context.Ruler.updateRuler();
    }

    // Final updates
    _context.elements.forEach(el => {
        const label = el.mesh.children.find(child => child.isSprite);
        if(label) label.visible = _context.params.showLabels;
        _context.GizmoUI.correctLabelScale(el.mesh, _context.params.labelFontSize);
    });

    _context.tcontrols.detach();
    _context.doRecompute();
    _context.refreshSelectedUI();

    setTimeout(() => { isRestoringState = false; }, 50);
}

/**
 * Pushes the current application state onto the history stack.
 */
export function pushHistory() {
    if (isRestoringState) return;

    if (historyIndex < history.length - 1) {
        history.splice(historyIndex + 1);
    }

    const currentState = captureState();
    history.push(currentState);

    if (history.length > MAX_HISTORY) {
        history.shift();
    }

    historyIndex = history.length - 1;
}

/**
 * Reverts the application to the previous state in the history stack.
 */
export function undo() {
    if (historyIndex > 0) {
        historyIndex--;
        restoreState(history[historyIndex]);
    }
}

/**
 * Advances the application to the next state in the history stack.
 */
export function redo() {
    if (historyIndex < history.length - 1) {
        historyIndex++;
        restoreState(history[historyIndex]);
    }
}

/**
 * Triggers a file download of the current application state.
 */
export function saveState() {
    const state = captureState();
    const jsonString = JSON.stringify(state, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'optical_setup.json';
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Opens a file dialog to load a previously saved state.
 */
export function loadState() {
    if (fileInput) {
        fileInput.click();
    }
}