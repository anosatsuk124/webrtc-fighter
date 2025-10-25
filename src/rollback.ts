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

export interface Fighter {
	x: number; // fixed-point
	vx: number; // fixed-point per tick
	hp: number; // int
	anim: number; // hash of anim name
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

	constructor(seedState: State, vmFactory: () => RhaiVM) {
		this.hist[seedState.frame % this.hist.length] = structuredClone(seedState);
		this.latest = seedState.frame;
		this.vm1 = vmFactory(); // same script loaded into each
		this.vm2 = vmFactory();
	}

	setLocalInput(f: number, m: InputMask) {
		this.in1[f & 0xffff] = m;
	}
	setRemoteInput(f: number, m: InputMask) {
		this.in2[f & 0xffff] = m;
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
			step(s, i1, i2, this.vm1, this.vm2);
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
			step(s, i1, i2, this.vm1, this.vm2);
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
) {
	const walk = FP.from(2.5);

	// P1 from Rhai
	const nextFrame = s.frame + 1;
	const cmds1 = vm1.tick(nextFrame, in1);
	let vx1 = s.p1.vx;
	for (const c of cmds1) {
		if (c.t === "move") vx1 = c.dx > 0 ? walk : c.dx < 0 ? -walk : 0; // move(0) stops
		if (c.t === "anim") s.p1.anim = hashStr(c.name);
	}
	if (cmds1.length === 0) {
		// Fallback: if script returned nothing, derive movement directly from inputs
		const LEFT = 1 << 2;
		const RIGHT = 1 << 3;
		if (in1 & LEFT) vx1 = -walk;
		else if (in1 & RIGHT) vx1 = walk;
		else vx1 = 0; // no input → move(0)
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
	}
	if (cmds2.length === 0) {
		const LEFT = 1 << 2;
		const RIGHT = 1 << 3;
		if (in2 & LEFT) vx2 = -walk;
		else if (in2 & RIGHT) vx2 = walk;
		else vx2 = 0; // no input → move(0)
	}
	if (cmds2.length)
		log.debug("p2 cmds", { frame: nextFrame & 0xffff, cmds: cmds2 });
	s.p2.vx = vx2;
	s.p2.x = (s.p2.x + vx2) | 0;

	s.frame = (s.frame + 1) & 0xffff;
}

function hashStr(str: string) {
	let h = 0;
	for (let i = 0; i < str.length; i++) {
		h = ((h << 5) - h + str.charCodeAt(i)) | 0;
	}
	return h | 0;
}
