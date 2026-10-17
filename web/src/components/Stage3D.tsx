/**
 * 3D view of the live stage (docs/specs/venue-fixtures-stage.md, « Vue 3D »): zones as slabs at their
 * floor height, fixtures at their place turned by their heading and lit in their real output colour,
 * beams as glowing cones to where the server says they land. Drag to orbit, wheel to zoom, right
 * drag to pan. Loaded on demand (three.js is heavy); the 2D plan stays the place to edit.
 *
 * Stage frame (X cour, Y upstage, Z up) → three.js (x = X, y = Z, z = −Y): the default camera stands
 * in the audience, looking upstage.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PlanFixture, PlanZone } from "./StagePlan";

type Vec = { x: number; y: number; z: number };
export interface Stage3DProps {
  fixtures: PlanFixture[];
  zones: PlanZone[];
  colors: Record<string, string[]>;
  beams: Record<string, Vec & { angle?: number; to: Vec }>;
  noWebgl: string;
  label: string;
}

const ZONE_COLOR: Record<string, string> = { stage: "#2a2f3b", riser: "#343b4a", floor: "#22262f", audience: "#1b2a22", wall: "#3a2f2a", pillar: "#3a2f2a", backdrop: "#30283a" };
const toThree = (v: Vec) => new THREE.Vector3(v.x, v.z, -v.y);
const lit = (cs?: string[]) => (cs ?? []).filter((c) => c !== "#000000");

export default function Stage3D({ fixtures, zones, colors, beams, noWebgl, label }: Stage3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const world = useRef<{ scene: THREE.Scene; dynamic: THREE.Group; zones: THREE.Group; camera: THREE.PerspectiveCamera; controls: OrbitControls; framed: boolean } | null>(null);
  const [failed, setFailed] = useState(false);

  // the renderer, camera and controls, once
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch {
      setFailed(true);
      return;
    }
    const width = el.clientWidth || 800;
    const height = Math.round(Math.min(520, Math.max(300, width * 0.55)));
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.setAttribute("aria-label", label);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0e1015");
    scene.add(new THREE.HemisphereLight("#9aa4b8", "#101218", 1.2));
    const sun = new THREE.DirectionalLight("#ffffff", 0.6);
    sun.position.set(-4, 10, 8);
    scene.add(sun);
    const grid = new THREE.GridHelper(40, 40, "#262b36", "#1a1e26");
    grid.position.y = -0.001;
    scene.add(grid);
    const zonesGroup = new THREE.Group();
    const dynamic = new THREE.Group();
    scene.add(zonesGroup, dynamic);
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200);
    camera.position.set(0, 5, 12);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1, -2);
    controls.enableDamping = true;
    controls.update();
    world.current = { scene, dynamic, zones: zonesGroup, camera, controls, framed: false };
    let frame = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    loop();
    const resize = () => {
      const w = el.clientWidth || width;
      const h = Math.round(Math.min(520, Math.max(300, w * 0.55)));
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      world.current = null;
    };
  }, [label]);

  // zones: slabs at their floor height, red edges for the protected and the no-aim ones
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    clear(w.zones);
    for (const z of zones) {
      const shape = new THREE.Shape(z.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.03, z.floorHeight), bevelEnabled: false });
      geometry.rotateX(-Math.PI / 2); // extruded upward: (X, Y, depth) → (X, depth, −Y)
      const slab = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: ZONE_COLOR[z.type] ?? "#262a33", roughness: 0.9 }));
      w.zones.add(slab);
      if (z.protected || z.noAim) w.zones.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: "#e5484d" })));
    }
  }, [zones]);

  // framed once, on what there is: the zones and the placed fixtures, seen from the audience
  useEffect(() => {
    const w = world.current;
    const points = [...zones.flatMap((z) => z.polygon), ...fixtures.filter((f) => f.position).map((f) => [f.position!.x, f.position!.y] as [number, number])];
    if (!w || w.framed || !points.length) return;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const [cx, cy] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const size = Math.max(4, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    w.controls.target.set(cx, 1, -cy);
    w.camera.position.set(cx, 1 + size * 0.55, -cy + size * 1.1);
    w.controls.update();
    w.framed = true;
  }, [zones, fixtures]);

  // fixtures and their beams, from the live output
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    clear(w.dynamic);
    fixtures.forEach((f, i) => {
      // unplaced fixtures wait in a row in front of the stage, as on the plan
      const p = f.position ?? { x: (i - fixtures.length / 2) * 0.6, y: -1, z: 0.3 };
      const heads = colors[f.id] ?? ["#000000"];
      const body = new THREE.Group();
      body.position.copy(toThree(p));
      body.rotation.y = ((f.orientation?.yaw ?? 0) * Math.PI) / 180; // front (local +z) towards its heading
      const cell = Math.min(0.25, 1.2 / heads.length);
      heads.forEach((c, k) => {
        const on = c !== "#000000";
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(cell * 0.9, 0.15, 0.2),
          new THREE.MeshStandardMaterial({ color: on ? c : "#2b2f38", emissive: on ? c : "#000000", emissiveIntensity: on ? 0.9 : 0 }),
        );
        box.position.x = (k - (heads.length - 1) / 2) * cell;
        body.add(box);
      });
      w.dynamic.add(body);
      const beam = beams[f.id];
      const shine = lit(heads);
      if (!beam || !f.position || !shine.length) return;
      const from = toThree(f.position);
      const to = toThree(beam.to);
      const length = from.distanceTo(to);
      if (length < 0.05) return;
      const half = (Math.min(Math.max(beam.angle ?? 24, 4), 120) * Math.PI) / 360;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(Math.tan(half) * length, length, 24, 1, true),
        new THREE.MeshBasicMaterial({ color: shine[Math.floor(shine.length / 2)], transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
      );
      // the cone's tip (+y) at the fixture, its base where the light lands
      cone.position.copy(from.clone().add(to).multiplyScalar(0.5));
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), from.clone().sub(to).normalize());
      w.dynamic.add(cone);
    });
  }, [fixtures, colors, beams]);

  if (failed) return <p className="hint">{noWebgl}</p>;
  return <div className="stage-3d" ref={host} />;
}

/** Empties a group, freeing what its meshes hold on the GPU. */
function clear(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }
}
