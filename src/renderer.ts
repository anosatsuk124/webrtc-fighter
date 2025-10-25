// ActorRenderer abstraction for mesh (GLB) and sprite (PNG Atlas) rendering.

import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

// Hash function to convert anim name to number (matches rollback.ts)
export function hashAnimName(str: string): number {
	let h = 0;
	for (let i = 0; i < str.length; i++) {
		h = ((h << 5) - h + str.charCodeAt(i)) | 0;
	}
	return h | 0;
}

// ActorRenderer abstraction
export interface ActorRenderer {
	load(data: LoadData): Promise<void>;
	applyState(xFixed16: number, animHash?: number): void;
}

export type LoadData =
	| { type: "mesh"; blob: Blob }
	| { type: "sprite"; pngBlob: Blob; atlasBlob: Blob };

// MeshActorRenderer: handles GLB models with AnimationGroups
export class MeshActorRenderer implements ActorRenderer {
	private urlForRevoke: string | null = null;
	private anims: Record<string, AnimationGroup> = {};
	private mesh: AbstractMesh | null = null;

	constructor(
		private scene: Scene,
		private root: TransformNode,
	) {}

	async load(data: LoadData): Promise<void> {
		if (data.type !== "mesh")
			throw new Error("MeshActorRenderer requires mesh type");

		if (this.urlForRevoke) {
			URL.revokeObjectURL(this.urlForRevoke);
			this.urlForRevoke = null;
		}
		const url = URL.createObjectURL(data.blob);
		this.urlForRevoke = url;

		// Clear previous animations for this actor
		for (const ag of this.scene.animationGroups.slice()) {
			if (ag.targetedAnimations.some((ta) => ta.target === this.mesh)) {
				ag.dispose();
			}
		}

		// Load GLB - force glTF plugin via extension hint for blob URLs
		const result = await SceneLoader.ImportMeshAsync(
			"",
			"",
			url,
			this.scene,
			undefined,
			".glb",
		);
		this.anims = {};
		for (const ag of this.scene.animationGroups) {
			this.anims[ag.name] = ag;
		}

		// Parent first mesh to root
		if (result.meshes[0]) {
			this.mesh = result.meshes[0];
			this.mesh.setParent(this.root);
		}
	}

	applyState(xFixed16: number, animHash?: number): void {
		// Convert 16.16 fixed to world units
		this.root.position.x = xFixed16 / (1 << 16);

		if (animHash !== undefined) {
			// Find anim by name hash
			const name = this.findAnimNameByHash(animHash);
			if (name) this.playOnce(name);
		}
	}

	private findAnimNameByHash(hash: number): string | null {
		for (const name of Object.keys(this.anims)) {
			if (hashAnimName(name) === hash) return name;
		}
		return null;
	}

	private playOnce(name: string) {
		const ag = this.anims[name];
		if (!ag) return;
		// Stop all others and play this
		for (const g of this.scene.animationGroups) g.stop();
		ag.start(true, 1.0);
	}
}

// Atlas JSON structure
interface AtlasData {
	cellWidth: number;
	cellHeight: number;
	anims: Record<
		string,
		{ from: number; to: number; fps: number; loop: boolean }
	>;
}

// SpriteActorRenderer: handles PNG Atlas + JSON for pixel-perfect sprites
export class SpriteActorRenderer implements ActorRenderer {
	private manager?: SpriteManager;
	private sprite?: Sprite;
	private atlas?: AtlasData;
	private pxPerUnit = 16; // world units → pixels
	private currentAnim: number | null = null; // Track current animation hash

	constructor(
		private scene: Scene,
		_canvas: HTMLCanvasElement,
	) {}

	async load(data: LoadData): Promise<void> {
		if (data.type !== "sprite")
			throw new Error("SpriteActorRenderer requires sprite type");

		// Read atlas JSON
		const atlasText = await data.atlasBlob.text();
		this.atlas = JSON.parse(atlasText);

		// Create PNG URL
		const pngUrl = URL.createObjectURL(data.pngBlob);

		// Create texture with NEAREST sampling, no mipmaps, clamp
		const tex = new Texture(
			pngUrl,
			this.scene,
			false, // noMipmap
			false, // invertY
			Texture.NEAREST_SAMPLINGMODE,
		);
		tex.wrapU = Texture.CLAMP_ADDRESSMODE;
		tex.wrapV = Texture.CLAMP_ADDRESSMODE;

		// Create sprite manager with nearest sampling
		if (!this.atlas) throw new Error("atlas not loaded");
		const cellWidth = this.atlas.cellWidth;
		const cellHeight = this.atlas.cellHeight;
		this.manager = new SpriteManager(
			"sm",
			pngUrl,
			128, // capacity (increased for more frames)
			{ width: cellWidth, height: cellHeight },
			this.scene,
			undefined, // epsilon
			Texture.NEAREST_SAMPLINGMODE,
		);
		this.sprite = new Sprite("actor", this.manager);
		this.sprite.cellIndex = 0;
		this.sprite.width = cellWidth / this.pxPerUnit;
		this.sprite.height = cellHeight / this.pxPerUnit;
		this.sprite.invertU = false;
		this.sprite.invertV = false;

		// Use viewer's active camera. No camera switching here.
	}

	applyState(xFixed16: number, animHash?: number): void {
		if (!this.sprite) return;

		// Pixel snap
		const x = xFixed16 / (1 << 16);
		const snapped = Math.round(x * this.pxPerUnit) / this.pxPerUnit;
		this.sprite.position.x = snapped;

		// Only play animation if it changed
		if (animHash !== undefined && this.atlas && animHash !== this.currentAnim) {
			const name = this.findAnimNameByHash(animHash);
			if (name) {
				const a = this.atlas.anims[name];
				if (a) {
					this.sprite.playAnimation(a.from, a.to, a.loop, 1000 / a.fps);
					this.currentAnim = animHash;
				}
			}
		}
	}

	private findAnimNameByHash(hash: number): string | null {
		if (!this.atlas) return null;
		for (const name of Object.keys(this.atlas.anims)) {
			if (hashAnimName(name) === hash) return name;
		}
		return null;
	}
}
