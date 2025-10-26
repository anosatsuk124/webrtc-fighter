// Deterministic fixed-point sim + rollback.
import type { InputMask } from "./input";
import { createLogger } from "./logger";
import type { RhaiVM } from "./vm_rhai";

// 16.16 fixed-point helpers
const FP = {
	ONE: 1 << 16,
	from(n: number) {
		return (n * (1 << 16)) | 0;
	},
	mul(a: number, b: number) {
		return ((a * b) >> 16) | 0;
	},
};

const log = createLogger("rollback");

// AABB collision detection for capsule-style boxes
function checkCollision(box1: CollisionBox, box2: CollisionBox): boolean {
	const halfW1 = box1.width / 2;
	const halfH1 = box1.height / 2;
	const halfW2 = box2.width / 2;
	const halfH2 = box2.height / 2;

	const left1 = box1.x - halfW1;
	const right1 = box1.x + halfW1;
	const top1 = box1.y - halfH1;
	const bottom1 = box1.y + halfH1;

	const left2 = box2.x - halfW2;
	const right2 = box2.x + halfW2;
	const top2 = box2.y - halfH2;
	const bottom2 = box2.y + halfH2;

	return !(
		right1 < left2 ||
		left1 > right2 ||
		bottom1 < top2 ||
		top1 > bottom2
	);
}

// Calculate pushback amount when boxes collide
// Returns the X-axis overlap amount (positive = push apart)
function calculateOverlapX(box1: CollisionBox, box2: CollisionBox): number {
	const halfW1 = box1.width / 2;
	const halfW2 = box2.width / 2;

	const left1 = box1.x - halfW1;
	const right1 = box1.x + halfW1;
	const left2 = box2.x - halfW2;
	const right2 = box2.x + halfW2;

	// Check if boxes overlap on X-axis
	if (right1 < left2 || left1 > right2) {
		return 0; // No overlap
	}

	// Calculate overlap from both sides and take minimum
	const overlapFromLeft = right1 - left2;
	const overlapFromRight = right2 - left1;

	return Math.min(overlapFromLeft, overlapFromRight);
}

export interface CollisionBox {
	x: number; // centered X offset in pixels (right positive)
	y: number; // centered Y offset in pixels (up positive)
	width: number; // width in pixels
	height: number; // height in pixels
}

export interface Fighter {
	x: number; // fixed-point
	vx: number; // fixed-point per tick
	hp: number; // int
	anim: number; // hash of anim name
	hitboxActive: boolean; // whether hitbox is active
	hurtboxActive: boolean; // whether hurtbox is active
}
export interface State {
	frame: number;
	p1: Fighter;
	p2: Fighter;
}

function hash32(h: number, v: number) {
	h ^= v >>> 0;
	h = Math.imul(h, 16777619) >>> 0;
	return h >>> 0;
}
export function hashState(s: State): number {
	let h = 2166136261 >>> 0;
	h = hash32(h, s.frame);
	for (const f of [s.p1, s.p2]) {
		h = hash32(h, f.x);
		h = hash32(h, f.vx);
		h = hash32(h, f.hp | 0);
		h = hash32(h, f.anim | 0);
		h = hash32(h, f.hitboxActive ? 1 : 0);
		h = hash32(h, f.hurtboxActive ? 1 : 0);
	}
	return h >>> 0;
}

export class Rollback {
	private hist: State[] = new Array(64);
	private in1 = new Uint16Array(65536);
	private in2 = new Uint16Array(65536);
	private latest = 0;
	private vm1: RhaiVM;
	private vm2: RhaiVM;
	private localPlayerNumber: 1 | 2;
	private collisionData: Map<
		number,
		{ hitboxes: CollisionBox[]; hurtboxes: CollisionBox[] }
	> = new Map();

	constructor(
		seedState: State,
		vmFactory: () => RhaiVM,
		localPlayerNumber: 1 | 2 = 1,
	) {
		this.hist[seedState.frame % this.hist.length] = structuredClone(seedState);
		this.latest = seedState.frame;
		this.vm1 = vmFactory(); // same script loaded into each
		this.vm2 = vmFactory();
		this.localPlayerNumber = localPlayerNumber;
	}

	// Load collision data from atlas JSON
	loadCollisionData(
		animConfigs: Record<
			string,
			{ hitboxes?: CollisionBox[]; hurtboxes?: CollisionBox[] }
		>,
	) {
		log.info("[Collision Data] Loading collision data");
		for (const [name, config] of Object.entries(animConfigs)) {
			const hash = hashStr(name);
			this.collisionData.set(hash, {
				hitboxes: config.hitboxes || [],
				hurtboxes: config.hurtboxes || [],
			});
			log.info("[Collision Data] Registered", {
				name,
				hash,
				hitboxCount: config.hitboxes?.length || 0,
				hurtboxCount: config.hurtboxes?.length || 0,
			});
		}
	}

	// Get collision boxes for current animation state
	getCollisionBoxes(state: State): {
		p1Hitboxes?: CollisionBox[];
		p1Hurtboxes?: CollisionBox[];
		p2Hitboxes?: CollisionBox[];
		p2Hurtboxes?: CollisionBox[];
	} {
		const p1Data = this.collisionData.get(state.p1.anim);
		const p2Data = this.collisionData.get(state.p2.anim);

		// Log every 60 frames (~1 second) to avoid spam
		if ((state.frame & 0x3f) === 0) {
			log.debug("[Collision Data] getCollisionBoxes", {
				frame: state.frame,
				p1Anim: state.p1.anim,
				p2Anim: state.p2.anim,
				p1Found: !!p1Data,
				p2Found: !!p2Data,
				p1HitboxCount: p1Data?.hitboxes?.length || 0,
				p1HurtboxCount: p1Data?.hurtboxes?.length || 0,
				p2HitboxCount: p2Data?.hitboxes?.length || 0,
				p2HurtboxCount: p2Data?.hurtboxes?.length || 0,
			});
		}

		return {
			p1Hitboxes: p1Data?.hitboxes,
			p1Hurtboxes: p1Data?.hurtboxes,
			p2Hitboxes: p2Data?.hitboxes,
			p2Hurtboxes: p2Data?.hurtboxes,
		};
	}

	setLocalInput(f: number, m: InputMask) {
		if (this.localPlayerNumber === 1) {
			this.in1[f & 0xffff] = m;
		} else {
			this.in2[f & 0xffff] = m;
		}
	}
	setRemoteInput(f: number, m: InputMask) {
		if (this.localPlayerNumber === 1) {
			this.in2[f & 0xffff] = m;
		} else {
			this.in1[f & 0xffff] = m;
		}
	}

	getLatest(): State {
		return structuredClone(this.hist[this.latest % this.hist.length]);
	}

	simulateTo(target: number): State {
		const s = structuredClone(this.hist[this.latest % this.hist.length]);
		while (s.frame < target) {
			const next = (s.frame + 1) & 0xffff;
			const i1 = this.in1[next] ?? 0;
			const i2 = this.in2[next] ?? this.in2[(next - 1) & 0xffff] ?? 0;
			step(s, i1, i2, this.vm1, this.vm2, this.collisionData);
			this.latest = s.frame;
			this.hist[s.frame % this.hist.length] = structuredClone(s);
		}
		return s;
	}

	rollbackFrom(frame: number) {
		const resume = (frame - 1) & 0xffff;
		const s = structuredClone(this.hist[resume % this.hist.length]);
		const tgt = this.latest;
		while (s.frame < tgt) {
			const next = (s.frame + 1) & 0xffff;
			const i1 = this.in1[next] ?? 0;
			const i2 = this.in2[next] ?? this.in2[(next - 1) & 0xffff] ?? 0;
			step(s, i1, i2, this.vm1, this.vm2, this.collisionData);
			this.hist[s.frame % this.hist.length] = structuredClone(s);
		}
	}
}

// Deterministic per-tick step.
// Rhai VM returns commands that we interpret deterministically.
function step(
	s: State,
	in1: InputMask,
	in2: InputMask,
	vm1: RhaiVM,
	vm2: RhaiVM,
	collisionData: Map<
		number,
		{ hitboxes: CollisionBox[]; hurtboxes: CollisionBox[] }
	>,
) {
	const walk = FP.from(0.25);

	// Determine facing direction for each player (for sprite/box mirroring only)
	const p1FacingLeft = s.p1.x > s.p2.x;
	const p2FacingLeft = s.p1.x < s.p2.x;

	// P1 from Rhai
	const nextFrame = s.frame + 1;
	const cmds1 = vm1.tick(nextFrame, in1);
	let vx1 = s.p1.vx;
	for (const c of cmds1) {
		if (c.t === "move") vx1 = c.dx > 0 ? walk : c.dx < 0 ? -walk : 0; // move(0) stops
		if (c.t === "anim") s.p1.anim = hashStr(c.name);
		if (c.t === "hitbox") s.p1.hitboxActive = c.active;
		if (c.t === "hurtbox") s.p1.hurtboxActive = c.active;
	}
	if (cmds1.length)
		log.debug("p1 cmds", { frame: nextFrame & 0xffff, cmds: cmds1 });
	s.p1.vx = vx1;
	s.p1.x = (s.p1.x + vx1) | 0;

	// P2 from Rhai
	const cmds2 = vm2.tick(nextFrame, in2);
	let vx2 = s.p2.vx;
	for (const c of cmds2) {
		if (c.t === "move") vx2 = c.dx > 0 ? walk : c.dx < 0 ? -walk : 0; // move(0) stops
		if (c.t === "anim") s.p2.anim = hashStr(c.name);
		if (c.t === "hitbox") s.p2.hitboxActive = c.active;
		if (c.t === "hurtbox") s.p2.hurtboxActive = c.active;
	}
	if (cmds2.length)
		log.debug("p2 cmds", { frame: nextFrame & 0xffff, cmds: cmds2 });
	s.p2.vx = vx2;
	s.p2.x = (s.p2.x + vx2) | 0;

	// Pushback: prevent characters from overlapping
	// Get collision data for both players
	const p1Data = collisionData.get(s.p1.anim);
	const p2Data = collisionData.get(s.p2.anim);

	if (p1Data && p2Data) {
		// Use first frame collision boxes (TODO: track animation frame index)
		const p1Hitbox = p1Data.hitboxes?.[0];
		const p1Hurtbox = p1Data.hurtboxes?.[0];
		const p2Hitbox = p2Data.hitboxes?.[0];
		const p2Hurtbox = p2Data.hurtboxes?.[0];

		// Convert fixed-point positions to pixel space (16 px per unit)
		const pxPerUnit = 16;
		const p1WorldX = (s.p1.x / (1 << 16)) * pxPerUnit;
		const p2WorldX = (s.p2.x / (1 << 16)) * pxPerUnit;

		// Combine all collision boxes for each player
		const boxes1: CollisionBox[] = [];
		const boxes2: CollisionBox[] = [];

		if (p1Hitbox) {
			boxes1.push({
				x: p1WorldX + (p1FacingLeft ? -p1Hitbox.x : p1Hitbox.x),
				y: p1Hitbox.y,
				width: p1Hitbox.width,
				height: p1Hitbox.height,
			});
		}
		if (p1Hurtbox) {
			boxes1.push({
				x: p1WorldX + (p1FacingLeft ? -p1Hurtbox.x : p1Hurtbox.x),
				y: p1Hurtbox.y,
				width: p1Hurtbox.width,
				height: p1Hurtbox.height,
			});
		}
		if (p2Hitbox) {
			boxes2.push({
				x: p2WorldX + (p2FacingLeft ? -p2Hitbox.x : p2Hitbox.x),
				y: p2Hitbox.y,
				width: p2Hitbox.width,
				height: p2Hitbox.height,
			});
		}
		if (p2Hurtbox) {
			boxes2.push({
				x: p2WorldX + (p2FacingLeft ? -p2Hurtbox.x : p2Hurtbox.x),
				y: p2Hurtbox.y,
				width: p2Hurtbox.width,
				height: p2Hurtbox.height,
			});
		}

		// Check for overlaps and calculate maximum pushback needed
		let maxOverlap = 0;
		for (const box1 of boxes1) {
			for (const box2 of boxes2) {
				const overlap = calculateOverlapX(box1, box2);
				maxOverlap = Math.max(maxOverlap, overlap);
			}
		}

		// Apply pushback if overlapping
		if (maxOverlap > 0) {
			// Split pushback equally between both players
			const pushbackPerPlayer = maxOverlap / 2;

			// Convert pixels back to fixed-point
			const pushbackFixed = FP.from(pushbackPerPlayer / pxPerUnit);

			// Push players apart based on their relative positions
			if (s.p1.x < s.p2.x) {
				// P1 is on the left, P2 is on the right
				s.p1.x = (s.p1.x - pushbackFixed) | 0;
				s.p2.x = (s.p2.x + pushbackFixed) | 0;
			} else {
				// P1 is on the right, P2 is on the left
				s.p1.x = (s.p1.x + pushbackFixed) | 0;
				s.p2.x = (s.p2.x - pushbackFixed) | 0;
			}

			log.debug("Pushback applied", {
				frame: nextFrame & 0xffff,
				overlap: maxOverlap,
				pushback: pushbackPerPlayer,
			});
		}
	}

	// Collision detection
	// Check if P1's hitbox collides with P2's hurtbox
	if (s.p1.hitboxActive && s.p2.hurtboxActive) {
		const p1Data = collisionData.get(s.p1.anim);
		const p2Data = collisionData.get(s.p2.anim);

		if (p1Data?.hitboxes && p2Data?.hurtboxes) {
			// TODO: Need to get current animation frame index
			// For now, use frame 0 as placeholder
			const p1Hitbox = p1Data.hitboxes[0];
			const p2Hurtbox = p2Data.hurtboxes[0];

			if (p1Hitbox && p2Hurtbox) {
				// Transform hitbox positions to world space
				// Convert fixed-point x to pixels (assuming 16 px per unit)
				const p1WorldX = (s.p1.x / (1 << 16)) * 16;
				const p2WorldX = (s.p2.x / (1 << 16)) * 16;

				const p1BoxWorld = {
					x: p1WorldX + (p1FacingLeft ? -p1Hitbox.x : p1Hitbox.x),
					y: p1Hitbox.y,
					width: p1Hitbox.width,
					height: p1Hitbox.height,
				};

				const p2BoxWorld = {
					x: p2WorldX + (p2FacingLeft ? -p2Hurtbox.x : p2Hurtbox.x),
					y: p2Hurtbox.y,
					width: p2Hurtbox.width,
					height: p2Hurtbox.height,
				};

				if (checkCollision(p1BoxWorld, p2BoxWorld)) {
					s.p2.hp = Math.max(0, s.p2.hp - 1);
					log.debug("Hit detected!", { frame: nextFrame & 0xffff });
				}
			}
		}
	}

	// Check if P2's hitbox collides with P1's hurtbox
	if (s.p2.hitboxActive && s.p1.hurtboxActive) {
		const p1Data = collisionData.get(s.p1.anim);
		const p2Data = collisionData.get(s.p2.anim);

		if (p1Data?.hurtboxes && p2Data?.hitboxes) {
			const p1Hurtbox = p1Data.hurtboxes[0];
			const p2Hitbox = p2Data.hitboxes[0];

			if (p1Hurtbox && p2Hitbox) {
				const p1WorldX = (s.p1.x / (1 << 16)) * 16;
				const p2WorldX = (s.p2.x / (1 << 16)) * 16;

				const p1BoxWorld = {
					x: p1WorldX + (p1FacingLeft ? -p1Hurtbox.x : p1Hurtbox.x),
					y: p1Hurtbox.y,
					width: p1Hurtbox.width,
					height: p1Hurtbox.height,
				};

				const p2BoxWorld = {
					x: p2WorldX + (p2FacingLeft ? -p2Hitbox.x : p2Hitbox.x),
					y: p2Hitbox.y,
					width: p2Hitbox.width,
					height: p2Hitbox.height,
				};

				if (checkCollision(p1BoxWorld, p2BoxWorld)) {
					s.p1.hp = Math.max(0, s.p1.hp - 1);
					log.debug("Hit detected!", { frame: nextFrame & 0xffff });
				}
			}
		}
	}

	s.frame = (s.frame + 1) & 0xffff;
}

export function hashStr(str: string) {
	let h = 0;
	for (let i = 0; i < str.length; i++) {
		h = ((h << 5) - h + str.charCodeAt(i)) | 0;
	}
	return h | 0;
}
