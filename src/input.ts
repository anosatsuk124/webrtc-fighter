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
		addEventListener("keydown", (e) => this.keys.add(e.code));
		addEventListener("keyup", (e) => this.keys.delete(e.code));
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
