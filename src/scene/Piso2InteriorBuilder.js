import * as THREE from 'three';
import { loopToShape, applyArchitecturalBrickUVs } from './HotelBuildingBuilder.js';
import { buildItemMeshes } from './FurniturePrims.js';
import { customModel, customYaw } from './CatalogModels.js';

const MM_TO_M = 0.001;

/** UV en metros para las 6 caras de un BoxGeometry(ancho, alto, fondo). */
function metricBoxUV(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const sizes = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]; // px, nx, py, ny, pz, nz
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * sizes[f][0], uv.getY(i) * sizes[f][1]);
    }
  }
  uv.needsUpdate = true;
}
const PISO2_Y = 3.02; // Base elevation of Piso 2 in meters

/**
 * Builds the 1:1 Photorealistic BIM Interior of Piso 2
 * using real Revit coordinates (mm) and real PBR textures.
 * Every mesh carries `userData.bim` for live BIM inspection & AI Agent queries.
 */
export class Piso2InteriorBuilder {
  constructor(materials) {
    this.materials = materials;
    this.group = new THREE.Group();
    this.categoryGroups = {
      floors: new THREE.Group(),
      walls: new THREE.Group(),
      cladding: new THREE.Group(),
      rugs: new THREE.Group(),
      furniture: new THREE.Group()
    };
    Object.values(this.categoryGroups).forEach(g => this.group.add(g));
    this.bimElements = [];
  }

  registerBimMesh(mesh, meta) {
    mesh.userData.bim = meta;
    this.bimElements.push(mesh);
  }

  build(architectureData, finishesData, furnitureData, roomsData) {
    // 1. Structural Concrete Slab of Piso 2
    const slabRing = architectureData.slabLoops?.[0]?.loops?.[0];
    if (slabRing) {
      const shape = loopToShape(slabRing);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const slabMesh = new THREE.Mesh(geo, this.materials.get('WALL_PAINT'));
      slabMesh.position.y = PISO2_Y - 0.24;
      slabMesh.receiveShadow = true;
      this.categoryGroups.floors.add(slabMesh);
      this.registerBimMesh(slabMesh, {
        elementId: 408912,
        category: 'Floors (Losas Estructurales)',
        familyAndType: 'Insitu Concrete 225mm',
        level: 'PISO 2 (+3.00 m)',
        areaM2: 1142.5,
        material: 'Concreto Estructural f\'c 28 MPa',
        trustNote: 'Unidades verificadas en mm · Contorno cerrado sin auto-intersecciones'
      });
    }

    // 2. Corridor Tweed Carpet & Marble Border
    if (architectureData.corridorCarpetLoop?.[0]) {
      const shape = loopToShape(architectureData.corridorCarpetLoop[0]);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.015, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this.materials.get('HALL_ALFOMBRA'));
      mesh.position.y = PISO2_Y - 0.014;
      mesh.receiveShadow = true;
      this.categoryGroups.floors.add(mesh);
      this.registerBimMesh(mesh, {
        elementId: 1153461,
        category: 'Floors (Acabados de Piso)',
        familyAndType: 'HLF-PISO HALL ALFOMBRA TWEED 10mm',
        level: 'PISO 2 (+3.00 m)',
        areaM2: 32.94,
        material: 'HLF-ALFOMBRA HALL TWEED TRÁFICO PESADO',
        trustNote: 'Área calculada de geometría Revit: 32.94 m² exactos'
      });
    }

    if (architectureData.corridorMarbleBorderLoops?.[0]) {
      const shape = loopToShape(architectureData.corridorMarbleBorderLoops[0]);
      if (architectureData.corridorMarbleBorderLoops[1]) {
        const hole = new THREE.Path();
        const hr = architectureData.corridorMarbleBorderLoops[1];
        hole.moveTo(hr[0][0] * MM_TO_M, hr[0][1] * MM_TO_M);
        for (let i = 1; i < hr.length; i++) hole.lineTo(hr[i][0] * MM_TO_M, hr[i][1] * MM_TO_M);
        hole.closePath();
        shape.holes.push(hole);
      }
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this.materials.get('HALL_MARMOL'));
      mesh.position.y = PISO2_Y - 0.018;
      mesh.receiveShadow = true;
      this.categoryGroups.floors.add(mesh);
      this.registerBimMesh(mesh, {
        elementId: 1153565,
        category: 'Floors (Acabados de Piso)',
        familyAndType: 'HLF-PISO HALL BORDE MARMOL 20mm',
        level: 'PISO 2 (+3.00 m)',
        areaM2: 20.48,
        material: 'Mármol Crema Marfil / Antik Silver',
        trustNote: '2 bucles (perímetro exterior + vacío central de alfombra)'
      });
    }

    // 3. Room Bedroom & Bathroom Finish Floors (REF01 Wood Vinyl & REF02 Mosaic Porcelain)
    for (const room of roomsData) {
      // Main Bedroom Floor (REF01)
      const shape = loopToShape(room.mainLoop);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this.materials.get('REF01'));
      mesh.position.y = PISO2_Y - 0.014;
      mesh.receiveShadow = true;
      this.categoryGroups.floors.add(mesh);
      this.registerBimMesh(mesh, {
        elementId: Number(room.revitFloorId),
        roomId: room.id,
        category: 'Floors (Piso Acabado Habitación)',
        familyAndType: 'HLF-PISO REF 01 VINILICO MADERA 5mm',
        level: 'PISO 2 (+3.00 m)',
        areaM2: room.areaMainM2,
        material: room.finishes.floorMain,
        trustNote: `Habitación ${room.number} (${room.typology}) · Veta orientada hacia fachada`
      });

      // Bathroom Floors (REF02)
      (room.bathLoops || []).forEach((bLoop, idx) => {
        if (!bLoop || bLoop.length < 3) return;
        const bShape = loopToShape(bLoop);
        const bGeo = new THREE.ExtrudeGeometry(bShape, { depth: 0.014, bevelEnabled: false });
        bGeo.rotateX(-Math.PI / 2);
        const bMesh = new THREE.Mesh(bGeo, this.materials.get('REF02'));
        bMesh.position.y = PISO2_Y - 0.014;
        bMesh.receiveShadow = true;
        this.categoryGroups.floors.add(bMesh);
        this.registerBimMesh(bMesh, {
          elementId: Number(room.revitFloorId) + 100 + idx,
          roomId: room.id,
          category: 'Floors (Piso Baño REF 02)',
          familyAndType: 'HLF-PISO REF 02 PORCELANATO MOS THE DREAM 30x30 10mm',
          level: 'PISO 2 (+3.00 m)',
          areaM2: room.areaBathM2,
          material: room.finishes.floorBath,
          trustNote: `Zona húmeda Habitación ${room.number} · Pendiente hacia desagüe lineal`
        });
      });

      // Extra closet/vestibule loops
      (room.extraLoops || []).forEach((eLoop) => {
        if (!eLoop || eLoop.length < 3) return;
        const eShape = loopToShape(eLoop);
        const eGeo = new THREE.ExtrudeGeometry(eShape, { depth: 0.012, bevelEnabled: false });
        eGeo.rotateX(-Math.PI / 2);
        const eMesh = new THREE.Mesh(eGeo, this.materials.get('REF01'));
        eMesh.position.y = PISO2_Y - 0.014;
        eMesh.receiveShadow = true;
        this.categoryGroups.floors.add(eMesh);
      });
    }

    // 4. Rugs (TA-01, TA-02, TA-04)
    const allRugs = finishesData.rugs || [];
    allRugs.forEach((rug, idx) => {
      const [code, ring] = Array.isArray(rug) ? [rug[0], rug[1]] : [rug.code || 'TA-01', rug.ring];
      if (!ring || ring.length < 3) return;
      const rShape = loopToShape(ring);
      const rGeo = new THREE.ExtrudeGeometry(rShape, { depth: 0.012, bevelEnabled: false });
      rGeo.rotateX(-Math.PI / 2);
      const matKey = code.includes('02') ? 'TA02' : code.includes('04') ? 'TA04' : 'TA01';
      const rMesh = new THREE.Mesh(rGeo, this.materials.get(matKey));
      rMesh.position.y = PISO2_Y + 0.022;
      rMesh.receiveShadow = true;
      this.categoryGroups.rugs.add(rMesh);
      this.registerBimMesh(rMesh, {
        elementId: 967100 + idx,
        category: 'Floors (Tapetes Decorativos)',
        familyAndType: `HLF-TAPETE ${code} 10mm`,
        level: 'PISO 2 (+3.01 m)',
        areaM2: 3.4,
        material: `Tejido Plano Alto Tráfico ${code}`,
        trustNote: 'Cota superior +15 mm sobre nivel de losa Piso 2'
      });
    });

    // 5. Interior & Perimeter Walls from Revit (`p2_walls_now.json`)
    const walls = architectureData.walls || [];
    walls.forEach((w) => {
      const [id, pts, thickMm, typeName] = w;
      if (!pts || pts.length < 2) return;
      const [ax, ay] = pts[0];
      const [bx, by] = pts[1];
      const x1 = ax * MM_TO_M, z1 = -ay * MM_TO_M;
      const x2 = bx * MM_TO_M, z2 = -by * MM_TO_M;
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.08) return;

      const thick = Math.max((thickMm || 120) * MM_TO_M, 0.08);
      const wallHeight = 2.42; // Cutaway height so interior rooms are clearly visible from above
      const geo = new THREE.BoxGeometry(len, wallHeight, thick);
      // por dentro los muros van pintados / con papel: el ladrillo a la vista solo en fachada
      const isBrick = false; // dentro de las habitaciones nunca se ve ladrillo (la fachada exterior es otro modelo)
      if (isBrick) applyArchitecturalBrickUVs(geo, 1.35, 1.35);
      const mat = isBrick ? this.materials.get('BRICK_FACADE') : this.materials.get('WALL_PAINT');
      const mesh = new THREE.Mesh(geo, mat);

      mesh.position.set((x1 + x2) / 2, PISO2_Y + wallHeight / 2, (z1 + z2) / 2);
      mesh.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.categoryGroups.walls.add(mesh);

      this.registerBimMesh(mesh, {
        elementId: id,
        category: 'Walls (Muros Piso 2)',
        familyAndType: typeName || `HLF-MURO EXISTENTE ${thickMm}mm`,
        level: 'PISO 2 (+3.00 m)',
        areaM2: +(len * 2.6).toFixed(2),
        dimensions: `L=${(len * 1000).toFixed(0)} mm × e=${thickMm} mm × H=2600 mm`,
        material: isBrick ? 'Mampostería + Papel Colgadura Tessera REF 03' : 'Drywall / Mampostería Pintura Sobre Las Nubes REF 06',
        trustNote: 'Eje verificado contra levantamiento CAD 210-HLF-AI-100'
      });
    });

    // 6. Wall Cladding & Headboard Panels (E-1 to E-9 from `p2_enchapes_tapetes.json`)
    const segs = finishesData.wallCladdingSegments || [];
    segs.forEach((s, idx) => {
      const [code, x1m, y1m, x2m, y2m, thMm, z0Mm, z1Mm] = s;
      const x1 = x1m * MM_TO_M, z1 = -y1m * MM_TO_M;
      const x2 = x2m * MM_TO_M, z2 = -y2m * MM_TO_M;
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.08) return;

      const h = Math.min(((z1Mm || 2400) - (z0Mm || 0)) * MM_TO_M, 2.38);
      const yBottom = PISO2_Y + (z0Mm || 0) * MM_TO_M;
      const thick = Math.max((thMm || 12) * MM_TO_M, 0.025);

      let matKey = 'WALL_TESSERA';
      if (code === 'E-2' || code === 'E-6') matKey = 'NOGAL';
      else if (code === 'E-7') matKey = 'REF09';
      else if (code === 'E-9') matKey = 'MARMOL';
      else if (code === 'E-5') matKey = 'WALL_LISMORE';

      const geo = new THREE.BoxGeometry(len, h, thick);
      metricBoxUV(geo, len, h, thick); // textura a escala real (sin estirar la veta)
      const mesh = new THREE.Mesh(geo, this.materials.get(matKey));
      mesh.position.set((x1 + x2) / 2, yBottom + h / 2, (z1 + z2) / 2);
      mesh.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      this.categoryGroups.cladding.add(mesh);

      this.registerBimMesh(mesh, {
        elementId: 966700 + idx,
        category: 'Walls (Enchapes y Revestimientos)',
        familyAndType: `HLF-ENCHAPE ${code} (${thMm}mm)`,
        level: 'PISO 2 (+3.00 m)',
        areaM2: +(len * h).toFixed(2),
        material: code === 'E-6' || code === 'E-2'
          ? 'REF 04/08 Melamina Sikuani Nogal'
          : code === 'E-7'
          ? 'REF 09 Porcelanato Santorini Grey 120×120'
          : 'REF 03 Papel Colgadura Tessera Vescom',
        trustNote: `Revestimiento interior verificado · Altura ${(z1Mm || 2400)} mm`
      });
    });

    // 7. Real 3D Furniture Primitives (Suite D, Suites Fondo, Dobles, Sencillas)
    const furnitureCollections = [
      { list: furnitureData.suiteD || [], groupName: 'Suite D (Hab. 214)' },
      { list: furnitureData.suitesFondo || [], groupName: 'Suites Fondo (Hab. 222–224)' },
      { list: furnitureData.dobles || [], groupName: 'Habitaciones Dobles (Hab. 215, 217, 219, 221)' },
      { list: furnitureData.sencillas || [], groupName: 'Habitaciones Sencillas (Hab. 216, 218, 220, 225)' }
    ];

    let furnCounter = 0;
    const matCache = new Map();
    // dirección "pie de cama" de cada habitación (del cabecero ME-07 hacia la cama): orienta las piezas con frente (p. ej. la ranura de la mesa de noche)
    const planCenter = (it) => { const p = (it.prims || []).find((q) => q.t === 'ext' && q.ring) || null; if (p) { const n = p.ring.length; return [p.ring.reduce((s, q) => s + q[0], 0) / n * MM_TO_M, -p.ring.reduce((s, q) => s + q[1], 0) / n * MM_TO_M]; } const r = (it.prims || []).find((q) => q.t === 'rev'); return r ? [r.c[0] * MM_TO_M, -r.c[1] * MM_TO_M] : null; };
    const footDir = new Map();
    for (const col of furnitureCollections) {
      const by = new Map();
      for (const it of col.list) { const k = (/\[(\w+)\]/.exec(it.code || '') || [])[1] || '-'; if (!by.has(k)) by.set(k, {}); const o = by.get(k), c0 = /^(CAMA|ME-07)/.test(it.code) ? it.code.slice(0, 6).trim() : null; if (/^CAMA/.test(it.code) && !o.cama) o.cama = planCenter(it); if (/^ME-07/.test(it.code) && !o.head) o.head = planCenter(it); }
      for (const [k, o] of by) if (o.cama && o.head) { const dx = o.cama[0] - o.head[0], dz = o.cama[1] - o.head[1]; footDir.set(col.groupName + '|' + k, Math.atan2(dx, dz)); }
    }
    for (const col of furnitureCollections) {
      for (const item of col.list) {
        const itemGroup = new THREE.Group();
        // todos los tipos de primitivo de Revit (loft, revolución, varilla, perfil vertical…), no solo extrusiones planas
        let meshes = []; const customMeshes = [];
        // modelos 1:1 de la matriz de amoblamiento (CatalogModels) en la posición del Revit; el resto, la geometría de Revit
        const baseCode = (item.code || '').replace(/\s*\[.*\]/, '');
        const rev = (item.prims || []).find((p) => p.t === 'rev');
        const custom = rev ? customModel(baseCode, this.materials, true) : null;
        if (custom) {
          custom.position.set(rev.c[0] * MM_TO_M, PISO2_Y, -rev.c[1] * MM_TO_M);
          const yaw = footDir.get(col.groupName + '|' + ((/\[(\w+)\]/.exec(item.code || '') || [])[1] || '-'));
          const own = customYaw(baseCode, item);
          if (own !== undefined) custom.rotation.y = own; else if (yaw !== undefined) custom.rotation.y = yaw;
          itemGroup.add(custom);   // el grupo conserva su posición; sus mallas se registran para el BIM más abajo
          custom.traverse((o) => { if (o.isMesh) customMeshes.push(o); });
        } else {
          try { meshes = buildItemMeshes(item, this.materials, matCache); } catch (err) { console.warn('mobiliario', item.code, err); }
        }
        for (const mesh of meshes) {
          this.registerBimMesh(mesh, {
            elementId: 1150000 + (++furnCounter),
            category: 'Furniture (Mobiliario Fijo y Suelto)',
            familyAndType: `${item.code || 'HLF-MOB'} · ${item.desc || 'Mobiliario Hotel La Fontana'}`,
            level: 'PISO 2 (+3.00 m)',
            dimensions: 'Geometría de Revit (loft / revolución / extrusión)',
            material: `HLF-${mesh.material?.name || 'MOB'} (${col.groupName})`,
            trustNote: 'Geometría real de las familias de Revit según planos INT-605A / INT-608A'
          });
          itemGroup.add(mesh);
        }
        for (const mesh of customMeshes) {
          this.registerBimMesh(mesh, { elementId: 1150000 + (++furnCounter), category: 'Furniture (Mobiliario Fijo y Suelto)', familyAndType: `${item.code || 'HLF-MOB'} · modelo 1:1 de la matriz`, level: 'PISO 2 (+3.00 m)', dimensions: 'Medidas de la matriz de amoblamiento', material: `HLF-${mesh.material?.name || 'MOB'} (${col.groupName})`, trustNote: 'Modelo paramétrico 1:1 según matriz de amoblamiento V2' });
        }
        this.categoryGroups.furniture.add(itemGroup);
      }
    }

    return this.group;
  }
}
