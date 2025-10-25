// Babylon.js viewer. Applies latest state each render.
// Supports both mesh (GLB) and sprite (PNG Atlas) rendering.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";
// Ensure StandardMaterial and its shaders are registered (used by ground)
import "@babylonjs/core/Materials/standardMaterial";
// Ensure default shaders are registered in ShadersStore (avoid network fetch)
import "@babylonjs/core/Shaders/default.fragment";
import "@babylonjs/core/Shaders/default.vertex";
// Ensure sprite shaders are registered (used by SpriteManager)
import "@babylonjs/core/Shaders/sprites.fragment";
import "@babylonjs/core/Shaders/sprites.vertex";
import type { CAS } from "./cas";
import type { Manifest } from "./protocol";
import {
	type ActorRenderer,
	MeshActorRenderer,
	SpriteActorRenderer,
} from "./renderer";

export class ViewerBJS {
	private engine: Engine;
	private scene: Scene;
	private root1: TransformNode;
	private root2: TransformNode;
	private renderer1?: ActorRenderer;
	private renderer2?: ActorRenderer;

	constructor(private canvas: HTMLCanvasElement) {
		this.engine = new Engine(canvas, true, {
			preserveDrawingBuffer: true,
			stencil: false,
		});
		this.scene = new Scene(this.engine);
		this.root1 = new TransformNode("p1", this.scene);
		this.root2 = new TransformNode("p2", this.scene);

		// Default 3D camera (fixed) — framed to show both characters at x=-1 and x=1
		const cam = new ArcRotateCamera(
			"cam",
			Math.PI / 2, // side view
			Math.PI / 2.2, // slightly above
			15, // further back to include both actors
			new Vector3(0, 1.0, 0),
			this.scene,
		);
		cam.minZ = 0.1;
		cam.maxZ = 1000;
		// Fix camera in place (no user control)
		// Do not attach controls and clamp all limits to current values
		cam.lowerRadiusLimit = cam.radius;
		cam.upperRadiusLimit = cam.radius;
		cam.lowerAlphaLimit = cam.alpha;
		cam.upperAlphaLimit = cam.alpha;
		cam.lowerBetaLimit = cam.beta;
		cam.upperBetaLimit = cam.beta;
		cam.wheelPrecision = 0; // ignore wheel if controls get attached elsewhere
		new HemisphericLight("h", new Vector3(0, 1, 0), this.scene);
		const d = new DirectionalLight("d", new Vector3(-1, -2, -1), this.scene);
		d.position = new Vector3(3, 6, 3);
		this.root1.position = new Vector3(-1, 0, 0);
		this.root2.position = new Vector3(1, 0, 0);

		this.engine.runRenderLoop(() => {
			this.scene.render();
		});
		addEventListener("resize", () => this.engine.resize());
	}

	// Legacy method for backward compatibility
	async loadGLBFromBlob(blob: Blob) {
		const r1 = new MeshActorRenderer(this.scene, this.root1);
		const r2 = new MeshActorRenderer(this.scene, this.root2);
		await r1.load({ type: "mesh", blob });
		await r2.load({ type: "mesh", blob });
		this.renderer1 = r1;
		this.renderer2 = r2;
	}

	// New method: load from Manifest + CAS
	async loadFromManifest(m: Manifest, cas: CAS) {
		const type = m.type || "mesh";

		if (type === "sprite") {
			// Sprite: PNG + Atlas JSON
			const pngChunk = m.chunks.find((c) => c.mime === "image/png");
			const atlasHash = m.meta?.atlas;
			if (!pngChunk || !atlasHash) {
				throw new Error("Sprite manifest missing PNG chunk or atlas hash");
			}
			const pngData = cas.get(pngChunk.hash);
			const atlasData = cas.get(atlasHash);
			if (!pngData || !atlasData) {
				throw new Error("Sprite assets not found in CAS");
			}
			// Ensure BlobParts are ArrayBuffer (not ArrayBufferLike)
			const pngAb = new Uint8Array(pngData).buffer;
			const atlasAb = new Uint8Array(atlasData).buffer;
			const pngBlob = new Blob([pngAb], { type: "image/png" });
			const atlasBlob = new Blob([atlasAb], { type: "application/json" });

			const r1 = new SpriteActorRenderer(this.scene, this.canvas);
			const r2 = new SpriteActorRenderer(this.scene, this.canvas);
			await r1.load({ type: "sprite", pngBlob, atlasBlob });
			await r2.load({ type: "sprite", pngBlob, atlasBlob });
			this.renderer1 = r1;
			this.renderer2 = r2;
		} else {
			// Mesh: GLB
			const entry = m.chunks[0];
			const data = cas.get(entry.hash);
			if (!data) throw new Error("Mesh asset not found in CAS");
			const ab = new Uint8Array(data).buffer;
			const blob = new Blob([ab], {
				type: entry.mime || "model/gltf-binary",
			});

			const r1 = new MeshActorRenderer(this.scene, this.root1);
			const r2 = new MeshActorRenderer(this.scene, this.root2);
			await r1.load({ type: "mesh", blob });
			await r2.load({ type: "mesh", blob });
			this.renderer1 = r1;
			this.renderer2 = r2;
		}
	}

	applyState(
		x1: number,
		x2: number,
		anim1Hash?: number,
		anim2Hash?: number,
	): void {
		if (this.renderer1) this.renderer1.applyState(x1, anim1Hash);
		if (this.renderer2) this.renderer2.applyState(x2, anim2Hash);
	}
}
