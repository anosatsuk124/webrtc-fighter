// Babylon.js viewer. Applies latest state each render.
// Supports both mesh (GLB) and sprite (PNG Atlas) rendering.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
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
import type { CollisionBox } from "./rollback";

export class ViewerBJS {
	private engine: Engine;
	private scene: Scene;
	private root1: TransformNode;
	private root2: TransformNode;
	private renderer1?: ActorRenderer;
	private renderer2?: ActorRenderer;
	private showCollisionBoxes = false;
	private collisionBoxMeshes: Mesh[] = [];
	private redMaterial?: StandardMaterial;
	private blueMaterial?: StandardMaterial;
	private cellWidth = 96; // Default, updated when loading sprite
	private cellHeight = 63; // Default, updated when loading sprite

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
			-Math.PI / 2, // side view (from negative X direction)
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

		// Initialize collision box materials
		this.redMaterial = new StandardMaterial("hitboxMat", this.scene);
		this.redMaterial.diffuseColor = Color3.Red();
		this.redMaterial.wireframe = true;

		this.blueMaterial = new StandardMaterial("hurtboxMat", this.scene);
		this.blueMaterial.diffuseColor = Color3.Blue();
		this.blueMaterial.wireframe = true;

		this.engine.runRenderLoop(() => {
			this.scene.render();
		});
		addEventListener("resize", () => this.engine.resize());
	}

	setShowCollisionBoxes(show: boolean) {
		this.showCollisionBoxes = show;
		if (!show) {
			// Clear all collision box meshes
			for (const mesh of this.collisionBoxMeshes) {
				mesh.dispose();
			}
			this.collisionBoxMeshes = [];
		}
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

			// Parse atlas JSON to get cell dimensions
			const atlasText = new TextDecoder().decode(atlasData);
			const atlasJson = JSON.parse(atlasText);
			if (atlasJson.cellWidth) this.cellWidth = atlasJson.cellWidth;
			if (atlasJson.cellHeight) this.cellHeight = atlasJson.cellHeight;

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
		collisionData?: {
			p1Hitboxes?: CollisionBox[];
			p1Hurtboxes?: CollisionBox[];
			p2Hitboxes?: CollisionBox[];
			p2Hurtboxes?: CollisionBox[];
		},
	): void {
		// Determine facing direction: characters always face toward their opponent
		const p1FacesLeft = x1 > x2;
		const p2FacesLeft = x1 < x2;

		if (this.renderer1) this.renderer1.applyState(x1, anim1Hash, p1FacesLeft);
		if (this.renderer2) this.renderer2.applyState(x2, anim2Hash, p2FacesLeft);

		// Draw collision boxes if enabled
		if (this.showCollisionBoxes && collisionData) {
			this.drawCollisionBoxes(x1, x2, p1FacesLeft, p2FacesLeft, collisionData);
		} else if (!this.showCollisionBoxes) {
			// Clear boxes when disabled
			for (const mesh of this.collisionBoxMeshes) {
				mesh.dispose();
			}
			this.collisionBoxMeshes = [];
		}
	}

	private drawCollisionBoxes(
		x1: number,
		x2: number,
		p1FacesLeft: boolean,
		p2FacesLeft: boolean,
		data: {
			p1Hitboxes?: CollisionBox[];
			p1Hurtboxes?: CollisionBox[];
			p2Hitboxes?: CollisionBox[];
			p2Hurtboxes?: CollisionBox[];
		},
	) {
		// Clear previous boxes
		for (const mesh of this.collisionBoxMeshes) {
			mesh.dispose();
		}
		this.collisionBoxMeshes = [];

		const pxPerUnit = 16; // pixels per world unit

		// Debug: log collision data
		const totalBoxes =
			(data.p1Hitboxes?.length || 0) +
			(data.p1Hurtboxes?.length || 0) +
			(data.p2Hitboxes?.length || 0) +
			(data.p2Hurtboxes?.length || 0);
		if (totalBoxes > 0) {
			console.log("[Collision Viz]", {
				p1Hitboxes: data.p1Hitboxes?.length,
				p1Hurtboxes: data.p1Hurtboxes?.length,
				p2Hitboxes: data.p2Hitboxes?.length,
				p2Hurtboxes: data.p2Hurtboxes?.length,
				cellWidth: this.cellWidth,
				cellHeight: this.cellHeight,
			});
		}

		// Helper function to create a box mesh
		const createBox = (
			box: CollisionBox,
			worldX: number,
			facingLeft: boolean,
			color: "red" | "blue",
		): Mesh => {
			// Convert pixels to world units
			const width = box.width / pxPerUnit;
			const height = box.height / pxPerUnit;
			const depth = 1.0; // Visible depth for 2D

			const mesh = MeshBuilder.CreateBox(
				"collisionBox",
				{ width, height, depth },
				this.scene,
			);

			// Position: convert centered offsets (pixels) to world units
			// Collision boxes are already centered: x right+, y up+
			const offsetX = box.x / pxPerUnit;
			const offsetY = box.y / pxPerUnit;

			mesh.position.x = worldX + (facingLeft ? -offsetX : offsetX);
			mesh.position.y = offsetY;
			mesh.position.z = 0;

			// Apply material
			if (this.redMaterial && this.blueMaterial) {
				mesh.material = color === "red" ? this.redMaterial : this.blueMaterial;
			}

			return mesh;
		};

		// Convert fixed-point to world coordinates
		const p1WorldX = x1 / (1 << 16);
		const p2WorldX = x2 / (1 << 16);

		// Draw P1 hitboxes (red)
		if (data.p1Hitboxes) {
			for (const box of data.p1Hitboxes) {
				const mesh = createBox(box, p1WorldX, p1FacesLeft, "red");
				this.collisionBoxMeshes.push(mesh);
			}
		}

		// Draw P1 hurtboxes (blue)
		if (data.p1Hurtboxes) {
			for (const box of data.p1Hurtboxes) {
				const mesh = createBox(box, p1WorldX, p1FacesLeft, "blue");
				this.collisionBoxMeshes.push(mesh);
			}
		}

		// Draw P2 hitboxes (red)
		if (data.p2Hitboxes) {
			for (const box of data.p2Hitboxes) {
				const mesh = createBox(box, p2WorldX, p2FacesLeft, "red");
				this.collisionBoxMeshes.push(mesh);
			}
		}

		// Draw P2 hurtboxes (blue)
		if (data.p2Hurtboxes) {
			for (const box of data.p2Hurtboxes) {
				const mesh = createBox(box, p2WorldX, p2FacesLeft, "blue");
				this.collisionBoxMeshes.push(mesh);
			}
		}
	}
}
