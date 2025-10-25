// Babylon.js viewer. Applies latest state each render.

import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

export class ViewerBJS {
	private engine: Engine;
	private scene: Scene;
	private root1: TransformNode;
	private root2: TransformNode;
	private anims: Record<string, AnimationGroup> = {};
	private urlForRevoke: string | null = null;

	constructor(canvas: HTMLCanvasElement) {
		this.engine = new Engine(canvas, true, {
			preserveDrawingBuffer: true,
			stencil: false,
		});
		this.scene = new Scene(this.engine);
		this.root1 = new TransformNode("p1", this.scene);
		this.root2 = new TransformNode("p2", this.scene);
		const cam = new ArcRotateCamera(
			"cam",
			Math.PI / 2,
			Math.PI / 3,
			6,
			new Vector3(0, 1.2, 0),
			this.scene,
		);
		cam.attachControl(canvas, true);
		new HemisphericLight("h", new Vector3(0, 1, 0), this.scene);
		const d = new DirectionalLight("d", new Vector3(-1, -2, -1), this.scene);
		d.position = new Vector3(3, 6, 3);
		MeshBuilder.CreateGround("g", { width: 30, height: 30 }, this.scene);
		this.root1.position = new Vector3(-1, 0, 0);
		this.root2.position = new Vector3(1, 0, 0);

		this.engine.runRenderLoop(() => {
			this.scene.render();
		});
		addEventListener("resize", () => this.engine.resize());
	}

	async loadGLBFromBlob(blob: Blob) {
		if (this.urlForRevoke) {
			URL.revokeObjectURL(this.urlForRevoke);
			this.urlForRevoke = null;
		}
		const url = URL.createObjectURL(blob);
		this.urlForRevoke = url;

		// Clear previous model
		for (const ag of this.scene.animationGroups.slice()) ag.dispose();

		// Load twice for two fighters (for simplicity)
		await SceneLoader.AppendAsync("", url, this.scene, undefined, ".glb");
		await SceneLoader.AppendAsync("", url, this.scene, undefined, ".glb");

		// Gather animation groups by name
		this.anims = {};
		for (const ag of this.scene.animationGroups) {
			this.anims[ag.name] = ag;
		}

		// Parent first two top-level meshes to roots
		const meshes = this.scene.meshes.filter((m) => m.name && m.name !== "g");
		if (meshes[0]) meshes[0].setParent(this.root1);
		if (meshes[1]) meshes[1].setParent(this.root2);
	}

	applyState(x1: number, x2: number, anim1Name?: string, anim2Name?: string) {
		// Convert 16.16 fixed to world units ~ meters
		this.root1.position.x = x1 / (1 << 16);
		this.root2.position.x = x2 / (1 << 16);
		if (anim1Name) this.playOnce(anim1Name, this.root1);
		if (anim2Name) this.playOnce(anim2Name, this.root2);
	}

	private playOnce(name: string, _root: TransformNode) {
		const ag = this.anims[name];
		if (!ag) return;
		// For simplicity: stop others and play this
		for (const g of this.scene.animationGroups) g.stop();
		ag.start(true, 1.0);
	}
}
