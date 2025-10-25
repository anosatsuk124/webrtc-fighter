// Input mapping and constants.
export enum Btn {
	Up = 1 << 0,
	Down = 1 << 1,
	Left = 1 << 2,
	Right = 1 << 3,
	LP = 1 << 4,
	HP = 1 << 5,
	LK = 1 << 6,
	HK = 1 << 7,
	Start = 1 << 8,
}
export type InputMask = number;

export class KeyboardInput {
	private keys = new Set<string>();
	constructor() {
		const norm = (e: KeyboardEvent): string => {
			// Prefer code; fallback to key→code mapping for letters/Enter/Space
			if (e.code?.length) return e.code;
			const k = e.key || "";
			if (k.length === 1) {
				const u = k.toUpperCase();
				if (u >= "A" && u <= "Z") return `Key${u}`;
			}
			if (k === "Enter") return "Enter";
			if (k === " " || k === "Spacebar") return "Space";
			return k;
		};

		addEventListener("keydown", (e) => {
			const c = norm(e);
			// Prevent page scroll on arrows only; allow typing in textarea for letters
			if (c.startsWith("Arrow")) e.preventDefault();
			this.keys.add(c);
		});
		addEventListener("keyup", (e) => {
			this.keys.delete(norm(e));
		});
		addEventListener("blur", () => this.keys.clear());
		document.addEventListener("visibilitychange", () => {
			if (document.hidden) this.keys.clear();
		});
	}
	snapshot(): InputMask {
		let m = 0;
		if (this.keys.has("ArrowUp")) m |= Btn.Up;
		if (this.keys.has("ArrowDown")) m |= Btn.Down;
		if (this.keys.has("ArrowLeft")) m |= Btn.Left;
		if (this.keys.has("ArrowRight")) m |= Btn.Right;
		if (this.keys.has("KeyA")) m |= Btn.LP;
		if (this.keys.has("KeyS")) m |= Btn.HP;
		if (this.keys.has("KeyZ")) m |= Btn.LK;
		if (this.keys.has("KeyX")) m |= Btn.HK;
		if (this.keys.has("Enter")) m |= Btn.Start;
		return m;
	}
}
