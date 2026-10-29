import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { store } from '../state/store.js';
import { InteriorLook, upgradeInteriorMaterials } from './InteriorLook.js';
import { RoomDoors } from './RoomDoors.js';
import { buildBathroomDetails, addBathInstances } from './BathroomDetails.js';

/**
 * FloorTour — Experiencia "Piso 2" tipo sitio de desarrolladora:
 *  1. Transición premium: la cubierta y los pisos superiores se levantan, la cámara baja a una
 *     planta cenital del Piso 2 con las habitaciones resaltadas y numeradas.
 *  2. Clic en una habitación → la cámara "entra" (vuelo + descenso a altura de ojos).
 *  3. Recorrido por la habitación: mirar alrededor arrastrando, vistas (Entrada, Alcoba, Ventana,
 *     Baño…), habitación anterior/siguiente, minimapa con la posición y ficha de la unidad.
 *  4. Caminar con W A S D o las flechas (Shift = más rápido, Q/E = girar), con colisión contra muros.
 *  5. Modo render de interior (InteriorLook): materiales con relieve, luz de ventana y downlights.
 */
const P2 = 3.02;        // cota del Piso 2
const EYE = 1.6;        // altura de ojos
const CEIL = 2.42;      // altura del cielo raso (coincide con el corte de muros)
const LIFT = 46;        // cuánto suben los pisos superiores en la transición
const toW = ([x, y]) => [x / 1000, -y / 1000];

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function edgeDist(x, z, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i];
    const vx = bx - ax, vz = bz - az, L = vx * vx + vz * vz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / L));
    d = Math.min(d, Math.hypot(x - ax - t * vx, z - az - t * vz));
  }
  return d;
}
/** Distancia libre desde (x,z) en la dirección (dx,dz) hasta el borde del polígono. */
function freeRay(x, z, dx, dz, poly) {
  let best = 30;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i];
    const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - x) * ez - (az - z) * ex) / den, u = ((ax - x) * dz - (az - z) * dx) / den;
    if (t > 0.05 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}
function polyArea(p) { let a = 0; p.forEach((q, i) => { const r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; }); return Math.abs(a / 2); }

export class FloorTour {
  constructor(app) {
    this.app = app;               // MasterplanScene
    this.mode = 'off';            // 'off' | 'plan' | 'room'
    this.lifted = false;
    this.rooms = [];
    this.byId = new Map();
    this.current = null;
    this.vpIndex = 0;
    this.group = new THREE.Group();
    this.group.name = 'FloorTour';
    this.group.visible = false;
    app.scene.add(this.group);
    this._injectCSS();
  }

  // ------------------------------------------------------------------ datos
  init(rooms, arch) {
    this.rooms = rooms.map((r) => this._analyseRoom(r)).filter(Boolean);
    this.rooms.forEach((r) => this.byId.set(r.id, r));
    // orden de recorrido: por número de habitación
    this.rooms.sort((a, b) => Number(a.data.number) - Number(b.data.number));
    try { upgradeInteriorMaterials(this.app.materials); } catch (e) { console.warn('materiales interior', e); }
    try { this.look = new InteriorLook(this.app); } catch (e) { console.warn('render interior', e); }
    this._buildInteriorDressing(arch);
    this._initWalk(arch);
    this._buildDOM();
  }

  _analyseRoom(room) {
    if (!room.mainLoop || room.mainLoop.length < 3) return null;
    const poly = room.mainLoop.map(toW);
    const baths = (room.bathLoops || []).filter((l) => l && l.length > 2).map((l) => l.map(toW));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    poly.forEach(([x, z]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); });

    // ventanas (posición y normal exterior) → define hacia dónde mira la habitación
    const wins = (room.windows || []).map((w) => {
      const [x, z] = toW(w.p);
      const n = new THREE.Vector2(w.fo?.[0] || 0, -(w.fo?.[1] || 0));
      if (n.lengthSq() < 1e-6) n.set(0, 1);
      n.normalize();
      return { x, z, n, w: (w.w || 1200) / 1000, t: (w.t || 200) / 1000 };
    });

    // puntos interiores con holgura a muros y fuera del baño
    const pts = [];
    const step = 0.22;
    for (let x = minX + step / 2; x < maxX; x += step) {
      for (let z = minZ + step / 2; z < maxZ; z += step) {
        if (!pointInPoly(x, z, poly)) continue;
        if (baths.some((b) => pointInPoly(x, z, b) || edgeDist(x, z, b) < 0.35)) continue;
        const c = edgeDist(x, z, poly);
        if (c >= 0.4) pts.push({ x, z, c });
      }
    }
    if (!pts.length) return null;
    const pole = pts.reduce((a, b) => (b.c > a.c ? b : a));
    const win = wins[0] || null;
    const n = win ? win.n : new THREE.Vector2(1, 0);
    const wx = win ? win.x : pole.x + n.x * 3, wz = win ? win.z : pole.z + n.y * 3;
    const along = (p) => (p.x - wx) * n.x + (p.z - wz) * n.y;           // ≈0 junto a la fachada, negativo hacia la puerta
    const lateral = (p) => Math.abs((p.x - pole.x) * -n.y + (p.z - pole.z) * n.x);
    const good = pts.filter((p) => p.c >= 0.55);
    const pool = good.length > 4 ? good : pts;
    const entry = pool.reduce((a, b) => (along(b) + 0.35 * lateral(b) < along(a) + 0.35 * lateral(a) ? b : a));
    const nearWin = pool.reduce((a, b) => (along(b) - 0.35 * lateral(b) > along(a) - 0.35 * lateral(a) ? b : a));

    const y = P2 + EYE;
    const v3 = (x, z, yy = y) => new THREE.Vector3(x, yy, z);
    const vps = [];
    vps.push({ name: 'Entrada', pos: v3(entry.x, entry.z), look: v3(wx, wz, P2 + 1.35) });
    // Alcoba: desde el centro, hacia el lado con más profundidad libre (no hacia la ventana ni la puerta)
    let bestDir = null, bestFree = -1;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
      const facing = Math.abs(dx * n.x + dz * n.y);
      if (facing > 0.75) continue;
      const f = freeRay(pole.x, pole.z, dx, dz, poly);
      if (f > bestFree) { bestFree = f; bestDir = [dx, dz]; }
    }
    if (bestDir) vps.push({ name: 'Alcoba', pos: v3(pole.x, pole.z), look: v3(pole.x + bestDir[0] * 3, pole.z + bestDir[1] * 3, P2 + 1.2) });
    vps.push({ name: 'Ventana', pos: v3(nearWin.x, nearWin.z), look: v3(entry.x, entry.z, P2 + 1.3) });
    if (polyArea(poly) > 34) {
      // suites: una vista adicional desde el punto más alejado de las anteriores
      const far = pool.reduce((a, b) => {
        const da = Math.min(...vps.map((v) => Math.hypot(a.x - v.pos.x, a.z - v.pos.z)));
        const db = Math.min(...vps.map((v) => Math.hypot(b.x - v.pos.x, b.z - v.pos.z)));
        return db > da ? b : a;
      });
      vps.splice(2, 0, { name: 'Estar', pos: v3(far.x, far.z), look: v3(pole.x, pole.z, P2 + 1.2) });
    }
    baths.forEach((b, i) => {
      let bp = null;
      let bMinX = Infinity, bMaxX = -Infinity, bMinZ = Infinity, bMaxZ = -Infinity;
      b.forEach(([x, z]) => { bMinX = Math.min(bMinX, x); bMaxX = Math.max(bMaxX, x); bMinZ = Math.min(bMinZ, z); bMaxZ = Math.max(bMaxZ, z); });
      for (let x = bMinX + 0.1; x < bMaxX; x += 0.12) {
        for (let z = bMinZ + 0.1; z < bMaxZ; z += 0.12) {
          if (!pointInPoly(x, z, b)) continue;
          const c = edgeDist(x, z, b);
          if (!bp || c > bp.c) bp = { x, z, c };
        }
      }
      if (!bp) return;
      let dir = [1, 0], fr = -1;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
        const f = freeRay(bp.x, bp.z, dx, dz, b);
        if (f > fr) { fr = f; dir = [dx, dz]; }
      }
      // retrocede hacia la pared opuesta para ver el baño completo
      const back = Math.max(0, Math.min(freeRay(bp.x, bp.z, -dir[0], -dir[1], b) - 0.25, 0.8));
      vps.push({ name: baths.length > 1 ? `Baño ${i + 1}` : 'Baño', pos: v3(bp.x - dir[0] * back, bp.z - dir[1] * back), look: v3(bp.x + dir[0] * 2, bp.z + dir[1] * 2, P2 + 1.1) });
    });

    return {
      id: room.id, data: room, poly, baths, wins, pole, vps,
      center: new THREE.Vector3(pole.x, P2, pole.z),
      bounds: { minX, maxX, minZ, maxZ }
    };
  }

  /** Moldura de cielo raso (cornisa escalonada en blanco) en el perímetro de cada habitación. */
  _buildCornices() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.6, metalness: 0 });
    // perfil escalonado: [alto, fondo] de abajo hacia arriba
    const steps = [[0.025, 0.035], [0.035, 0.06], [0.05, 0.09]];
    const geos = [];
    for (const r of this.rooms) {
      const poly = r.poly;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ax, az] = poly[j], [bx, bz] = poly[i];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.25) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        let nx = -uz, nz = ux; // normal hacia el interior
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (!pointInPoly(mx + nx * 0.2, mz + nz * 0.2, poly)) { nx = -nx; nz = -nz; }
        let y = P2 + CEIL - steps.reduce((a, s) => a + s[0], 0);
        for (const [h, d] of steps) {
          const g = new THREE.BoxGeometry(len + d * 2, h, d);
          g.rotateY(-Math.atan2(uz, ux));
          g.translate(mx + nx * d / 2, y + h / 2, mz + nz * d / 2);
          geos.push(g); y += h;
        }
      }
    }
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = true;
    this.cornices = mesh;
    this.group.add(mesh);
  }

  // ------------------------------------------------------- cielo raso, ventanas, luz
  _buildInteriorDressing(arch) {
    const slab = arch?.slabLoops?.[0]?.loops?.[0];
    // cielo raso: losa principal + el polígono de CADA habitación (las alas no están en la losa 0)
    const shapes = [];
    if (slab) shapes.push(new THREE.Shape(slab.map(([x, y]) => new THREE.Vector2(x / 1000, y / 1000))));
    for (const r of this.rooms) shapes.push(new THREE.Shape(r.poly.map(([x, z]) => new THREE.Vector2(x, -z))));
    if (shapes.length) {
      const geo = new THREE.ShapeGeometry(shapes);
      geo.rotateX(-Math.PI / 2);
      // cielo raso en estuco blanco cálido con micro-relieve (como en los renders de referencia)
      const tl = new THREE.TextureLoader();
      const ct = (suf, srgb) => { const t = tl.load(`./assets/textures/real/cielo${suf}.webp`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / 1.5, 1 / 1.5); if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
      const mat = new THREE.MeshStandardMaterial({ map: ct('', true), normalMap: ct('_n'), roughnessMap: ct('_r'), color: 0xffffff, roughness: 1, metalness: 0, side: THREE.DoubleSide });
      mat.normalScale.set(0.3, 0.3);
      this.ceiling = new THREE.Mesh(geo, mat);
      this.ceiling.position.y = P2 + CEIL;
      this.ceiling.castShadow = true;     // el sol no entra por el techo
      this.ceiling.receiveShadow = false;
      this.group.add(this.ceiling);
    }
    this._buildCornices();
    // Las puertas y baños equipados ya vienen 1:1 en el GLB exportado de 3ds Max
    // vanos: luz de día difusa con cortina translúcida (lo que se ve desde dentro)
    const winTex = this._windowTexture();
    const winMat = new THREE.MeshBasicMaterial({ map: winTex, fog: false, toneMapped: true });
    winMat.color.setScalar(1.5); // más brillante que el interior: la luz de día "quema" y florece (bloom)
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.5, metalness: 0.3 });
    for (const r of this.rooms) {
      for (const w of r.wins) {
        const width = Math.max(0.6, w.w - 0.08), h = 1.4;
        const g = new THREE.Group();
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(width, h), winMat);
        g.add(pane);
        const fr = (fw, fh, x, y) => { const m = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, 0.05), frameMat); m.position.set(x, y, 0.02); g.add(m); };
        fr(width + 0.1, 0.06, 0, h / 2 + 0.03); fr(width + 0.1, 0.08, 0, -h / 2 - 0.04);
        fr(0.06, h + 0.1, -width / 2 - 0.03, 0); fr(0.06, h + 0.1, width / 2 + 0.03, 0); fr(0.04, h, 0, 0);
        const sill = new THREE.Mesh(new THREE.BoxGeometry(width + 0.2, 0.03, 0.2), new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.4 }));
        sill.position.set(0, -h / 2 - 0.08, 0.1); g.add(sill);
        // cara interior del muro de fachada, mirando hacia dentro
        const inward = new THREE.Vector3(-w.n.x, 0, -w.n.y);
        g.position.set(w.x, P2 + 0.9 + h / 2, w.z).addScaledVector(inward, w.t / 2 + 0.03);
        g.lookAt(g.position.clone().add(inward));
        this.group.add(g);
      }
    }
    // luz cálida de la habitación activa + relleno
    // downlights empotrados en el cielo raso (emisivos: brillan con el bloom)
    const dlGeo = new THREE.CircleGeometry(0.075, 20); dlGeo.rotateX(Math.PI / 2);
    const dlMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.8, 2.2), fog: false });
    const ringGeo = new THREE.RingGeometry(0.075, 0.1, 20); ringGeo.rotateX(Math.PI / 2);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide });
    for (const r of this.rooms) {
      const spots = [r.pole, ...r.vps.filter((v) => !v.name.startsWith('Baño')).map((v) => ({ x: v.pos.x, z: v.pos.z }))];
      const placed = [];
      for (const p of spots) {
        if (placed.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1.6)) continue;
        placed.push(p);
        const d = new THREE.Mesh(dlGeo, dlMat); d.position.set(p.x, P2 + CEIL - 0.006, p.z); this.group.add(d);
        const g = new THREE.Mesh(ringGeo, ringMat); g.position.set(p.x, P2 + CEIL - 0.004, p.z); this.group.add(g);
      }
    }
    // Las luces viven siempre en la escena (intensidad 0 fuera del recorrido): así el número de luces
    // no cambia y la GPU no tiene que recompilar todos los materiales al entrar a una habitación.
    this.roomLight = new THREE.PointLight(0xffd7a3, 0, 10, 1.6);
    this.roomLight.position.set(0, P2 + 2.2, 0);
    this.fillLight = new THREE.PointLight(0xfff4e6, 0, 8, 1.6);
    this.app.scene.add(this.roomLight, this.fillLight);
  }

  _windowTexture() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0, '#cfe3f6'); sky.addColorStop(0.55, '#f4f7f8'); sky.addColorStop(1, '#dfe6d8');
    g.fillStyle = sky; g.fillRect(0, 0, 256, 256);
    // copas de árboles y fachadas lejanas, desenfocadas
    g.filter = 'blur(6px)';
    for (let i = 0; i < 14; i++) { g.fillStyle = `rgba(${90 + Math.random() * 40},${125 + Math.random() * 40},${85 + Math.random() * 30},0.55)`; g.beginPath(); g.arc(Math.random() * 256, 190 + Math.random() * 60, 25 + Math.random() * 30, 0, 7); g.fill(); }
    g.fillStyle = 'rgba(190,170,150,0.35)'; g.fillRect(150, 120, 70, 90);
    g.filter = 'none';
    // cortina de lino a los lados
    const cur = g.createLinearGradient(0, 0, 256, 0);
    cur.addColorStop(0, 'rgba(250,246,238,0.92)'); cur.addColorStop(0.16, 'rgba(250,246,238,0.25)');
    cur.addColorStop(0.84, 'rgba(250,246,238,0.25)'); cur.addColorStop(1, 'rgba(250,246,238,0.92)');
    g.fillStyle = cur; g.fillRect(0, 0, 256, 256);
    for (let x = 0; x < 256; x += 9) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, 0, 3, 256); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ------------------------------------------------------------- transición
  /** Sube (o baja) la cubierta y los pisos superiores como una tapa. */
  lift(up, fast = false) {
    const b = this.app.buildingBuilder;
    const groups = [b.upperBuildingGroup, b.exteriorShellPiso2].filter(Boolean);
    if (up === this.lifted && !fast) return;
    this.lifted = up;
    groups.forEach((g, i) => {
      gsap.killTweensOf(g.position);
      if (up) {
        g.visible = true;
        if (fast) { g.position.y = 0; g.visible = false; return; }
        gsap.to(g.position, { y: LIFT + i * 4, duration: 1.25, delay: i * 0.08, ease: 'power2.in', onComplete: () => { g.visible = false; g.position.y = 0; } });
      } else {
        g.visible = true;
        if (fast) { g.position.y = 0; return; }
        g.position.y = LIFT + i * 4;
        gsap.to(g.position, { y: 0, duration: 1.3, delay: 0.15 + i * 0.06, ease: 'power3.out' });
      }
    });
  }

  _planCamera() {
    const a = this.app.camera.aspect || 1.6;
    const halfW = 36, halfD = 20;
    const t = Math.tan(THREE.MathUtils.degToRad(this.app.camera.fov / 2));
    const h = Math.max(halfD / t, halfW / (t * a)) * 1.08;
    return { pos: new THREE.Vector3(17, P2 + h, 7.5), target: new THREE.Vector3(17, P2, 0.6) };
  }

  _setControlsFree() {
    const c = this.app.controls;
    c.minDistance = 0.01; c.maxDistance = 5000; c.minPolarAngle = 0; c.maxPolarAngle = Math.PI;
    c.enableZoom = true; c.enablePan = true; c.rotateSpeed = 0.55;
  }

  /** Entra a la planta del Piso 2 (desde el exterior o desde una habitación). */
  enterPlan() {
    const wasRoom = this.mode === 'room';
    this.mode = 'plan';
    this.current = null;
    document.body.classList.add('ft-plan');
    document.body.classList.remove('ft-room');
    this.lift(true);
    this._showDressing(false);
    this.app.roomHighlighter.setTheme?.('plan');
    this.app.roomHighlighter.setVisibility(true);
    const { pos, target } = this._planCamera();
    const cam = this.app.camera, ctl = this.app.controls;
    this._setControlsFree();
    ctl.enabled = false;
    gsap.killTweensOf(cam.position); gsap.killTweensOf(ctl.target);
    const tl = gsap.timeline({
      onComplete: () => {
        ctl.enabled = true;
        ctl.minPolarAngle = 0; ctl.maxPolarAngle = 0.75; ctl.minDistance = 18; ctl.maxDistance = 140;
        ctl.enablePan = true; this.app.panRadius = 60;
        this._revealBadges(true);
      }
    });
    if (!wasRoom) {
      // arco: primero se eleva y gira hacia el frente, luego baja a la planta cenital
      const mid = new THREE.Vector3().lerpVectors(cam.position, pos, 0.5);
      mid.y = Math.max(cam.position.y, pos.y) + 25;
      tl.to(cam.position, { x: mid.x, y: mid.y, z: mid.z, duration: 1.1, ease: 'power2.in' }, 0)
        .to(cam.position, { x: pos.x, y: pos.y, z: pos.z, duration: 1.3, ease: 'power3.out' }, 1.1)
        .to(ctl.target, { x: target.x, y: target.y, z: target.z, duration: 2.2, ease: 'power2.inOut' }, 0.1);
    } else {
      tl.to(cam.position, { x: pos.x, y: pos.y, z: pos.z, duration: 1.6, ease: 'power3.inOut' }, 0)
        .to(ctl.target, { x: target.x, y: target.y, z: target.z, duration: 1.6, ease: 'power3.inOut' }, 0)
        .to(cam, { fov: 45, duration: 1.2, onUpdate: () => cam.updateProjectionMatrix() }, 0);
    }
    this._revealBadges(false);
    this._syncPills('interior');
    this._updateHeader();
  }

  /** Sale del recorrido (al exterior o a la planta 3D ortogonal). */
  leave(dropRoof = true) {
    if (this.mode === 'off' && !this.lifted) return;
    this.mode = 'off';
    this.current = null;
    document.body.classList.remove('ft-plan', 'ft-room');
    this._showDressing(false);
    this._revealBadges(false);
    this.app.roomHighlighter.setTheme?.('default');
    const ctl = this.app.controls, cam = this.app.camera;
    ctl.enabled = true; ctl.enableZoom = true; ctl.enablePan = true; ctl.rotateSpeed = 0.55;
    if (cam.fov !== 45) { cam.fov = 45; cam.updateProjectionMatrix(); }
    this.app.renderer.toneMappingExposure = this._baseExposure ?? this.app.renderer.toneMappingExposure;
    if (dropRoof) this.lift(false);
  }

  // ------------------------------------------------------------- habitación
  async enterRoom(id, vp = 0) {
    const r = this.byId.get(id);
    if (!r) return;
    if (this.app._mode !== 'interior') {
      // viene del exterior: abre directamente la cubierta y entra
      this._skipPlanCamera = true;
      store.setState({ viewMode: 'interior' });
    }
    if (store.state.selectedRoomId !== id) store.setState({ selectedRoomId: id });
    const fromRoom = this.mode === 'room';
    this.mode = 'room';
    this.current = r;
    this.vpIndex = Math.min(vp, r.vps.length - 1);
    this._syncPills('interior');
    document.body.classList.add('ft-room');
    document.body.classList.remove('ft-plan');
    this.lift(true);
    this._revealBadges(false);
    this.app.roomHighlighter.setVisibility(false);
    this.app.hideTooltip?.();
    this._renderRoomUI();

    const v = r.vps[this.vpIndex];
    const cam = this.app.camera, ctl = this.app.controls;
    this._busy = true;
    gsap.killTweensOf(cam.position); gsap.killTweensOf(ctl.target);
    this._setControlsFree();
    ctl.enabled = false;
    if (fromRoom) {
      await this._fadeTo(() => { this._placeAt(v); });
    } else {
      // vuelo: se coloca sobre la habitación y desciende hasta la altura de los ojos
      const above = new THREE.Vector3(r.center.x, P2 + 11, r.center.z).add(new THREE.Vector3(v.pos.x - r.center.x, 0, v.pos.z - r.center.z).multiplyScalar(0.6));
      const look = v.look.clone();
      const tl = gsap.timeline();
      tl.to(cam.position, { x: above.x, y: above.y, z: above.z + 0.01, duration: 1.0, ease: 'power2.inOut' }, 0)
        .to(ctl.target, { x: r.center.x, y: P2, z: r.center.z, duration: 1.0, ease: 'power2.inOut' }, 0)
        .add(() => this._showDressing(true, r), 1.0)
        .to(cam.position, { x: v.pos.x, y: v.pos.y, z: v.pos.z, duration: 1.5, ease: 'power3.inOut' }, 1.0)
        .to(ctl.target, { x: look.x, y: look.y, z: look.z, duration: 1.5, ease: 'power3.inOut' }, 1.0)
        .to(cam, { fov: 62, duration: 1.5, ease: 'power2.inOut', onUpdate: () => cam.updateProjectionMatrix() }, 1.0);
      await tl.then();
      this._placeAt(v);
    }
  }

  /** Coloca la cámara en un punto de vista y activa "mirar alrededor". */
  _placeAt(v) {
    const r = this.current;
    this._busy = false;
    this._showDressing(true, r);
    const cam = this.app.camera, ctl = this.app.controls;
    const dir = v.look.clone().sub(v.pos).normalize();
    cam.position.copy(v.pos);
    if (cam.fov !== 62) { cam.fov = 62; cam.updateProjectionMatrix(); }
    ctl.target.copy(v.pos).addScaledVector(dir, 0.05);
    ctl.minDistance = 0.05; ctl.maxDistance = 0.05;
    ctl.minPolarAngle = 0.55; ctl.maxPolarAngle = 2.35;
    ctl.enableZoom = false; ctl.enablePan = false;
    ctl.rotateSpeed = -0.32;            // arrastrar "toma" la vista (como un 360°)
    ctl.enabled = true;
    ctl.update();
    this._updateRoomUI();
  }

  goToView(i) {
    const r = this.current;
    if (!r || i < 0 || i >= r.vps.length) return;
    this.vpIndex = i;
    this._fadeTo(() => this._placeAt(r.vps[i]));
  }

  stepRoom(d) {
    if (!this.rooms.length) return;
    const i = this.current ? this.rooms.indexOf(this.current) : -1;
    const next = this.rooms[(i + d + this.rooms.length) % this.rooms.length];
    this.enterRoom(next.id, 0);
  }

  /** Fundido a negro suave con un pequeño avance de cámara al reaparecer. */
  _fadeTo(fn) {
    const veil = this.dom.veil;
    this._busy = true;
    return new Promise((res) => {
      gsap.to(veil, {
        opacity: 1, duration: 0.32, ease: 'power1.in',
        onComplete: () => {
          fn();
          const cam = this.app.camera, ctl = this.app.controls;
          const dir = ctl.target.clone().sub(cam.position).normalize();
          const end = cam.position.clone(), endT = ctl.target.clone();
          cam.position.addScaledVector(dir, -0.45); ctl.target.addScaledVector(dir, -0.45);
          gsap.to(cam.position, { x: end.x, y: end.y, z: end.z, duration: 0.9, ease: 'power2.out' });
          gsap.to(ctl.target, { x: endT.x, y: endT.y, z: endT.z, duration: 0.9, ease: 'power2.out' });
          gsap.to(veil, { opacity: 0, duration: 0.55, ease: 'power1.out', onComplete: () => { this._busy = false; res(); } });
        }
      });
    });
  }

  /** En el recorrido por habitación se apaga el entorno (ciudad y edificios de contexto): no se ve desde dentro, choca con cortinas
   *  y muros, y es ~1,3 M de triángulos + sus sombras en cada cuadro. Las sombras del sol se congelan (el cielo raso las bloquea). */
  _setEnvironment(show) {
    const a = this.app, R = a.renderer;
    if (!show) {
      if (!this._envHidden) { this._envHidden = [a.city?.group, a.buildingBuilder?.contextGroup].filter((g) => g && g.visible); this._envHidden.forEach((g) => { g.visible = false; }); }
      R.shadowMap.autoUpdate = false; R.shadowMap.needsUpdate = true;
    } else {
      (this._envHidden || []).forEach((g) => { g.visible = true; }); this._envHidden = null;
      R.shadowMap.autoUpdate = true;
    }
  }

  _showDressing(on, r = null) {
    this._setEnvironment(!on);
    if (on) {   // las luces del interior (y las del baño) se mueven a la habitación en uso: el número de luces no cambia
      const rf = this.app.revitFurniture, maps = rf?.focusRoom?.((r || this.current)?.id);
      if (maps && this.bathLights) { this.bathLights.matrix.copy(maps.doble); this.bathLights.matrixWorldNeedsUpdate = true; }
      if (rf && this.bath && !this.bath.userData.bathInst) addBathInstances(this.bath, [...rf.instances.filter((i) => i.from === 'doble'), ...(rf.pieces?.baths || [])]);
    }
    this.group.visible = on;
    const R = this.app.renderer;
    if (this._baseExposure == null) this._baseExposure = R.toneMappingExposure;
    R.toneMappingExposure = on ? this._baseExposure * 0.95 : this._baseExposure;
    if (on) { try { this.doors?.applyCarve(); } catch (e) { console.warn("hueco puertas", e); } }
    if (on) this.look?.enable(r || this.current); else this.look?.disable();
    this.app.revitFurniture?.setInterior(on);
    this.app.postfx?.setInterior?.(on);
    this.roomLight.intensity = on ? (this.app.revitFurniture ? 1.2 : 6) : 0;
    this.fillLight.intensity = on ? (this.app.revitFurniture ? 0.5 : 1.8) : 0;
    if (on && r) {
      this.roomLight.position.set(r.pole.x, P2 + 2.15, r.pole.z);
      const v = r.vps[0].pos;
      this.fillLight.position.set(v.x, P2 + 2.1, v.z);
    }
  }

  // ------------------------------------------------------------------- UI
  _injectCSS() {
    const css = document.createElement('style');
    css.textContent = `
    .ft-badges{position:fixed;inset:0;pointer-events:none;z-index:6}
    .ft-badge{position:absolute;transform:translate(-50%,-50%) scale(.6);opacity:0;transition:opacity .35s, transform .35s cubic-bezier(.2,.9,.3,1.3);pointer-events:auto;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px}
    .ft-badge.on{opacity:1;transform:translate(-50%,-50%) scale(1)}
    .ft-badge b{width:34px;height:34px;border-radius:50%;background:#fff;color:#e8611c;font:700 12px/34px Roboto,system-ui,sans-serif;text-align:center;box-shadow:0 3px 12px rgba(0,0,0,.35);border:2px solid #f2782f}
    .ft-badge span{font:500 10.5px/1 Roboto,system-ui,sans-serif;color:#fff;background:rgba(18,18,20,.72);padding:4px 7px;border-radius:999px;white-space:nowrap;opacity:0;transform:translateY(-3px);transition:.2s}
    .ft-badge:hover span{opacity:1;transform:none}
    .ft-badge:hover b{background:#f2782f;color:#fff}
    .ft-veil{position:fixed;inset:0;background:#0d0d0f;opacity:0;pointer-events:none;z-index:40}
    .ft-ui{position:fixed;inset:0;pointer-events:none;z-index:30;font-family:Roboto,system-ui,sans-serif;color:#fff;display:none}
    body.ft-plan .ft-ui.plan, body.ft-room .ft-ui.room{display:block}
    .ft-ui > *{pointer-events:auto}
    .ft-pill{position:absolute;top:18px;left:18px;display:flex;background:rgba(20,20,22,.78);backdrop-filter:blur(10px);border-radius:999px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.3)}
    .ft-pill button{background:none;border:0;color:#ddd;font:600 11px/1 Roboto,sans-serif;letter-spacing:1.2px;padding:10px 16px;border-radius:999px;cursor:pointer;text-transform:uppercase}
    .ft-pill button.on,.ft-pill button:hover{background:#fff;color:#141414}
    .ft-head{position:absolute;top:78px;left:50%;transform:translateX(-50%);background:rgba(20,20,22,.72);backdrop-filter:blur(10px);padding:10px 18px;border-radius:14px;text-align:center;pointer-events:none}
    .ft-head small{display:block;font-size:10px;letter-spacing:1.6px;color:#f2a06b;text-transform:uppercase;margin-bottom:3px}
    .ft-head strong{font-size:15px;font-weight:600}
    .ft-tabs{position:absolute;bottom:22px;left:50%;transform:translateX(-50%);display:flex;gap:4px;background:rgba(20,20,22,.78);backdrop-filter:blur(10px);padding:5px;border-radius:999px;max-width:calc(100vw - 32px);overflow-x:auto}
    .ft-tabs button{background:none;border:0;color:#ddd;font:600 11px/1 Roboto,sans-serif;letter-spacing:1.1px;padding:10px 16px;border-radius:999px;cursor:pointer;text-transform:uppercase;white-space:nowrap}
    .ft-tabs button.on{background:#fff;color:#141414}
    .ft-arrow{position:absolute;top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;border:0;background:rgba(20,20,22,.55);color:#fff;font-size:22px;cursor:pointer;backdrop-filter:blur(8px)}
    .ft-arrow:hover{background:#f2782f}
    .ft-arrow.prev{left:18px}.ft-arrow.next{right:338px}
    .ft-card{position:absolute;top:18px;right:18px;bottom:18px;width:300px;background:rgba(16,16,18,.86);backdrop-filter:blur(14px);border-radius:18px;padding:18px;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.4)}
    .ft-card .tag{display:inline-block;font:700 9.5px/1 Roboto,sans-serif;letter-spacing:1.4px;color:#f2782f;border:1px solid #f2782f;border-radius:6px;padding:5px 7px;text-transform:uppercase}
    .ft-card h3{margin:10px 0 4px;font-size:22px;font-weight:600;letter-spacing:.3px}
    .ft-card .sub{font-size:11.5px;color:#aaa;letter-spacing:.6px;text-transform:uppercase;margin-bottom:14px}
    .ft-card .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 10px;margin:14px 0}
    .ft-card .grid div{font-size:10px;letter-spacing:1.2px;color:#999;text-transform:uppercase}
    .ft-card .grid b{display:block;font-size:17px;color:#fff;letter-spacing:0;margin-top:3px;font-weight:500}
    .ft-card p{font-size:12.5px;line-height:1.5;color:#d4d4d4;margin:8px 0}
    .ft-card .btn{display:block;width:100%;margin-top:10px;padding:12px;border-radius:12px;border:0;font:600 12px/1 Roboto,sans-serif;letter-spacing:.8px;cursor:pointer}
    .ft-card .btn.main{background:#d6202e;color:#fff}.ft-card .btn.ghost{background:rgba(255,255,255,.1);color:#fff}
    .ft-map{position:absolute;bottom:84px;right:338px;width:210px;background:rgba(16,16,18,.82);backdrop-filter:blur(10px);border-radius:14px;padding:8px;box-shadow:0 6px 20px rgba(0,0,0,.35)}
    .ft-map canvas{display:block;width:100%;cursor:pointer}
    .ft-map div{font:600 9.5px/1 Roboto,sans-serif;letter-spacing:1.3px;color:#bbb;text-transform:uppercase;text-align:center;margin-top:6px}
    .ft-hint{position:absolute;bottom:82px;left:50%;transform:translateX(-50%);font-size:11.5px;color:#fff;background:rgba(0,0,0,.45);padding:7px 12px;border-radius:999px;pointer-events:none;transition:opacity .6s}
    .ft-back{position:absolute;bottom:22px;left:18px;background:rgba(20,20,22,.78);border:0;color:#fff;font:600 11px/1 Roboto,sans-serif;letter-spacing:1px;padding:12px 16px;border-radius:999px;cursor:pointer;text-transform:uppercase}
    .ft-back:hover{background:#fff;color:#141414}
    body.ft-room #left-sidebar-wrapper, body.ft-room #room-detail-container, body.ft-room #bottom-dock-container,
    body.ft-room .project-tag, body.ft-room .top-right-bar, body.ft-room .sky-time-control, body.ft-room .mode-pills-bar{display:none !important}
    body.ft-plan #room-detail-container, body.ft-plan #left-sidebar-wrapper{display:none !important}
    @media (max-width: 760px){
      .ft-card{top:auto;left:12px;right:12px;bottom:76px;width:auto;max-height:34vh;padding:14px}
      .ft-arrow.next{right:12px}.ft-arrow.prev{left:12px}
      .ft-map{display:none}
      .ft-tabs{bottom:14px}
      .ft-head{top:70px}
    }`;
    document.head.appendChild(css);
  }

  _buildDOM() {
    const mk = (cls, html = '') => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; document.body.appendChild(d); return d; };
    const veil = mk('ft-veil');
    const badges = mk('ft-badges');
    const plan = mk('ft-ui plan', `
      <div class="ft-head"><small>Piso 2 · Planta de habitaciones</small><strong>Elige una habitación para recorrerla</strong></div>
      <button class="ft-back" data-act="exterior">← Volver al exterior</button>`);
    const room = mk('ft-ui room', `
      <div class="ft-pill"><button data-act="exterior">3D</button><button data-act="plan">Planta</button><button data-act="gallery">Galería</button></div>
      <div class="ft-head"><small class="r-floor"></small><strong class="r-title"></strong></div>
      <button class="ft-arrow prev" data-act="prev" title="Habitación anterior">‹</button>
      <button class="ft-arrow next" data-act="next" title="Habitación siguiente">›</button>
      <div class="ft-tabs"></div>
      <div class="ft-hint">Arrastra para mirar · <b>W A S D</b> o flechas para caminar · <b>Clic en un mueble</b> para cambiar su material PBR</div>
      <div class="ft-map"><canvas width="420" height="300"></canvas><div class="r-mapname"></div></div>
      <div class="ft-card"></div>`);
    this.dom = { veil, badges, plan, room, tabs: room.querySelector('.ft-tabs'), card: room.querySelector('.ft-card'), map: room.querySelector('canvas'), hint: room.querySelector('.ft-hint') };

    const onAct = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'exterior') this._goMode('exterior');
      else if (a === 'plan') this.enterPlan();
      else if (a === 'prev') this.stepRoom(-1);
      else if (a === 'next') this.stepRoom(1);
      else if (a === 'gallery' && this.current) window.__masterplanApp?.openRoomGallery?.(this.current.data);
      else if (a === 'view') this.goToView(Number(b.dataset.i));
    };
    plan.addEventListener('click', onAct);
    room.addEventListener('click', onAct);

    // badges de la planta
    this.badgeEls = this.rooms.map((r) => {
      const el = document.createElement('div');
      el.className = 'ft-badge';
      el.innerHTML = `<b>${r.data.number}</b><span>${r.data.typology} · ${r.data.areaPrivateM2} m²</span>`;
      el.onclick = (e) => { e.stopPropagation(); this.enterRoom(r.id); };
      el.onmouseenter = () => this.app.roomHighlighter.setHover(r.id);
      el.onmouseleave = () => this.app.roomHighlighter.setHover(null);
      badges.appendChild(el);
      return { el, r, p: new THREE.Vector3(r.pole.x, P2 + 2.9, r.pole.z) };
    });

    // minimapa: clic para saltar a otra habitación
    this.dom.map.addEventListener('click', (e) => {
      const rect = this.dom.map.getBoundingClientRect();
      const [x, z] = this._mapInv((e.clientX - rect.left) / rect.width * this.dom.map.width, (e.clientY - rect.top) / rect.height * this.dom.map.height);
      const hit = this.rooms.find((r) => pointInPoly(x, z, r.poly));
      if (hit && hit !== this.current) this.enterRoom(hit.id);
    });
    // la rueda acerca/aleja con el campo visual dentro de la habitación
    this.app.renderer.domElement.addEventListener('wheel', (e) => {
      if (this.mode !== 'room') return;
      const cam = this.app.camera;
      cam.fov = THREE.MathUtils.clamp(cam.fov + Math.sign(e.deltaY) * 3, 38, 78);
      cam.updateProjectionMatrix();
    }, { passive: true });

    // extensión del minimapa
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    this.rooms.forEach((r) => r.poly.forEach(([x, z]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }));
    const W = this.dom.map.width, H = this.dom.map.height, pad = 14;
    const s = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxZ - minZ));
    const ox = (W - (maxX - minX) * s) / 2, oz = (H - (maxZ - minZ) * s) / 2;
    this._mapFwd = (x, z) => [ox + (x - minX) * s, oz + (z - minZ) * s];
    this._mapInv = (u, v) => [minX + (u - ox) / s, minZ + (v - oz) / s];
  }

  _goMode(mode) {
    store.setState({ viewMode: mode });
    this._syncPills(mode);
  }

  _syncPills(mode) {
    document.querySelectorAll('.mode-pill-btn[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  }

  _updateHeader() {}

  _revealBadges(on) {
    this.badgesOn = on;
    this.badgeEls?.forEach(({ el }, i) => {
      clearTimeout(el._t);
      if (on) el._t = setTimeout(() => el.classList.add('on'), 60 * i);
      else el.classList.remove('on');
    });
  }

  _renderRoomUI() {
    const r = this.current; if (!r) return;
    const d = r.data;
    this.dom.room.querySelector('.r-floor').textContent = `Piso 2 · ${d.wing || ''}`;
    this.dom.room.querySelector('.r-title').textContent = `Habitación ${d.number} · ${d.typology}`;
    this.dom.room.querySelector('.r-mapname').textContent = `Hab. ${d.number}`;
    this.dom.tabs.innerHTML = r.vps.map((v, i) => `<button data-act="view" data-i="${i}">${v.name}</button>`).join('');
    const status = d.status || 'Disponible';
    this.dom.card.innerHTML = `
      <span class="tag">${status}</span>
      <h3>Habitación ${d.number}</h3>
      <div class="sub">${d.typology} · ${d.wing || ''}</div>
      <div class="grid">
        <div>Área privada<b>${d.areaPrivateM2} m²</b></div>
        <div>Área construida<b>${d.areaBuiltM2} m²</b></div>
        <div>Baños<b>${r.baths.length || 1}</b></div>
        <div>Movilidad reducida<b>${d.reducedMobility || '—'}</b></div>
      </div>
      <p><b style="color:#fff">Dotación:</b> ${d.bedConfig || ''}</p>
      <p><b style="color:#fff">Ubicación:</b> ${d.locationType || ''}</p>
      ${d.finishes?.floorMain ? `<p><b style="color:#fff">Piso:</b> ${d.finishes.floorMain}</p>` : ''}
      ${d.finishes?.walls ? `<p><b style="color:#fff">Muros:</b> ${d.finishes.walls}</p>` : ''}
      <button class="btn main" data-act="gallery">Ver galería (${d.gallery?.length || 0})</button>
      <button class="btn ghost" data-act="plan">Volver a la planta</button>`;
    this.dom.hint.style.opacity = '1';
    clearTimeout(this._hintT);
    this._hintT = setTimeout(() => { this.dom.hint.style.opacity = '0'; }, 6000);
  }

  _updateRoomUI() {
    this.dom.tabs.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === this.vpIndex));
  }

  _drawMap() {
    const cv = this.dom.map, g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    for (const r of this.rooms) {
      g.beginPath();
      r.poly.forEach(([x, z], i) => { const [u, v] = this._mapFwd(x, z); i ? g.lineTo(u, v) : g.moveTo(u, v); });
      g.closePath();
      const on = r === this.current;
      g.fillStyle = on ? 'rgba(242,120,47,0.55)' : 'rgba(255,255,255,0.07)';
      g.strokeStyle = on ? '#f2782f' : 'rgba(255,255,255,0.45)';
      g.lineWidth = on ? 3 : 1.5;
      g.fill(); g.stroke();
      const [u, v] = this._mapFwd(r.pole.x, r.pole.z);
      g.fillStyle = on ? '#fff' : 'rgba(255,255,255,0.6)';
      g.font = '600 15px Roboto, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(r.data.number, u, v);
    }
    // posición y cono de visión
    const cam = this.app.camera;
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    const [u, v] = this._mapFwd(cam.position.x, cam.position.z);
    const a = Math.atan2(dir.z, dir.x), half = THREE.MathUtils.degToRad(cam.fov * 0.6);
    const grd = g.createRadialGradient(u, v, 2, u, v, 46);
    grd.addColorStop(0, 'rgba(255,255,255,0.75)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.beginPath(); g.moveTo(u, v); g.arc(u, v, 46, a - half, a + half); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.strokeStyle = '#f2782f'; g.lineWidth = 3;
    g.beginPath(); g.arc(u, v, 6, 0, 7); g.fill(); g.stroke();
  }

  // ------------------------------------------------------------- caminar
  _initWalk(arch) {
    this.wallSegs = (arch?.walls || []).map((w) => {
      const pts = w[1];
      if (!pts || pts.length < 2) return null;
      const [ax, az] = toW(pts[0]), [bx, bz] = toW(pts[1]);
      return { ax, az, bx, bz, r: Math.max((w[2] || 120) / 2000, 0.04) + 0.2 };
    }).filter(Boolean);
    const slab = arch?.slabLoops?.[0]?.loops?.[0];
    this.slabPoly = slab ? slab.map(toW) : null;
    this.keys = new Set();
    const WALK_KEYS = ['w', 'a', 's', 'd', 'q', 'e', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
    window.addEventListener('keydown', (e) => {
      if (this.mode !== 'room' || e.target?.closest?.('input,textarea,select,[contenteditable]')) return;
      const k = e.key.toLowerCase();
      if (!WALK_KEYS.includes(k)) return;
      this.keys.add(k);
      if (k.startsWith('arrow')) e.preventDefault();
      if (this.dom?.hint) this.dom.hint.style.opacity = '0';
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  _blocked(x, z) {
    if (this.slabPoly && !pointInPoly(x, z, this.slabPoly)) return true;
    if (this.doors?.passable(x, z)) return false;   // vano de una puerta abierta
    if (this.doors?.blocks(x, z)) return true;      // hoja cerrada
    for (const s of this.wallSegs) {
      const vx = s.bx - s.ax, vz = s.bz - s.az, L = vx * vx + vz * vz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * vx + (z - s.az) * vz) / L));
      if (Math.hypot(x - s.ax - t * vx, z - s.az - t * vz) < s.r) return true;
    }
    return false;
  }

  _walk(dt) {
    const k = this.keys;
    if (this.mode !== 'room' || this._busy || !k?.size) return;
    const cam = this.app.camera, ctl = this.app.controls;
    const has = (...a) => a.some((x) => k.has(x));
    const fwd = (has('w', 'arrowup') ? 1 : 0) - (has('s', 'arrowdown') ? 1 : 0);
    const side = (has('d', 'arrowright') ? 1 : 0) - (has('a', 'arrowleft') ? 1 : 0);
    const turn = (has('e') ? 1 : 0) - (has('q') ? 1 : 0);
    const look = ctl.target.clone().sub(cam.position);
    if (turn) {
      look.applyAxisAngle(new THREE.Vector3(0, 1, 0), -turn * 1.5 * dt);
      ctl.target.copy(cam.position).add(look);
    }
    if (!fwd && !side) return;
    const f = new THREE.Vector2(look.x, look.z);
    if (f.lengthSq() < 1e-8) return;
    f.normalize();
    const rgt = new THREE.Vector2(-f.y, f.x);
    const mv = f.multiplyScalar(fwd).add(rgt.multiplyScalar(side));
    if (mv.lengthSq() < 1e-8) return;
    mv.normalize().multiplyScalar((k.has('shift') ? 2.8 : 1.35) * dt);
    const x = cam.position.x, z = cam.position.z;
    let nx = x + mv.x, nz = z + mv.y;
    if (this._blocked(nx, nz)) {
      // deslizar a lo largo del muro
      if (!this._blocked(x + mv.x, z)) nz = z;
      else if (!this._blocked(x, z + mv.y)) nx = x;
      else return;
    }
    const dx = nx - x, dz = nz - z;
    cam.position.x += dx; cam.position.z += dz;
    ctl.target.x += dx; ctl.target.z += dz;
    if (this.vpIndex !== -1) { this.vpIndex = -1; this._updateRoomUI(); }
    // al cruzar a otra habitación, se actualizan ficha, luces y minimapa
    const here = this.rooms.find((r) => pointInPoly(nx, nz, r.poly));
    if (here && here !== this.current) {
      this.current = here;
      this._renderRoomUI();
      this._showDressing(true, here);
      if (store.state.selectedRoomId !== here.id) store.setState({ selectedRoomId: here.id });
    }
  }

  // ------------------------------------------------------------- por frame
  update(dt = 0.016) {
    this.look?.update();
    // el mobiliario del Piso 2 solo se dibuja en el recorrido, la planta y la vista cenital (en el exterior lo tapa la cubierta)
    const furn = this.app.interiorBuilder?.categoryGroups?.furniture;
    if (furn) { const show = this.mode !== 'off' || this.app._mode === 'top'; if (furn.visible !== show) furn.visible = show; }
    this._walk(dt);
    // el cielo raso solo aparece al cruzarlo (así el descenso no "choca" contra una losa blanca)
    if (this.ceiling && this.group.visible) this.ceiling.visible = this.app.camera.position.y < P2 + CEIL - 0.03;
    if (this.cornices && this.ceiling) this.cornices.visible = this.ceiling.visible;
    if (this.badgesOn && this.badgeEls) {
      const rect = this.app.container.getBoundingClientRect();
      for (const b of this.badgeEls) {
        const p = b.p.clone().project(this.app.camera);
        b.el.style.left = `${rect.left + (p.x * 0.5 + 0.5) * rect.width}px`;
        b.el.style.top = `${rect.top + (-p.y * 0.5 + 0.5) * rect.height}px`;
      }
    }
    if (this.mode === 'room') {
      this._mapTick = (this._mapTick || 0) + 1;
      if (this._mapTick % 3 === 0) this._drawMap();
    }
  }
}
