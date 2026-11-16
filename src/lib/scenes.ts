import * as THREE from "three";
import { RAD, clamp, norm, scale, sub, type OrbitPositions, type SkySample, type TriangleResult } from "./astronomy";
import { CanvasRenderer } from "./canvasRenderer";

const SUN = 0xf4d21f;
const EARTH = 0x93e5e1;
const GREEN = 0xf4d21f;
const vec = (values: number[]) => new THREE.Vector3(values[0], values[1], values[2]);
const colors = { sun: SUN, earth: EARTH, lander: GREEN };
const up = new THREE.Vector3(0, 1, 0);

function domePoint(altitude: number, azimuth: number, radius = 1) {
  const a = altitude * RAD;
  const h = azimuth * RAD;
  return new THREE.Vector3(
    radius * Math.cos(a) * Math.sin(h),
    radius * Math.sin(a),
    -radius * Math.cos(a) * Math.cos(h),
  );
}

function createLine(points: THREE.Vector3[], color: number, opacity = 1, dashed = false) {
  const params = { color, opacity, transparent: opacity < 1, depthWrite: false };
  const material = dashed
    ? new THREE.LineDashedMaterial({ ...params, dashSize: 0.013, gapSize: 0.01 })
    : new THREE.LineBasicMaterial(params);
  const object = new THREE.Line(new THREE.BufferGeometry(), material);
  linePoints(object, points);
  return object;
}

function linePoints(object: THREE.Line, points: THREE.Vector3[]) {
  object.geometry.dispose();
  object.geometry = new THREE.BufferGeometry().setFromPoints(points);
  if ((object.material as any).isLineDashedMaterial) object.computeLineDistances();
}

function disposableGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    child.traverse((obj) => {
      const mesh = obj as any;
      mesh.geometry?.dispose?.();
      mesh.material?.dispose?.();
    });
    group.remove(child);
  }
}

function sphere(radius: number, material: THREE.Material) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 24), material);
}

function starField(scene: THREE.Scene, extent = 3.8) {
  let seed = 3481;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const stars = new Float32Array(950 * 3);
  for (let i = 0; i < stars.length; i++) stars[i] = extent * (2 * random() - 1);
  const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(stars, 3));
  scene.add(
    new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0x99b0ce,
        size: 1.25,
        opacity: 0.38,
        transparent: true,
        depthWrite: false,
        sizeAttenuation: false,
      }),
    ),
  );
}

interface CameraPreset {
  yaw: number;
  pitch: number;
  span: number;
}

interface LabelEntry {
  element: HTMLSpanElement;
  position?: THREE.Vector3;
  visible?: boolean;
  offset?: number;
}

class Viewport {
  host: HTMLElement;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  labels: Map<string, LabelEntry>;
  target: THREE.Vector3;
  renderer: CanvasRenderer;
  labelsHost: HTMLDivElement;
  resize: ResizeObserver;
  yaw = 0;
  pitch = 0;
  span = 1;
  zoom = 1;
  width = 0;
  height = 0;

  constructor(host: HTMLElement, preset: CameraPreset) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 30);
    this.labels = new Map();
    this.target = new THREE.Vector3();
    this.renderer = new CanvasRenderer();
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    this.labelsHost = document.createElement("div");
    this.labelsHost.className = "scene-labels";
    this.labelsHost.setAttribute("aria-hidden", "true");
    host.append(this.renderer.domElement, this.labelsHost);
    this.bindPointer();
    this.resize = new ResizeObserver(() => this.render());
    this.resize.observe(host);
    this.setCamera(preset);
  }

  dispose() {
    this.resize.disconnect();
    this.renderer.domElement.remove();
    this.labelsHost.remove();
  }

  setCamera({ yaw, pitch, span }: CameraPreset) {
    this.yaw = yaw;
    this.pitch = pitch;
    this.span = span;
    this.zoom = 1;
    this.render();
  }

  bindPointer() {
    const canvas = this.renderer.domElement;
    let drag: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag || !event.isPrimary) return;
      this.yaw -= (event.clientX - drag.x) * 0.008;
      this.pitch = clamp(this.pitch + (event.clientY - drag.y) * 0.008, -1.48, 1.565);
      drag = { x: event.clientX, y: event.clientY };
      this.render();
    });
    canvas.addEventListener("lostpointercapture", () => {
      drag = null;
    });
    canvas.addEventListener("dblclick", () => {
      this.zoom = 1;
      this.render();
    });
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.adjustZoom(Math.exp(-clamp(event.deltaY, -200, 200) * 0.0035));
      },
      { passive: false },
    );
    this.host.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") this.yaw -= 0.13;
      else if (event.key === "ArrowRight") this.yaw += 0.13;
      else if (event.key === "ArrowUp") this.pitch = clamp(this.pitch + 0.13, -1.48, 1.565);
      else if (event.key === "ArrowDown") this.pitch = clamp(this.pitch - 0.13, -1.48, 1.565);
      else if (event.key === "+" || event.key === "=") this.adjustZoom(1.15);
      else if (event.key === "-") this.adjustZoom(1 / 1.15);
      else return;
      event.preventDefault();
      this.render();
    });
  }

  adjustZoom(factor: number) {
    this.zoom = clamp(this.zoom * factor, 0.55, 3.8);
    this.render();
  }

  label(
    id: string,
    text: string,
    position: THREE.Vector3,
    type = "",
    visible = true,
    offset = 0,
  ) {
    if (!this.labels.has(id)) {
      const element = document.createElement("span");
      element.className = `marker-label ${type}`;
      this.labelsHost.append(element);
      this.labels.set(id, { element });
    }
    const label = this.labels.get(id)!;
    label.position = position;
    label.visible = visible;
    label.offset = offset;
    if (label.element.textContent !== text) label.element.textContent = text;
  }

  render() {
    const { clientWidth: width, clientHeight: height } = this.host;
    if (!width || !height) return;
    if (this.width !== width || this.height !== height) {
      this.renderer.setSize(width, height);
      this.width = width;
      this.height = height;
    }
    const aspect = width / height;
    const range = this.span / this.zoom;
    const x = range * Math.max(1, aspect);
    const y = range * Math.max(1, 1 / aspect);
    Object.assign(this.camera, { left: -x, right: x, bottom: -y, top: y });
    const eye = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.position.copy(this.target).addScaledVector(eye, 5);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    for (const { element, position, visible, offset } of this.labels.values()) {
      if (!position) {
        element.hidden = true;
        continue;
      }
      const projected = position.clone().project(this.camera);
      element.hidden =
        !visible || Math.abs(projected.x) > 0.95 || Math.abs(projected.y) > 0.96 || Math.abs(projected.z) > 1;
      if (element.hidden) continue;
      element.style.left = `${((projected.x + 1) * width) / 2}px`;
      element.style.top = `${((1 - projected.y) * height) / 2 + (offset ?? 0)}px`;
    }
  }
}

export type TerrainCameraKey = "dome" | "eye" | "top";

const terrainCameras: Record<TerrainCameraKey, CameraPreset> = {
  dome: { yaw: 0.43, pitch: 0.63, span: 0.99 },
  eye: { yaw: 0, pitch: 0.085, span: 1.09 },
  top: { yaw: 0, pitch: 1.565, span: 1.14 },
};

function smoothGrid(mesh: number[][]) {
  const n = mesh.length;
  return mesh.map((row, r) =>
    row.map((height, c) => {
      const left = row[Math.max(0, c - 1)];
      const right = row[Math.min(n - 1, c + 1)];
      const previous = mesh[Math.max(0, r - 1)][c];
      const next = mesh[Math.min(n - 1, r + 1)][c];
      return height * 0.6 + (left + right + previous + next) * 0.1;
    }),
  );
}

function surfaceData(mesh: number[][], relief: number) {
  const grid = smoothGrid(mesh);
  const n = grid.length;
  const rings = 43;
  const sectors = 96;
  const values = grid.flat();
  const low = Math.min(...values);
  const high = Math.max(...values);
  const verticalScale = (0.155 * relief) / Math.max(420, Math.abs(low), Math.abs(high));

  function rawHeight(x: number, z: number) {
    const c = clamp(((x + 1) * (n - 1)) / 2, 0, n - 1);
    const r = clamp(((1 - z) * (n - 1)) / 2, 0, n - 1);
    const i = Math.min(Math.floor(r), n - 2);
    const j = Math.min(Math.floor(c), n - 2);
    const a = r - i;
    const b = c - j;
    return (
      (1 - a) * ((1 - b) * grid[i][j] + b * grid[i][j + 1]) +
      a * ((1 - b) * grid[i + 1][j] + b * grid[i + 1][j + 1])
    );
  }

  const origin = rawHeight(0, 0);
  const positions: number[] = [];
  const vertexColors: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const radius = r / rings;
    const taper = 1 - 0.65 * radius ** 8;
    for (let s = 0; s < sectors; s++) {
      const angle = (2 * Math.PI * s) / sectors;
      const x = radius * Math.sin(angle);
      const z = -radius * Math.cos(angle);
      const elevation = rawHeight(x, z);
      positions.push(x, (elevation - origin) * verticalScale * taper, z);
      const luminance = 0.135 + 0.14 * ((elevation - low) / Math.max(35, high - low));
      vertexColors.push(luminance * 1.04, luminance, luminance * 0.95);
      if (r === rings) continue;
      const a = r * sectors + s;
      const b = r * sectors + ((s + 1) % sectors);
      indices.push(a, b + sectors, a + sectors, a, b, b + sectors);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(vertexColors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const skirt: number[] = [];
  const skirtIndices: number[] = [];
  for (let s = 0; s < sectors; s++) {
    const j = (rings * sectors + s) * 3;
    const [x, y, z] = positions.slice(j, j + 3);
    skirt.push(x, y, z, x, y - 0.055, z);
    const a = s * 2;
    const b = ((s + 1) % sectors) * 2;
    skirtIndices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const edge = new THREE.BufferGeometry();
  edge.setAttribute("position", new THREE.Float32BufferAttribute(skirt, 3));
  edge.setIndex(skirtIndices);
  edge.computeVertexNormals();
  return { geometry, edge };
}

export class TerrainScene extends Viewport {
  surface: THREE.Group;
  skyline: THREE.Line;
  markers: Record<"sun" | "earth", { marker: THREE.Mesh; ray: THREE.Line }>;

  constructor(host: HTMLElement) {
    super(host, terrainCameras.dome);
    this.target.y = 0.13;
    this.scene.userData.staticTerrain = true;
    this.scene.userData.terrainRevision = 0;
    starField(this.scene);
    this.surface = new THREE.Group();
    this.scene.add(this.surface);
    for (const altitude of [0, 30, 60]) {
      this.scene.add(
        createLine(
          Array.from({ length: 121 }, (_, i) => domePoint(altitude, i * 3)),
          altitude === 0 ? 0x7b9cbc : 0x81a0c6,
          altitude === 0 ? 0.53 : 0.28,
          altitude !== 0,
        ),
      );
    }
    for (const [i, direction] of ["N", "E", "S", "W"].entries()) {
      this.label(direction, direction, domePoint(1, i * 90, 1.08));
    }
    this.skyline = createLine([], 0xdab784, 0.83);
    this.skyline.renderOrder = 1;
    this.scene.add(this.skyline);

    const markers = {} as Record<"sun" | "earth", { marker: THREE.Mesh; ray: THREE.Line }>;
    for (const key of ["sun", "earth"] as const) {
      const marker = sphere(
        key === "sun" ? 0.035 : 0.028,
        new THREE.MeshBasicMaterial({
          color: colors[key],
          toneMapped: false,
          depthTest: false,
          depthWrite: false,
          transparent: true,
        }),
      );
      marker.renderOrder = 5;
      marker.userData.animated = true;
      const ray = createLine([], colors[key], 0.6, true);
      ray.material.depthTest = false;
      ray.renderOrder = 3;
      ray.userData.animated = true;
      this.scene.add(marker, ray);
      markers[key] = { marker, ray };
    }
    this.markers = markers;

    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.014, 0.066, 8),
      new THREE.MeshBasicMaterial({ color: GREEN, toneMapped: false }),
    );
    mast.position.y = 0.035;
    const lander = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.046, 0.019, 8),
      new THREE.MeshBasicMaterial({ color: 0xadc88a, toneMapped: false }),
    );
    lander.position.y = 0.009;
    this.scene.add(mast, lander);
    this.label("lander", "Lander", new THREE.Vector3(0, 0.082, 0), "lander", true, -4);
    this.render();
  }

  preset(name: TerrainCameraKey) {
    this.setCamera(terrainCameras[name]);
  }

  setSurface(mesh: number[][] | null, relief: number, horizon: number[]) {
    this.scene.userData.terrainRevision++;
    disposableGroup(this.surface);
    if (mesh) {
      const { geometry, edge } = surfaceData(mesh, relief);
      this.surface.add(
        new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98 })),
        new THREE.Mesh(
          edge,
          new THREE.MeshStandardMaterial({ color: 0x2a303a, roughness: 0.98, side: THREE.DoubleSide }),
        ),
      );
    } else {
      const plane = new THREE.Mesh(
        new THREE.CircleGeometry(1, 96),
        new THREE.MeshStandardMaterial({
          color: 0x384250,
          roughness: 0.95,
          transparent: true,
          opacity: 0.48,
        }),
      );
      plane.rotation.x = -Math.PI / 2;
      this.surface.add(plane);
    }
    linePoints(
      this.skyline,
      Array.from({ length: 361 }, (_, i) => domePoint(horizon[i % 360], i, 1.006)),
    );
    this.render();
  }

  setHorizonVisible(visible: boolean) {
    this.skyline.visible = visible;
    this.scene.userData.terrainRevision++;
    this.render();
  }

  update(bodies: SkySample) {
    for (const key of ["sun", "earth"] as const) {
      const { marker, ray } = this.markers[key];
      const body = bodies[key];
      const visible = body.clearance > 0;
      const position = domePoint(body.alt, body.az, 1.02);
      marker.position.copy(position);
      (marker.material as THREE.MeshBasicMaterial).opacity = visible ? 1 : 0.48;
      (ray.material as THREE.LineBasicMaterial).opacity = visible ? 0.68 : 0.27;
      const array = ray.geometry.attributes.position as THREE.BufferAttribute | undefined;
      if (!array || array.count !== 2) linePoints(ray, [new THREE.Vector3(0, 0.02, 0), position]);
      else {
        array.setXYZ(1, position.x, position.y, position.z);
        array.needsUpdate = true;
        ray.computeLineDistances();
        ray.geometry.computeBoundingSphere();
      }
      this.label(key, key === "sun" ? "Sun" : "Earth", position, key, true, key === "sun" ? -14 : 25);
    }
    this.render();
  }
}

export type OrbitCameraMode = "system" | "pair";

const orbitCameras: Record<OrbitCameraMode, CameraPreset> = {
  system: { yaw: 0.2, pitch: 0.72, span: 1.13 },
  pair: { yaw: 0.2, pitch: 0.63, span: 0.112 },
};

function toOrbitVector([x, y, z]: number[]) {
  const ecliptic = 23.43928 * RAD;
  return new THREE.Vector3(
    x,
    z * Math.cos(ecliptic) - y * Math.sin(ecliptic),
    -(y * Math.cos(ecliptic) + z * Math.sin(ecliptic)),
  );
}

export class OrbitScene extends Viewport {
  mode: OrbitCameraMode;
  sun: THREE.Mesh;
  earth: THREE.Mesh;
  moon: THREE.Mesh;
  earthPath: THREE.Line;
  moonPath: THREE.Line;
  distanceLines: THREE.Line[];
  showLines: boolean;

  constructor(host: HTMLElement) {
    super(host, orbitCameras.system);
    this.mode = "system";
    starField(this.scene);
    this.sun = sphere(0.072, new THREE.MeshBasicMaterial({ color: SUN, toneMapped: false }));
    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = glowCanvas.height = 128;
    const context = glowCanvas.getContext("2d")!;
    const gradient = context.createRadialGradient(64, 64, 10, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255, 208, 131, .8)");
    gradient.addColorStop(0.47, "rgba(255, 177, 78, .45)");
    gradient.addColorStop(1, "rgba(255, 171, 76, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(glowCanvas),
        depthWrite: false,
        toneMapped: false,
      }),
    );
    glow.scale.set(0.45, 0.45, 1);
    glow.renderOrder = -1;
    this.sun.add(glow);

    this.earth = sphere(0.023, new THREE.MeshStandardMaterial({ color: 0x5baedd, roughness: 0.86 }));
    this.moon = sphere(0.0125, new THREE.MeshStandardMaterial({ color: 0xb9b5b1, roughness: 1 }));
    const loader = new THREE.TextureLoader();
    for (const [mesh, file] of [
      [this.earth, "earth.jpg"],
      [this.moon, "moon.jpg"],
    ] as const) {
      loader.load(
        `/assets/${file}`,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          const mat = mesh.material as THREE.MeshStandardMaterial;
          mat.map = texture;
          mat.color.set(0xffffff);
          mat.needsUpdate = true;
          this.render();
        },
        undefined,
        () => {},
      );
    }
    this.earthPath = createLine([], 0x6f93b4, 0.56);
    this.moonPath = createLine([], 0x899bab, 0.57);
    this.distanceLines = [
      createLine([], SUN, 0.52),
      createLine([], EARTH, 0.65),
      createLine([], 0xdfa889, 0.53),
    ];
    this.showLines = true;
    this.scene.add(
      this.sun,
      this.earth,
      this.moon,
      this.earthPath,
      this.moonPath,
      ...this.distanceLines,
    );
  }

  setMode(mode: OrbitCameraMode) {
    this.mode = mode;
    this.earth.scale.setScalar(mode === "pair" ? 0.78 : 1);
    this.moon.scale.setScalar(mode === "pair" ? 0.39 : 1);
    this.setCamera(orbitCameras[mode]);
  }

  updatePaths(fixedEarthPath: number[][], moonOffsetPath: number[][]) {
    linePoints(this.earthPath, fixedEarthPath.map(toOrbitVector));
    linePoints(
      this.moonPath,
      moonOffsetPath.map((offset) => toOrbitVector(scale(offset, 30))),
    );
  }

  setLines(visible: boolean) {
    this.showLines = visible;
  }

  update(positions: OrbitPositions) {
    const pair = this.mode === "pair";
    const earth = pair ? new THREE.Vector3() : toOrbitVector(positions.earth.position);
    const moon = earth.clone().add(toOrbitVector(scale(positions.lunar.position, 30)));
    const sun = new THREE.Vector3();
    this.earth.position.copy(earth);
    this.moon.position.copy(moon);
    this.sun.visible = !pair;
    this.earthPath.visible = !pair;
    this.moonPath.position.copy(earth);
    for (const [i, points] of (
      [
        [sun, earth],
        [earth, moon],
        [sun, moon],
      ] as [THREE.Vector3, THREE.Vector3][]
    ).entries()) {
      this.distanceLines[i].visible = this.showLines && (!pair || i === 1);
      if (this.distanceLines[i].visible) linePoints(this.distanceLines[i], points);
    }
    this.label("sun", "Sun", sun, "sun", !pair, -21);
    const radiusInPixels = (this.host.clientHeight * this.zoom) / (2 * this.span);
    const earthRadius = (this.earth.geometry as THREE.SphereGeometry).parameters.radius * this.earth.scale.x * radiusInPixels;
    const moonRadius = (this.moon.geometry as THREE.SphereGeometry).parameters.radius * this.moon.scale.x * radiusInPixels;
    this.label("earth", "Earth", earth, "earth", true, -earthRadius - 4);
    this.label("moon", "Moon", moon, "", true, moonRadius + 16);
    this.render();
  }
}

const geometryCamera: CameraPreset = { yaw: 0.65, pitch: 0.92, span: 1.14 };

export class GeometryScene extends Viewport {
  objects: THREE.Group;

  constructor(host: HTMLElement) {
    super(host, geometryCamera);
    this.objects = new THREE.Group();
    this.scene.add(this.objects);
    const grid = new THREE.GridHelper(2.05, 12, 0x4b5c6c, 0x293342);
    const mat = grid.material as THREE.LineBasicMaterial;
    mat.color.set(0x4b5c6c);
    mat.opacity = 0.55;
    grid.position.y = -0.57;
    this.scene.add(grid);
  }

  reset() {
    this.setCamera(geometryCamera);
  }

  update(points: number[][], geometry: TriangleResult | null) {
    disposableGroup(this.objects);
    for (const label of this.labels.values()) label.visible = false;
    if (!geometry) {
      this.render();
      return;
    }
    const normalized = points.map((point) =>
      scale(sub(point, geometry.incenter), 1.7 / geometry.scale),
    );
    const xyz = normalized.map(vec);
    const triangle = new THREE.BufferGeometry().setFromPoints(xyz);
    triangle.computeVertexNormals();
    this.objects.add(
      new THREE.Mesh(
        triangle,
        new THREE.MeshStandardMaterial({
          color: EARTH,
          side: THREE.DoubleSide,
          opacity: 0.64,
          transparent: true,
        }),
      ),
    );
    this.objects.add(createLine([...xyz, xyz[0]], EARTH));
    for (const [i, point] of xyz.entries()) {
      const vertex = sphere(0.026, new THREE.MeshBasicMaterial({ color: EARTH, toneMapped: false }));
      vertex.position.copy(point);
      this.objects.add(vertex);
      const name = "ABC"[i];
      this.label(name, name, point, "earth", true, -5);
    }
    const origin = new THREE.Vector3();
    this.objects.add(sphere(0.026, new THREE.MeshBasicMaterial({ color: SUN, toneMapped: false })));
    const arrowLength = clamp(norm(normalized[0]) * 0.72, 0.32, 0.64);
    const normal = vec(geometry.normal);
    this.objects.add(new THREE.ArrowHelper(normal, origin, arrowLength, SUN, 0.105, 0.052));
    this.label("incenter", "I", origin, "sun", true, 13);
    this.label("normal", "n", normal.clone().multiplyScalar(arrowLength), "sun", true, -3);

    const systemOrigin = geometry.incenter.map((value) =>
      value === 0 ? 0 : (-value * 1.7) / geometry.scale,
    );
    if (norm(systemOrigin) < 0.96) {
      const axisColors = [0xe78f8d, 0x9fd792, 0x83b9eb];
      for (const [i, letter] of ["X", "Y", "Z"].entries()) {
        const axis = i === 1 ? up : vec(i === 0 ? [1, 0, 0] : [0, 0, 1]);
        const axesOrigin = vec(systemOrigin);
        this.objects.add(new THREE.ArrowHelper(axis, axesOrigin, 0.43, axisColors[i], 0.07, 0.035));
        this.label(letter, letter, axesOrigin.addScaledVector(axis, 0.47), "", true, 0);
      }
    }
    this.render();
  }
}

export function mountScene<T extends Viewport>(
  SceneCtor: new (host: HTMLElement) => T,
  host: HTMLElement,
): T | null {
  try {
    return new SceneCtor(host);
  } catch (error) {
    console.error(error);
    const message = document.createElement("p");
    message.className = "scene-error";
    message.textContent = "The 3D view is unavailable in this browser. You can still use the numerical results.";
    host.append(message);
    return null;
  }
}
