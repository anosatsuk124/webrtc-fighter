// WASM Rhai wrapper with input-aware tick.
import initWasm, * as wasm from "../wasm-rhai/pkg/wasm_rhai.js";
import { createLogger } from "./logger";

export type Cmd = { t: "move"; dx: number } | { t: "anim"; name: string };

interface WasmRhaiModule {
	load_script_source(src: string): boolean;
	tick_and_get_commands(frame: number, inputMask: number): string;
	take_last_error(): string;
}

export class RhaiVM {
	private ready = false;
	private log = createLogger("rhai");

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
		const ok = (wasm as unknown as WasmRhaiModule).load_script_source(src);
		if (!ok) {
			try {
				const err = (wasm as unknown as WasmRhaiModule).take_last_error();
				if (err) this.log.warn("compile error", { err });
			} catch {}
		}
		return ok;
	}

	tick(frame: number, inputMask: number): Cmd[] {
		const s = (wasm as unknown as WasmRhaiModule).tick_and_get_commands(
			frame >>> 0,
			inputMask >>> 0,
		);
		if (s === "[]") {
			const err = (wasm as unknown as WasmRhaiModule).take_last_error();
			if (err?.length) this.log.warn("tick error", { frame, err });
			else this.log.debug("tick no cmds", { frame, inputMask });
		}
		try {
			const cmds = JSON.parse(s) as Cmd[];
			if (cmds.length) this.log.debug("cmds", { frame, cmds });
			return cmds;
		} catch (e) {
			this.log.error("parse cmds failed", { frame, s, e: String(e) });
			return [];
		}
	}

	getLastError(): string {
		try {
			return (wasm as unknown as WasmRhaiModule).take_last_error();
		} catch {
			return "";
		}
	}
}
