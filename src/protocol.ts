// Binary protocol for assets and live channels.
export const MSG = {
	Manifest: 0x01,
	NeedChunks: 0x02,
	Chunk: 0x03,
	ScriptPush: 0x20,
	ScriptAck: 0x21,
	Input: 0x10,
	StateHash: 0x11,
} as const;

export type Manifest = {
	id: string;
	type?: "mesh" | "sprite"; // defaults to "mesh" if not specified
	entry: string;
	chunks: { hash: string; size: number; mime: string }[];
	meta?: Record<string, string>; // e.g., { atlas: "sha256:..." } for sprites
};

export function encManifest(m: Manifest): ArrayBuffer {
	const u = new TextEncoder().encode(JSON.stringify(m));
	const buf = new ArrayBuffer(1 + u.length);
	new DataView(buf).setUint8(0, MSG.Manifest);
	new Uint8Array(buf, 1).set(u);
	return buf;
}
export function decManifest(buf: ArrayBuffer): Manifest {
	return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 1)));
}

export function encNeedChunks(hashes: string[]): ArrayBuffer {
	const enc = new TextEncoder();
	const parts = hashes.map((h) => {
		const uh = enc.encode(h);
		const a = new Uint8Array(1 + uh.length);
		a[0] = uh.length;
		a.set(uh, 1);
		return a;
	});
	const size = 1 + 2 + parts.reduce((s, a) => s + a.length, 0);
	const buf = new ArrayBuffer(size);
	const dv = new DataView(buf);
	dv.setUint8(0, MSG.NeedChunks);
	dv.setUint16(1, hashes.length, true);
	let off = 3;
	const out = new Uint8Array(buf);
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return buf;
}
export function decNeedChunks(buf: ArrayBuffer): string[] {
	const dv = new DataView(buf);
	const u = new Uint8Array(buf);
	let off = 3;
	const n = dv.getUint16(1, true);
	const dec = new TextDecoder();
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		const l = u[off++];
		out.push(dec.decode(u.subarray(off, off + l)));
		off += l;
	}
	return out;
}

export function encChunk(
	hash: string,
	offset: number,
	payload: Uint8Array,
): ArrayBuffer {
	const uh = new TextEncoder().encode(hash);
	const buf = new ArrayBuffer(1 + 1 + uh.length + 4 + payload.length);
	const dv = new DataView(buf);
	dv.setUint8(0, MSG.Chunk);
	dv.setUint8(1, uh.length);
	new Uint8Array(buf, 2, uh.length).set(uh);
	dv.setUint32(2 + uh.length, offset, true);
	new Uint8Array(buf, 6 + uh.length).set(payload);
	return buf;
}
export function decChunk(buf: ArrayBuffer) {
	const dv = new DataView(buf);
	const u = new Uint8Array(buf);
	const dec = new TextDecoder();
	const hl = dv.getUint8(1);
	const hash = dec.decode(u.subarray(2, 2 + hl));
	const off = dv.getUint32(2 + hl, true);
	const data = u.subarray(6 + hl);
	return { hash, offset: off, data };
}

export function encScriptPush(name: string, bytes: Uint8Array): ArrayBuffer {
	const un = new TextEncoder().encode(name);
	const buf = new ArrayBuffer(1 + 1 + un.length + 4 + bytes.length);
	const dv = new DataView(buf);
	dv.setUint8(0, MSG.ScriptPush);
	dv.setUint8(1, un.length);
	new Uint8Array(buf, 2, un.length).set(un);
	dv.setUint32(2 + un.length, bytes.length, true);
	new Uint8Array(buf, 6 + un.length).set(bytes);
	return buf;
}
export function decScriptPush(buf: ArrayBuffer) {
	const dv = new DataView(buf);
	const u = new Uint8Array(buf);
	const dec = new TextDecoder();
	const nl = dv.getUint8(1);
	const name = dec.decode(u.subarray(2, 2 + nl));
	const len = dv.getUint32(2 + nl, true);
	const bytes = u.subarray(6 + nl, 6 + nl + len);
	return { name, bytes };
}

// Live messages
export function encInput(
	frame: number,
	mask: number,
	ack: number,
): ArrayBuffer {
	const buf = new ArrayBuffer(1 + 2 + 2 + 2);
	const dv = new DataView(buf);
	dv.setUint8(0, MSG.Input);
	dv.setUint16(1, frame & 0xffff, true);
	dv.setUint16(3, mask & 0xffff, true);
	dv.setUint16(5, ack & 0xffff, true);
	return buf;
}
export function decInput(buf: ArrayBuffer) {
	const dv = new DataView(buf);
	return {
		frame: dv.getUint16(1, true),
		mask: dv.getUint16(3, true),
		ack: dv.getUint16(5, true),
	};
}

export function encStateHash(frame: number, h: number): ArrayBuffer {
	const buf = new ArrayBuffer(1 + 2 + 4);
	const dv = new DataView(buf);
	dv.setUint8(0, MSG.StateHash);
	dv.setUint16(1, frame & 0xffff, true);
	dv.setUint32(3, h >>> 0, true);
	return buf;
}
export function decStateHash(buf: ArrayBuffer) {
	const dv = new DataView(buf);
	return { frame: dv.getUint16(1, true), hash: dv.getUint32(3, true) };
}
