import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ------------------------------------------------------------------ *
 * 坐标约定
 *   解包数据是 UE 的厘米、X 前 / Y 右 / Z 上；
 *   glTF 导出时做了 (x, z, y) 交换并乘 0.01，所以这里是米。
 * ------------------------------------------------------------------ */
const S = 0.01;
const toVec3 = (v) => new THREE.Vector3(v[0] * S, v[2] * S, v[1] * S);
const toQuat = (q) => new THREE.Quaternion(q[0], q[2], q[1], -q[3]);

const COLORS = {
  engine: 0xff6b5a,
  front: 0xffb340,
  side: 0x56a1ff,
  track: 0x4ad07a,
  turret: 0xc07bff,
  ignore: 0x7d8794,
};

// 部位盒之外的碰撞体积，颜色分开，避免和部位盒混淆
const LAYER_COLORS = {
  impact: 0xffd24a,      // 载具撞击碰撞盒
  chassis: 0x35d6c0,     // 底盘物理盒
  nav: 0x9b8cff,         // AI 导航盒
  assembly: 0xb9c2cc,    // 装配体盒
};
const COLLISION_MESH_COLOR = 0x39e0ff;

const state = {
  data: null,
  vehicle: null,
  showModels: true,
  showBoxes: true,
  boxFill: true,
  showLabels: true,
  boxAlpha: 0.10,
  explode: 0,
  selectedBoxIndex: -1,
  tableTab: 'weapons',
  sort: {},
  hideZero: false,
  showAllArmor: false,
  showExplain: false,
  sim: { name: '', boxIndex: -1, angle: 0, distance: 0 },
  view: '3d',
  bounds: null,
  layers: { impact: false, chassis: false, nav: false, assembly: false, colmesh: false },
};

let scene, renderer, controls, modelGroup, boxGroup, axes, grid;
const layerGroups = {};
let perspCamera, orthoCamera, activeCamera;
let boxMeshes = [];
let labelLayer, hoverLabel;
let boxListEl;
let collisionMeshMaterials = [];
/* 每次换车 +1 的令牌：异步加载回来的旧车数据一律作废，防止两辆车的模型叠在一起 */
let modelToken = 0;

const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const textureCache = new Map();

/* 构建版本：改动后 +1，拼到请求上，避免浏览器 / 内嵌 WebView 缓存旧模型包与旧数据 */
const APP_BUILD = '20261014.4';
const bust = (u) => (/\?/.test(u) ? u + '&v=' : u + '?v=') + APP_BUILD;

/* ---------------------------- MFPK 打包加载 ---------------------------- */
/* GLB + 贴图按载具类型拆进多个 models.*.mfpk（每个 < 100MB），
   先读 models.manifest.json 拿到 URL->包名，再按包名懒加载。 */
let mfpkManifest = null;
const mfpkPackages = new Map();

async function parseMfpk(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'MFPK') throw new Error('bad mfpk magic');
  const view = new DataView(buf);
  const indexBytes = view.getUint32(12, true);
  const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 16, indexBytes)));
  let off = 16 + Math.ceil(indexBytes / 4) * 4;
  const entries = new Map();
  for (const e of index.entries) {
    entries.set(e.name, { kind: e.kind, offset: off, size: e.size, mime: e.mime });
    off += e.size + ((4 - e.size % 4) % 4);
  }
  return { buf, entries, loader: new GLTFLoader() };
}

async function loadMfpkManifest() {
  if (mfpkManifest) return mfpkManifest;
  try {
    const res = await fetch(bust('models.manifest.json'));
    mfpkManifest = await res.json();
  } catch (error) {
    mfpkManifest = {};
  }
  return mfpkManifest;
}

function getMfpk(pkgName) {
  if (!mfpkPackages.has(pkgName)) {
    mfpkPackages.set(pkgName, parseMfpk(bust(pkgName)).catch(() => null));
  }
  return mfpkPackages.get(pkgName);
}

async function mfpkFor(url) {
  const manifest = await loadMfpkManifest();
  const pkgName = manifest[url];
  return pkgName ? getMfpk(pkgName) : null;
}

init();

async function init() {
  labelLayer = document.getElementById('labels');
  setupScene();
  bindControls();

  const params = new URLSearchParams(location.search);
  const response = await fetch(bust('./data/vehicles.json'));
  state.data = await response.json();
  renderVehicleList();

  const wantId = Number(params.get('veh'));
  const vehicle = state.data.vehicles.find((v) => v.id === wantId) || state.data.vehicles[0];

  // URL 参数（便于自动化截图）
  const toggle = (id, key, value) => {
    if (value === null) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = value !== '0';
    state[key] = el.checked;
    el.dispatchEvent(new Event('change'));
  };
  toggle('showBoxes', 'showBoxes', params.get('boxes'));
  toggle('showModels', 'showModels', params.get('models'));
  toggle('showLabels', 'showLabels', params.get('labels'));
  toggle('boxFill', 'boxFill', params.get('fill'));
  if (params.get('help') !== null) {
    document.getElementById('layerHelp').hidden = params.get('help') === '0';
  }
  if (params.get('alpha')) {
    const slider = document.getElementById('boxAlpha');
    slider.value = params.get('alpha');
    state.boxAlpha = Number(params.get('alpha')) / 100;
  }

  selectVehicle(vehicle.id);
  const view = params.get('view');
  if (view) setView(view);
  if (params.get('box') !== null) {
    const index = Number(params.get('box'));
    if (state.vehicle.hitBoxes[index]) {
      state.selectedBoxIndex = index;
      applyBoxAlpha();
      renderBoxList();
      renderBoxInfo();
    }
  }
  if (params.get('explode')) {
    const slider = document.getElementById('explode');
    slider.value = params.get('explode');
    state.explode = Number(params.get('explode')) / 100;
    layoutParts();
  }
  document.querySelectorAll('.layer-toggle').forEach((box) => {
    const value = params.get(`layer_${box.dataset.layer}`);
    if (value === null) return;
    box.checked = value !== '0';
    box.dispatchEvent(new Event('change'));
  });
  const tab = params.get('tab');
  if (tab && document.querySelector(`.tab[data-tab="${tab}"]`)) {
    document.querySelector(`.tab[data-tab="${tab}"]`).click();
  }
  state.showExplain = params.get('explain') === '1';
  state.showAllArmor = params.get('allarmor') === '1';
  state.hideZero = params.get('hidezero') === '1';
  renderTable();
  animate();
}

/* ------------------------------ 场景 ------------------------------ */

function setupScene() {
  const canvas = document.getElementById('scene');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0f1216, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0f1216, 22, 70);

  perspCamera = new THREE.PerspectiveCamera(42, 1, 0.05, 500);
  perspCamera.position.set(6, 4, 7);
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 400);
  activeCamera = perspCamera;

  controls = new OrbitControls(activeCamera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;

  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x2a3038, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(7, 12, 9);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.7);
  fill.position.set(-9, 7, -7);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.5);
  rim.position.set(-4, 3, 10);
  scene.add(rim);

  grid = new THREE.GridHelper(60, 60, 0x2b333d, 0x1b2128);
  scene.add(grid);
  axes = new THREE.AxesHelper(2);
  axes.visible = false;
  scene.add(axes);

  modelGroup = new THREE.Group();
  boxGroup = new THREE.Group();
  scene.add(modelGroup, boxGroup);
  Object.keys(LAYER_COLORS).forEach((key) => {
    layerGroups[key] = new THREE.Group();
    layerGroups[key].visible = state.layers[key];
    scene.add(layerGroups[key]);
  });
  layerGroups.colmesh = new THREE.Group();
  layerGroups.colmesh.visible = state.layers.colmesh;
  scene.add(layerGroups.colmesh);

  hoverLabel = document.createElement('div');
  hoverLabel.className = 'label';
  hoverLabel.style.display = 'none';
  labelLayer.appendChild(hoverLabel);

  window.addEventListener('resize', resize);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('mousemove', onMove);
  resize();
}

function resize() {
  const viewport = document.getElementById('viewport');
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  if (!w || !h) return; // 收起视图后画布尺寸为 0，跳过以免把宽高比算成 NaN
  renderer.setSize(w, h, false);
  perspCamera.aspect = w / h;
  perspCamera.updateProjectionMatrix();
  updateOrtho();
}

/* ---------------------------- 交互绑定 ---------------------------- */

function bindControls() {
  document.getElementById('showModels').addEventListener('change', (e) => {
    state.showModels = e.target.checked;
    modelGroup.visible = state.showModels;
    refreshCollisionMeshStyle();
  });
  document.getElementById('showBoxes').addEventListener('change', (e) => {
    state.showBoxes = e.target.checked;
    boxGroup.visible = state.showBoxes;
  });
  document.getElementById('showLabels').addEventListener('change', (e) => {
    state.showLabels = e.target.checked;
  });
  document.getElementById('showAxes').addEventListener('change', (e) => {
    axes.visible = e.target.checked;
    grid.visible = !e.target.checked;
  });
  document.getElementById('autoRotate').addEventListener('change', (e) => {
    controls.autoRotate = e.target.checked;
    controls.autoRotateSpeed = 1.1;
  });
  document.getElementById('explode').addEventListener('input', (e) => {
    state.explode = Number(e.target.value) / 100;
    layoutParts();
  });
  document.getElementById('boxAlpha').addEventListener('input', (e) => {
    state.boxAlpha = Number(e.target.value) / 100;
    applyBoxAlpha();
  });
  document.getElementById('boxFill').addEventListener('change', (e) => {
    state.boxFill = e.target.checked;
    applyBoxAlpha();
  });
  document.getElementById('resetView').addEventListener('click', () => {
    setView('3d');
    fitCamera();
  });
  // 收起三维视图：把高度让给下面的伤害表 / 模拟面板（评论区要的「模型窗口可以关掉」）
  document.getElementById('toggleView').addEventListener('click', (e) => {
    const collapsed = document.body.classList.toggle('view-collapsed');
    e.target.textContent = collapsed ? '展开视图' : '收起视图';
    // 三面板重排：收起视图后把底部数据表挪到中间（原视图位置），
    // 变成「载具列表 | 数据表 | 详情」三栏；展开时再放回底部。
    const footer = document.querySelector('footer');
    const main = document.querySelector('main');
    if (collapsed) {
      main.insertBefore(footer, document.getElementById('detailPanel'));
    } else {
      document.body.appendChild(footer);
    }
    if (!collapsed) resize();
  });
  document.getElementById('soloCollision').addEventListener('click', () => {
    // 只留实车碰撞体：关模型、关部位盒、只开 *_COL 那一层
    setToggle('showModels', false);
    setToggle('showBoxes', false);
    document.querySelectorAll('.layer-toggle').forEach((box) => {
      const want = box.dataset.layer === 'colmesh';
      if (box.checked !== want) box.checked = want;
      box.dispatchEvent(new Event('change'));
    });
  });
  document.getElementById('layerHelpBtn').addEventListener('click', () => {
    const panel = document.getElementById('layerHelp');
    panel.hidden = !panel.hidden;
  });
  document.querySelectorAll('.layer-toggle').forEach((box) => {
    box.addEventListener('change', () => {
      const key = box.dataset.layer;
      state.layers[key] = box.checked;
      if (layerGroups[key]) layerGroups[key].visible = box.checked;
      if (key === 'colmesh') refreshCollisionMeshStyle();
    });
  });
  document.querySelectorAll('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.tableTab = tab.dataset.tab;
      renderTable();
    });
  });
}

const VIEW_DIR = {
  front: new THREE.Vector3(1, 0, 0),
  rear: new THREE.Vector3(-1, 0, 0),
  side: new THREE.Vector3(0, 0, 1),
  top: new THREE.Vector3(0, 1, 0),
};

/** 改某个开关的状态并触发它自己的 change 逻辑（顶部按钮用）。 */
function setToggle(id, checked) {
  const el = document.getElementById(id);
  if (!el) return;
  el.checked = checked;
  el.dispatchEvent(new Event('change'));
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  applyView();
}

/** 把当前视角模式真正落到相机上（换车、改窗口、切模式都要走一遍）。 */
function applyView() {
  if (state.view === '3d') {
    activeCamera = perspCamera;
    controls.object = perspCamera;
    controls.maxPolarAngle = Math.PI * 0.495;
    perspCamera.up.set(0, 1, 0);
    fitCamera();
    return;
  }
  activeCamera = orthoCamera;
  controls.object = orthoCamera;
  controls.maxPolarAngle = Math.PI;
  fitOrthoCamera(VIEW_DIR[state.view]);
}

/* ---------------------------- 载具列表 ---------------------------- */

function renderVehicleList() {
  const groups = { 地面: [], 空中: [], 水上: [], 摩加迪沙: [], 其他: [] };
  state.data.vehicles.forEach((v) => {
    if (v.mode === '摩加迪沙') { groups['摩加迪沙'].push(v); return; }
    (groups[v.domain] || groups['其他']).push(v);
  });
  const container = document.getElementById('vehicleGroups');
  container.innerHTML = '';
  Object.entries(groups).forEach(([domain, list]) => {
    if (!list.length) return;
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = domain;
    container.appendChild(title);
    list.forEach((v) => {
      const button = document.createElement('button');
      button.className = 'vehicle-item';
      button.dataset.id = v.id;
      button.textContent = v.name;
      button.addEventListener('click', () => selectVehicle(v.id));
      container.appendChild(button);
    });
  });
}

function selectVehicle(id) {
  const vehicle = state.data.vehicles.find((v) => v.id === id);
  if (!vehicle) return;
  state.vehicle = vehicle;
  state.selectedBoxIndex = -1;
  state.explode = 0;
  const slider = document.getElementById('explode');
  if (slider) slider.value = '0';
  document.querySelectorAll('.vehicle-item').forEach((el) =>
    el.classList.toggle('active', Number(el.dataset.id) === id));

  renderVehicleInfo();
  renderBoxList();
  renderBoxInfo();
  buildHitBoxes();
  buildModel();
  renderTable();          // 底部伤害表跟着当前载具走
}

/* ---------------------------- 车体加载 ---------------------------- */

const gltfCache = new Map();

/**
 * 导出的骨骼网格在 three.js 里会被骨架矩阵带偏：M1A4 的炮管会掉到车底、
 * 天线会缩成一个点拉着几条细线、底盘会塌掉。原因是这份 GLB 的
 * 逆绑定矩阵/骨架姿态与本机导出不完全一致。
 * 这里统一只取「绑定姿态的顶点」当普通静态网格用——顶点本来就是正确的形状，
 * 位置交给蓝图里的 RelativeLocation 决定，实测与三维可视化报告里的包围盒完全吻合。
 */
function flattenSkinned(scene) {
  const skinned = [];
  scene.traverse((child) => { if (child.isSkinnedMesh) skinned.push(child); });
  skinned.forEach((child) => {
    const mesh = new THREE.Mesh(child.geometry, child.material);
    mesh.name = child.name;
    mesh.position.copy(child.position);
    mesh.quaternion.copy(child.quaternion);
    mesh.scale.copy(child.scale);
    mesh.visible = child.visible;
    child.parent.add(mesh);
    child.parent.remove(child);
  });
  return scene;
}

function loadGltf(url) {
  if (!gltfCache.has(url)) {
    gltfCache.set(url, (async () => {
      const pkg = await mfpkFor(url);
      if (pkg && pkg.entries.has(url)) {
        const entry = pkg.entries.get(url);
        try {
          const gltf = await pkg.loader.parseAsync(pkg.buf.slice(entry.offset, entry.offset + entry.size), '');
          flattenSkinned(gltf.scene);
          return gltf;
        } catch (error) {
          console.error('模型加载失败(MFPK)', url, error);
          return null;
        }
      }
      return new Promise((resolve) => {
        gltfLoader.load(bust(url), (gltf) => {
          flattenSkinned(gltf.scene);
          resolve(gltf);
        }, undefined, (error) => {
          console.error('模型加载失败', url, error);
          resolve(null);
        });
      });
    })());
  }
  return gltfCache.get(url);
}

function loadTexture(url) {
  if (textureCache.has(url)) return textureCache.get(url);
  const promise = (async () => {
    const apply = (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.flipY = false;
      return tex;
    };
    const pkg = await mfpkFor(url);
    if (pkg && pkg.entries.has(url)) {
      const entry = pkg.entries.get(url);
      const blob = new Blob([pkg.buf.slice(entry.offset, entry.offset + entry.size)],
        { type: entry.mime || 'image/jpeg' });
      const objUrl = URL.createObjectURL(blob);
      return new Promise((resolve) => {
        texLoader.load(objUrl, (tex) => resolve(apply(tex)), undefined, () => resolve(null));
      });
    }
    return new Promise((resolve) => {
      texLoader.load(bust(url), (tex) => resolve(apply(tex)), undefined, () => resolve(null));
    });
  })();
  textureCache.set(url, promise);
  return promise;
}

async function loadMaterialSet(entry) {
  const textures = {};
  await Promise.all(Object.entries(entry.materials || {}).map(async ([name, url]) => {
    textures[name] = await loadTexture(url);
  }));
  return textures;
}

function applyMaterials(object, textures) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    const tex = textures ? textures[child.material?.name] : null;
    const material = new THREE.MeshStandardMaterial({
      map: tex || null,
      color: tex ? 0xffffff : 0x98a6b6,
      metalness: 0.28,
      roughness: 0.68,
    });
    // 换材质时必须把原来的材质名带上：同一个网格第二次套贴图全靠它找对应关系
    material.name = child.material?.name || '';
    child.material = material;
    if (child.geometry) child.geometry.computeBoundingBox();
  });
}

function place(object, loc, quat, scale) {
  object.position.copy(toVec3(loc || [0, 0, 0]));
  object.quaternion.copy(quat ? new THREE.Quaternion(quat[0], quat[1], quat[2], quat[3])
    : new THREE.Quaternion());
  if (scale) object.scale.set(scale[0], scale[1], scale[2]);
}

/**
 * 加载当前载具的全部外观件。
 *
 * 模型是异步下载的，而玩家可能在中途连着点好几辆车：如果不做处理，先点的那辆车
 * 会在「已经清过场」之后才把网格挂进来，屏幕上就出现两辆车叠在一起（例如轻坦压在
 * AAV 上）。所以每次调用先领一个令牌，任何 await 回来之后只要令牌已经不是最新的
 * 就直接退出，绝不往场景里塞东西。
 */
async function buildModel() {
  const token = ++modelToken;
  const stale = () => token !== modelToken;
  const vehicle = state.vehicle;

  modelGroup.clear();
  modelGroup.userData.parts = [];
  modelGroup.visible = state.showModels;
  Object.values(layerGroups).forEach((g) => g.clear());
  collisionMeshMaterials = [];

  const status = document.getElementById('status');
  if (status) status.textContent = `载入 ${vehicle.name}…`;

  const allParts = vehicle.modelParts || [];
  const parts = allParts.filter((part) => !part.unplaced);
  const loaded = await Promise.all(parts.map(async (part) => {
    const gltf = await loadGltf(part.url);
    if (!gltf || stale()) return null;
    applyMaterials(gltf.scene, await loadMaterialSet(part));
    if (stale()) return null;
    return { part, object: gltf.scene.clone(true) };
  }));
  if (stale()) return;

  await buildWheels(token, vehicle);
  if (stale()) return;
  await buildTracks(token, vehicle);
  if (stale()) return;
  await buildCollisionMeshes(token, vehicle);
  if (stale()) return;
  buildCollisionBoxes(vehicle);

  const ok = loaded.filter(Boolean).length;
  const volumes = vehicle.hitBoxes.filter((b) => !b.point).length;
  const skipped = allParts.length - parts.length;
  if (status) {
    status.textContent = `外观件 ${ok}/${parts.length}`
      + ` · 轮 ${(vehicle.modelWheels || []).reduce((n, w) => n + w.transforms.length, 0)}`
      + ` · 履带 ${(vehicle.modelTracks || []).length}`
      + ` · 命中盒 ${volumes}`
      + (skipped ? ` · 未定位 ${skipped}` : '');
  }
  modelGroup.userData.parts = loaded.filter(Boolean);
  modelGroup.userData.parts.forEach(({ object }) => modelGroup.add(object));
  layoutParts();
  computeBounds(vehicle);
  applyView();
}

/* 实例化轮组：位置直接来自蓝图 InitWheelTransforms */
async function buildWheels(token, vehicle) {
  for (const group of vehicle.modelWheels || []) {
    const gltf = await loadGltf(group.url);
    if (!gltf || token !== modelToken) return;
    const textures = await loadMaterialSet(group);
    if (token !== modelToken) return;
    applyMaterials(gltf.scene, textures);
    group.transforms.forEach((transform) => {
      const object = gltf.scene.clone(true);
      place(object, transform.loc, transform.quat, transform.scale);
      modelGroup.add(object);
    });
  }
}

/* 履带链节：沿蓝图样条按 TrackSize 等距铺链节 */
const TRACK_LINK_LIMIT = 200;

async function buildTracks(token, vehicle) {
  for (const track of vehicle.modelTracks || []) {
    const gltf = await loadGltf(track.url);
    if (!gltf || token !== modelToken) return;
    const textures = await loadMaterialSet(track);
    if (token !== modelToken) return;
    const offset = toVec3(track.loc);
    const curve = new THREE.CatmullRomCurve3(
      track.points.map((p) => toVec3(p).add(offset)), false, 'catmullrom', 0.5);
    const length = curve.getLength();
    const spacing = Math.max(0.05, (track.size || 20) / 100);
    const count = Math.min(TRACK_LINK_LIMIT, Math.max(2, Math.round(length / spacing)));
    applyMaterials(gltf.scene, textures);
    for (let i = 0; i < count; i += 1) {
      const t = count === 1 ? 0 : i / (count - 1);
      const point = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      const object = gltf.scene.clone(true);
      object.position.copy(point);
      object.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(tangent.y, tangent.x));
      modelGroup.add(object);
    }
  }
}

/* _COL 简化碰撞网格：贴着对应外观件画一层淡青色“碰撞皮” */
async function buildCollisionMeshes(token, vehicle) {
  for (const entry of vehicle.collisionMeshes || []) {
    const gltf = await loadGltf(entry.url);
    if (!gltf || token !== modelToken) return;
    const part = entry.partIndex >= 0 ? vehicle.modelParts[entry.partIndex] : null;
    gltf.scene.traverse((child) => {
      if (!child.isMesh) return;
      // 车体关掉时这份碰撞体会被单独查看，所以要让它可以变实一点、双面可见
      child.material = new THREE.MeshBasicMaterial({
        color: COLLISION_MESH_COLOR, transparent: true, opacity: 0.22,
        depthWrite: false, side: THREE.DoubleSide,
      });
      collisionMeshMaterials.push(child.material);
    });
    const object = gltf.scene.clone(true);
    place(object, part?.loc, part?.quat, part?.scale);
    layerGroups.colmesh.add(object);
  }
  refreshCollisionMeshStyle();
}

/** 车体隐藏时把实车碰撞体画得更实，方便单独观察子弹判定体。 */
function refreshCollisionMeshStyle() {
  const solo = !state.showModels;
  collisionMeshMaterials.forEach((material) => {
    material.opacity = solo ? 0.5 : 0.22;
    material.depthWrite = solo;   // 单独看的时候按实体画，叠在车体上时不要挡车
  });
}

/* 车辆撞击 / 底盘 / AI 导航 / 装配体：只画线框，避免盖住部位盒 */
function buildCollisionBoxes(vehicle) {
  const layers = vehicle.collisionLayers || {};
  Object.entries(LAYER_COLORS).forEach(([key, color]) => {
    const boxes = layers[key] || [];
    for (const box of boxes) {
      const size = box.extent.map((e) => (e || 0) * S * 2);
      const geometry = new THREE.BoxGeometry(size[0], size[2], size[1]);
      const lines = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
      );
      place(lines, box.loc, box.quat);
      layerGroups[key].add(lines);
    }
  });
}

function layoutParts() {
  const parts = modelGroup.userData.parts || [];
  const k = 1 + state.explode * 1.6;
  parts.forEach(({ part, object }) => {
    const scale = part.role === 'body' ? 1 : k;
    object.position.copy(toVec3(part.loc)).multiplyScalar(scale);
    object.position.y += (part.role === 'body' ? 0 : state.explode * 0.6);
    object.quaternion.copy(part.quat
      ? new THREE.Quaternion(part.quat[0], part.quat[1], part.quat[2], part.quat[3])
      : new THREE.Quaternion());
  });
  // 钉在模型件上的点位标记（目前是炮塔）要跟着一起分解，不然一拉就脱位
  boxMeshes.forEach((mesh) => {
    const part = mesh.userData.anchor;
    if (!part) return;
    const scale = part.role === 'body' ? 1 : k;
    mesh.position.copy(toVec3(part.loc)).multiplyScalar(scale);
    mesh.position.y += (part.role === 'body' ? 0 : state.explode * 0.6);
  });
}

/* ---------------------------- 命中盒 ---------------------------- */

function boxColor(name, ignore) {
  if (ignore) return COLORS.ignore;
  if (name.includes('发动机')) return COLORS.engine;
  if (name.includes('前部')) return COLORS.front;
  if (name.includes('履带')) return COLORS.track;
  if (name.includes('炮塔') || name.includes('武器站')) return COLORS.turret;
  return COLORS.side;
}

/**
 * 零体积「点位」命中盒（炮塔、防爆装甲等）在蓝图里没有自己的坐标，
 * translation 全是 0。能对上外观件的（炮塔 → role=turret）就钉在对应件上，
 * 对不上的返回 null：宁可不在场景里画，也不要在车体正中央丢一个看不出是什么的点。
 */
function pointAnchor(box) {
  const kind = ((state.vehicle.parts || []).find((p) => p.id === box.instance) || {}).kind || '';
  const roles = /炮塔|武器站/.test(kind) ? ['turret', 'gun'] : [];
  for (const role of roles) {
    const part = (state.vehicle.modelParts || []).find((p) => p.role === role);
    if (part && part.loc) return part;
  }
  return null;
}

/** 命中盒在场景里的落点（分解视图的偏移也会算进去）；无体积又对不上模型的返回 null。 */
function boxAnchorVec(box) {
  if (!box.point) return toVec3(box.translation);
  const part = pointAnchor(box);
  if (!part) return null;
  const scale = part.role === 'body' ? 1 : 1 + state.explode * 1.6;
  const v = toVec3(part.loc).multiplyScalar(scale);
  v.y += part.role === 'body' ? 0 : state.explode * 0.6;
  return v;
}

function buildHitBoxes() {
  boxGroup.clear();
  boxMeshes = [];
  state.vehicle.hitBoxes.forEach((box, index) => {
    if (box.point) {
      // 零体积的“点位”（炮塔点、装甲部件点）：画个小八面体标记
      const anchor = boxAnchorVec(box);
      if (!anchor) return;                      // 没有可对位的模型件就不画
      const marker = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.16),
        // 点位是标记不是几何体：关掉深度测试，免得埋在炮塔模型里面看不见
        new THREE.MeshBasicMaterial({
          color: COLORS.turret, transparent: true, opacity: 0.95, depthTest: false,
        }),
      );
      marker.position.copy(anchor);
      marker.quaternion.copy(toQuat(box.rotation));
      marker.userData.index = index;
      marker.userData.anchor = pointAnchor(box); // 分解视图里要跟着炮塔一起走
      boxGroup.add(marker);
      boxMeshes.push(marker);
      return;
    }
    const size = box.extent.map((e) => (e || 0) * S * 2);
    const geometry = new THREE.BoxGeometry(size[0], size[2], size[1]);
    const color = boxColor(box.name, box.ignore);
    const material = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: state.boxAlpha, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }),
    );
    mesh.add(edges);
    mesh.position.copy(toVec3(box.translation));
    mesh.quaternion.copy(toQuat(box.rotation));
    mesh.userData.index = index;
    boxGroup.add(mesh);
    boxMeshes.push(mesh);
  });
  boxGroup.visible = state.showBoxes;
  applyBoxAlpha();
}

function applyBoxAlpha() {
  boxMeshes.forEach((mesh, i) => {
    const selected = i === state.selectedBoxIndex;
    if (mesh.geometry?.type === 'OctahedronGeometry') {
      mesh.material.opacity = selected ? 1 : 0.85;
      return;
    }
    if (!state.boxFill) {
      mesh.material.opacity = 0;
      return;
    }
    mesh.material.opacity = selected ? Math.min(0.75, state.boxAlpha + 0.25) : state.boxAlpha;
  });
}

/* ---------------------------- 相机 ---------------------------- */

function computeBounds(vehicle) {
  const box = new THREE.Box3();
  let has = false;
  (modelGroup.userData.parts || []).forEach(({ part }) => {
    if (!part.min || !part.max) return;
    const local = new THREE.Box3(
      new THREE.Vector3(part.min[0], part.min[1], part.min[2]),
      new THREE.Vector3(part.max[0], part.max[1], part.max[2]),
    );
    const matrix = new THREE.Matrix4().compose(
      toVec3(part.loc),
      part.quat ? new THREE.Quaternion(part.quat[0], part.quat[1], part.quat[2], part.quat[3]) : new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1),
    );
    box.union(local.applyMatrix4(matrix));
    has = true;
  });
  (vehicle.hitBoxes || []).forEach((b) => {
    const half = new THREE.Vector3(
      Math.abs(b.extent[0] || 0) * S, Math.abs(b.extent[2] || 0) * S, Math.abs(b.extent[1] || 0) * S,
    );
    const center = toVec3(b.translation);
    box.union(new THREE.Box3(center.clone().sub(half), center.clone().add(half)));
    has = true;
  });
  // 轮组、履带、撞击碰撞盒也要包进来，不然相机可能切掉它们
  (vehicle.modelWheels || []).forEach((group) => {
    group.transforms.forEach((transform) => {
      box.union(localBox(group.min, group.max, transform.loc, transform.quat, transform.scale));
      has = true;
    });
  });
  (vehicle.modelTracks || []).forEach((track) => {
    const offset = toVec3(track.loc);
    track.points.forEach((point) => {
      const world = toVec3(point).add(offset);
      box.union(new THREE.Box3(world.clone().subScalar(0.3), world.clone().addScalar(0.3)));
      has = true;
    });
  });
  ['impact', 'chassis'].forEach((key) => {
    ((vehicle.collisionLayers || {})[key] || []).forEach((entry) => {
      box.union(localBox(
        [-entry.extent[0] * S, -entry.extent[1] * S, -entry.extent[2] * S],
        [entry.extent[0] * S, entry.extent[1] * S, entry.extent[2] * S],
        entry.loc, entry.quat, [1, 1, 1]));
      has = true;
    });
  });
  state.bounds = has ? box : null;
}

/** 把“glTF 米制局部包围盒 + UE 厘米制变换”换算成世界包围盒。 */
function localBox(min, max, loc, quat, scale) {
  const local = new THREE.Box3(
    new THREE.Vector3(min[0], min[1], min[2]),
    new THREE.Vector3(max[0], max[1], max[2]),
  );
  const matrix = new THREE.Matrix4().compose(
    toVec3(loc || [0, 0, 0]),
    quat ? new THREE.Quaternion(quat[0], quat[1], quat[2], quat[3]) : new THREE.Quaternion(),
    new THREE.Vector3(...(scale || [1, 1, 1])),
  );
  return local.applyMatrix4(matrix);
}

function fitCamera() {
  const box = state.bounds;
  if (!box) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  // 视觉重心略高于包围盒中心（底盘/履带被算进了包围盒），把镜头落点抬高一点，让车体往下坐
  const target = center.clone().add(new THREE.Vector3(0, size.y * 0.08, 0));
  controls.target.copy(target);
  const fovV = THREE.MathUtils.degToRad(perspCamera.fov);
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * perspCamera.aspect);
  const dir = new THREE.Vector3(0.66, 0.34, 0.68).normalize();
  const distance = frameDistance(box, target, dir, fovV, fovH);
  activeCamera.position.copy(target).addScaledVector(dir, distance);
  perspCamera.near = Math.max(0.05, distance / 400);
  perspCamera.far = distance * 80;
  perspCamera.updateProjectionMatrix();
  controls.update();
}

/** 让包围盒的 8 个角刚好落进视锥所需的相机距离（比用外接球贴合得多）。 */
function frameDistance(box, center, dir, fovV, fovH) {
  const up0 = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up0, dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  const tanV = Math.tan(fovV / 2) || 0.4;
  const tanH = Math.tan(fovH / 2) || 0.4;
  let distance = 0;
  for (let i = 0; i < 8; i += 1) {
    const corner = new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).sub(center);
    const depth = corner.dot(dir);
    distance = Math.max(distance,
      depth + Math.abs(corner.dot(right)) / tanH,
      depth + Math.abs(corner.dot(up)) / tanV);
  }
  return distance * 0.92 + 0.15;
}

function updateOrtho() {
  const viewport = document.getElementById('viewport');
  const aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
  const box = state.bounds;
  const radius = box ? box.getBoundingSphere(new THREE.Sphere()).radius : 6;
  const half = box ? orthoHalf(box, aspect) : 6;
  orthoCamera.near = -radius * 4 - 20;
  orthoCamera.far = radius * 4 + 20;
  orthoCamera.left = -half * aspect;
  orthoCamera.right = half * aspect;
  orthoCamera.top = half;
  orthoCamera.bottom = -half;
  orthoCamera.updateProjectionMatrix();
}

/** 正交投影时，按当前视角方向算出需要的半高。 */
function orthoHalf(box, aspect) {
  const center = box.getCenter(new THREE.Vector3());
  const dir = new THREE.Vector3().subVectors(activeCamera.position, center).normalize();
  const up0 = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up0, dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  let halfW = 0;
  let halfH = 0;
  for (let i = 0; i < 8; i += 1) {
    const corner = new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).sub(center);
    halfW = Math.max(halfW, Math.abs(corner.dot(right)));
    halfH = Math.max(halfH, Math.abs(corner.dot(up)));
  }
  return Math.max(halfH, halfW / Math.max(0.3, aspect)) * 1.06 + 0.3;
}

function fitOrthoCamera(dir) {
  const box = state.bounds;
  if (!box) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  controls.target.copy(center);
  activeCamera.position.copy(center).addScaledVector(dir, radius * 3 + 10);
  activeCamera.up.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.9) activeCamera.up.set(0, 0, -1);
  updateOrtho();
  controls.update();
}

/* ---------------------------- 拾取 ---------------------------- */

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function toPointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function pick(event) {
  toPointer(event);
  raycaster.setFromCamera(pointer, activeCamera);
  const hits = raycaster.intersectObjects(boxMeshes, false);
  return hits.length ? hits[0].object.userData.index : -1;
}

function onClick(event) {
  state.selectedBoxIndex = pick(event);
  applyBoxAlpha();
  renderBoxList();
  renderBoxInfo();
}

function onMove(event) {
  if (!state.showLabels) { hoverLabel.style.display = 'none'; return; }
  const index = pick(event);
  if (index < 0) { hoverLabel.style.display = 'none'; return; }
  const box = state.vehicle.hitBoxes[index];
  hoverLabel.textContent = `${box.name} · ×${box.scaling}`;
  hoverLabel.style.display = 'block';
  const rect = renderer.domElement.getBoundingClientRect();
  hoverLabel.style.left = `${event.clientX - rect.left}px`;
  hoverLabel.style.top = `${event.clientY - rect.top}px`;
}

/* ---------------------------- 侧栏 ---------------------------- */

function translateDebuff(key) {
  const map = {
    EngineDebuffRatio: '发动机功率惩罚',
    TrackDebuffRatio: '履带机动惩罚',
    WeaponRoateDebuffRatio: '炮塔转向惩罚',
  };
  return map[key] || key;
}

function renderVehicleInfo() {
  const v = state.vehicle;
  // 有些车（玩家版武直、攻击艇）客户端里没有独立碰撞网格，子弹判定走外观网格本体，
  // 直接说清楚，免得用户以为是我们的数据缺了或者「只有一个小盒子」。
  const collisionNote = (v.collisionMeshes || []).length
    ? `${(v.collisionMeshes || []).length} 份`
    : '无（该车没有独立碰撞网格，子弹判定按外观网格本体算）';
  document.getElementById('vehicleInfo').innerHTML = `
    <div class="card">
      <h3>${v.name}</h3>
      <div>
        <span class="pill">${v.category}</span>
        <span class="pill">${v.domain}</span>
        <span class="pill">${v.mode || '全面战场'}</span>
        <span class="pill">${v.armor || '—'}</span>
      </div>
      <div class="kv" style="margin-top:8px">
        <span>总耐久</span><span>${v.hp ?? '—'}</span>
        <span>护盾</span><span>${v.shield ?? 0}</span>
        <span>直击伤害承受</span><span>${v.pointRate ?? '—'}</span>
        <span>爆炸伤害承受</span><span>${v.explodeRate ?? '—'}</span>
        <span>低血量提示</span><span>${v.lowHpRatio ?? '—'}</span>
        <span>外观网格</span><span>${(v.modelParts || []).filter((p) => !p.unplaced).length} 件</span>
        <span>实车碰撞体</span><span>${collisionNote}</span>
      </div>
    </div>
    <div class="card">
      <h3>独立部位（${v.parts.length}）</h3>
      ${v.parts.length ? v.parts.map((p) => `
        <div class="kv">
          <span>${p.kind}</span>
          <span>耐久 ${p.hp}${p.debuff && Object.keys(p.debuff).length
            ? ' · ' + Object.entries(p.debuff).map(([k, val]) => `${translateDebuff(k)}=${val}`).join('、') : ''}</span>
        </div>`).join('') : '<div class="kv"><span>无</span><span>该载具没有细分部位</span></div>'}
    </div>`;
}

function renderBoxList() {
  const v = state.vehicle;
  const list = v.hitBoxes.map((box, index) => `
    <div class="box-row ${index === state.selectedBoxIndex ? 'active' : ''}" data-index="${index}">
      <span>${box.name}</span>
      <span class="scaling">${box.point
        ? (pointAnchor(box) ? '点位 · 已贴到模型件' : '点位 · 无体积')
        : `×${box.scaling}`}${box.ignore ? ' · 不结算' : ''}</span>
    </div>`).join('');
  boxListEl = document.getElementById('boxListCard');
  const volumes = v.hitBoxes.filter((b) => !b.point).length;
  boxListEl.innerHTML = `<div class="card"><h3>命中盒（${volumes} 个体积 + ${v.hitBoxes.length - volumes} 个点位）</h3>${
    list || '<div class="kv"><span>无</span><span>该载具没有细分命中盒</span></div>'}</div>`;
  boxListEl.querySelectorAll('.box-row').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedBoxIndex = Number(row.dataset.index);
      applyBoxAlpha();
      renderBoxList();
      renderBoxInfo();
    });
  });
}

function renderBoxInfo() {
  const holder = document.getElementById('boxInfo');
  if (state.selectedBoxIndex < 0) {
    holder.innerHTML = `<div class="card"><h3>命中盒详情</h3>
      <div class="kv"><span>提示</span><span>在列表或三维视图中点击一个命中盒</span></div></div>`;
    return;
  }
  const box = state.vehicle.hitBoxes[state.selectedBoxIndex];
  const part = state.vehicle.parts.find((p) => p.id === box.instance);
  const angles = box.angles.map((a) => `${a.from}–${a.to}° = ×${a.scale}`).join('<br>');
  const pct = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);
  const anti = box.antiVehicle.length
    ? box.antiVehicle.map((c) => `${c.weapon}：部位完好时减伤 ${pct(c.BodyPartIntactDamageReduction)}`
      + `、部位损坏后加成 ${pct(c.BodyPartBrokenDamageBonus)}`).join('<br>')
    : '—';
  holder.innerHTML = `
    <div class="card">
      <h3>${box.name}</h3>
      ${box.point ? '<div class="kv"><span>说明</span><span>蓝图里的零体积位置标记，没有伤害体积</span></div>' : ''}
      <div class="kv">
        <span>伤害倍率</span><span>×${box.scaling}</span>
        <span>爆炸衰减倍率</span><span>×${box.radiusScaling}</span>
        <span>命中盒自带减伤</span><span>${box.intactReduction ?? '无'}</span>
        <span>忽略伤害</span><span>${box.ignore ? '是（装饰件）' : '否'}</span>
        <span>对应部位</span><span>${part ? `${part.kind}（耐久 ${part.hp}）` : '车体'}</span>
        <span>半尺寸(米)</span><span>${box.extent.map((e) => (e / 100).toFixed(2)).join(' × ')}</span>
      </div>
    </div>
    <div class="card">
      <h3>入射角修正</h3>
      <div class="kv"><span>角度区间</span><span>${angles || '—'}</span></div>
    </div>
    <div class="card">
      <h3>反载具武器覆盖</h3>
      <div class="kv"><span>武器</span><span>${anti}</span></div>
      ${box.antiVehicle.length ? '<div class="owner">同一部位对「完好 / 已损坏」两种状态，'
        + '只有名单里的武器结算不同；不在名单里的武器按上面的伤害倍率直接结算。</div>' : ''}
    </div>`;
}

/* ---------------------------- 数据表 ---------------------------- */

function renderTable() {
  const area = document.getElementById('tableArea');
  if (state.tableTab === 'repair') {
    renderPlainTable(area, state.data.repair);
    return;
  }
  if (state.tableTab === 'collision') {
    renderPlainTable(area, state.data.collisionRules);
    return;
  }
  if (state.tableTab === 'sim') {
    renderSimulator(area);
    return;
  }
  const source = state.tableTab === 'weapons' ? state.data.weapons : state.data.gadgets;
  if (!source || !source.length) { area.innerHTML = '暂无数据'; return; }
  renderDamageTable(area, source);
}

/* ------------------------- 命中模拟（按验证过的口径） ------------------------- */

const ANGLE_MODES = [
  { label: '垂直 0–10°', scale: 1.2, hint: '炮弹几乎垂直砸在装甲面上' },
  { label: '常规 10–80°', scale: 1.0, hint: '普通入射' },
  { label: '掠射 80–90°', scale: 0.5, hint: '几乎擦着装甲面打过去' },
];

function allEntries() {
  return [
    ...state.data.gadgets.map((row) => ({ row, table: 'gadgets' })),
    ...state.data.weapons.map((row) => ({ row, table: 'weapons' })),
  ];
}

function findEntryByName(name) {
  return allEntries().find((item) => item.row.name === name) || null;
}

function entryComponents(row) {
  const parts = (row.components || []).filter((p) => (p.base || 0) > 0);
  if (parts.length) return parts;
  const base = row.base || 0;
  const byArmor = row.damageByArmor || {};
  let armor = row.armor;
  if (!armor && base) {
    armor = {};
    Object.entries(byArmor).forEach(([k, v]) => { armor[k] = v / base; });
  }
  return [{
    kind: row.kind || '直击', base, armor: armor || {},
    minBase: row.minBase, fullRadius: row.fullRadius, explodeRadius: row.explodeRadius,
  }];
}

/** 这件东西在「爆心距离」多远之内还是满伤（取各爆炸段里最大的满伤→边缘区间）。 */
function blastRange(row) {
  const edge = Math.max(0, ...entryComponents(row)
    .filter((p) => p.kind === '爆炸')
    .map((p) => Number(p.explodeRadius) || 0));
  const full = Math.max(0, ...entryComponents(row)
    .filter((p) => p.kind === '爆炸')
    .map((p) => Number(p.fullRadius) || 0));
  return edge > full ? { full, edge } : null;
}

/** 爆炸段的半径衰减：满伤半径内给满额，边缘半径外给最小值，中间线性插值。 */
function blastFalloff(part, distance) {
  const base = Number(part.base || 0);
  const min = part.minBase == null ? base : Number(part.minBase);
  const full = Number(part.fullRadius);
  const edge = Number(part.explodeRadius);
  if (!Number.isFinite(full) || !Number.isFinite(edge) || edge <= full) return base;
  if (!(distance > full)) return base;
  if (distance >= edge) return min;
  return base + (min - base) * ((distance - full) / (edge - full));
}

/**
 * 对干员的伤害：直击段给生命伤害，爆炸段给人物伤害。
 * 和打载具完全是两套数值，这里只给每发的原始值（全面战场没有干员护甲）。
 */
function personRows(row, distance) {
  const parts = (row.components || []).length ? row.components : [row];
  const rows = [];
  parts.forEach((p) => {
    const isExplode = p.kind === '爆炸' || (p.kind === undefined && (row.kind || '') === '爆炸');
    if (isExplode) {
      const base = Number(p.personDamage ?? row.personDamage ?? 0);
      const min = Number(p.minPersonDamage ?? row.minPersonDamage ?? base);
      const value = blastFalloff({ ...p, base, minBase: min }, distance);
      if (value > 0) rows.push({ kind: '爆炸', health: null, armor: null, person: value });
      return;
    }
    const health = p.healthDamage ?? row.healthDamage;
    if ((health || 0) > 0) {
      rows.push({ kind: p.kind || '直击', health, person: null });
    }
  });
  return rows;
}

function personHtml(row, distance, note) {
  const rows = personRows(row, distance);
  if (!rows.length) return '';
  const body = rows.map((r) => `<tr>
      <td>${r.kind}</td>
      <td class="num">${r.health == null ? '—' : round1(r.health)}</td>
      <td class="num">${r.person == null ? '—' : round1(r.person)}</td>
    </tr>`).join('');
  const totalHealth = rows.reduce((n, r) => n + (r.health || 0), 0);
  const totalPerson = rows.reduce((n, r) => n + (r.person || 0), 0);
  return `
    <div class="explainbox simnote">
      <div class="formula">对干员（每发，和打载具是两套数值）</div>
      <table class="damagetable simtable">
        <thead><tr><th>段</th><th class="num">生命伤害</th>
        <th class="num">爆炸·人物伤害</th></tr></thead>
        <tbody>${body}<tr class="clickable"><td><b>合计</b></td>
          <td class="num"><b>${round1(totalHealth)}</b></td>
          <td class="num"><b>${round1(totalPerson)}</b></td></tr></tbody>
      </table>
      <div class="owner">直击段还会乘健康部位倍率，爆炸段按落点距离衰减 ——
      本表给的是没乘这些之前的原始值（全面战场模式没有干员护甲）。${note || ''}</div>
    </div>`;
}

/** 按实测验证过的口径算一次命中。 */
function simulateHit(row, vehicle, box, angleScale, distance = 0) {
  const key = vehicle.armorKey || 'Default';
  const hp = vehicle.hp || 1000;
  const scaling = box ? box.scaling : 1;
  const radius = box ? (box.radiusScaling ?? 1) : 1;
  const rows = entryComponents(row).map((part) => {
    const coefficient = (part.armor || {})[key];
    const coef = coefficient === undefined ? 1 : coefficient;
    const isExplode = part.kind === '爆炸';
    const multiplier = isExplode ? radius : scaling;
    const angle = isExplode ? 1 : angleScale;
    const effectiveBase = isExplode ? blastFalloff(part, distance) : Number(part.base || 0);
    return {
      kind: part.kind,
      base: effectiveBase,
      baseFull: Number(part.base || 0),
      coefficient: coef,
      multiplier,
      angle,
      damage: effectiveBase * coef * multiplier * angle,
      note: isExplode
        ? (distance > (Number(part.fullRadius) || 0)
          ? `爆心 ${round1(distance)} 米：按半径衰减后的值（满伤 ${round1(Number(part.fullRadius) || 0)} 米 → 边缘 ${round1(Number(part.explodeRadius) || 0)} 米）`
          : '爆炸段走爆炸衰减倍率，不吃部位与角度')
        : '直击段吃部位倍率与入射角',
    };
  });
  const total = rows.reduce((sum, r) => sum + r.damage, 0);
  return { rows, total, hp, percent: (total / hp) * 100, bar: 100 - (total / hp) * 100 };
}

function renderSimulator(area) {
  const vehicle = state.vehicle;
  const boxes = (vehicle.hitBoxes || []).filter((b) => !b.point);
  const sim = state.sim;
  const entries = allEntries();
  if (!sim.name || !findEntryByName(sim.name)) sim.name = entries[0]?.row.name || '';
  if (sim.boxIndex >= boxes.length) sim.boxIndex = -1;

  const chosen = findEntryByName(sim.name);
  const box = sim.boxIndex >= 0 ? boxes[sim.boxIndex] : null;
  const angle = ANGLE_MODES[sim.angle] || ANGLE_MODES[0];
  // 爆心距离：只有带爆炸段、且满伤半径 < 边缘半径的条目才有得调
  const blast = chosen ? blastRange(chosen.row) : null;
  sim.distance = blast ? Math.min(Math.max(sim.distance || 0, 0), blast.edge) : 0;
  const result = chosen ? simulateHit(chosen.row, vehicle, box, angle.scale, sim.distance) : null;

  const boxChips = [
    `<button class="chip ${sim.boxIndex === -1 ? 'on' : ''}" data-box="-1"
       title="不打在任何细分部位上，按车体整体（倍率 ×1.0）算">车体（无部位加成）</button>`,
    ...boxes.map((b, i) => `<button class="chip ${sim.boxIndex === i ? 'on' : ''}"
       data-box="${i}" title="伤害倍率 ×${b.scaling}，爆炸衰减 ×${b.radiusScaling}">${b.name} ×${b.scaling}</button>`),
  ].join('');

  const angleChips = ANGLE_MODES.map((mode, i) => `<button class="chip ${sim.angle === i ? 'on' : ''}"
    data-angle="${i}" title="${mode.hint}">${mode.label}</button>`).join('');

  const list = entries.map((item) =>
    `<option value="${item.row.name}">${item.table === 'weapons' ? '载具武器' : '步兵技能'}</option>`).join('');

  area.innerHTML = `
    <div class="simwrap">
      <div class="simctl">
        <div class="row">
          <span class="lbl">用什么打</span>
          <input id="simEntry" list="simList" value="${sim.name}" placeholder="输入武器 / 道具名称" />
          <datalist id="simList">${list}</datalist>
        </div>
        <div class="row">
          <span class="lbl">打谁</span>
          <span class="pill">${vehicle.name}</span>
          <span class="pill">${vehicle.armor || vehicle.armorKey}</span>
          <span class="owner">总耐久 ${vehicle.hp}　护甲类型决定了上面那张表里的系数</span>
        </div>
        <div class="row"><span class="lbl">打哪</span><div class="chiprow">${boxChips}</div></div>
        <div class="row"><span class="lbl">入射角</span><div class="chiprow">${angleChips}</div></div>
        ${blast ? `<div class="row"><span class="lbl">爆心距离</span>
          <input type="range" id="simDistance" min="0" max="${blast.edge}" step="0.25" value="${sim.distance}" />
          <span class="pill" id="simDistanceLabel">${round1(sim.distance)} 米</span>
          <span class="owner">${round1(blast.full)} 米内满伤，到 ${round1(blast.edge)} 米衰减到最小值</span>
        </div>` : ''}
      </div>
      <div class="simout">${result ? simResultHtml(chosen, vehicle, box, angle, result, sim.distance) : '没有可用的条目'}</div>
    </div>`;

  const input = document.getElementById('simEntry');
  input.addEventListener('change', () => {
    state.sim.name = input.value.trim();
    renderTable();
  });
  area.querySelectorAll('.chip[data-box]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.sim.boxIndex = Number(chip.dataset.box);
      renderTable();
    });
  });
  area.querySelectorAll('.chip[data-angle]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.sim.angle = Number(chip.dataset.angle);
      renderTable();
    });
  });
  // 拖动时只刷新结果区，不整块重绘，否则滑杆会被原地重建、拖不动
  const distInput = document.getElementById('simDistance');
  if (distInput && chosen) {
    const distLabel = document.getElementById('simDistanceLabel');
    const out = area.querySelector('.simout');
    distInput.addEventListener('input', () => {
      state.sim.distance = Number(distInput.value);
      if (distLabel) distLabel.textContent = `${round1(state.sim.distance)} 米`;
      if (out) {
        const r = simulateHit(chosen.row, vehicle, box, angle.scale, state.sim.distance);
        out.innerHTML = simResultHtml(chosen, vehicle, box, angle, r, state.sim.distance);
      }
    });
  }
}

function simResultHtml(chosen, vehicle, box, angle, result, distance = 0) {
  const lines = result.rows.map((row) => `
    <tr>
      <td>${row.kind}</td>
      <td class="num">${round1(row.base)}</td>
      <td class="num">×${row.coefficient}</td>
      <td class="num">×${row.multiplier}</td>
      <td class="num">${row.angle === 1 ? '—' : `×${row.angle}`}</td>
      <td class="num primary">${round1(row.damage)}</td>
      <td class="owner">${row.note}</td>
    </tr>`).join('');
  const factor = result.percent;
  const hp = vehicle.hp || 1;
  const perHit = result.total || 0;
  const shotsToKill = perHit > 0 ? Math.ceil(hp / perHit) : null;
  const fireInterval = Number(chosen.row.fireInterval);
  const ttk = Number.isFinite(fireInterval) && fireInterval > 0 && shotsToKill ? fireInterval * shotsToKill : null;
  const nice = (v) => (Number.isFinite(v) ? String(Number(v.toFixed(2))) : '—');
  return `
    <div class="simhead">
      <div><b>${chosen.row.name}</b> → ${vehicle.name}${box ? ` · ${box.name}` : ' · 车体整体'} · ${angle.label}</div>
      <div class="bignum">${round1(result.total)} <span>点</span></div>
      <div class="owner">掉 ${factor.toFixed(2)}% 总耐久　→　血条显示 <b>${result.bar.toFixed(1)}</b></div>
      <div class="ttkline">
        <span class="ttk-num">TTK ${ttk != null ? `${nice(ttk)} 秒` : '—'}</span>
        <span class="ttk-num">DTK ${shotsToKill ? `${shotsToKill} 发` : '—'}</span>
        <span class="owner">${ttk != null && shotsToKill ? `射速 ${nice(fireInterval)} 秒/发` : '（单发/无射速）'}</span>
      </div>
    </div>
    <table class="damagetable simtable">
      <thead><tr><th>段</th><th class="num">基础</th><th class="num">护甲系数</th>
      <th class="num">部位/衰减倍率</th><th class="num">角度</th><th class="num primary">小计</th><th>说明</th></tr></thead>
      <tbody>${lines}</tbody>
    </table>
    <div class="explainbox simnote">
      <div class="formula">对「${vehicle.name}」的伤害 ＝ Σ（每段基础伤害 × 该弹种对${vehicle.armor || vehicle.armorKey}的系数 × 命中倍率 × 角度）</div>
      <div class="owner">口径来自实测验证：<b>直击段</b>吃命中盒伤害倍率与入射角；
      <b>爆炸段</b>只走命中盒的爆炸衰减倍率，不吃部位倍率也不吃角度（10 发定向实测里 9 发落在 ±1 个百分点内）。</div>
    </div>
    ${personHtml(chosen.row, distance)}`;
}

/** 当前选中的载具就是伤害的“目标”，表格按它的护甲类型现算。 */
function damageTarget() {
  const vehicle = state.vehicle;
  return {
    name: vehicle?.name || '未选择载具',
    key: vehicle?.armorKey || 'Default',
    label: vehicle?.armor || '无装甲/通用',
    hp: vehicle?.hp || 1000,
  };
}

function renderDamageTable(area, source) {
  const isWeapon = state.tableTab === 'weapons';
  const target = damageTarget();
  const columns = isWeapon
    ? [{ key: 'name', label: '武器名称', cls: 'name' },
       { key: 'makeup', label: '伤害构成' },
       { key: 'base', label: '基础合计' },
       { key: 'fireInterval', label: '射击间隔' },
       { key: 'clipAmmo', label: '弹匣发数' },
       { key: 'coef', label: '装甲系数' },
       { key: 'damage', label: `对「${target.name}」总伤害`, primary: true },
       { key: 'percent', label: '百分比伤害', primary: true }]
    : [{ key: 'name', label: '道具 / 技能', cls: 'name' },
       { key: 'owner', label: '归属' },
       { key: 'makeup', label: '伤害构成' },
       { key: 'base', label: '基础合计' },
       { key: 'coef', label: '装甲系数' },
       { key: 'damage', label: `对「${target.name}」总伤害`, primary: true },
       { key: 'percent', label: '百分比伤害', primary: true }];
  if (state.showAllArmor) {
    if (isWeapon) {
      columns.push({ key: 'armorGroup', label: '装甲修正组' });
    }
    (state.data.armorColumns || []).forEach((column) => {
      columns.push({
        key: `armor_${column.key}`,
        label: `对${column.label}`,
        current: column.key === target.key,
      });
    });
  }

  let rows = source.map((row) => {
    const parts = row.components || [];
    const rawDamage = Number((row.damageByArmor || {})[target.key] ?? 0);
    const rawBase = Number(row.base || 0);
    const out = {
      ...row,
      // 一件武器常常是「直击 + 命中后爆炸」两段，分别乘自己的装甲系数再相加
      makeup: parts.length
        ? parts.map((c) => `${c.kind} ${trimNum(c.base)}`).join(' ＋ ')
        : (row.damageType === 'Buff' ? '持续伤害（状态，无每发直击值）' : row.kind || ''),
      // 燃烧弹这类走状态系统的条目没有每发数值，不该被当成「对本车无效」划掉
      isState: row.damageType === 'Buff',
      base: trimNum(row.base),
      fireInterval: row.fireInterval == null ? '' : String(Math.round(Number(row.fireInterval) * 100) / 100),
      clipAmmo: row.clipAmmo == null || Number(row.clipAmmo) >= 65535 ? '' : String(row.clipAmmo),
      damage: trimNum(rawDamage),
      percent: rawDamage / (target.hp || 1) * 100,
      coef: rawBase > 0 ? rawDamage / rawBase : 0,
      armorGroup: parts.length
        ? parts.map((c) => c.armorGroup || '').filter(Boolean).join(' / ')
        : (row.armorGroup || ''),
    };
    if (state.showAllArmor) {
      (state.data.armorColumns || []).forEach((column) => {
        out[`armor_${column.key}`] = trimNum((row.damageByArmor || {})[column.key]);
      });
    }
    return out;
  });
  const total = rows.length;
  if (state.hideZero) rows = rows.filter((r) => Number(r.damage) > 0 || r.isState);

  const sortKey = state.sort[state.tableTab];
  const sortList = (list) => {
    const arr = [...list];
    if (!sortKey) {
      arr.sort((a, b) => Number(b.damage || 0) - Number(a.damage || 0));
      return arr;
    }
    const numeric = arr.every((r) => r[sortKey] === '' || !isNaN(Number(r[sortKey])));
    arr.sort((a, b) => (numeric
      ? Number(b[sortKey] || 0) - Number(a[sortKey] || 0)
      : String(a[sortKey]).localeCompare(String(b[sortKey]), 'zh')));
    return arr;
  };

  const cellHtml = (row, column) => {
    const value = row[column.key] ?? '';
    const zero = Number(row.damage) === 0 && !row.isState;
    if (column.key === 'damage') {
      return `<td class="num primary${zero ? ' zero' : ''}">${value}</td>`;
    }
    if (column.key === 'percent') {
      return `<td class="num primary${zero ? ' zero' : ''}">${value === '' ? '—' : `${trimNum(value)}%`}</td>`;
    }
    if (column.key === 'coef') {
      const num = Number(value);
      const text = Number.isFinite(num) ? String(Math.round(num * 1000) / 1000) : '—';
      return `<td class="num${zero ? ' zero' : ''}">×${text}</td>`;
    }
    if (column.key === 'fireInterval') {
      // 射击间隔给两位小数：像 25mm 机炮这种 0.05 秒的，只留一位就分不出来
      return `<td class="num">${value === '' ? '—' : `${value} 秒`}</td>`;
    }
    if (column.key === 'clipAmmo') {
      return `<td class="num">${value === '' ? '弹链' : value}</td>`;
    }
    const numeric = typeof value === 'number';
    return `<td class="${numeric ? 'num' : (column.cls || '')}${numeric && value === 0 ? ' zero' : ''}">${value}</td>`;
  };

  const rowHtml = (row, vehicleCell = '') => {
    const zero = Number(row.damage) === 0 && !row.isState;
    return `<tr class="${zero ? 'ineffective' : ''} clickable" data-name="${row.name}"
      title="点这一行，把它送进「命中模拟」算具体部位的伤害">`
      + vehicleCell
      + `<td class="swatchcell">${zero ? '<span class="noeff" title="该条目的护甲系数为 0，对这种载具完全无效">无效</span>' : ''}</td>`
      + columns.map((c) => cellHtml(row, c)).join('')
      + '</tr>';
  };

  const headHtml = (withVehicle) =>
    '<tr>' + (withVehicle ? '<th>来源载具</th>' : '') + '<th></th>'
    + columns.map((c) =>
      `<th data-key="${c.key}" class="${c.primary ? 'primary' : ''}${c.current ? ' current' : ''}">`
      + `${c.label}${sortKey === c.key ? ' ↓' : ''}</th>`).join('') + '</tr>';

  const maxDamage = (list) => Math.max(...list.map((r) => Number(r.damage) || 0), 0);

  let tablesHtml;
  if (isWeapon) {
    const groups = new Map();
    rows.forEach((r) => {
      const vehicle = r.vehicle || '通用武器站';
      if (!groups.has(vehicle)) groups.set(vehicle, []);
      groups.get(vehicle).push(r);
    });
    const groupList = [...groups.entries()]
      .map(([vehicle, list]) => ({ vehicle, rows: sortList(list) }))
      .sort((a, b) => maxDamage(b.rows) - maxDamage(a.rows));
    const tbody = groupList.map((g) => g.rows.map((row, i) =>
      rowHtml(row, i === 0 ? `<td class="vcell" rowspan="${g.rows.length}">${g.vehicle}</td>` : '')).join('')).join('');
    tablesHtml = `<table class="damagetable"><thead>${headHtml(true)}</thead><tbody>${tbody}</tbody></table>`;
  } else {
    // 四组共用同一张表 + 分组标题行，保证「不同组之间相同列」严格对齐
    const groups = [
      ['战术道具', sortList(rows.filter((r) => r.group === '战术道具'))],
      ['干员道具', sortList(rows.filter((r) => r.group === '干员道具'))],
      ['阵地支援', sortList(rows.filter((r) => r.group === '阵地支援'))],
      ['场景武器', sortList(rows.filter((r) => r.group === '场景武器'))],
    ].filter(([, list]) => list.length > 0);
    const colspan = columns.length + 1; // +1 是行首的「无效」小格
    const body = groups.map(([title, list]) =>
      `<tr class="grouptitle-row"><td colspan="${colspan}">${title}（${list.length}）</td></tr>`
      + list.map((r) => rowHtml(r)).join('')).join('');
    tablesHtml = `<table class="damagetable"><thead>${headHtml(false)}</thead><tbody>${body}</tbody></table>`;
  }

  area.innerHTML = `
    <div class="tablebar">
      <div class="tinfo">
        <span class="tcur">当前目标：<b>${target.name}</b></span>
        <span class="pill">${target.label}</span>
        <code>对${target.name}的伤害 ＝ 基础载具伤害 × 装甲系数</code>
      </div>
      <div class="tacts">
        <label><input type="checkbox" id="hideZero" ${state.hideZero ? 'checked' : ''} /> 隐藏无效条目</label>
        <label><input type="checkbox" id="allArmor" ${state.showAllArmor ? 'checked' : ''} /> 展开全部护甲列</label>
        <button id="explainBtn">这个值怎么来的</button>
      </div>
    </div>
    <div id="explain" ${state.showExplain ? '' : 'hidden'}>${explainHtml()}</div>
    ${tablesHtml}
    <div class="owner">共 ${total} 条${state.hideZero ? `，其中对本车有效 ${rows.length} 条` : ''}。</div>`;

  area.querySelectorAll('th[data-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      state.sort[state.tableTab] = state.sort[state.tableTab] === key ? '' : key;
      renderTable();
    });
  });
  document.getElementById('hideZero').addEventListener('change', (e) => {
    state.hideZero = e.target.checked;
    renderTable();
  });
  document.getElementById('allArmor').addEventListener('change', (e) => {
    state.showAllArmor = e.target.checked;
    renderTable();
  });
  document.getElementById('explainBtn').addEventListener('click', () => {
    state.showExplain = !state.showExplain;
    document.getElementById('explain').hidden = !state.showExplain;
  });
  // 点表格里任意一行 → 把它送进命中模拟
  area.querySelectorAll('tbody tr[data-name]').forEach((tr) => {
    tr.addEventListener('click', () => {
      state.sim.name = tr.dataset.name;
      state.sim.boxIndex = -1;
      document.querySelectorAll('.tab').forEach((t) =>
        t.classList.toggle('active', t.dataset.tab === 'sim'));
      state.tableTab = 'sim';
      renderTable();
    });
  });
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** 数字保留一位小数，整数就不显示小数点。 */
function trimNum(value) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return String(Math.round(number * 10) / 10);
}

function explainHtml() {
  const model = state.data.damageModel || {};
  const steps = (model.steps || []).map((s) => `<li>${s}</li>`).join('');
  const notes = (model.notes || []).map((s) => `<li>${s}</li>`).join('');
  return `<div class="explainbox">
    <div class="formula">${model.formula || ''}</div>
    <ol>${steps}</ol>
    <div class="owner">还需要注意：</div>
    <ul>${notes}</ul>
  </div>`;
}

/** 修复规则那种和载具无关的表，按原样铺开。 */
function renderPlainTable(area, source) {
  if (!source || !source.length) { area.innerHTML = '暂无数据'; return; }
  const columns = Object.keys(source[0]);
  const nameKey = '载具名称';
  const head = columns.map((c) => `<th>${c}</th>`).join('');
  const selected = state.vehicle?.name || '';
  // 选中载具的数值组置顶并高亮，其余按载具名排序
  const ordered = [...source].sort((a, b) => {
    const aSel = a[nameKey] === selected ? 0 : 1;
    const bSel = b[nameKey] === selected ? 0 : 1;
    if (aSel !== bSel) return aSel - bSel;
    return String(a[nameKey] ?? '').localeCompare(String(b[nameKey] ?? ''), 'zh');
  });
  // 第一列（载具名称）合并相同格
  const body = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const row = ordered[i];
    const isSel = row[nameKey] === selected;
    const isFirst = i === 0 || ordered[i - 1][nameKey] !== row[nameKey];
    let count = 1;
    while (i + count < ordered.length && ordered[i + count][nameKey] === row[nameKey]) count += 1;
    const cells = [];
    columns.forEach((c, ci) => {
      if (ci === 0 && !isFirst) return;  // 被 rowspan 覆盖，跳过
      const span = ci === 0 ? ` class="name-cell" rowspan="${count}"` : '';
      cells.push(`<td${span}>${row[c] ?? ''}</td>`);
    });
    body.push(`<tr class="${isSel ? 'selected-row' : ''}">${cells.join('')}</tr>`);
  }
  area.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`;
}

/* ---------------------------- 渲染循环 ---------------------------- */

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, activeCamera);
  updateLabels();
}

function updateLabels() {
  if (!state.showLabels || !state.vehicle) {
    labelLayer.querySelectorAll('.label:not(#hoverLabel)').forEach((el) => el.remove());
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const nodes = Array.from(labelLayer.children).filter((el) => el !== hoverLabel);
  state.vehicle.hitBoxes.forEach((box, index) => {
    let node = nodes[index];
    if (!node) {
      node = document.createElement('div');
      node.className = 'label';
      labelLayer.appendChild(node);
    }
    node.textContent = `${box.name} ×${box.scaling}`;
    const anchor = boxAnchorVec(box);
    if (!anchor) {                 // 无体积又对不上模型的点位（如防爆装甲），不挂标签
      node.style.display = 'none';
      return;
    }
    const position = anchor.project(activeCamera);
    const x = (position.x * 0.5 + 0.5) * rect.width;
    const y = (-position.y * 0.5 + 0.5) * rect.height;
    const visible = state.showBoxes && position.z < 1 && x > 0 && y > 0 && x < rect.width && y < rect.height;
    node.style.display = visible ? 'block' : 'none';
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.opacity = index === state.selectedBoxIndex ? '1' : '0.72';
  });
  nodes.slice(state.vehicle.hitBoxes.length).forEach((el) => el.remove());
}

// 供截图脚本/调试使用
window.__viewer = { state, setView, selectVehicle, fitCamera };
