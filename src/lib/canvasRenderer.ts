import * as THREE from "three";
import { clamp } from "./astronomy";

const sunDirection = new THREE.Vector3(-0.59, 0.69, -0.41).normalize();
const byte = (linear: number) => Math.round(255 * clamp(linear, 0, 1) ** (1 / 2.2));
const rgb = (r: number, g: number, b: number) => `rgb(${byte(r)},${byte(g)},${byte(b)})`;

interface RenderQueueItem {
  type: "sprite" | "sphere" | "stars" | "path" | "face";
  depth: number;
  point?: [number, number, number];
  points?: [number, number, number][];
  radius?: number;
  material?: any;
  color?: string;
  opacity?: number;
  dashed?: boolean;
  wide?: boolean;
}

export class CanvasRenderer {
  domElement: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  backdrop: HTMLCanvasElement;
  backdropContext: CanvasRenderingContext2D;
  textureCache: WeakMap<object, HTMLCanvasElement>;
  dpr: number;
  width = 0;
  height = 0;
  pixelScale = 1;
  backdropKey: string | null = null;

  constructor() {
    this.domElement = document.createElement("canvas");
    this.context = this.domElement.getContext("2d")!;
    this.backdrop = document.createElement("canvas");
    this.backdropContext = this.backdrop.getContext("2d")!;
    this.textureCache = new WeakMap();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    for (const canvas of [this.domElement, this.backdrop]) {
      canvas.width = Math.round(width * this.dpr);
      canvas.height = Math.round(height * this.dpr);
    }
    this.backdropKey = null;
  }

  clear(context: CanvasRenderingContext2D) {
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
  }

  render(scene: THREE.Scene, camera: THREE.OrthographicCamera) {
    const { context, backdropContext } = this;
    this.clear(context);
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const transform = new THREE.Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.pixelScale = this.width / (camera.right - camera.left);
    if (scene.userData.staticTerrain) {
      const key = `${scene.userData.terrainRevision}:${transform.elements.join(",")}`;
      if (key !== this.backdropKey) {
        this.clear(backdropContext);
        this.draw(scene, transform, backdropContext, false);
        this.backdropKey = key;
      }
      context.drawImage(this.backdrop, 0, 0, this.width, this.height);
      this.draw(scene, transform, context, true);
    } else {
      this.draw(scene, transform, context);
    }
  }

  draw(
    scene: THREE.Scene,
    transform: THREE.Matrix4,
    context: CanvasRenderingContext2D,
    dynamic?: boolean,
  ) {
    const queue: RenderQueueItem[] = [];
    scene.traverseVisible((obj) => {
      const object = obj as any;
      if (dynamic !== undefined && !!object.userData?.animated !== dynamic) return;
      if (!(object.isMesh || object.isLine || object.isPoints || object.isSprite)) return;
      const matrix = new THREE.Matrix4().multiplyMatrices(transform, object.matrixWorld).elements;
      const project = (x: number, y: number, z: number): [number, number, number] => [
        ((1 + matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) * this.width) / 2,
        ((1 - matrix[1] * x - matrix[5] * y - matrix[9] * z - matrix[13]) * this.height) / 2,
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
      ];
      const { material, geometry } = object;
      const { color, opacity } = material;
      const layer = (object.renderOrder || 0) * 10;
      if (opacity <= 0) return;
      if (object.isSprite || geometry?.type === "SphereGeometry") {
        const point = project(0, 0, 0);
        const worldScale = Math.hypot(
          object.matrixWorld.elements[0],
          object.matrixWorld.elements[1],
          object.matrixWorld.elements[2],
        );
        const radius =
          (object.isSprite ? 0.5 : geometry.parameters.radius) * worldScale * this.pixelScale;
        queue.push({
          type: object.isSprite ? "sprite" : "sphere",
          point,
          radius,
          material,
          depth: point[2] - layer,
        });
        return;
      }
      const position = geometry?.attributes?.position;
      if (!position?.count) return;
      const colorStyle = color.getStyle();
      const points: [number, number, number][] = Array.from({ length: position.count }, (_, i) =>
        project(position.getX(i), position.getY(i), position.getZ(i)),
      );
      if (object.isPoints) {
        queue.push({ type: "stars", points, opacity, color: colorStyle, depth: 1000 });
      } else if (object.isLine) {
        if (object.isLineSegments) {
          for (let i = 0; i + 1 < points.length; i += 2) {
            queue.push({
              type: "path",
              points: points.slice(i, i + 2),
              opacity,
              color: colorStyle,
              depth: (points[i][2] + points[i + 1][2]) / 2 - layer,
            });
          }
        } else {
          const depth = points.reduce((sum, p) => sum + p[2], 0) / points.length;
          queue.push({
            type: "path",
            points,
            opacity,
            color: colorStyle,
            depth: depth - layer,
            dashed: material.isLineDashedMaterial,
            wide: layer > 0,
          });
        }
      } else {
        this.faces(object, points, queue, layer);
      }
    });
    queue.sort((a, b) => b.depth - a.depth);
    for (const item of queue) this.paint(context, item);
    context.globalAlpha = 1;
  }

  faces(
    object: any,
    points: [number, number, number][],
    queue: RenderQueueItem[],
    layer: number,
  ) {
    const { geometry, material } = object;
    const indices = geometry.index?.array;
    const normals = geometry.attributes.normal;
    const colors = geometry.attributes.color;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
    const normal = new THREE.Vector3();
    for (let i = 0; i + 2 < (indices?.length ?? points.length); i += 3) {
      const a = indices ? indices[i] : i;
      const b = indices ? indices[i + 1] : i + 1;
      const c = indices ? indices[i + 2] : i + 2;
      const p = points[a];
      const q = points[b];
      const r = points[c];
      const signedArea = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      if (Math.abs(signedArea) < 0.025 || (material.side === 0 && signedArea > 0)) continue;
      let color: string = material.color.getStyle();
      if (!material.isMeshBasicMaterial && normals) {
        normal
          .set(
            normals.getX(a) + normals.getX(b) + normals.getX(c),
            normals.getY(a) + normals.getY(b) + normals.getY(c),
            normals.getZ(a) + normals.getZ(b) + normals.getZ(c),
          )
          .applyNormalMatrix(normalMatrix);
        if (signedArea > 0) normal.negate();
        const light =
          0.31 + 0.89 * Math.max(0, normal.dot(sunDirection)) + 0.1 * Math.max(0, normal.y);
        const base =
          material.vertexColors && colors
            ? [
                (colors.getX(a) + colors.getX(b) + colors.getX(c)) / 3,
                (colors.getY(a) + colors.getY(b) + colors.getY(c)) / 3,
                (colors.getZ(a) + colors.getZ(b) + colors.getZ(c)) / 3,
              ]
            : [material.color.r, material.color.g, material.color.b];
        color = rgb(base[0] * light, base[1] * light, base[2] * light);
      }
      queue.push({
        type: "face",
        points: [p, q, r],
        color,
        opacity: material.opacity,
        depth: (p[2] + q[2] + r[2]) / 3 - layer,
      });
    }
  }

  paint(context: CanvasRenderingContext2D, item: RenderQueueItem) {
    const { type, color, opacity, points, material, point, radius } = item;
    if ((type === "sphere" || type === "sprite") && point && radius !== undefined) {
      const [x, y] = point;
      if (x < -radius || x > this.width + radius || y < -radius || y > this.height + radius) return;
      context.globalAlpha = material.opacity;
      if (type === "sprite" && material.map?.image) {
        context.drawImage(material.map.image, x - radius, y - radius, 2 * radius, 2 * radius);
      } else if (type === "sphere") {
        if (material.map?.image) {
          const globe = this.texturedGlobe(material.map.image);
          context.drawImage(globe, x - radius, y - radius, 2 * radius, 2 * radius);
          return;
        }
        const { r, g, b } = material.color;
        const gradient = context.createRadialGradient(
          x - radius * 0.31,
          y - radius * 0.34,
          0,
          x,
          y,
          radius,
        );
        gradient.addColorStop(0, rgb(r * 1.35, g * 1.31, b * 1.24));
        gradient.addColorStop(0.68, rgb(r, g, b));
        gradient.addColorStop(1, rgb(r * 0.57, g * 0.57, b * 0.61));
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(x, y, radius, 0, 2 * Math.PI);
        context.fill();
      }
      return;
    }
    if (!points || !points.length) return;
    context.globalAlpha = opacity ?? 1;
    if (type === "stars") {
      context.fillStyle = color ?? "#99b0ce";
      for (const [x, y] of points) context.fillRect(x, y, 1.25, 1.25);
      return;
    }
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) context.lineTo(points[i][0], points[i][1]);
    if (type === "face") {
      context.closePath();
      context.fillStyle = color!;
      context.fill();
      if (opacity === 1) {
        context.strokeStyle = color!;
        context.lineWidth = 0.5;
        context.stroke();
      }
    } else {
      context.strokeStyle = color!;
      context.lineWidth = item.wide ? 1.35 : 1;
      context.setLineDash(item.dashed ? [3, 3] : []);
      context.stroke();
      context.setLineDash([]);
    }
  }

  texturedGlobe(image: CanvasImageSource) {
    const cached = this.textureCache.get(image);
    if (cached) return cached;
    const source = document.createElement("canvas");
    source.width = 360;
    source.height = 180;
    const input = source.getContext("2d")!;
    input.drawImage(image, 0, 0, source.width, source.height);
    const texture = input.getImageData(0, 0, source.width, source.height).data;
    const globe = document.createElement("canvas");
    globe.width = globe.height = 128;
    const context = globe.getContext("2d")!;
    const pixels = context.createImageData(globe.width, globe.height);
    const half = globe.width / 2;
    for (let row = 0; row < globe.height; row++) {
      for (let col = 0; col < globe.width; col++) {
        const x = (col + 0.5) / half - 1;
        const y = 1 - (row + 0.5) / half;
        const radius = Math.hypot(x, y);
        if (radius >= 1) continue;
        const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
        const u = Math.floor((Math.atan2(x, z) / (2 * Math.PI) + 0.5) * source.width);
        const v = clamp(
          Math.floor((0.5 - Math.asin(y) / Math.PI) * source.height),
          0,
          source.height - 1,
        );
        const index = (v * source.width + u) * 4;
        const target = (row * globe.width + col) * 4;
        const light = 0.51 + 0.49 * Math.max(0, -0.37 * x + 0.45 * y + 0.82 * z);
        for (let band = 0; band < 3; band++) {
          pixels.data[target + band] = texture[index + band] * light;
        }
        pixels.data[target + 3] = 255 * clamp((1 - radius) * half, 0, 1);
      }
    }
    context.putImageData(pixels, 0, 0);
    this.textureCache.set(image, globe);
    return globe;
  }
}
