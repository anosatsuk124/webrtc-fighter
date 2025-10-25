// WASM Rhai wrapper with input-aware tick.
import initWasm, * as wasm from "../wasm-rhai/pkg/wasm_rhai.js";

export type Cmd = { t: "move"; dx: number } | { t: "anim"; name: string };

interface WasmRhaiModule {
	load_script_source(src: string): boolean;
	tick_and_get_commands(frame: number, inputMask: number): string;
}

export class RhaiVM {
	private ready = false;

	async initOnce() {
		if (this.ready) return;
		await initWasm();
		this.ready = true;
	}

	clone(): RhaiVM {
		const v = new RhaiVM();
		v.ready = this.ready;
		return v;
	}

	loadSource(src: string): boolean {
		if (!this.ready) throw new Error("WASM not ready");
		return (wasm as unknown as WasmRhaiModule).load_script_source(src);
	}

	tick(frame: number, inputMask: number): Cmd[] {
		const s = (wasm as unknown as WasmRhaiModule).tick_and_get_commands(
			frame >>> 0,
			inputMask >>> 0,
		);
		try {
			return JSON.parse(s) as Cmd[];
		} catch {
			return [];
		}
	}
}
