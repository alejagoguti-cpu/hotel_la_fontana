import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

/**
 * InteriorLook — "modo render" para el recorrido interior (aspecto tipo Lumion):
 *  · Materiales con relieve y variación de rugosidad (madera, telas, pañete, mármol, metales).
 *  · Iluminación de interior: reflejos de estudio (RoomEnvironment), luz de día suave que entra
 *    por la ventana (RectAreaLight), luz cálida de downlights y menos luz plana de cielo.
 *  · Posproceso de interior: oclusión ambiental de contacto, brillo (bloom) en ventanas y
 *    luminarias, gradación cálida con viñeta.
 * Todas las luces se crean una sola vez (intensidad 0 fuera del recorrido) para no obligar a la GPU
 * a recompilar los materiales al entrar a una habitación.
 */
// las telas con textura real ya traen su propio relieve; el ruido procedural solo se aplica al quilt y al lino
const FABRICS = ['QUILT', 'LINO'];
const SOLIDS = ['REF01', 'REF02', 'REF09', 'HALL_MARMOL', 'MARMOL', 'NOGAL', 'WALL_LISMORE', 'WALL_PAINT'];
const METALS = ['ACERO', 'ORO', 'CROMO'];

function noiseTexture(kind) {
  const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), img = g.createImageData(N, N), d = img.data;
  // ruido de valor suavizado + grano fino
  const rnd = new Float32Array(N * N).map(() => Math.random());
  const smooth = (x, y, s) => {
    let acc = 0, n = 0;
    for (let j = -s; j <= s; j++) for (let i = -s; i <= s; i++) { acc += rnd[((y + j + N) % N) * N + ((x + i + N) % N)]; n++; }
    return acc / n;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v;
      if (kind === 'fabric') {
        // tejido: trama y urdimbre
        const weave = (Math.sin(x * 1.6) * 0.5 + 0.5) * ((y >> 1) % 2) + (Math.sin(y * 1.6) * 0.5 + 0.5) * (((y >> 1) + 1) % 2);
        v = 0.55 + 0.3 * weave + 0.15 * (rnd[y * N + x] - 0.5);
      } else {
        v = 0.62 + 0.25 * (smooth(x, y, 3) - 0.5) * 2 + 0.12 * (rnd[y * N + x] - 0.5);
      }
      const b = Math.max(0, Math.min(255, v * 255));
      const k = (y * N + x) * 4; d[k] = d[k + 1] = d[k + 2] = b; d[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(kind === 'fabric' ? 6 : 2, kind === 'fabric' ? 6 : 2);
  return t;
}

/** Ajusta (una sola vez) los materiales de interiores de la biblioteca. */
export function upgradeInteriorMaterials(lib) {
  if (lib._interiorUpgraded) return;
  lib._interiorUpgraded = true;
  const grain = noiseTexture('grain'), fabric = noiseTexture('fabric');
  const get = (k) => lib.materials.get(k);
  for (const k of SOLIDS) {
    const m = get(k); if (!m) continue;
    if (!m.bumpMap) { m.bumpMap = grain; m.bumpScale = 0.6; }
    if (!m.roughnessMap) m.roughnessMap = grain;
    m.needsUpdate = true;
  }
  for (const k of FABRICS) {
    const m = get(k); if (!m) continue;
    m.bumpMap = fabric; m.bumpScale = 0.9; m.roughness = Math.max(m.roughness, 0.92);
    m.needsUpdate = true;
  }
  for (const k of METALS) {
    const m = get(k); if (!m) continue;
    m.roughness = Math.min(m.roughness, 0.28); m.metalness = Math.max(m.metalness, 0.85); m.envMapIntensity = 1.3; m.needsUpdate = true;
  }
  // piso de madera satinado y mármol pulido: reflejos suaves de la ventana
  const wood = get('REF01'); if (wood) { wood.roughness = 0.42; wood.envMapIntensity = 0.9; }
  ['MARMOL', 'HALL_MARMOL', 'REF02'].forEach((k) => { const m = get(k); if (m) { m.roughness = Math.min(m.roughness, 0.18); m.envMapIntensity = 1.1; } });
  const paint = get('WALL_PAINT'); if (paint) { paint.bumpScale = 0.35; paint.roughness = 0.9; }
}

export class InteriorLook {
  constructor(app) {
    this.app = app;
    this.on = false;
    RectAreaLightUniformsLib.init();
    const pmrem = new THREE.PMREMGenerator(app.renderer);
    this.roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    // luz de día de las ventanas (2 paneles) + se crean fijas, apagadas
    this.windowLights = [0, 1].map(() => {
      const l = new THREE.RectAreaLight(0xfff8ed, 0, 1.2, 1.4);
      app.scene.add(l);
      return l;
    });
  }

  /** Activa el modo render para la habitación `r` (de FloorTour). */
  enable(r) {
    const app = this.app, fx = app.postfx;
    if (!this.on) {
      this.on = true;
      this._saved = {
        hemi: app.hemiLight?.intensity,
        sun: app.sunLight?.intensity,
        bloom: fx?.bloom ? [fx.bloom.strength, fx.bloom.radius, fx.bloom.threshold] : null,
        grade: fx?.grade ? { c: fx.grade.uniforms.uContrast.value, s: fx.grade.uniforms.uSaturation.value, v: fx.grade.uniforms.uVignette.value, w: fx.grade.uniforms.uWarm.value.clone() } : null
      };
      if (app.hemiLight) app.hemiLight.intensity = this._saved.hemi * 0.38;
      if (app.sunLight) app.sunLight.intensity = this._saved.sun * 0.16;   // menos relleno plano: que mande la luz de las lámparas
      if (fx?.bloom) { fx.bloom.strength = 0.28; fx.bloom.radius = 0.5; fx.bloom.threshold = 0.93; }
      if (fx?.grade) {
        const u = fx.grade.uniforms;
        u.uContrast.value = 1.05; u.uSaturation.value = 1.06; u.uVignette.value = 0.22; u.uWarm.value.set(1.04, 1.0, 0.95);
      }
      // la oclusión ambiental va siempre encendida dentro de la habitación (también en GPUs integradas, con menos muestras):
      // sin ella las telas y la madera "flotan" y se ven de cera
      if (fx?.ao) { fx.ao.enabled = true; fx.ao.blendIntensity = 0.75; fx.ao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.3, thickness: 0.8, scale: 1.1, samples: fx.low ? 6 : 12 }); if (fx.low) fx.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 4 }); }
    }
    app.scene.environment = this.roomEnv;
    // ventanas de esta habitación → luz de área orientada hacia adentro
    this.windowLights.forEach((l, i) => {
      const w = r?.wins?.[i];
      if (!w) { l.intensity = 0; return; }
      const inward = new THREE.Vector3(-w.n.x, 0, -w.n.y);
      l.width = Math.max(0.8, w.w); l.height = 1.4;
      l.position.set(w.x, 3.02 + 1.6, w.z).addScaledVector(inward, w.t / 2 + 0.06);
      l.lookAt(l.position.clone().add(inward));
      l.intensity = 2.6;
    });
  }

  disable() {
    if (!this.on) return;
    this.on = false;
    const app = this.app, fx = app.postfx, s = this._saved;
    if (app.hemiLight && s.hemi != null) app.hemiLight.intensity = s.hemi;
    if (app.sunLight && s.sun != null) app.sunLight.intensity = s.sun;
    if (fx?.bloom && s.bloom) [fx.bloom.strength, fx.bloom.radius, fx.bloom.threshold] = s.bloom;
    if (fx?.grade && s.grade) {
      const u = fx.grade.uniforms;
      u.uContrast.value = s.grade.c; u.uSaturation.value = s.grade.s; u.uVignette.value = s.grade.v; u.uWarm.value.copy(s.grade.w);
    }
    if (fx?.ao) { fx.ao.enabled = fx.aoExterior; fx.ao.blendIntensity = 0.85; fx.ao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 2.0, scale: 1.0 }); }
    this.windowLights.forEach((l) => { l.intensity = 0; });
    app.scene.environment = app.skyEnv?.envRT?.texture || null;
  }

  /** El reloj solar puede reemplazar el entorno: mientras se está dentro, se mantiene el de interior. */
  update() {
    if (this.on && this.app.scene.environment !== this.roomEnv) this.app.scene.environment = this.roomEnv;
  }
}
