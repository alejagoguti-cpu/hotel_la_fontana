import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * MaxPiso2Loader — Carga el modelo arquitectónico real de 3ds Max del Piso 2 completo
 * (`./assets/models/hotel_la_fontana_piso_2.glb`), lo alinea con precisión sub-milimétrica
 * al sistema de coordenadas del Masterplan Web y habilita la selección de mobiliario
 * y acabados con cambio de materiales PBR en tiempo real (estilo Bear Studios).
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
    this.materialsByName = new Map();
    this.selectedMesh = null;
    this.highlightBox = null;

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
          { label: 'Pintura Sobre las Nubes', matName: 'Pintura_Sobre_las_nubes', swatch: '#cec5c0' }
        ]
      },
      {
        id: 'metales',
        label: 'Metales y Herrajes',
        items: [
          { label: 'Hierro Negro Mate', matName: 'Iron_Blurry_Negro', swatch: '#1c1c1c' },
          { label: 'Dorado Champagne', matName: 'Gold_Blurry', swatch: '#fae6ab' },
          { label: 'Cromo Pulido', matName: 'Aluminum_Polished', swatch: '#f4f5f6' },
          { label: 'Aluminio Cepillado', matName: 'Aluminium_Brushed_Distorted_15cm', swatch: '#d0d3d6' },
          { label: 'Acero Martillado', matName: 'MARTILLADO', swatch: '#5a5d60' }
        ]
      }
    ];

    this._injectUI();
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
            }
            const nm = obj.name || obj.parent?.name || 'Elemento_P2';
            const isCeil = /Cielo_Pasillo|Faldon_Cielo/i.test(nm);
            if (isCeil) {
              obj.userData.isCeiling = true;
              obj.userData.dynamic = true;
              this.ceilingMeshes.push(obj);
            }
            // Solo muros, columnas y pórticos proyectan sombra solar directa (evita sobrecargar el shadow map de 4096px)
            obj.castShadow = !isCeil && /MURO|COLUMNA|PORTAL|PUERTA|MARCO|DINTEL/i.test(nm);
            obj.receiveShadow = true;

            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach((m) => {
              if (!m) return;
              // DoubleSide garantiza que los objetos instanciados con escala negativa o planos simples se vean siempre correctamente
              m.side = THREE.DoubleSide;
              if (m.map) m.map.anisotropy = aniso;
              if (m.normalMap) m.normalMap.anisotropy = aniso;
              if (m.roughnessMap) m.roughnessMap.anisotropy = aniso;
              if (m.name && !this.materialsByName.has(m.name)) {
                this.materialsByName.set(m.name, m);
              }
            });

            // Registrar metadatos BIM para que el inspector y el selector PBR funcionen sobre cada objeto
            const matLabel = mats[0]?.name || 'PBR Standard';
            obj.userData.bim = {
              elementId: obj.id,
              category: this._inferCategory(nm),
              familyAndType: this._cleanName(nm),
              level: 'PISO 2 (+3.02 m · 3ds Max Real)',
              areaM2: '—',
              material: matLabel,
              trustNote: 'Geometría 1:1 exportada de Autodesk 3ds Max 2027 (HLF_P2_Luces_Restituidas_26.max)'
            };

            this.interactiveMeshes.push(obj);
          });

          this.group.add(root);
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
    if (this._ceilVis === vis) return;
    this._ceilVis = vis;
    for (const m of this.ceilingMeshes) m.visible = vis;
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
    this.app.shadowsDirty = true;
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
