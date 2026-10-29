import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MaterialLibrary } from './MaterialLibrary.js';
import { HotelBuildingBuilder } from './HotelBuildingBuilder.js';
import { Piso2InteriorBuilder } from './Piso2InteriorBuilder.js';
import { RoomHighlighter } from './RoomHighlighter.js';
import { store } from '../state/store.js';
import { SkyEnvironment } from './SkyEnvironment.js';
import { PostFX } from './PostFX.js';
import { CityContext } from './CityContext.js';
import { FloorTour } from './FloorTour.js';
import { NetworksLayer } from './NetworksLayer.js';
import { batchStatic, snapshotMatrices, movingSince } from './StaticBatcher.js';
import { applyWind, windUniforms } from './Wind.js';
import { RevitRoomFurniture, ROOM_INSTANCES } from './RevitRoomFurniture.js';
import { MaxPiso2Loader } from './MaxPiso2Loader.js';

export class MasterplanScene {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    // Cielo procedural tipo Unreal (Sky Atmosphere + Volumetric Clouds): ver SkyEnvironment
    this.scene.fog = new THREE.Fog(0xc9d6e4, 220, 1400);
    this.clock = new THREE.Clock();

    this.camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.5,
      90000
    );
    this.camera.position.set(34, 20, 30);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // Pivoteo tipo masterplan (Umbra): giro suave alrededor del hotel, inclinación acotada,
    // desplazamiento sobre el plano del suelo y sin perder el proyecto de vista
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.8;
    this.controls.screenSpacePanning = false; // arrastre sobre el suelo, el pivote nunca sube ni se entierra
    this.controls.target.set(16, 4.2, 2);
    this.pivotCenter = new THREE.Vector3(20, 0, 0);
    this.setOrbitLimits('exterior');

    this.materials = new MaterialLibrary(this.renderer);
    this.materials.initAll();

    this.buildingBuilder = new HotelBuildingBuilder(this.materials);
    this.interiorBuilder = new Piso2InteriorBuilder(this.materials);
    this.maxPiso2 = new MaxPiso2Loader(this);
    this.roomHighlighter = new RoomHighlighter(this.scene);
    this.tour = new FloorTour(this);
    try { this.networks = new NetworksLayer(this); } catch (e) { console.warn('Capa de redes no disponible', e); }

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    this.setupLighting();
    this.skyEnv = new SkyEnvironment(this.renderer, this.scene, this.sunLight, this.hemiLight);
    // Contexto real de Bogotá: ortofoto, relieve (Cerros Orientales), catastro 3D y arbolado
    try {
      this.city = new CityContext(this.scene, { renderer: this.renderer, mobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) });
      if (this.skyEnv.farGround) this.skyEnv.farGround.visible = false;
    } catch (e) { console.warn('Contexto urbano no disponible', e); }
    try { this.postfx = new PostFX(this.renderer, this.scene, this.camera, this.container); } catch (e) { console.warn('PostFX desactivado', e); }
    // resolución adaptable: arranca en el máximo del perfil y se ajusta según los FPS reales
    this.maxPixelRatio = this.postfx?.maxPixelRatio ?? Math.min(window.devicePixelRatio, 2);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this._perf = { t: 0, n: 0, ms: 0 };
    if (this.postfx?.low && this.skyEnv?.cloudMaterial) this.skyEnv.cloudMaterial.uniforms.uSteps.value = 16;
    this.setupEvents();
    this.animate();
  }

  setupLighting() {
    // Ambient / Skylight dome illumination
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xc8d6e5, 0.95);
    this.hemiLight = hemiLight;
    this.scene.add(hemiLight);

    // Main Sunlight (Bright Bogotá daylight with crisp shadows)
    const sunLight = new THREE.DirectionalLight(0xfffaed, 3.1);
    sunLight.position.set(65, 85, 45);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 4096;
    sunLight.shadow.mapSize.height = 4096;
    sunLight.shadow.normalBias = 0.03;
    sunLight.shadow.radius = 3;
    sunLight.shadow.camera.near = 10;
    sunLight.shadow.camera.far = 240;
    sunLight.shadow.camera.left = -65;
    sunLight.shadow.camera.right = 65;
    sunLight.shadow.camera.top = 65;
    sunLight.shadow.camera.bottom = -65;
    sunLight.shadow.bias = -0.0003;
    this.sunLight = sunLight;
    this.scene.add(sunLight);

    // Warm bounce fill light
    const fillLight = new THREE.DirectionalLight(0xe8f0fa, 0.35);
    fillLight.position.set(-50, 40, -40);
    this.scene.add(fillLight);
  }

  async loadData() {
    const [arch, finishes, rooms, catastro, urbanNetwork, revitWindows, roofs] = await Promise.all([
      fetch('./data/geometry/p2-architecture.json').then(r => r.json()),
      fetch('./data/geometry/p2-finishes.json').then(r => r.json()),
      
      fetch('./data/rooms-piso2.json').then(r => r.json()),
      fetch('./data/geometry/catastro-buildings-3d.json').then(r => r.json()).catch(() => []),
      fetch('./data/geometry/urban-roads-trees-3d.json').then(r => r.json()).catch(() => ({})),
      fetch('./data/geometry/p2-windows-revit.json').then(r => r.json()).catch(() => []),
      fetch('./data/geometry/hotel-roofs.json').then(r => r.json()).catch(() => null)
    ]);

    // 1. Hotel building exterior + real Catastro urban context + real roads & trees + authentic Revit windows
    //    (los volúmenes blancos del entorno los reemplaza CityContext con el catastro real texturizado)
    const ctxBuildings = this.city ? catastro.filter((b) => b.isHotel) : catastro;
    const building = this.buildingBuilder.build(arch, ctxBuildings, urbanNetwork, revitWindows, roofs);
    if (this.city && this.buildingBuilder.groundPlane) this.buildingBuilder.groundPlane.visible = false;
    this.scene.add(building);

    // 2. Interior Piso 2 — Modelo 1:1 Real exportado de Autodesk 3ds Max (hotel_la_fontana_piso_2.glb)
    // Se conserva únicamente la losa base estructural del Piso 2 y se carga el GLB completo del segundo piso
    const slabOnly = this.interiorBuilder.build({ slabLoops: arch.slabLoops, corridorCarpetLoop: arch.corridorCarpetLoop, corridorMarbleBorderLoops: arch.corridorMarbleBorderLoops, walls: [], columns: [], stairs: [] }, { wallFinishes: [] }, { items: [] }, rooms);
    this.scene.add(slabOnly);
    this.scene.add(this.maxPiso2.group);
    this.maxPiso2Ready = this.maxPiso2.load().then(() => {
      this.interiorBuilder.bimElements.push(...this.maxPiso2.interactiveMeshes);
      this.batchSoon();
      this.shadowsDirty = true;
      console.info('[3ds Max Piso 2] Modelo GLB cargado y alineado con éxito:', this.maxPiso2.interactiveMeshes.length, 'objetos interactivos');
    }).catch((e) => console.error('Error cargando GLB Piso 2:', e));

    // 3. Room highlights
    this.roomHighlighter.build(rooms);
    try { this.tour.init(rooms, arch); } catch (e) { console.warn('Recorrido Piso 2 no disponible', e); }

    store.setState({ rooms });
    this.applyViewMode(store.state.viewMode);
    this.batchSoon();
  }

  /** Fusiona las mallas quietas (ver StaticBatcher): de ~14.000 llamadas de dibujo a unos cientos. */
  batchSoon() {
    clearTimeout(this._batchT);
    const roots = () => [...this.buildingBuilder.rootGroup.children.filter((c) => !c.userData.isBatch), this.interiorBuilder.group, this.maxPiso2.group];
    const snap = snapshotMatrices(roots());
    this._batchT = setTimeout(() => {
      const moving = movingSince(snap);
      let merged = 0, meshes = 0;
      for (const r of roots()) { const s = batchStatic(r, { exclude: moving }); merged += s.merged; meshes += s.meshes; }
      this.shadowsDirty = true;
      console.info(`[optimización] ${meshes} mallas fusionadas en ${merged}`);
    }, 1200);
  }

  loadFurnitureLater(arch, finishes, rooms) {
    const load = () => fetch('./data/geometry/p2-furniture.json').then((r) => r.json()).then((furniture) => {
      const oldGroup = this.interiorBuilder.group;
      this.scene.remove(oldGroup);
      oldGroup.traverse((obj) => { if (obj.isMesh) obj.geometry?.dispose(); });
      this.interiorBuilder = new Piso2InteriorBuilder(this.materials);
      this.scene.add(this.interiorBuilder.build(arch, finishes, furniture, rooms));
      this._useRevitFurniture(rooms, furniture);
      this.batchSoon();
      if (store.state.viewMode !== 'exterior') this.applyViewMode(store.state.viewMode);
    }).catch((e) => console.warn('Mobiliario de Piso 2 no disponible', e));
    if (window.requestIdleCallback) requestIdleCallback(load, { timeout: 1200 });
    else setTimeout(load, 300);
  }

  /** Mobiliario real del Revit (por capas Doble / Sencilla…) en vez del simplificado. */
  _useRevitFurniture(rooms, furniture) {
    const covered = [];   // el mobiliario procedural ya trae la geometría completa de Revit: no se oculta nada
    const list = Array.isArray(rooms) ? rooms : (rooms?.rooms || []);
    const partial = new Set(ROOM_INSTANCES.filter((i) => i.partial).map((i) => i.id));
    const boxes = list.filter((r) => covered.includes(r.id) && r.bounds && !partial.has(r.id)).map((r) => r.bounds);
    // suites: solo la huella del módulo clonado (polígono de la 216 transformado), no toda la habitación
    const src216 = list.find((r) => r.id === 'HAB-216');
    const polys = src216?.mainLoop ? ROOM_INSTANCES.filter((i) => i.partial && i.m).map((i) => { const [pa, pb, pc, pd, tx, tz] = i.m; return src216.mainLoop.map(([px, py]) => { const X = px / 1000, Z = -py / 1000; return [pa * X + pb * Z + tx, pc * X + pd * Z + tz]; }); }) : [];
    const inPoly = (x, z, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { if (((P[i][1] > z) !== (P[j][1] > z)) && (x < (P[j][0] - P[i][0]) * (z - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0])) c = !c; } return c; };
    const furn = this.interiorBuilder.categoryGroups?.furniture;
    if (furn && (boxes.length || polys.length)) {
      const b = new THREE.Box3(), c = new THREE.Vector3();
      furn.children.forEach((item) => {
        b.setFromObject(item); if (b.isEmpty()) return;
        b.getCenter(c);
        const X = c.x * 1000, Y = -c.z * 1000;
        if (boxes.some((r) => X >= r.minX && X <= r.maxX && Y >= r.minY && Y <= r.maxY) || polys.some((P) => inPoly(c.x, c.z, P))) item.visible = false;
      });
    }
    const target = this.interiorBuilder.group;
    new RevitRoomFurniture(this.renderer).load({ furniture, rooms }).then((rf) => {
      this.revitFurniture = rf;
      target.add(rf.group);
      // piezas procedurales que el GLB ya reemplaza en su posición exacta (índice = orden de creación en Piso2InteriorBuilder)
      if (furn && rf.pieces?.replaced?.size) rf.pieces.replaced.forEach((i) => { if (furn.children[i]) furn.children[i].visible = false; });
      this.shadowsDirty = true;
    });
  }

  setupEvents() {
    window.addEventListener('resize', () => {
      this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
      this.postfx?.setSize(this.container.clientWidth, this.container.clientHeight);
    });

    const onPointerMove = (e) => {
      if (this.tour?.mode === 'room') return;
      const rect = this.container.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      // Check raycast for room highlights or BIM elements
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const isBimMode = store.state.bimInspectorOpen;

      if (!isBimMode && store.state.showRoomsOverlay) {
        const hits = this.raycaster.intersectObjects(this.roomHighlighter.roomMeshes);
        if (hits.length > 0) {
          const hitRoom = hits[0].object.userData;
          this.roomHighlighter.setHover(hitRoom.roomId);
          this.container.style.cursor = 'pointer';
          this.updateTooltip(e.clientX, e.clientY, `${hitRoom.title} · ${hitRoom.data.areaPrivateM2} m²`);
        } else {
          this.roomHighlighter.setHover(null);
          this.container.style.cursor = 'grab';
          this.hideTooltip();
        }
      }
    };

    let downPos = { x: 0, y: 0 };
    this.container.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });

    const onClick = (e) => {
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) return;
      const rect = this.container.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const isBimMode = store.state.bimInspectorOpen;

      if (isBimMode) {
        const hits = [...this.raycaster.intersectObjects(this.interiorBuilder.bimElements, true), ...(this.maxPiso2?.loaded ? this.maxPiso2.raycast(this.raycaster) : [])].sort((a, b) => a.distance - b.distance);
        if (hits.length > 0) {
          let obj = hits[0].object;
          while (obj && !obj.userData?.bim && obj.parent) obj = obj.parent;
          if (obj && obj.userData?.bim) {
            store.setState({ selectedBimElement: obj.userData.bim });
          }
          if (this.maxPiso2?.loaded) this.maxPiso2.selectObject(hits[0].object);
        }
        return;
      }

      // En Recorrido de Habitación: clic sobre cualquier mueble o acabado del GLB abre el Personalizador PBR
      if (this.tour?.mode === 'room' && this.maxPiso2?.loaded) {
        const meshHits = this.maxPiso2.raycast(this.raycaster);
        if (meshHits.length > 0) {
          this.maxPiso2.selectObject(meshHits[0].object);
        }
        return;
      }

      if (this.tour?.mode === 'room') return;

      if (store.state.showRoomsOverlay) {
        const hits = this.raycaster.intersectObjects(this.roomHighlighter.roomMeshes);
        if (hits.length > 0) {
          const hitRoom = hits[0].object.userData;
          this.selectRoom(hitRoom.roomId);
          return;
        }
      }

      // En Corte Piso 2 o Planta 3D: permitir seleccionar mobiliario o superficies directamente con clic
      if ((this._mode === 'interior' || this._mode === 'top') && this.maxPiso2?.loaded) {
        const meshHits = this.maxPiso2.raycast(this.raycaster);
        if (meshHits.length > 0) {
          this.maxPiso2.selectObject(meshHits[0].object);
        }
      }
    };

    this.container.addEventListener('pointermove', onPointerMove);
    this.container.addEventListener('click', onClick);

    // Controles de cámara orbital 360° con flechas del teclado y zoom con +/-
    this._orbitKeys = new Set();
    window.addEventListener('keydown', (e) => {
      if (this.tour?.mode === 'room' || e.target?.closest?.('input,textarea,select,[contenteditable]')) return;
      const k = e.key.toLowerCase();
      if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', '+', '=', '-', '_'].includes(k)) {
        this._orbitKeys.add(k);
        if (k.startsWith('arrow')) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this._orbitKeys?.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this._orbitKeys?.clear());

    // Subscribe to store updates
    store.subscribe((state) => {
      this.roomHighlighter.setVisibility(state.showRoomsOverlay && this.tour?.mode !== 'room');
      this.roomHighlighter.setSelected(state.selectedRoomId);
      this.applyViewMode(state.viewMode);
    });
  }

  selectRoom(roomId) {
    // en la planta del Piso 2, elegir una habitación = entrar a recorrerla
    if (this._mode === 'interior' && this.tour?.byId.has(roomId)) { this.tour.enterRoom(roomId); return; }
    store.setState({ selectedRoomId: roomId });
    const room = store.rooms?.find(r => r.id === roomId) || store.state.rooms.find(r => r.id === roomId);
    if (!room) return;

    // Fly camera smoothly toward room
    const cx = room.bounds.centerX * 0.001;
    const cz = -room.bounds.centerY * 0.001;

    gsap.to(this.controls.target, {
      x: cx,
      y: 4.5,
      z: cz,
      duration: 1.2,
      ease: 'power2.inOut'
    });

    gsap.to(this.camera.position, {
      x: cx + 24,
      y: 20,
      z: cz + 24,
      duration: 1.2,
      ease: 'power2.inOut'
    });
  }

  /** Límites de cámara por modo: el exterior se comporta como un masterplan aéreo. */
  setOrbitLimits(mode) {
    const c = this.controls;
    if (mode === 'top') {
      c.minPolarAngle = 0; c.maxPolarAngle = 0.6; c.minDistance = 20; c.maxDistance = 400; this.panRadius = 120;
    } else if (mode === 'interior') {
      c.minPolarAngle = 0; c.maxPolarAngle = Math.PI / 2 - 0.05; c.minDistance = 5; c.maxDistance = 300; this.panRadius = 120;
    } else {
      c.minPolarAngle = 0.32;          // no llega a la vertical (evita el giro brusco en el cenit)
      c.maxPolarAngle = 1.32;          // ni al horizonte (siempre se ve el suelo y el contexto)
      c.minDistance = 25; c.maxDistance = 1500; this.panRadius = 350;
    }
  }

  /** Mantiene el pivote cerca del hotel y a nivel de suelo (mueve cámara y pivote juntos). */
  _clampPivot() {
    const t = this.controls.target, c = this.pivotCenter;
    const d = new THREE.Vector3(t.x - c.x, 0, t.z - c.z);
    const r = d.length(), R = this.panRadius || 350;
    const fix = new THREE.Vector3();
    if (r > R) fix.copy(d).multiplyScalar(R / r - 1);
    fix.y = THREE.MathUtils.clamp(t.y, 0, 30) - t.y;
    if (fix.lengthSq() > 1e-8) { t.add(fix); this.camera.position.add(fix); }
  }

  applyViewMode(mode) {
    // solo actúa cuando el modo cambia (antes cualquier cambio del estado reiniciaba la cámara)
    if (mode === this._mode) return;
    this._mode = mode;
    this.setOrbitLimits(mode);
    if (mode === 'interior') {
      // Piso 2: la cubierta se levanta y la cámara baja a la planta de habitaciones
      if (this.tour?.rooms.length) {
        if (this.tour._skipPlanCamera) { this.tour._skipPlanCamera = false; this.tour.lift(true); }
        else this.tour.enterPlan();
      } else {
        this.buildingBuilder.upperBuildingGroup.visible = false;
        this.buildingBuilder.exteriorShellPiso2.visible = false;
        gsap.to(this.camera.position, { x: 32, y: 19, z: 28, duration: 1.2, ease: 'power2.inOut' });
        gsap.to(this.controls.target, { x: 16, y: 4.2, z: 2, duration: 1.2, ease: 'power2.inOut' });
      }
    } else if (mode === 'top') {
      this.tour?.leave(false);
      if (this.tour) this.tour.lift(true);
      else { this.buildingBuilder.upperBuildingGroup.visible = false; this.buildingBuilder.exteriorShellPiso2.visible = false; }
      gsap.to(this.camera.position, { x: 16, y: 75, z: 2.1, duration: 1.2, ease: 'power2.inOut' });
      gsap.to(this.controls.target, { x: 16, y: 3.5, z: 2, duration: 1.2, ease: 'power2.inOut' });
    } else {
      // Exterior: la cubierta vuelve a bajar y la cámara sale a la vista aérea del barrio
      this.tour?.leave(true);
      if (!this.tour) { this.buildingBuilder.upperBuildingGroup.visible = true; this.buildingBuilder.exteriorShellPiso2.visible = true; }
      gsap.killTweensOf(this.camera.position); gsap.killTweensOf(this.controls.target);
      gsap.to(this.camera.position, { x: -150, y: 135, z: 215, duration: 1.8, ease: 'power2.inOut' });
      gsap.to(this.controls.target, { x: 24, y: 4.0, z: 0, duration: 1.8, ease: 'power2.inOut' });
    }
  }

  updateTooltip(x, y, text) {
    let tip = document.getElementById('room-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'room-tooltip';
      tip.className = 'hover-room-tooltip';
      document.body.appendChild(tip);
    }
    tip.textContent = text;
    tip.style.left = `${x + 14}px`;
    tip.style.top = `${y + 14}px`;
    tip.classList.add('show');
  }

  hideTooltip() {
    const tip = document.getElementById('room-tooltip');
    if (tip) tip.classList.remove('show');
  }

  /** Plano cercano, niebla y cielo según la distancia de la cámara (de detalle a vista aérea de la ciudad). */
  _updateRange() {
    const cam = this.camera;
    const dist = cam.position.distanceTo(this.controls.target);
    const near = THREE.MathUtils.clamp(dist * 0.012, this.tour?.mode === 'room' ? 0.05 : 0.3, 30);
    if (Math.abs(near - cam.near) > 0.02 * cam.near) { cam.near = near; cam.updateProjectionMatrix(); }
    if (this.scene.fog) {
      this.scene.fog.near = 180 + dist * 0.9;
      this.scene.fog.far = 7000 + dist * 6;
    }
    const s = this.skyEnv;
    if (s) { s.sky?.position.copy(cam.position); s.clouds?.position.copy(cam.position); }
    this._updateProjectTag(dist);
  }

  /** Etiqueta flotante del proyecto (estilo masterplan inmobiliario), visible en vistas aéreas. */
  _updateProjectTag(dist) {
    if (!this._tag) {
      const el = document.createElement('div');
      el.className = 'project-tag';
      el.innerHTML = '<span class="project-tag__pill">Hotel Estelar La Fontana</span><span class="project-tag__stem"></span><span class="project-tag__dot"></span>';
      const css = document.createElement('style');
      css.textContent = `.project-tag{position:fixed;left:0;top:0;pointer-events:none;display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);transition:opacity .3s;z-index:5}
        .project-tag__pill{background:#d6202e;color:#fff;font:600 12px/1 Inter,system-ui,sans-serif;padding:7px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.35);white-space:nowrap;letter-spacing:.2px}
        .project-tag__stem{width:2px;height:26px;background:rgba(255,255,255,.9)}
        .project-tag__dot{width:9px;height:9px;border-radius:50%;background:#fff;border:2px solid #d6202e}`;
      document.head.appendChild(css);
      document.body.appendChild(el);
      this._tag = el;
      this._tagPos = new THREE.Vector3(18, 26, 2);
    }
    const p = this._tagPos.clone().project(this.camera);
    const show = dist > 140 && p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
    this._tag.style.opacity = show ? '1' : '0';
    if (show) {
      const r = this.container.getBoundingClientRect();
      this._tag.style.left = `${r.left + (p.x * 0.5 + 0.5) * r.width}px`;
      this._tag.style.top = `${r.top + (-p.y * 0.5 + 0.5) * r.height}px`;
    }
  }

  /** Baja o sube la resolución interna para mantener la fluidez (cada 2 s, sin saltos bruscos). */
  _adaptResolution(dt) {
    const p = this._perf; if (!p || dt >= 0.1) return; // cuadros congelados (pestaña oculta) no cuentan
    p.t += dt; p.ms += dt * 1000; p.n++;
    if (p.t < 2) return;
    const avg = p.ms / p.n; p.t = 0; p.ms = 0; p.n = 0;
    if (document.hidden) return;
    let pr = this.pixelRatio;
    // nunca por debajo de la resolución nativa: se veía pixelado
    const minPr = Math.min(1, this.maxPixelRatio);
    if (avg > 38 && pr > minPr) pr = Math.max(minPr, pr - 0.15);
    else if (avg < 20 && pr < this.maxPixelRatio) pr = Math.min(this.maxPixelRatio, pr + 0.1);
    if (Math.abs(pr - this.pixelRatio) < 0.01) return;
    this.pixelRatio = pr;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.postfx?.setPixelRatio(pr);
    this.postfx?.setSize(w, h);
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.skyEnv?.update(dt);
    this.buildingBuilder?.update?.(dt);
    if (this._orbitKeys?.size && this.tour?.mode !== 'room') {
      const azSpeed = 1.15 * dt;
      const polSpeed = 0.85 * dt;
      const zoomFactor = 1.0 + 1.2 * dt;
      const offset = this.camera.position.clone().sub(this.controls.target);
      const sph = new THREE.Spherical().setFromVector3(offset);
      if (this._orbitKeys.has('arrowleft')) sph.theta += azSpeed;
      if (this._orbitKeys.has('arrowright')) sph.theta -= azSpeed;
      if (this._orbitKeys.has('arrowup')) sph.phi = Math.max(this.controls.minPolarAngle + 0.02, sph.phi - polSpeed);
      if (this._orbitKeys.has('arrowdown')) sph.phi = Math.min(this.controls.maxPolarAngle - 0.02, sph.phi + polSpeed);
      if (this._orbitKeys.has('+') || this._orbitKeys.has('=')) sph.radius = Math.max(this.controls.minDistance, sph.radius / zoomFactor);
      if (this._orbitKeys.has('-') || this._orbitKeys.has('_')) sph.radius = Math.min(this.controls.maxDistance, sph.radius * zoomFactor);
      offset.setFromSpherical(sph);
      this.camera.position.copy(this.controls.target).add(offset);
    }
    this.controls.update();
    this._clampPivot();
    this._updateRange();
    this.tour?.update(dt);
    this._adaptResolution(dt);
    // viento en el arbolado (urbano + ortofoto)
    windUniforms.uWindTime.value += dt;
    if (!this._windOn && this.materials) {
      ['TREE_ROBLE', 'TREE_CHICALA', 'TREE_SAUCO', 'TREE_FLOWER_YELLOW', 'TREE_ACACIA'].forEach((k) => applyWind(this.materials.materials.get(k)));
      this._windOn = true;
    }
    if (this.city?.trees && !this._cityWind) { applyWind(this.city.trees.material, { amp: 1.2, from: 2.0, to: 10 }); this._cityWind = true; }
    if (this.postfx) this.postfx.render(dt); else this.renderer.render(this.scene, this.camera);
  }
}
