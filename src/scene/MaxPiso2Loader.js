import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

const _tl = new THREE.TextureLoader();
const _texCache = new Map();

function loadRealPBR(name, rep = 1.2, aniso = 8) {
  const key = `${name}|${rep}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const mk = (suf, srgb = false) => {
    const t = _tl.load(`./assets/textures/real/${name}${suf}.webp`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep, rep);
    t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const pack = {
    map: mk('', true),
    normal: mk('_n', false),
    rough: mk('_r', false)
  };
  _texCache.set(key, pack);
  return pack;
}

/**
 * Normaliza las coordenadas UV existentes cuando provienen en escala milimétrica/centimétrica
 * de 3ds Max / SketchUp / Revit (rango > 12, p. ej. -1275..1267 en tendidos o -157..157 en papel Lismore),
 * conservando intacto el despliegue UV original sin romper costuras ni normales.
 */
function normalizeExistingUV(geo) {
  if (!geo || geo.userData._uvNormalized) return;
  geo.userData._uvNormalized = true;
  const uv = geo.attributes?.uv;
  if (!uv) return;

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const spanU = maxU - minU;
  const spanV = maxV - minV;
  const maxSpan = Math.max(spanU, spanV);
  if (maxSpan > 12) {
    const targetSpan = 2.4;
    const scale = targetSpan / maxSpan;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) - minU) * scale, (uv.getY(i) - minV) * scale);
    }
    uv.needsUpdate = true;
  }
}

/** Genera UV métricas bajo demanda si el usuario asigna un material texturizado a una malla que no traía UV. */
function ensureUVOnDemand(mesh, scaleMeters = 1.0) {
  const g = mesh?.geometry;
  if (!g || g.attributes?.uv || !g.attributes?.position) return;
  mesh.updateWorldMatrix(true, false);
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  const S = 1.0 / scaleMeters;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const mw = mesh.matrixWorld;
  const nm = new THREE.Matrix3().getNormalMatrix(mw);

  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mw);
    if (nrm) n.fromBufferAttribute(nrm, i).applyNormalMatrix(nm);
    else n.set(0, 1, 0);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    let u0, v0;
    if (ay >= ax && ay >= az) { u0 = v.x; v0 = v.z; }
    else if (ax >= az) { u0 = v.z; v0 = v.y; }
    else { u0 = v.x; v0 = v.y; }
    uv[i * 2] = u0 * S;
    uv[i * 2 + 1] = v0 * S;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * MaxPiso2Loader — Carga el modelo arquitectónico real de 3ds Max del Piso 2 completo
 * (`./assets/models/hotel_la_fontana_piso_2.glb`), lo alinea con precisión sub-milimétrica
 * al sistema de coordenadas del Masterplan Web, calibra la respuesta lumínica PBR
 * y habilita la selección de mobiliario con cambio de materiales PBR en tiempo real.
 */
export class MaxPiso2Loader {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group();
    this.group.name = 'Piso2_3dsMax_Real';
    // Alineación exacta verificada contra las 33 columnas estructurales del Masterplan:
    // X_web = X_glb - 19.6882, Y_web = Y_glb + 3.02, Z_web = Z_glb + 15.3414
    this.group.position.set(-19.6882, 3.02, 15.3414);

    this.loaded = false;
    this.interactiveMeshes = [];
    this.ceilingMeshes = [];
    this.emitterBoxes = [];
    this.mirrorSpecs = [];
    this.mirrorsGroup = new THREE.Group();
    this.mirrorsGroup.name = 'Espejos_Piso2_3dsMax';
    this.colliderGrid = new Map();
    this.colliderCellSize = 2.0;
    this.colliderSegmentsCount = 0;
    this.mirrorsGroup.visible = false;
    this._renderingMirror = false;
    this.materialsByName = new Map();
    this.selectedMesh = null;
    this.highlightBox = null;
    this._ceilVis = false;

    // Catálogo de variantes PBR reales de la escena para intercambio en tiempo real
    this.paletteCategories = [
      {
        id: 'maderas',
        label: 'Maderas y Carpintería',
        items: [
          { label: 'Sikuani Primadera', matName: 'Sikuani___Primadera', swatch: '#7c5338' },
          { label: 'Madera Negra', matName: 'Madera_Negra___Carpinter_a', swatch: '#2b2421' },
          { label: 'Roble Pórtico', matName: 'LF_PASILLO_PORTICO_MADERA_PBR', swatch: '#9c7a54' },
          { label: 'Parquet Europeo E01', matName: 'Flooring_Parquet_Parallel_E01_120cm', swatch: '#8d6346' }
        ]
      },
      {
        id: 'textiles',
        label: 'Tapizados y Textiles',
        items: [
          { label: 'Jacquard Gris', matName: 'Plain_Grey_Jacquard_2882279_24cm', swatch: '#76777a' },
          { label: 'Tejido Pino Oliva', matName: 'Fabric_Bolt_Pine', swatch: '#4a5d4e' },
          { label: 'Terciopelo Azul', matName: 'Velvet_03_Blue_6cm', swatch: '#2c4257' },
          { label: 'Lino Natural', matName: 'Plain_Natural_Texture_26193580_28cm', swatch: '#c8b9a6' },
          { label: 'Cuero Camel', matName: 'Leather_Worn_Brown_100cm', swatch: '#6e472b' },
          { label: 'Cuero Negro', matName: 'Leather_Worn_Black_100cm', swatch: '#232325' },
          { label: 'Coral Terracota', matName: 'PBR_Cojines_Coral', swatch: '#ba715c' },
          { label: 'Lencería Blanca', matName: 'M_2PT_TENDIDO_BLANCO1', swatch: '#f0eee9' }
        ]
      },
      {
        id: 'piedras',
        label: 'Piedras, Mármoles y Piso',
        items: [
          { label: 'Neolith Amazónico', matName: 'Neolith_Amazonico', swatch: '#3d4f49' },
          { label: 'Mármol Silver Blue', matName: 'Silver_Blue', swatch: '#8b929a' },
          { label: 'Porcelanato Blanco', matName: 'Porcelain_White_Glossy_001', swatch: '#e5e5e5' },
          { label: 'Tapete Habitación A02', matName: 'Carpet_A02_100cm', swatch: '#9b958b' },
          { label: 'Alfombra Ocre Carbón', matName: 'P2_PBR_Alfombra_Abstracta_Ocre_Carbon', swatch: '#8a6f48' },
          { label: 'Papel Lismore Beige', matName: 'Papel_Colgadua_Lismore', swatch: '#d2c8b8' },
          { label: 'Pintura Sobre las Nubes', matName: 'Pintura_Sobre_las_nubes', swatch: '#f2ece1' }
        ]
      },
      {
        id: 'metales',
        label: 'Metales y Herrajes',
        items: [
          { label: 'Hierro Negro Mate', matName: 'Iron_Blurry_Negro', swatch: '#1c1c1c' },
          { label: 'Dorado Champagne', matName: 'Gold_Blurry', swatch: '#d4af62' },
          { label: 'Cromo Pulido', matName: 'Aluminum_Polished', swatch: '#e8ecef' },
          { label: 'Aluminio Cepillado', matName: 'Aluminium_Brushed_Distorted_15cm', swatch: '#d0d3d6' },
          { label: 'Acero Martillado', matName: 'MARTILLADO', swatch: '#5a5d60' }
        ]
      }
    ];

    this._injectUI();
  }

  /**
   * Posiciona las luces existentes de FloorTour / InteriorLook sobre los emisores reales de 3ds Max
   * de la habitación activa (0 luces adicionales en la escena -> compilación de shaders instantánea).
   */
  focusRoom(on, r) {
    if (this.mirrorsGroup) {
      if (!this.mirrorsGroup.parent && this.app?.scene) {
        this.app.scene.add(this.mirrorsGroup);
      }
      this.mirrorsGroup.visible = Boolean(on && r);
    }

    const tour = this.app.tour;
    const look = tour?.look;
    if (!on || !r || !tour) return;

    const P2 = 3.02;
    const poly = r.poly || [];
    const cx = r.bounds ? (r.bounds.minX + r.bounds.maxX) * 0.5 : r.pole.x;
    const cz = r.bounds ? (r.bounds.minZ + r.bounds.maxZ) * 0.5 : r.pole.z;

    // Activar únicamente los espejos (Reflector en tiempo real) que pertenecen a la habitación activa
    // y orientar su normal hacia el punto de vista más cercano dentro de la habitación
    const vps = r.vps?.length ? r.vps : [{ pos: new THREE.Vector3(cx, P2 + 1.6, cz) }];
    for (const ms of this.mirrorSpecs) {
      const dist = Math.hypot(ms.center.x - cx, ms.center.z - cz);
      const inRoom = (poly.length >= 3 && pointInPoly(ms.center.x, ms.center.z, poly)) || dist < 4.8;
      if (!inRoom) {
        ms.refl.visible = false;
        continue;
      }
      const nearVp = vps.reduce((a, b) => (a.pos.distanceTo(ms.center) < b.pos.distanceTo(ms.center) ? a : b), vps[0]);
      const toEyeX = nearVp.pos.x - ms.center.x;
      const toEyeZ = nearVp.pos.z - ms.center.z;
      const dot = toEyeX * ms.normal.x + toEyeZ * ms.normal.z;
      // Si el espejo está en el otro lado de un muro divisorio (mirando a la habitación vecina), no activarlo
      if (dot < -0.15 && dist > 1.8) {
        ms.refl.visible = false;
        continue;
      }
      const sign = dot >= 0 ? 1 : -1;
      const nx = ms.normal.x * sign;
      const nz = ms.normal.z * sign;
      // Offset de 2.6 cm hacia el interior para quedar por delante del paño de muro (-3.13) y dentro del bisel negro (-3.115)
      const frontOffset = Math.max(ms.thickness * 0.5 + 0.008, 0.026);
      ms.refl.position.set(
        ms.center.x + nx * frontOffset,
        ms.center.y,
        ms.center.z + nz * frontOffset
      );
      ms.refl.rotation.set(0, Math.atan2(nx, nz), 0);
      ms.refl.updateMatrixWorld(true);
      ms.refl.userData.wallPos = ms.refl.position.clone();
      ms.refl.userData.wallQuat = ms.refl.quaternion.clone();
      ms.refl.userData.wallNormal = new THREE.Vector3(nx, 0, nz);
      ms.refl.userData.roomCenter = new THREE.Vector3(cx, P2 + 1.15, cz);
      ms.refl.userData.width = ms.width;
      ms.refl.visible = true;
      ms.refl.userData.frame = 0;
    }

    const roomEmitters = this.emitterBoxes.filter((eb) => {
      if (poly.length >= 3 && pointInPoly(eb.center.x, eb.center.z, poly)) return true;
      return Math.hypot(eb.center.x - r.pole.x, eb.center.z - r.pole.z) < 3.6;
    });

    const strips = roomEmitters
      .filter((e) => e.long > 0.48 && e.size.y < 0.35)
      .sort((a, b) => b.long - a.long);

    // Centro geométrico de la habitación para que roomLight nunca quede pegada a un muro lateral
    const midX = (cx + r.pole.x) * 0.5;
    const midZ = (cz + r.pole.z) * 0.5;

    if (tour.roomLight) {
      tour.roomLight.color.setHex(0xffe0b2);
      tour.roomLight.distance = 14;
      tour.roomLight.decay = 1.2;
      tour.roomLight.intensity = 0.72;
      tour.roomLight.position.set(midX, P2 + 1.65, midZ);
    }

    if (tour.fillLight) {
      const v0 = r.vps?.[0]?.pos || r.pole;
      tour.fillLight.color.setHex(0xfff1dc);
      tour.fillLight.distance = 12;
      tour.fillLight.decay = 1.2;
      tour.fillLight.intensity = 0.52;
      tour.fillLight.position.set((v0.x + midX) * 0.5, P2 + 1.6, (v0.z + midZ) * 0.5);
    }

    // Si la habitación tiene solo 1 ventana, el 2do RectAreaLight de InteriorLook actúa como difusor cálido cenital suave
    const rect2 = look?.windowLights?.[1];
    if (rect2 && (!r.wins || r.wins.length < 2)) {
      rect2.color.setHex(0xffd9a8);
      rect2.width = 2.8;
      rect2.height = 1.8;
      rect2.position.set(midX, P2 + 2.25, midZ);
      rect2.lookAt(midX, P2, midZ);
      rect2.intensity = 0.85;
    }
  }

  /** Calibra físicamente cada material del GLB de 3ds Max para iluminación PBR realista. */
  _upgradeMaxMaterial(m, aniso) {
    if (!m || m.userData?._upgraded) return;
    m.userData._upgraded = true;
    m.side = THREE.DoubleSide;

    const nm = m.name || '';
    const u = nm.toUpperCase();

    if (m.map) {
      m.color.setHex(0xffffff);
      m.map.anisotropy = aniso;
      m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
    }

    // 1. Pinturas de muro y cielos rasos: blanco cálido arquitectónico "Sobre las nubes"
    if (/PINTURA_SOBRE_LAS_NUBES|CIELO_PASILLO|EMPTY_MATERIAL/.test(u)) {
      m.map = null;
      m.normalMap = null;
      m.color.setHex(/EMPTY_MATERIAL/.test(u) ? 0xf5f1ea : 0xf2ece1);
      m.roughness = /EMPTY_MATERIAL/.test(u) ? 0.42 : 0.9;
      m.metalness = 0;
      m.envMapIntensity = 0.35;
      // Sutil luminancia cálida para evitar sombras grises cerradas en muros/plafones interiores
      m.emissive = new THREE.Color(0xf4eee4);
      m.emissiveIntensity = /PINTURA_SOBRE_LAS_NUBES_1|CIELO_PASILLO/.test(u) ? 0.22 : 0.08;
    }
    // 2. Maderas (Sikuani, Carpintería Negra, Pórticos, Parquet)
    else if (/SIKUANI|PORTICO_MADERA|PARQUET|MADERA_NEGRA/.test(u)) {
      m.roughness = /MADERA_NEGRA/.test(u) ? 0.46 : 0.52;
      m.metalness = 0;
      m.envMapIntensity = 0.48;
    }
    // 3. Lencería de cama y toallas (blanco cálido mate con trama de algodón)
    else if (/TENDIDO_BLANCO/.test(u)) {
      const pack = loadRealPBR('cama_blanca', 1.4, aniso);
      m.map = pack.map;
      m.normalMap = pack.normal;
      m.normalScale = new THREE.Vector2(0.35, 0.35);
      m.roughnessMap = pack.rough;
      m.color.setHex(0xfbf9f5);
      m.roughness = 0.92;
      m.metalness = 0;
      m.envMapIntensity = 0.38;
      m.emissive = new THREE.Color(0xf7f2e8);
      m.emissiveIntensity = 0.06;
    }
    // 4. Papeles de colgadura (Lismore / Lino Beige)
    else if (/PAPEL_COLGADUA|PAPEL_LINO/.test(u)) {
      m.color.setHex(0xf3ece0);
      m.roughness = 0.88;
      m.metalness = 0;
      m.envMapIntensity = 0.35;
    }
    // 5. Cortinas translúcidas iluminadas por luz de día
    else if (/CORTINA/.test(u)) {
      const pack = loadRealPBR('lino_cortina', 1.2, aniso);
      m.map = pack.map;
      m.normalMap = pack.normal;
      m.normalScale = new THREE.Vector2(0.45, 0.45);
      m.color.setHex(0xf7f2e8);
      m.roughness = 0.9;
      m.transparent = true;
      m.opacity = 0.9;
      m.emissive = new THREE.Color(0xfff6e5);
      m.emissiveIntensity = 0.22;
      m.envMapIntensity = 0.38;
    }
    // 6. Tapizados y telas (Jacquard, Pino, Terciopelo, Lino, Cojines Coral)
    else if (/JACQUARD|FABRIC_BOLT|VELVET|PLAIN_NATURAL|COJINES_CORAL/.test(u)) {
      if (/COJINES_CORAL/.test(u)) m.color.setHex(0xc4745c);
      m.roughness = 0.9;
      m.metalness = 0;
      m.envMapIntensity = 0.38;
    }
    // 7. Cueros (Camel / Negro)
    else if (/LEATHER/.test(u)) {
      m.roughness = 0.48;
      m.metalness = 0;
      m.envMapIntensity = 0.55;
    }
    // 8. Alfombras y tapetes
    else if (/CARPET|ALFOMBRA/.test(u)) {
      m.roughness = 0.92;
      m.metalness = 0;
      m.envMapIntensity = 0.35;
    }
    // 9. Piedras, Mármoles y Porcelanatos (Neolith, Silver Blue, Porcelain)
    else if (/NEOLITH|SILVER_BLUE|PORCELAIN|PIRLAN/.test(u)) {
      if (/PORCELAIN/.test(u)) m.color.setHex(0xf5f3ef);
      m.roughness = 0.22;
      m.metalness = 0.05;
      m.envMapIntensity = 0.95;
    }
    // 10. Metales (Oro, Cromo, Aluminio, Hierro Negro, Corten, Martillado)
    else if (/GOLD|ALUMIN|IRON|HERRAJES|MARTILLADO|CORTEN|SENALETICA/.test(u)) {
      if (/GOLD/.test(u)) {
        m.color.setHex(0xd4af62);
        m.roughness = 0.26;
        m.metalness = 0.92;
      } else if (/ALUMINUM_POLISHED/.test(u)) {
        m.color.setHex(0xe8ecef);
        m.roughness = 0.12;
        m.metalness = 0.96;
      } else if (/ALUMIN/.test(u)) {
        m.color.setHex(0xd0d4d8);
        m.roughness = 0.28;
        m.metalness = 0.88;
      } else if (/IRON|HERRAJES/.test(u)) {
        m.color.setHex(0x222326);
        m.roughness = 0.36;
        m.metalness = 0.78;
      }
      m.envMapIntensity = 1.1;
    }
    // 11. Vidrios
    else if (/GLASS/.test(u)) {
      m.transparent = true;
      m.opacity = /BLACK/.test(u) ? 0.55 : 0.22;
      m.roughness = 0.06;
      m.metalness = 0.1;
      m.depthWrite = false;
      m.envMapIntensity = 1.15;
    }
    // 12. Emisores LED y luminarias (Luz / Difusor LED 3000K)
    else if (/^LUZ$|DIFUSOR_LED/.test(u)) {
      m.color.setHex(0xfff6e6);
      m.emissive = new THREE.Color(0xffc985);
      m.emissiveIntensity = 2.2;
      m.roughness = 0.2;
      m.envMapIntensity = 0.2;
    } else {
      m.envMapIntensity = 0.42;
    }

    m.needsUpdate = true;
  }

  async load(onProgress) {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    loader.setDRACOLoader(draco);
    try { loader.setMeshoptDecoder(MeshoptDecoder); } catch (_) {}

    return new Promise((resolve, reject) => {
      loader.load(
        './assets/models/hotel_la_fontana_piso_2.glb',
        (gltf) => {
          const root = gltf.scene;
          this.group.add(root);
          this.group.updateMatrixWorld(true);

          const aniso = this.app.renderer.capabilities.getMaxAnisotropy?.() || 8;
          const seenGeo = new Set();

          root.traverse((obj) => {
            if (!obj.isMesh) return;
            if (obj.geometry && !seenGeo.has(obj.geometry)) {
              seenGeo.add(obj.geometry);
              for (const [k, a] of Object.entries(obj.geometry.attributes)) {
                if (a.isInterleavedBufferAttribute) {
                  const n = a.count, s = a.itemSize, out = new a.array.constructor(n * s);
                  const src = a.data.array, stride = a.data.stride, off = a.offset;
                  for (let i = 0; i < n; i++) {
                    const base = i * stride + off, dst = i * s;
                    for (let j = 0; j < s; j++) out[dst + j] = src[base + j];
                  }
                  obj.geometry.setAttribute(k, new THREE.BufferAttribute(out, s, a.normalized));
                }
              }
              normalizeExistingUV(obj.geometry);
            }

            const geoName = obj.geometry?.name || '';
            const rawName = (obj.name && !/^P2_Muros_Trazado/i.test(obj.name) ? obj.name : '')
              || geoName
              || obj.parent?.name
              || 'Elemento_P2';
            obj.name = rawName;

            // Cielos rasos de pasillo y plafones de baños/habitaciones: se ocultan en vista aérea de corte y se muestran dentro de la habitación
            const isCeil = /Cielo_Pasillo|Faldon_Cielo|Doble_Grupo#14|Sencilla_Grupo#15/i.test(rawName)
              || /Cielo_Pasillo|Faldon_Cielo|Doble_Grupo#14|Sencilla_Grupo#15/i.test(geoName);
            if (isCeil) {
              obj.userData.isCeiling = true;
              obj.userData.dynamic = true;
              obj.visible = Boolean(this._ceilVis);
              this.ceilingMeshes.push(obj);
            }

            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            let isEmitter = false;
            mats.forEach((m) => {
              if (!m) return;
              this._upgradeMaxMaterial(m, aniso);
              if (/^Luz$|Difusor_LED/i.test(m.name || '')) isEmitter = true;
              if (m.name && !this.materialsByName.has(m.name)) {
                this.materialsByName.set(m.name, m);
              }
            });

            if (isEmitter) {
              const box = new THREE.Box3().setFromObject(obj);
              const center = box.getCenter(new THREE.Vector3());
              const size = box.getSize(new THREE.Vector3());
              const long = Math.max(size.x, size.z);
              this.emitterBoxes.push({ center, size, long, name: rawName });
            }

            // Espejos reales de habitaciones y baños (Reflector planar en tiempo real sobre láminas Aluminum_Polished)
            if (mats.length === 1 && /^Aluminum_Polished/i.test(mats[0]?.name || '') && obj.geometry) {
              obj.geometry.computeBoundingBox();
              const bb = obj.geometry.boundingBox;
              if (bb) {
                const sx = (bb.max.x - bb.min.x) * 0.0254;
                const sy = (bb.max.y - bb.min.y) * 0.0254;
                const sz = (bb.max.z - bb.min.z) * 0.0254;
                const thickness = Math.min(sx, sy);
                const width = Math.max(sx, sy);
                const height = sz;
                if (thickness < 0.04 && width > 0.45 && height > 0.45) {
                  const cLocal = bb.getCenter(new THREE.Vector3());
                  const worldCenter = cLocal.clone().applyMatrix4(obj.matrixWorld);
                  const nLocal = sx < sy ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, -1, 0);
                  const worldNormal = nLocal.clone().transformDirection(obj.matrixWorld);
                  worldNormal.y = 0;
                  if (worldNormal.lengthSq() > 1e-6) {
                    worldNormal.normalize();
                    const res = 512;
                    const refl = new Reflector(
                      new THREE.PlaneGeometry(Math.max(0.2, width - 0.012), Math.max(0.2, height - 0.012)),
                      {
                        textureWidth: res,
                        textureHeight: Math.max(256, Math.min(1024, Math.round((res * height) / width))),
                        color: 0xd4d8dc,
                        clipBias: 0.003
                      }
                    );
                    refl.position.copy(worldCenter).addScaledVector(worldNormal, thickness * 0.5 + 0.004);
                    refl.rotation.set(0, Math.atan2(worldNormal.x, worldNormal.z), 0);
                    refl.visible = false;
                    refl.userData.frame = 0;
                    const origBefore = refl.onBeforeRender;
                    refl.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
                      if (scene.overrideMaterial || this._renderingMirror) return;
                      if ((refl.userData.frame++ & 1) !== 0) return;
                      this._renderingMirror = true;
                      const wallPos = refl.userData.wallPos;
                      const wallQuat = refl.userData.wallQuat;
                      const wallNormal = refl.userData.wallNormal;
                      const roomCenter = refl.userData.roomCenter;
                      const mWidth = refl.userData.width || 0.84;
                      try {
                        if (wallPos && wallQuat && wallNormal && roomCenter) {
                          const toCam = new THREE.Vector3().subVectors(camera.position, wallPos).setY(0);
                          const toRoom = new THREE.Vector3().subVectors(roomCenter, wallPos).setY(0);
                          if (toCam.lengthSq() > 1e-4 && toRoom.lengthSq() > 1e-4) {
                            toCam.normalize();
                            toRoom.normalize();
                            const bisector = new THREE.Vector3().addVectors(toCam, toRoom).normalize();
                            const effN = new THREE.Vector3()
                              .addScaledVector(wallNormal, 0.35)
                              .addScaledVector(bisector, 0.65)
                              .normalize();
                            const sinTilt = Math.sqrt(Math.max(0, 1 - Math.pow(effN.dot(wallNormal), 2)));
                            const extraAdvance = mWidth * 0.55 * sinTilt + 0.015;
                            refl.position.copy(wallPos).addScaledVector(wallNormal, extraAdvance);
                            refl.rotation.set(0, Math.atan2(effN.x, effN.z), 0);
                            refl.updateMatrixWorld(true);
                          }
                        }
                        origBefore.call(refl, renderer, scene, camera, geometry, material, group);
                      } finally {
                        if (wallPos && wallQuat) {
                          refl.position.copy(wallPos);
                          refl.quaternion.copy(wallQuat);
                          refl.updateMatrixWorld(true);
                        }
                        this._renderingMirror = false;
                      }
                    };
                    this.mirrorsGroup.add(refl);
                    this.mirrorSpecs.push({ mesh: obj, refl, center: worldCenter, normal: worldNormal, width, height, thickness });
                  }
                }
              }
            }

            // Muros y mobiliario proyectan sombras suaves (al fusionarse con StaticBatcher no añade draw calls)
            obj.castShadow = !isCeil && !isEmitter && !mats[0]?.transparent;
            obj.receiveShadow = !isEmitter;

            // Registrar metadatos BIM para que el inspector y el selector PBR funcionen sobre cada objeto
            const matLabel = mats[0]?.name || 'PBR Standard';
            obj.userData.bim = {
              elementId: obj.id,
              category: this._inferCategory(rawName),
              familyAndType: this._cleanName(rawName),
              level: 'PISO 2 (+3.02 m · 3ds Max Real)',
              areaM2: '—',
              material: matLabel,
              trustNote: 'Geometría 1:1 exportada de Autodesk 3ds Max 2027 (HLF_P2_Luces_Restituidas_26.max)'
            };

            this.interactiveMeshes.push(obj);
          });

          if (this.app?.scene && !this.mirrorsGroup.parent) {
            this.app.scene.add(this.mirrorsGroup);
          }
          this._buildCollisionGrid();
          this.loaded = true;
          if (this.app?.tour?.mode === 'room' && this.app.tour.current) {
            this.focusRoom(true, this.app.tour.current);
          }
          console.info(`[3ds Max Piso 2] Espejos Reflector creados: ${this.mirrorSpecs.length} · Segmentos de colisión 3D: ${this.colliderSegmentsCount}`);
          resolve(this.group);
        },
        (xhr) => {
          if (onProgress && xhr.total) onProgress(xhr.loaded / xhr.total);
        },
        (err) => reject(err)
      );
    });
  }

  _inferCategory(nm) {
    const u = nm.toUpperCase();
    if (u.includes('MURO') || u.includes('COLUMNA')) return 'Arquitectura Estructural (3ds Max)';
    if (u.includes('PORTAL') || u.includes('PUERTA') || u.includes('MARCO') || u.includes('DINTEL')) return 'Carpintería y Pórticos (3ds Max)';
    if (u.includes('BANO') || u.includes('TOALHA')) return 'Baños Equipados (3ds Max)';
    if (u.includes('SUITE')) return 'Suites Mobiliario (3ds Max)';
    if (u.includes('PASILLO')) return 'Circulación y Acabados (3ds Max)';
    return 'Mobiliario y Equipamiento Piso 2 (3ds Max)';
  }

  _cleanName(nm) {
    return nm
      .replace(/_i\d+$/, '')
      .replace(/mesh_name_undefined_/g, 'Pieza_')
      .replace(/_/g, ' ');
  }

  setCeilingVisible(vis) {
    const b = Boolean(vis);
    if (this._ceilVis === b && this.loaded) return;
    this._ceilVis = b;
    for (const m of this.ceilingMeshes) m.visible = b;
    if (this.app?.renderer) this.app.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Construye una grilla espacial de colisión 2D cortando los triángulos reales de muros, tabiques,
   * ventanales, puertas y mobiliario de 3ds Max en los planos horizontales de paso (y = 3.48, 3.75, 4.25 m).
   * Evita por completo atravesar paredes, muebles o puertas cerradas como un fantasma.
   */
  _buildCollisionGrid() {
    this.colliderGrid.clear();
    this.colliderSegmentsCount = 0;
    const tmpBox = new THREE.Box3();

    for (const obj of this.interactiveMeshes) {
      if (!obj.geometry || obj.userData?.isCeiling) continue;
      const nm = obj.name || '';
      const matName = (Array.isArray(obj.material) ? obj.material[0]?.name : obj.material?.name) || '';
      const tag = `${nm}|${matName}`;

      // Ignorar emisores LED, cojines sueltos, cortinas (el ventanal detrás ya bloquea), vajilla y herrajes pequeños
      if (/^Luz$|Difusor_LED|Cortina|Hunter|Grupo#1014|skp399|Velvet_03_Blue|Componente#14$|fabric_0[12]|Grupo#7[15]|Cup|Coffee|Pitcher|Glass 05|Glass 134|Herraje|faceplate|duplex_receptacle|lutron|\blite\b/i.test(tag)) {
        continue;
      }

      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
      const bb = obj.geometry.boundingBox;
      if (!bb) continue;

      tmpBox.copy(bb).applyMatrix4(obj.matrixWorld);
      const sx = tmpBox.max.x - tmpBox.min.x;
      const sy = tmpBox.max.y - tmpBox.min.y;
      const sz = tmpBox.max.z - tmpBox.min.z;

      // Descartar pisos/alfombras planas, elementos por encima de la cabeza o accesorios diminutos
      if (sy < 0.22 || Math.max(sx, sz) < 0.26 || tmpBox.max.y < 3.38 || tmpBox.min.y > 4.75) continue;

      const isDoorLeaf = /Hoja|Puerta|Door|Doble_Grupo#22$|Doble_mesh_name_undefined_123$|Sencilla_mesh_name_undefined_131$|Sencilla_Grupo#63$|Sencilla_Grupo#21$|Puertas_Referencia/i.test(tag);
      if (isDoorLeaf) {
        this._extractMeshSliceSegments(obj, [4.25], obj);
      } else if (tmpBox.max.y >= 4.18 && tmpBox.min.y <= 4.30) {
        this._extractMeshSliceSegments(obj, [4.25], null);
      } else {
        this._extractMeshSliceSegments(obj, [3.48, 3.75], null);
      }
    }
  }

  _extractMeshSliceSegments(mesh, yPlanes, doorMesh = null) {
    const geo = mesh.geometry;
    const pos = geo?.attributes?.position;
    if (!pos || pos.count < 3) return;
    const idx = geo.index ? geo.index.array : null;
    const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(pos.count / 3);
    if (triCount > 45000) return;

    const m = mesh.matrixWorld.elements;
    const m00 = m[0], m01 = m[1], m02 = m[2];
    const m04 = m[4], m05 = m[5], m06 = m[6];
    const m08 = m[8], m09 = m[9], m10 = m[10];
    const m12 = m[12], m13 = m[13], m14 = m[14];

    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx[t * 3] : t * 3;
      const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;

      const lx0 = pos.getX(i0), ly0 = pos.getY(i0), lz0 = pos.getZ(i0);
      const lx1 = pos.getX(i1), ly1 = pos.getY(i1), lz1 = pos.getZ(i1);
      const lx2 = pos.getX(i2), ly2 = pos.getY(i2), lz2 = pos.getZ(i2);

      const y0 = m01 * lx0 + m05 * ly0 + m09 * lz0 + m13;
      const y1 = m01 * lx1 + m05 * ly1 + m09 * lz1 + m13;
      const y2 = m01 * lx2 + m05 * ly2 + m09 * lz2 + m13;

      const tMinY = Math.min(y0, y1, y2);
      const tMaxY = Math.max(y0, y1, y2);
      if (tMaxY - tMinY < 0.04) continue;

      for (let p = 0; p < yPlanes.length; p++) {
        const yp = yPlanes[p];
        if (yp < tMinY || yp > tMaxY) continue;

        const x0 = m00 * lx0 + m04 * ly0 + m08 * lz0 + m12;
        const z0 = m02 * lx0 + m06 * ly0 + m10 * lz0 + m14;
        const x1 = m00 * lx1 + m04 * ly1 + m08 * lz1 + m12;
        const z1 = m02 * lx1 + m06 * ly1 + m10 * lz1 + m14;
        const x2 = m00 * lx2 + m04 * ly2 + m08 * lz2 + m12;
        const z2 = m02 * lx2 + m06 * ly2 + m10 * lz2 + m14;

        let ax = 0, az = 0, bx = 0, bz = 0, count = 0;
        const edge = (ya, yb, xa, za, xb, zb) => {
          if ((ya <= yp && yb >= yp) || (yb <= yp && ya >= yp)) {
            const dy = yb - ya;
            if (Math.abs(dy) > 1e-6) {
              const s = (yp - ya) / dy;
              const px = xa + s * (xb - xa);
              const pz = za + s * (zb - za);
              if (count === 0) { ax = px; az = pz; count = 1; }
              else if (count === 1) { bx = px; bz = pz; count = 2; }
            }
          }
        };
        edge(y0, y1, x0, z0, x1, z1);
        edge(y1, y2, x1, z1, x2, z2);
        if (count < 2) edge(y2, y0, x2, z2, x0, z0);

        if (count === 2) {
          const vx = bx - ax, vz = bz - az;
          const lenSq = vx * vx + vz * vz;
          if (lenSq > 0.0004) {
            this._addColliderSegment(ax, az, bx, bz, vx, vz, lenSq, doorMesh);
          }
        }
      }
    }
  }

  _addColliderSegment(ax, az, bx, bz, vx, vz, lenSq, doorMesh) {
    const seg = { ax, az, bx, bz, vx, vz, lenSq, doorMesh };
    this.colliderSegmentsCount++;
    const cs = this.colliderCellSize;
    const gx0 = Math.floor(Math.min(ax, bx) / cs);
    const gx1 = Math.floor(Math.max(ax, bx) / cs);
    const gz0 = Math.floor(Math.min(az, bz) / cs);
    const gz1 = Math.floor(Math.max(az, bz) / cs);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const key = `${gx},${gz}`;
        let list = this.colliderGrid.get(key);
        if (!list) {
          list = [];
          this.colliderGrid.set(key, list);
        }
        list.push(seg);
      }
    }
  }

  _getNearbySegments(x, z, pad = 0.6) {
    const cs = this.colliderCellSize;
    const gx0 = Math.floor((x - pad) / cs);
    const gx1 = Math.floor((x + pad) / cs);
    const gz0 = Math.floor((z - pad) / cs);
    const gz1 = Math.floor((z + pad) / cs);
    const out = [];
    const seen = new Set();
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const list = this.colliderGrid.get(`${gx},${gz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          if (seen.has(s)) continue;
          if (s.doorMesh && s.doorMesh.userData?._doorRig?.open) continue;
          seen.add(s);
          out.push(s);
        }
      }
    }
    return out;
  }

  /** Indica si un punto (x, z) choca contra algún muro, mueble o puerta cerrada de 3ds Max dentro del radio dado. */
  isPointBlocked(x, z, radius = 0.28) {
    if (!this.loaded || !this.colliderSegmentsCount) return false;
    const rSq = radius * radius;
    const segs = this._getNearbySegments(x, z, radius + 0.15);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const t = Math.max(0, Math.min(1, ((x - s.ax) * s.vx + (z - s.az) * s.vz) / s.lenSq));
      const dx = x - (s.ax + t * s.vx);
      const dz = z - (s.az + t * s.vz);
      if (dx * dx + dz * dz < rSq) return true;
    }
    return false;
  }

  /**
   * Resuelve el movimiento de (fromX, fromZ) a (toX, toZ) con deslizamiento suave sobre muros (incluso a 45°)
   * y prevención estricta de efecto túnel (nunca atraviesa una pared ni una puerta cerrada).
   */
  resolveCollision(fromX, fromZ, toX, toZ, radius = 0.28) {
    if (!this.loaded || !this.colliderSegmentsCount) return [toX, toZ];

    const totalDx = toX - fromX;
    const totalDz = toZ - fromZ;
    const totalDist = Math.hypot(totalDx, totalDz);
    const steps = Math.max(1, Math.ceil(totalDist / 0.05));
    let curX = fromX;
    let curZ = fromZ;

    const segCross = (p0x, p0z, p1x, p1z, ax, az, bx, bz) => {
      const rX = p1x - p0x, rZ = p1z - p0z;
      const sX = bx - ax, sZ = bz - az;
      const denom = rX * sZ - rZ * sX;
      if (Math.abs(denom) < 1e-9) return false;
      const qpX = ax - p0x, qpZ = az - p0z;
      const t = (qpX * sZ - qpZ * sX) / denom;
      const u = (qpX * rZ - qpZ * rX) / denom;
      return t >= -0.02 && t <= 1.02 && u >= -0.02 && u <= 1.02;
    };

    for (let st = 1; st <= steps; st++) {
      let nx = curX + (totalDx / steps);
      let nz = curZ + (totalDz / steps);
      const segs = this._getNearbySegments(nx, nz, radius + 0.35);

      // 1. Empuje iterativo perpendicular al contorno 3D real (permite deslizar sobre muros ortogonales y a 45°)
      for (let iter = 0; iter < 3; iter++) {
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          const t = Math.max(0, Math.min(1, ((nx - s.ax) * s.vx + (nz - s.az) * s.vz) / s.lenSq));
          const qx = s.ax + t * s.vx;
          const qz = s.az + t * s.vz;
          const dx = nx - qx;
          const dz = nz - qz;
          const dSq = dx * dx + dz * dz;
          if (dSq < radius * radius) {
            const d = Math.sqrt(dSq);
            if (d > 1e-5) {
              const push = radius - d;
              nx += (dx / d) * push;
              nz += (dz / d) * push;
            } else {
              nx = curX;
              nz = curZ;
            }
          }
        }
      }

      // 2. Verificación anti-túnel: el segmento (curX, curZ) -> (nx, nz) jamás puede cruzar un segmento de muro
      let crossed = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (segCross(curX, curZ, nx, nz, s.ax, s.az, s.bx, s.bz)) {
          crossed = true;
          break;
        }
      }
      if (crossed || this.isPointBlocked(nx, nz, radius * 0.88)) {
        break;
      }
      curX = nx;
      curZ = nz;
    }

    return [curX, curZ];
  }

  /** Encuentra el punto libre más cercano dentro de la habitación si un punto de vista cae cerca de un muro o mueble. */
  findSafePosition(x, z, fallbackCenter = null, radius = 0.32) {
    if (!this.isPointBlocked(x, z, radius)) return [x, z];
    const [rx, rz] = this.resolveCollision(x, z, x, z, radius);
    if (!this.isPointBlocked(rx, rz, radius * 0.9)) return [rx, rz];

    for (let r = 0.12; r <= 1.25; r += 0.12) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const tx = x + Math.cos(a) * r;
        const tz = z + Math.sin(a) * r;
        if (!this.isPointBlocked(tx, tz, radius)) return [tx, tz];
      }
    }
    if (fallbackCenter && !this.isPointBlocked(fallbackCenter.x, fallbackCenter.z, radius * 0.85)) {
      return [fallbackCenter.x, fallbackCenter.z];
    }
    return [x, z];
  }

  /** Raycast contra las mallas individuales incluso cuando han sido agrupadas por StaticBatcher (`visible = false`). */
  raycast(raycaster) {
    const hits = [];
    for (const m of this.interactiveMeshes) {
      if (m.userData?.isCeiling && !m.visible) continue;
      m.raycast(raycaster, hits);
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  _unbatchMesh(mesh) {
    const batchMesh = mesh?.userData?.batchedInto;
    if (!batchMesh) return;
    const siblings = mesh.userData.batchSiblings || [mesh];
    batchMesh.parent?.remove(batchMesh);
    batchMesh.geometry?.dispose();
    for (const s of siblings) {
      s.visible = true;
      s.userData.batchedInto = null;
      s.userData.batchSiblings = null;
    }
  }

  /**
   * Detecta si la malla clicada corresponde a una Puerta, Cortina o Lámpara/Interruptor
   * para ejecutar su acción física interactiva (abrir/cerrar puerta, correr cortina, encender/apagar luz).
   */
  _classifyInteractive(mesh) {
    if (!mesh) return null;
    const nm = mesh.name || '';
    const matName = (Array.isArray(mesh.material) ? mesh.material[0]?.name : mesh.material?.name) || '';
    const tag = `${nm}|${matName}`;

    // 1. Puertas y manijas/herrajes
    const isDoorLeaf = /Hoja|Puerta|Door|Doble_Grupo#22$|Doble_mesh_name_undefined_123$|Sencilla_mesh_name_undefined_131$|Sencilla_Grupo#63$|Sencilla_Grupo#21$|Puertas_Referencia/i.test(tag);
    const isDoorHandle = /Herraje|Sencilla_Grupo#68$|Sencilla_Grupo#69$|85ee755f/i.test(tag);
    if (isDoorLeaf || isDoorHandle) {
      let leaf = mesh;
      if (isDoorHandle && !isDoorLeaf) {
        const hc = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
        let bestD = 1.3;
        for (const m of this.interactiveMeshes) {
          const mTag = `${m.name || ''}|${(Array.isArray(m.material) ? m.material[0]?.name : m.material?.name) || ''}`;
          if (/Hoja|Puerta|Door|Doble_Grupo#22$|Doble_mesh_name_undefined_123$|Sencilla_mesh_name_undefined_131$|Sencilla_Grupo#63$|Sencilla_Grupo#21$|Puertas_Referencia/i.test(mTag)) {
            const d = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()).distanceTo(hc);
            if (d < bestD) { bestD = d; leaf = m; }
          }
        }
      }
      return { type: 'door', target: leaf };
    }

    // 2. Cortinas y Blackouts Hunter Douglas (incluye paños de terciopelo skp399 y cortinas traslúcidas Grupo#1014)
    if (/Cortina|Hunter|Blackout|Blind|Grupo#1014|skp399|Velvet_03_Blue|Componente#14$/i.test(tag)) {
      let drape = mesh;
      if (!/Grupo#1014|skp399|adskMatCortinas|Velvet_03_Blue/i.test(tag)) {
        const cc = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
        let bestD = 2.8;
        for (const m of this.interactiveMeshes) {
          const mTag = `${m.name || ''}|${(Array.isArray(m.material) ? m.material[0]?.name : m.material?.name) || ''}`;
          if (/Grupo#1014|skp399|adskMatCortinas|Velvet_03_Blue/i.test(mTag)) {
            const d = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()).distanceTo(cc);
            if (d < bestD) { bestD = d; drape = m; }
          }
        }
      }
      return { type: 'curtain', target: drape };
    }

    // 3. Lámparas, Apliques, Luminarias LED e Interruptores de pared
    const isSwitch = /faceplate|duplex_receptacle|lutron|\blite\b/i.test(nm);
    const isGoldLamp = /Gold_Blurry/i.test(matName) && !/Componente#2$/i.test(nm);
    const isLampPart = isSwitch || isGoldLamp || /^Luz$|Difusor_LED/i.test(matName)
      || /Lamp|Lumin|Aplique|Difusor|Luz|Componente#(3[2-9]|4[0-9]|5[0-4]|168|169|275|319|32[2367]|41[0-9]|42[0-2])|Grupo#47$|Grupo#101$|Group#(87|189|191|192)|undefined_(85[3-6]|90[2367]|1196|1205|1312|137[678]|1722|1888|1895|1961)/i.test(nm);
    if (isLampPart) {
      return { type: 'lamp', target: mesh, isSwitch };
    }

    return null;
  }

  /** Abre o cierra suavemente una puerta (batiente sobre bisagra o corrediza) junto con sus herrajes. */
  toggleDoor(doorMesh) {
    if (!doorMesh) return;
    if (!doorMesh.userData._doorRig) {
      doorMesh.updateWorldMatrix(true, false);
      const doorBox = new THREE.Box3().setFromObject(doorMesh);
      const doorCenter = doorBox.getCenter(new THREE.Vector3());

      const parts = [doorMesh];
      for (const m of this.interactiveMeshes) {
        if (m === doorMesh) continue;
        const mTag = `${m.name || ''}|${(Array.isArray(m.material) ? m.material[0]?.name : m.material?.name) || ''}`;
        if (/Herraje|Sencilla_Grupo#68$|Sencilla_Grupo#69$|85ee755f/i.test(mTag)) {
          const mc = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
          if (mc.distanceTo(doorCenter) < 1.15) parts.push(m);
        }
      }

      const partStates = parts.map((p) => {
        this._unbatchMesh(p);
        p.updateWorldMatrix(true, false);
        p.matrixAutoUpdate = false;
        return {
          mesh: p,
          origMatrix: p.matrix.clone(),
          origWorld: p.matrixWorld.clone(),
          parentInv: p.parent.matrixWorld.clone().invert()
        };
      });

      doorMesh.geometry.computeBoundingBox();
      const bb = doorMesh.geometry.boundingBox;
      const sx = (bb.max.x - bb.min.x) * 0.0254;
      const sy = (bb.max.y - bb.min.y) * 0.0254;
      const xIsWidth = sx >= sy;
      const width = Math.max(sx, sy);
      const isSliding = /Grupo#63/i.test(doorMesh.name) || width > 1.55;

      const cLocal = bb.getCenter(new THREE.Vector3());
      const pMinLocal = cLocal.clone();
      const pMaxLocal = cLocal.clone();
      if (xIsWidth) { pMinLocal.x = bb.min.x; pMaxLocal.x = bb.max.x; }
      else { pMinLocal.y = bb.min.y; pMaxLocal.y = bb.max.y; }

      const pMinWorld = pMinLocal.applyMatrix4(doorMesh.matrixWorld);
      const pMaxWorld = pMaxLocal.applyMatrix4(doorMesh.matrixWorld);

      let hingeWorld = pMinWorld;
      if (parts.length > 1) {
        const hCenter = new THREE.Box3().setFromObject(parts[1]).getCenter(new THREE.Vector3());
        hingeWorld = pMinWorld.distanceTo(hCenter) >= pMaxWorld.distanceTo(hCenter) ? pMinWorld : pMaxWorld;
      } else {
        const minCoord = xIsWidth ? bb.min.x : bb.min.y;
        const maxCoord = xIsWidth ? bb.max.x : bb.max.y;
        hingeWorld = Math.abs(minCoord) <= Math.abs(maxCoord) ? pMinWorld : pMaxWorld;
      }

      const wAxisLocal = xIsWidth ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const slideDir = wAxisLocal.transformDirection(doorMesh.matrixWorld);
      slideDir.y = 0;
      if (slideDir.lengthSq() > 1e-6) slideDir.normalize();

      doorMesh.userData._doorRig = {
        open: false,
        progress: 0,
        isSliding,
        slideDir,
        slideDist: width * 0.45,
        hingeWorld,
        doorCenter,
        partStates,
        tween: null
      };
    }

    const rig = doorMesh.userData._doorRig;
    rig.open = !rig.open;

    // Elegir sentido de giro alejándose de la cámara al abrir
    if (rig.open && !rig.isSliding && this.app?.camera) {
      const camPos = this.app.camera.position;
      const vx = rig.doorCenter.x - rig.hingeWorld.x;
      const vz = rig.doorCenter.z - rig.hingeWorld.z;
      const rotPos = new THREE.Vector3(rig.hingeWorld.x + vx * Math.cos(1.1) + vz * Math.sin(1.1), rig.doorCenter.y, rig.hingeWorld.z - vx * Math.sin(1.1) + vz * Math.cos(1.1));
      const rotNeg = new THREE.Vector3(rig.hingeWorld.x + vx * Math.cos(-1.1) + vz * Math.sin(-1.1), rig.doorCenter.y, rig.hingeWorld.z - vx * Math.sin(-1.1) + vz * Math.cos(-1.1));
      rig.swingSign = rotPos.distanceTo(camPos) >= rotNeg.distanceTo(camPos) ? 1 : -1;
    } else if (!rig.swingSign) {
      rig.swingSign = 1;
    }

    const applyProgress = (t) => {
      rig.progress = t;
      if (t <= 1e-4) {
        for (const ps of rig.partStates) {
          ps.mesh.matrix.copy(ps.origMatrix);
          ps.mesh.matrixWorldNeedsUpdate = true;
          ps.mesh.updateMatrixWorld(true);
        }
      } else {
        const W = new THREE.Matrix4();
        if (rig.isSliding) {
          W.makeTranslation(rig.slideDir.x * rig.slideDist * t, 0, rig.slideDir.z * rig.slideDist * t);
        } else {
          const T1 = new THREE.Matrix4().makeTranslation(rig.hingeWorld.x, rig.hingeWorld.y, rig.hingeWorld.z);
          const R = new THREE.Matrix4().makeRotationY(rig.swingSign * 1.42 * t);
          const T2 = new THREE.Matrix4().makeTranslation(-rig.hingeWorld.x, -rig.hingeWorld.y, -rig.hingeWorld.z);
          W.multiplyMatrices(T1, R).multiply(T2);
        }
        const tmpWorld = new THREE.Matrix4();
        for (const ps of rig.partStates) {
          tmpWorld.multiplyMatrices(W, ps.origWorld);
          ps.mesh.matrix.multiplyMatrices(ps.parentInv, tmpWorld);
          ps.mesh.matrixWorldNeedsUpdate = true;
          ps.mesh.updateMatrixWorld(true);
        }
      }
      if (this.highlightBox?.visible && this.selectedMesh) {
        this.highlightBox.setFromObject(this.selectedMesh);
      }
      if (this.app?.renderer) this.app.renderer.shadowMap.needsUpdate = true;
    };

    rig.tween?.kill?.();
    const targetT = rig.open ? 1 : 0;
    if (window.gsap) {
      rig.tween = window.gsap.to(rig, {
        progress: targetT,
        duration: 0.85,
        ease: 'power2.inOut',
        onUpdate: () => applyProgress(rig.progress)
      });
    } else {
      applyProgress(targetT);
    }

    this._showToast(rig.open ? '🚪 Puerta abierta' : '🚪 Puerta cerrada');
    this._updateActionUI();
  }

  /** Corre o cierra suavemente una cortina hacia los extremos de la ventana y modula la entrada de luz natural. */
  toggleCurtain(drapeMesh) {
    if (!drapeMesh) return;
    let rig = drapeMesh.userData._curtainRig;
    if (!rig) {
      drapeMesh.updateWorldMatrix(true, false);
      const cBox = new THREE.Box3().setFromObject(drapeMesh);
      const cCenter = cBox.getCenter(new THREE.Vector3());

      const parts = [drapeMesh];
      for (const m of this.interactiveMeshes) {
        if (m === drapeMesh) continue;
        const mTag = `${m.name || ''}|${(Array.isArray(m.material) ? m.material[0]?.name : m.material?.name) || ''}`;
        if (/Grupo#1014|skp399|adskMatCortinas|Velvet_03_Blue/i.test(mTag)) {
          const mc = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
          if (mc.distanceTo(cCenter) < 2.8) parts.push(m);
        }
      }

      // Determinar eje horizontal de la ventana en espacio mundo
      const totalBox = new THREE.Box3();
      parts.forEach((p) => {
        p.updateWorldMatrix(true, false);
        totalBox.expandByObject(p);
      });
      const winCenter = totalBox.getCenter(new THREE.Vector3());
      const winSize = totalBox.getSize(new THREE.Vector3());

      let u = new THREE.Vector3(1, 0, 0);
      const r = this.app?.tour?.current;
      if (r?.wins?.[0]?.n) {
        u.set(-r.wins[0].n.y, 0, r.wins[0].n.x);
      } else if (winSize.z > winSize.x) {
        u.set(0, 0, 1);
      }
      if (u.lengthSq() > 1e-6) u.normalize();
      else u.set(1, 0, 0);

      const winDot = winCenter.x * u.x + winCenter.z * u.z;
      const winMinDot = Math.min(totalBox.min.x * u.x + totalBox.min.z * u.z, totalBox.max.x * u.x + totalBox.max.z * u.z);
      const winMaxDot = Math.max(totalBox.min.x * u.x + totalBox.min.z * u.z, totalBox.max.x * u.x + totalBox.max.z * u.z);

      const partStates = parts.map((p) => {
        this._unbatchMesh(p);
        p.updateWorldMatrix(true, false);
        p.matrixAutoUpdate = false;
        const pb = new THREE.Box3().setFromObject(p);
        const pc = pb.getCenter(new THREE.Vector3());
        const d1 = pb.min.x * u.x + pb.min.z * u.z;
        const d2 = pb.max.x * u.x + pb.max.z * u.z;
        const pMinDot = Math.min(d1, d2);
        const pMaxDot = Math.max(d1, d2);
        const pCenterDot = pc.x * u.x + pc.z * u.z;
        // Anclar cada paño hacia su extremo exterior del vano para que se abra despejando el centro
        const anchorDot = (pMaxDot - pMinDot > 1.8)
          ? winMinDot
          : (pCenterDot <= winDot ? pMinDot : pMaxDot);
        return {
          mesh: p,
          anchorDot,
          origMatrix: p.matrix.clone(),
          origWorld: p.matrixWorld.clone(),
          parentInv: p.parent.matrixWorld.clone().invert()
        };
      });

      rig = {
        open: false,
        progress: 0,
        u,
        partStates,
        tween: null
      };
      parts.forEach((p) => { p.userData._curtainRig = rig; });
    }

    rig.open = !rig.open;

    const applyProgress = (t) => {
      rig.progress = t;
      if (t <= 1e-4) {
        for (const ps of rig.partStates) {
          ps.mesh.matrix.copy(ps.origMatrix);
          ps.mesh.matrixWorldNeedsUpdate = true;
          ps.mesh.updateMatrixWorld(true);
        }
      } else {
        const s = 1.0 - 0.76 * t;
        const k = s - 1.0;
        const ux = rig.u.x, uz = rig.u.z;
        const tmpWorld = new THREE.Matrix4();
        const W = new THREE.Matrix4();
        for (const ps of rig.partStates) {
          const dotA = ps.anchorDot;
          W.set(
            1 + k * ux * ux, 0, k * ux * uz, -k * dotA * ux,
            0,               1, 0,           0,
            k * ux * uz,     0, 1 + k * uz * uz, -k * dotA * uz,
            0,               0, 0,           1
          );
          tmpWorld.multiplyMatrices(W, ps.origWorld);
          ps.mesh.matrix.multiplyMatrices(ps.parentInv, tmpWorld);
          ps.mesh.matrixWorldNeedsUpdate = true;
          ps.mesh.updateMatrixWorld(true);
        }
      }
      const winLight = this.app?.tour?.look?.windowLights?.[0];
      if (winLight) winLight.intensity = 1.9 + 0.95 * t;
      if (this.highlightBox?.visible && this.selectedMesh) {
        this.highlightBox.setFromObject(this.selectedMesh);
      }
      if (this.app?.renderer) this.app.renderer.shadowMap.needsUpdate = true;
    };

    rig.tween?.kill?.();
    const targetT = rig.open ? 1 : 0;
    if (window.gsap) {
      rig.tween = window.gsap.to(rig, {
        progress: targetT,
        duration: 0.9,
        ease: 'power2.inOut',
        onUpdate: () => applyProgress(rig.progress)
      });
    } else {
      applyProgress(targetT);
    }

    this._showToast(rig.open ? '🪟 Cortina abierta · Más luz natural' : '🪟 Cortina cerrada');
    this._updateActionUI();
  }

  /** Enciende o apaga una lámpara, aplique, tira LED o interruptor de pared en tiempo real. */
  toggleLamp(lampMesh) {
    if (!lampMesh) return;
    let rig = lampMesh.userData._lampRig;
    if (!rig) {
      const box = new THREE.Box3().setFromObject(lampMesh);
      const center = box.getCenter(new THREE.Vector3());
      const isSwitch = /faceplate|duplex_receptacle|lutron|\blite\b/i.test(lampMesh.name || '');
      const radius = isSwitch ? 4.2 : 0.75;

      const parts = [lampMesh];
      for (const m of this.interactiveMeshes) {
        if (m === lampMesh) continue;
        const nm = m.name || '';
        const matName = (Array.isArray(m.material) ? m.material[0]?.name : m.material?.name) || '';
        const isLampCandidate = /^Luz$|Difusor_LED/i.test(matName)
          || (/Gold_Blurry/i.test(matName) && !/Componente#2$/i.test(nm))
          || /Componente#(3[2-9]|4[0-9]|5[0-4]|168|169|275|319|32[2367]|41[0-9]|42[0-2])|Grupo#47$|Grupo#101$|Group#(87|189|191|192)|undefined_(85[3-6]|90[2367]|1196|1205|1312|137[678]|1722|1888|1895|1961)/i.test(nm);
        if (!isLampCandidate) continue;
        const mc = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
        if (mc.distanceTo(center) < radius) parts.push(m);
      }

      const clonedMats = [];
      parts.forEach((p) => {
        this._unbatchMesh(p);
        if (!p.userData._lampMatCloned && p.material) {
          p.userData._lampMatCloned = true;
          p.material = Array.isArray(p.material) ? p.material.map((x) => x?.clone()) : p.material.clone();
        }
        const ms = Array.isArray(p.material) ? p.material : [p.material];
        ms.forEach((m) => { if (m && !clonedMats.includes(m)) clonedMats.push(m); });
      });

      rig = {
        on: true,
        isSwitch,
        center,
        parts,
        mats: clonedMats
      };
      parts.forEach((p) => { p.userData._lampRig = rig; });
    }

    rig.on = !rig.on;
    for (const m of rig.mats) {
      const u = (m.name || '').toUpperCase();
      if (/^LUZ$|DIFUSOR_LED/.test(u)) {
        m.color.setHex(rig.on ? 0xfff8eb : 0x22201d);
        m.emissive = new THREE.Color(0xffc985);
        m.emissiveIntensity = rig.on ? 3.2 : 0.0;
      } else if (/GOLD/.test(u)) {
        m.color.setHex(rig.on ? 0xd4af62 : 0x2c2211);
        m.metalness = rig.on ? 0.90 : 0.22;
        m.roughness = rig.on ? 0.26 : 0.78;
        m.envMapIntensity = rig.on ? 1.1 : 0.06;
        m.emissive = new THREE.Color(0xffb84d);
        m.emissiveIntensity = rig.on ? 0.65 : 0.0;
      } else {
        m.emissive = new THREE.Color(0xffb84d);
        m.emissiveIntensity = rig.on ? 0.35 : 0.0;
      }
      m.needsUpdate = true;
    }

    const tour = this.app?.tour;
    if (tour) {
      if (rig.isSwitch) {
        if (tour.roomLight) tour.roomLight.intensity = rig.on ? 0.85 : 0.04;
        if (tour.fillLight) tour.fillLight.intensity = rig.on ? 0.75 : 0.02;
      } else {
        if (tour.fillLight) {
          tour.fillLight.color.setHex(0xffc478);
          tour.fillLight.position.set(rig.center.x, rig.center.y - 0.08, rig.center.z);
          tour.fillLight.intensity = rig.on ? 1.65 : 0.0;
        }
        if (tour.roomLight) {
          tour.roomLight.intensity = rig.on ? 0.80 : 0.16;
        }
      }
    }

    this._showToast(rig.on ? '💡 Luminaria encendida' : '💡 Luminaria apagada');
    this._updateActionUI();
  }

  _showToast(msg) {
    if (!this.toastEl) return;
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl?.classList.remove('show'), 2200);
  }

  _updateActionUI() {
    if (!this.domActionWrap) return;
    const feat = this._classifyInteractive(this.selectedMesh);
    if (!feat) {
      this.domActionWrap.style.display = 'none';
      return;
    }
    this.domActionWrap.style.display = 'block';
    if (feat.type === 'door') {
      const open = Boolean(feat.target.userData?._doorRig?.open);
      this.domActionBtn.textContent = open ? '🚪 Cerrar Puerta' : '🚪 Abrir Puerta';
      this.domActionBtn.onclick = () => this.toggleDoor(feat.target);
    } else if (feat.type === 'curtain') {
      const open = Boolean(feat.target.userData?._curtainRig?.open);
      this.domActionBtn.textContent = open ? '🪟 Cerrar Cortina' : '🪟 Correr / Abrir Cortina';
      this.domActionBtn.onclick = () => this.toggleCurtain(feat.target);
    } else if (feat.type === 'lamp') {
      const on = feat.target.userData?._lampRig ? feat.target.userData._lampRig.on : true;
      this.domActionBtn.textContent = on ? '💡 Apagar Luminaria' : '💡 Encender Luminaria';
      this.domActionBtn.onclick = () => this.toggleLamp(feat.target);
    }
  }

  /** Selecciona un objeto 3D del Piso 2, ejecuta su interacción física si es puerta/cortina/lámpara y abre el Personalizador PBR. */
  selectObject(mesh, triggerInteractive = true) {
    if (!mesh) {
      this.clearSelection();
      return;
    }
    this.selectedMesh = mesh;

    const feat = this._classifyInteractive(mesh);
    if (triggerInteractive && feat) {
      if (feat.type === 'door') this.toggleDoor(feat.target);
      else if (feat.type === 'curtain') this.toggleCurtain(feat.target);
      else if (feat.type === 'lamp') this.toggleLamp(feat.target);
    }

    if (!this.highlightBox) {
      this.highlightBox = new THREE.BoxHelper(mesh, 0xf2782f);
      this.highlightBox.material.depthTest = false;
      this.highlightBox.material.transparent = true;
      this.highlightBox.material.opacity = 0.85;
      this.app.scene.add(this.highlightBox);
    } else {
      this.highlightBox.setFromObject(mesh);
      this.highlightBox.visible = true;
    }

    const nm = this._cleanName(mesh.name || mesh.parent?.name || 'Elemento Piso 2');
    const curMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    this.domTitle.textContent = nm;
    this.domSub.textContent = `Material actual: ${(curMat?.name || 'PBR').replace(/_/g, ' ')}`;
    this._updateActionUI();
    this.panel.classList.add('open');

    // Marcar swatch activo
    const activeName = curMat?.name || '';
    this.panel.querySelectorAll('.pbr-swatch-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mat === activeName);
    });
  }

  clearSelection() {
    this.selectedMesh = null;
    if (this.highlightBox) this.highlightBox.visible = false;
    this.panel?.classList.remove('open');
  }

  applyMaterialVariant(matName) {
    if (!this.selectedMesh) return;
    const targetMat = this.materialsByName.get(matName);
    if (!targetMat) return;

    this._unbatchMesh(this.selectedMesh);
    if (targetMat.map) {
      ensureUVOnDemand(this.selectedMesh, 1.0);
    }
    if (!this.selectedMesh.userData._origMaterial) {
      this.selectedMesh.userData._origMaterial = this.selectedMesh.material;
    }
    this.selectedMesh.material = targetMat;
    if (this.selectedMesh.userData.bim) {
      this.selectedMesh.userData.bim.material = matName;
    }
    this.domSub.textContent = `Material actual: ${matName.replace(/_/g, ' ')}`;
    this.panel.querySelectorAll('.pbr-swatch-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mat === matName);
    });
    if (this.app.renderer) this.app.renderer.shadowMap.needsUpdate = true;
  }

  restoreOriginalMaterial() {
    if (!this.selectedMesh || !this.selectedMesh.userData._origMaterial) return;
    this._unbatchMesh(this.selectedMesh);
    this.selectedMesh.material = this.selectedMesh.userData._origMaterial;
    const curMat = Array.isArray(this.selectedMesh.material) ? this.selectedMesh.material[0] : this.selectedMesh.material;
    this.domSub.textContent = `Material actual: ${(curMat?.name || 'Original').replace(/_/g, ' ')}`;
    this.panel.querySelectorAll('.pbr-swatch-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mat === curMat?.name);
    });
  }

  _injectUI() {
    const css = document.createElement('style');
    css.textContent = `
      .pbr-customizer {
        position: fixed;
        left: 20px;
        bottom: 88px;
        width: 320px;
        max-height: 62vh;
        background: rgba(16, 17, 21, 0.88);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 16px;
        padding: 16px;
        color: #fff;
        font-family: Inter, Roboto, system-ui, sans-serif;
        z-index: 45;
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
        overflow-y: auto;
        transform: translateY(20px);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s ease, transform 0.25s ease;
      }
      .pbr-customizer.open {
        transform: translateY(0);
        opacity: 1;
        pointer-events: auto;
      }
      .pbr-customizer__head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        padding-bottom: 10px;
        margin-bottom: 12px;
      }
      .pbr-customizer__badge {
        display: inline-block;
        font-size: 9.5px;
        font-weight: 700;
        letter-spacing: 1.2px;
        text-transform: uppercase;
        color: #f2782f;
        margin-bottom: 4px;
      }
      .pbr-customizer__title {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
        line-height: 1.25;
      }
      .pbr-customizer__sub {
        font-size: 11px;
        color: #a8b0bc;
        margin-top: 3px;
      }
      .pbr-customizer__close {
        background: rgba(255, 255, 255, 0.1);
        border: 0;
        color: #fff;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 14px;
        line-height: 26px;
        text-align: center;
      }
      .pbr-customizer__close:hover { background: #d6202e; }
      .pbr-cat-title {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: #9ba3b0;
        margin: 10px 0 6px;
      }
      .pbr-swatch-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
      }
      .pbr-swatch-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        padding: 6px 8px;
        color: #e4e7ec;
        font-size: 11px;
        cursor: pointer;
        text-align: left;
        transition: all 0.15s ease;
      }
      .pbr-swatch-btn:hover {
        background: rgba(255, 255, 255, 0.14);
        border-color: rgba(255, 255, 255, 0.3);
      }
      .pbr-swatch-btn.active {
        border-color: #f2782f;
        background: rgba(242, 120, 47, 0.18);
        color: #fff;
      }
      .pbr-swatch-dot {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        flex-shrink: 0;
        border: 1px solid rgba(255, 255, 255, 0.35);
      }
      .pbr-reset-btn {
        margin-top: 12px;
        width: 100%;
        padding: 8px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.06);
        color: #ccc;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }
      .pbr-reset-btn:hover { background: rgba(255, 255, 255, 0.15); color: #fff; }
      .pbr-action-wrap {
        display: none;
        margin-bottom: 12px;
      }
      .pbr-action-btn {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid #f2782f;
        background: linear-gradient(135deg, #f2782f 0%, #d64e12 100%);
        color: #fff;
        font-size: 12.5px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(242, 120, 47, 0.35);
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .pbr-action-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 18px rgba(242, 120, 47, 0.5);
      }
      .pbr-toast {
        position: fixed;
        top: 76px;
        left: 50%;
        transform: translate(-50%, -12px);
        background: rgba(16, 17, 21, 0.92);
        border: 1px solid rgba(242, 120, 47, 0.65);
        color: #fff;
        padding: 8px 18px;
        border-radius: 999px;
        font: 600 12.5px/1.2 Inter, Roboto, system-ui, sans-serif;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        z-index: 60;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.22s ease, transform 0.22s ease;
      }
      .pbr-toast.show {
        opacity: 1;
        transform: translate(-50%, 0);
      }
    `;
    document.head.appendChild(css);

    const toast = document.createElement('div');
    toast.className = 'pbr-toast';
    document.body.appendChild(toast);
    this.toastEl = toast;

    const panel = document.createElement('div');
    panel.className = 'pbr-customizer';
    panel.innerHTML = `
      <div class="pbr-customizer__head">
        <div>
          <span class="pbr-customizer__badge">Interacción & PBR · Piso 2</span>
          <h4 class="pbr-customizer__title">Selecciona un elemento</h4>
          <div class="pbr-customizer__sub">Haz clic en puertas, cortinas, luces o muebles</div>
        </div>
        <button class="pbr-customizer__close" title="Cerrar">×</button>
      </div>
      <div class="pbr-action-wrap">
        <button class="pbr-action-btn">Acción interactiva</button>
      </div>
      <div class="pbr-customizer__body"></div>
      <button class="pbr-reset-btn">Restaurar material original</button>
    `;
    document.body.appendChild(panel);
    this.panel = panel;
    this.domTitle = panel.querySelector('.pbr-customizer__title');
    this.domSub = panel.querySelector('.pbr-customizer__sub');
    this.domActionWrap = panel.querySelector('.pbr-action-wrap');
    this.domActionBtn = panel.querySelector('.pbr-action-btn');

    const body = panel.querySelector('.pbr-customizer__body');
    this.paletteCategories.forEach((cat) => {
      const title = document.createElement('div');
      title.className = 'pbr-cat-title';
      title.textContent = cat.label;
      body.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'pbr-swatch-grid';
      cat.items.forEach((item) => {
        const btn = document.createElement('button');
        btn.className = 'pbr-swatch-btn';
        btn.dataset.mat = item.matName;
        btn.innerHTML = `<span class="pbr-swatch-dot" style="background:${item.swatch}"></span><span>${item.label}</span>`;
        btn.onclick = () => this.applyMaterialVariant(item.matName);
        grid.appendChild(btn);
      });
      body.appendChild(grid);
    });

    panel.querySelector('.pbr-customizer__close').onclick = () => this.clearSelection();
    panel.querySelector('.pbr-reset-btn').onclick = () => this.restoreOriginalMaterial();
  }
}
