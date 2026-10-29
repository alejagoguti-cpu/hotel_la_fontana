import { MasterplanScene } from './scene/MasterplanScene.js';
import { SidebarFilters } from './ui/SidebarFilters.js';
import { RoomDetailCard } from './ui/RoomDetailCard.js';
import { BottomDock } from './ui/BottomDock.js';
import { GalleryModal } from './ui/GalleryModal.js';
import { LocationModal } from './ui/LocationModal.js';
import { BimInspectorPanel } from './ui/BimInspectorPanel.js';
import { store } from './state/store.js';
import { WindowEditor } from './ui/WindowEditor.js';
import { LoadingScreen } from './ui/LoadingScreen.js';

class App {
  constructor() {
    this.loading = new LoadingScreen();
    this.loading.set(0.05, 'Cargando el modelo del hotel…');
    this.container = document.getElementById('canvas-container');
    this.scene = new MasterplanScene(this.container);
    window.__masterplan = this.scene;

    this.galleryModal = new GalleryModal();
    this.locationModal = new LocationModal();
    this.bimInspector = new BimInspectorPanel(document.body);

    this.sidebar = new SidebarFilters(
      document.getElementById('left-sidebar-wrapper'),
      (roomId) => this.selectRoom(roomId)
    );

    this.detailCard = new RoomDetailCard(
      document.getElementById('room-detail-container'),
      (room) => this.openRoomGallery(room)
    );

    this.dock = new BottomDock(
      document.getElementById('bottom-dock-container'),
      {
        onTabClick: (tab) => this.handleTabClick(tab)
      }
    );

    this.setupTopBar();
    this.scene.loadData().then(async () => {
      this.windowEditor = new WindowEditor(this.scene);
      this.loading.set(0.7, 'Cargando el contexto urbano de Bogotá…');
      const city = Promise.all([this.scene.city?.ready || Promise.resolve(), this.scene.maxPiso2Ready || Promise.resolve()]);
      await Promise.race([city, new Promise((r) => setTimeout(r, 11000))]);
      this.loading.set(0.92, 'Optimizando la escena…');
      await new Promise((r) => setTimeout(r, 1500));
      this.loading.done();
    }).catch((e) => { console.error(e); this.loading.done(); });
  }

  setupTopBar() {
    // Mode pill buttons (Exterior 3D / Corte Piso 2 / Planta 3D)
    document.querySelectorAll('.mode-pill-btn[data-mode]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.mode-pill-btn[data-mode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        store.setState({ viewMode: mode });
      };
    });

    // Sky Atmosphere: hora del día
    const hourInput = document.getElementById('sky-hour');
    const hourLabel = document.getElementById('sky-hour-label');
    if (hourInput) {
      let pending = null;
      hourInput.addEventListener('input', () => {
        const h = parseFloat(hourInput.value);
        const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
        hourLabel.textContent = `${String(hh).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
        if (pending) return;
        pending = requestAnimationFrame(() => {
          pending = null;
          this.scene.skyEnv?.setHour(parseFloat(hourInput.value));
        });
      });
    }

    // BIM AI Agent button
    const bimBtn = document.getElementById('btn-toggle-bim-agent');
    if (bimBtn) {
      bimBtn.onclick = () => {
        this.bimInspector.toggle();
      };
    }
  }

  selectRoom(roomId) {
    this.scene.selectRoom(roomId);
  }

  openRoomGallery(room) {
    this.galleryModal.open(
      `Galería · ${room.title} (${room.typology})`,
      room.gallery || []
    );
  }

  handleTabClick(tab) {
    if (tab === 'ubicacion') {
      this.locationModal.open();
    } else if (tab === 'galeria') {
      // General gallery of project
      const room = store.getSelectedRoom();
      const allImages = (store.state.rooms || []).flatMap(r => r.gallery || []);
      const uniqueImages = [...new Map(allImages.map(img => [img.src, img])).values()];
      this.galleryModal.open('Galería General · Hotel Estelar La Fontana', uniqueImages);
    } else if (tab === 'urbanismo') {
      store.setState({ viewMode: 'exterior' });
      document.querySelector('.mode-pill-btn[data-mode="exterior"]')?.click();
    } else if (tab === 'inmuebles') {
      store.setState({ showRoomsOverlay: true });
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.__masterplanApp = new App();
});
