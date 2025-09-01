/*!
 * BeamBench Copyright (C) 2025 VisuPhy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ruler.js — A self-contained 3-point measurement tool for a Three.js scene.
import * as THREE from 'three';

let ruler = null;
let rulerFolder = null;
const rulerUIState = {
    p1: { x: 0, y: 0, z: 0 },
    p2: { x: 0, y: 0, z: 0 },
    p3: { x: 0, y: 0, z: 0 },
    readouts: {
        dist12: '0.00 mm',
        dist23: '0.00 mm',
        angle: '0.00°'
    }
};

/**
 * Creates and updates a 3D text label sprite.
 * @param {string} text - The initial text for the label.
 * @param {object} options - Style options for the label.
 * @returns {THREE.Sprite} - The created sprite with an `updateText` method.
 */
function makeRulerLabel(text, { fontSize = 48, color = 'white', background = 'rgba(0,0,0,0.5)' } = {}) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `Bold ${fontSize}px Arial`;

    const w = Math.max(1, ctx.measureText(text).width + 20);
    const h = fontSize + 16;
    canvas.width = w;
    canvas.height = h;

    ctx.font = `Bold ${fontSize}px Arial`;
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
    }
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(w / 40000, h / 40000, 1);
    spr.renderOrder = 10;
    
    // #################### FIX IS HERE ####################
    // Attach a robust update function to the sprite for efficient text changes.
    // This version creates a new canvas and texture each time to avoid WebGL errors
    // that can occur when resizing an existing canvas texture.
    spr.updateText = function(newText) {
        const newCanvas = document.createElement('canvas');
        const newCtx = newCanvas.getContext('2d');
        newCtx.font = `Bold ${fontSize}px Arial`;

        const w = Math.max(1, newCtx.measureText(newText).width + 20);
        const h = fontSize + 16;
        newCanvas.width = w;
        newCanvas.height = h;

        newCtx.font = `Bold ${fontSize}px Arial`;
        if (background) {
            newCtx.fillStyle = background;
            newCtx.fillRect(0, 0, w, h);
        }
        newCtx.fillStyle = color;
        newCtx.textAlign = 'center';
        newCtx.textBaseline = 'middle';
        newCtx.fillText(newText, w / 2, h / 2);
        
        const newTexture = new THREE.CanvasTexture(newCanvas);
        newTexture.minFilter = THREE.LinearFilter;
        
        // Dispose of the old texture to prevent memory leaks
        this.material.map?.dispose();
        
        this.material.map = newTexture;
        this.material.needsUpdate = true;
        this.scale.set(w / 40000, h / 40000, 1);
    };
    // ######################################################

    return spr;
}


/**
 * Adds the measurement ruler to the scene.
 * @param {object} context - Main app context: { scene, selectable, tcontrols, pushHistory, isRestoringState }.
 * @param {THREE.Vector3} position - The initial center position for the ruler.
 * @returns {object|null} The created ruler object or null if it already exists.
 */
export function addRuler(context, position = new THREE.Vector3(0, 0, 0)) {
    if (ruler) return null;
    const { scene, selectable, tcontrols, pushHistory, isRestoringState } = context;

    const group = new THREE.Group();
    group.name = "Ruler";

    const pointGeo = new THREE.SphereGeometry(0.0015, 16, 12);
    const p1Mat = new THREE.MeshStandardMaterial({ color: 0xff8080 });
    const p2Mat = new THREE.MeshStandardMaterial({ color: 0x80ff80 });
    const p3Mat = new THREE.MeshStandardMaterial({ color: 0x8080ff });

    const p1 = new THREE.Mesh(pointGeo, p1Mat);
    p1.position.copy(position).add(new THREE.Vector3(-0.02, 0, 0));
    p1.userData = { isRulerPoint: true, pointId: 'p1' };

    const p2 = new THREE.Mesh(pointGeo, p2Mat);
    p2.position.copy(position);
    p2.userData = { isRulerPoint: true, pointId: 'p2' };

    const p3 = new THREE.Mesh(pointGeo, p3Mat);
    p3.position.copy(position).add(new THREE.Vector3(0, 0, 0.02));
    p3.userData = { isRulerPoint: true, pointId: 'p3' };

    const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
    const l1 = new THREE.Line(new THREE.BufferGeometry(), lineMat);
    const l2 = new THREE.Line(new THREE.BufferGeometry(), lineMat);

    const p1Label = makeRulerLabel('P1'); p1.add(p1Label); p1Label.position.set(0, 0.0025, 0);
    const p2Label = makeRulerLabel('P2'); p2.add(p2Label); p2Label.position.set(0, 0.0025, 0);
    const p3Label = makeRulerLabel('P3'); p3.add(p3Label); p3Label.position.set(0, 0.0025, 0);

    const dist12Label = makeRulerLabel('0.00 mm');
    const dist23Label = makeRulerLabel('0.00 mm');
    const angleLabel = makeRulerLabel('0.00°');

    group.add(p1, p2, p3, l1, l2, dist12Label, dist23Label, angleLabel);
    scene.add(group);
    selectable.push(p1, p2, p3);

    ruler = {
        group,
        points: { p1, p2, p3 },
        lines: { l1, l2 },
        labels: { dist12: dist12Label, dist23: dist23Label, angle: angleLabel }
    };

    updateRuler();
    if (!isRestoringState) pushHistory();
    return ruler;
}

/**
 * Removes the measurement ruler from the scene and cleans up resources.
 * @param {object} context - Main app context: { scene, selectable, tcontrols, pushHistory, isRestoringState }.
 */
export function removeRuler(context) {
    if (!ruler) return;
    const { scene, selectable, tcontrols, pushHistory, isRestoringState } = context;
    
    tcontrols.detach();
    scene.remove(ruler.group);

    Object.values(ruler.points).forEach(p => {
        const index = selectable.indexOf(p);
        if (index > -1) selectable.splice(index, 1);
        p.geometry.dispose();
        p.material.dispose();
    });

    ruler.lines.l1.geometry.dispose();
    ruler.lines.l2.geometry.dispose();
    ruler.lines.l1.material.dispose();
    Object.values(ruler.labels).forEach(label => {
        label.material.map?.dispose();
        label.material.dispose();
    });

    ruler = null;
    if (rulerFolder) {
        rulerFolder.destroy();
        rulerFolder = null;
    }
    if (!isRestoringState) pushHistory();
}

/**
 * Updates the ruler's lines, labels, and UI readouts based on point positions.
 */
export function updateRuler() {
    if (!ruler) return;

    const { p1, p2, p3 } = ruler.points;
    const { l1, l2 } = ruler.lines;
    const { dist12: dist12Label, dist23: dist23Label, angle: angleLabel } = ruler.labels;

    l1.geometry.setFromPoints([p1.position, p2.position]);
    l2.geometry.setFromPoints([p2.position, p3.position]);

    const dist12 = p1.position.distanceTo(p2.position);
    const dist23 = p2.position.distanceTo(p3.position);

    const v1 = new THREE.Vector3().subVectors(p1.position, p2.position);
    const v2 = new THREE.Vector3().subVectors(p3.position, p2.position);
    const angle = THREE.MathUtils.radToDeg(v1.angleTo(v2));

    dist12Label.updateText(`${(dist12 * 1000).toFixed(2)} mm`);
    dist12Label.position.lerpVectors(p1.position, p2.position, 0.5).add(new THREE.Vector3(0, 0.0015, 0));
    dist23Label.updateText(`${(dist23 * 1000).toFixed(2)} mm`);
    dist23Label.position.lerpVectors(p2.position, p3.position, 0.5).add(new THREE.Vector3(0, 0.0015, 0));
    angleLabel.updateText(`${angle.toFixed(2)}°`);
    const bisector = v1.clone().normalize().add(v2.clone().normalize()).normalize();
    if (bisector.lengthSq() < 0.01) {
        bisector.crossVectors(v1, new THREE.Vector3(0, 1, 0)).normalize();
        if (bisector.lengthSq() < 0.01) bisector.set(1, 0, 0);
    }
    angleLabel.position.copy(p2.position).add(bisector.multiplyScalar(0.005));

    rulerUIState.readouts.dist12 = `${(dist12 * 1000).toFixed(2)} mm`;
    rulerUIState.readouts.dist23 = `${(dist23 * 1000).toFixed(2)} mm`;
    rulerUIState.readouts.angle = `${angle.toFixed(2)}°`;

    ['p1', 'p2', 'p3'].forEach(p => {
        rulerUIState[p].x = ruler.points[p].position.x * 1000;
        rulerUIState[p].y = ruler.points[p].position.y * 1000;
        rulerUIState[p].z = ruler.points[p].position.z * 1000;
    });

    if (rulerFolder) {
        rulerFolder.controllers.forEach(c => c.updateDisplay());
    }
}

/**
 * Creates or recreates the GUI panel for the measurement ruler.
 * @param {GUI} gui - The main lil-gui instance.
 * @param {function} pushHistory - The function to call to save an undo state.
 * @param {object} context - The main app context for removeRuler.
 */
export function buildRulerUI(gui, pushHistory, context) {
    if (rulerFolder) rulerFolder.destroy();

    rulerFolder = gui.addFolder("Measurement Tool");
    rulerFolder.open();

    const addPointControls = (pointName, pointObject) => {
        const folder = rulerFolder.addFolder(`Point ${pointName.toUpperCase()} Position (mm)`);
        folder.add(rulerUIState[pointName], 'x').name('X').onFinishChange(v => {
            pointObject.position.x = v / 1000; updateRuler(); pushHistory();
        });
        folder.add(rulerUIState[pointName], 'y').name('Y').onFinishChange(v => {
            pointObject.position.y = v / 1000; updateRuler(); pushHistory();
        });
        folder.add(rulerUIState[pointName], 'z').name('Z').onFinishChange(v => {
            pointObject.position.z = v / 1000; updateRuler(); pushHistory();
        });
    };

    addPointControls('p1', ruler.points.p1);
    addPointControls('p2', ruler.points.p2);
    addPointControls('p3', ruler.points.p3);

    const readoutsFolder = rulerFolder.addFolder("Readouts");
    readoutsFolder.add(rulerUIState.readouts, 'dist12').name('Dist P1-P2').disable();
    readoutsFolder.add(rulerUIState.readouts, 'dist23').name('Dist P2-P3').disable();
    readoutsFolder.add(rulerUIState.readouts, 'angle').name('Angle').disable();
    readoutsFolder.open();
    
    rulerFolder.add({ remove: () => removeRuler(context) }, 'remove').name("Delete Tool");
}

/**
 * Checks if a ruler exists in the scene.
 * @returns {boolean}
 */
export function doesRulerExist() {
    return !!ruler;
}

/**
 * Returns the current ruler instance.
 * @returns {object|null}
 */
export function getRuler() {
    return ruler;
}

/**
 * Destroys any existing ruler GUI folder.
 */
export function destroyRulerUI() {
    if (rulerFolder) {
        rulerFolder.destroy();
        rulerFolder = null;
    }
}