import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

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
    const tour = this.app.tour;
    const look = tour?.look;
    if (!on || !r || !tour) return;

    const P2 = 3.02;
    const poly = r.poly || [];
    const roomEmitters = this.emitterBoxes.filter((eb) => {
      if (poly.length >= 3 && pointInPoly(eb.center.x, eb.center.z, poly)) return true;
      return Math.hypot(eb.center.x - r.pole.x, eb.center.z - r.pole.z) < 3.6;
    });

    const strips = roomEmitters
      .filter((e) => e.long > 0.48 && e.size.y < 0.35)
      .sort((a, b) => b.long - a.long);

    // Centro geométrico de la habitación para que roomLight nunca quede pegada a un muro lateral
    const cx = r.bounds ? (r.bounds.minX + r.bounds.maxX) * 0.5 : r.pole.x;
    const cz = r.bounds ? (r.bounds.minZ + r.bounds.maxZ) * 0.5 : r.pole.z;
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

          this.loaded = true;
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

  /** Selecciona un objeto 3D del Piso 2 para personalizar su material PBR en tiempo real. */
  selectObject(mesh) {
    if (!mesh) {
      this.clearSelection();
      return;
    }
    this.selectedMesh = mesh;
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
    `;
    document.head.appendChild(css);

    const panel = document.createElement('div');
    panel.className = 'pbr-customizer';
    panel.innerHTML = `
      <div class="pbr-customizer__head">
        <div>
          <span class="pbr-customizer__badge">Personalizador PBR · Piso 2</span>
          <h4 class="pbr-customizer__title">Selecciona un elemento</h4>
          <div class="pbr-customizer__sub">Haz clic en cualquier mueble o superficie</div>
        </div>
        <button class="pbr-customizer__close" title="Cerrar">×</button>
      </div>
      <div class="pbr-customizer__body"></div>
      <button class="pbr-reset-btn">Restaurar material original</button>
    `;
    document.body.appendChild(panel);
    this.panel = panel;
    this.domTitle = panel.querySelector('.pbr-customizer__title');
    this.domSub = panel.querySelector('.pbr-customizer__sub');

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
