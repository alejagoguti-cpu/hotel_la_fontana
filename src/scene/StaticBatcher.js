import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * StaticBatcher — fusiona todos los objetos QUIETOS que comparten material en una sola malla.
 *
 * El modelo tenía ~14.000 mallas sueltas (cada muro, mueble, bordillo, raya vial…) y cada una es una
 * "llamada de dibujo" a la GPU, tres veces por cuadro (imagen, sombras y oclusión). En portátiles con
 * gráficos integrados eso dejaba la escena en ~3 FPS. Al fusionarlas por material quedan unos cientos.
 *
 * Las mallas originales se conservan ocultas: los clics (BIM, ventanas, habitaciones) siguen funcionando
 * porque el raycaster de three.js no depende de la visibilidad. Lo que se mueve (carros, semáforos,
 * fuente) se detecta comparando su posición en el tiempo y no se fusiona.
 */
const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();

function signature(geo) {
  const a = geo.attributes;
  return Object.keys(a).sort().map((k) => `${k}${a[k].itemSize}${a[k].array.constructor.name}${a[k].normalized ? 'n' : ''}`).join('|')
    + (geo.index ? '#i' : '#n') + (Object.keys(geo.morphAttributes || {}).length ? '#m' : '');
}

/** Toma una "foto" de las matrices de todas las mallas (para detectar después lo que se mueve). */
export function snapshotMatrices(roots) {
  const snap = new Map();
  roots.forEach((r) => r?.updateMatrixWorld(true));
  roots.forEach((r) => r?.traverse((o) => { if (o.isMesh || o.isLine) snap.set(o, o.matrixWorld.clone()); }));
  return snap;
}

export function movingSince(snap) {
  const moving = new Set();
  for (const [o, m] of snap) {
    o.updateWorldMatrix(true, false);
    if (!o.matrixWorld.equals(m)) moving.add(o);
  }
  return moving;
}

/**
 * Fusiona las mallas estáticas de `root` (en el espacio local de `root`, para que si `root` se mueve
 * — p. ej. la cubierta que se levanta — lo fusionado se mueva con él).
 */
export function batchStatic(root, { exclude = new Set(), minCount = 2 } = {}) {
  if (!root) return { merged: 0, meshes: 0 };
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const buckets = new Map();

  const blocked = (o) => {
    for (let p = o; p && p !== root; p = p.parent) {
      if (p.userData?.dynamic || p.userData?.isBatch || !p.visible) return true;
    }
    return false;
  };

  root.traverse((o) => {
    if (!(o.isMesh || o.isLineSegments) || o.isInstancedMesh || o.isSkinnedMesh || o.isPoints) return;
    if (exclude.has(o) || blocked(o) || o.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) return;
    const geo = o.geometry;
    if (!geo?.attributes?.position || geo.morphAttributes?.position) return;
    let mat = o.material;
    if (Array.isArray(mat)) {
      const uniq = [...new Set(mat)];
      if (uniq.length !== 1) return;
      mat = uniq[0];
    }
    if (!mat) return;
    const key = `${o.isMesh ? 'M' : 'L'}|${mat.uuid}|${signature(geo)}|${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}|${o.renderOrder}|${o.frustumCulled ? 1 : 0}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat, isMesh: o.isMesh, cast: o.castShadow, recv: o.receiveShadow, order: o.renderOrder, items: [] }));
    b.items.push(o);
  });

  let merged = 0, meshes = 0;
  for (const b of buckets.values()) {
    if (b.items.length < minCount) continue;
    const geos = [];
    try {
      for (const o of b.items) {
        const g = o.geometry.clone();
        g.clearGroups();
        _m.multiplyMatrices(_inv, o.matrixWorld);
        g.applyMatrix4(_m);
        // un determinante negativo invierte las caras: se corrige el orden de los triángulos
        if (_m.determinant() < 0 && g.index) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i]; ix[i] = ix[i + 2]; ix[i + 2] = t; } }
        geos.push(g);
      }
      const geo = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!geo) continue;
      geo.computeBoundingSphere();
      const mesh = b.isMesh ? new THREE.Mesh(geo, b.mat) : new THREE.LineSegments(geo, b.mat);
      mesh.castShadow = b.cast; mesh.receiveShadow = b.recv; mesh.renderOrder = b.order;
      mesh.userData.isBatch = true;
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
      b.items.forEach((o) => { o.visible = false; o.userData.batchedInto = mesh; o.userData.batchSiblings = b.items; });
      merged++; meshes += b.items.length;
    } catch (e) {
      geos.forEach((g) => g.dispose());
      console.warn('No se pudo fusionar un grupo de mallas', e);
    }
  }
  return { merged, meshes };
}
