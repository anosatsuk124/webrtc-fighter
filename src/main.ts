import { CAS } from "./cas";
import { type InputMask, KeyboardInput } from "./input";
import {
	decChunk,
	decInput,
	decManifest,
	decNeedChunks,
	decScriptPush,
	encChunk,
	encInput,
	encManifest,
	encNeedChunks,
	encScriptPush,
	encStateHash,
	type Manifest,
	MSG,
} from "./protocol";
import { hashState, Rollback, type State } from "./rollback";
import { ViewerBJS } from "./viewer_babylon";
import { RhaiVM } from "./vm_rhai";
import {
	createAnswer,
	createOffer,
	createPeer,
	onRemoteDataChannel,
	setLocal,
	setRemote,
} from "./webrtc";

// Helper to safely query elements with type checking
function getElement<T extends Element>(
	selector: string,
	type?: new (...args: unknown[]) => T,
): T {
	const el = document.querySelector<T>(selector);
	if (!el) throw new Error(`Element not found: ${selector}`);
	if (type && !(el instanceof type))
		throw new Error(`Element ${selector} is not of expected type`);
	return el;
}

const statusEl = getElement("#status");
const localSdp = getElement<HTMLTextAreaElement>("#localSdp");
const remoteSdp = getElement<HTMLTextAreaElement>("#remoteSdp");
const btnOffer = getElement<HTMLButtonElement>("#btnOffer");
const btnAnswer = getElement<HTMLButtonElement>("#btnAnswer");
const btnSetRemote = getElement<HTMLButtonElement>("#btnSetRemote");
const fileGlb = getElement<HTMLInputElement>("#fileGlb");
const filePng = getElement<HTMLInputElement>("#filePng");
const fileAtlas = getElement<HTMLInputElement>("#fileAtlas");
const btnSendAsset = getElement<HTMLButtonElement>("#btnSendAsset");
const btnRunLocal = getElement<HTMLButtonElement>("#btnRunLocal");
const btnSendScript = getElement<HTMLButtonElement>("#btnSendScript");
const txtRhai = getElement<HTMLTextAreaElement>("#rhaiSrc");
const canvas = getElement<HTMLCanvasElement>("#view");

const cas = new CAS();
const viewer = new ViewerBJS(canvas);
const keys = new KeyboardInput();
const vmGlobal = new RhaiVM();
await vmGlobal.initOnce();

let vmSrc = txtRhai.value;
vmGlobal.loadSource(vmSrc);

let assetsDC: RTCDataChannel | undefined;
let liveDC: RTCDataChannel | undefined;

const ch = createPeer();
onRemoteDataChannel(ch, (dc) => {
	if (dc.label === "assets") {
		assetsDC = dc;
		mountAssetsDC(dc);
	}
	if (dc.label === "live") {
		liveDC = dc;
		mountLiveDC(dc);
	}
});

btnOffer.onclick = async () => {
	const offer = await createOffer(ch);
	await setLocal(ch, offer);
	ch.pc.onicecandidate = () => {
		if (ch.pc.localDescription)
			localSdp.value = JSON.stringify(ch.pc.localDescription);
	};
	localSdp.value = JSON.stringify(ch.pc.localDescription);
};
btnAnswer.onclick = async () => {
	ch.pc.ondatachannel = (e) => {
		if (e.channel.label === "assets") {
			assetsDC = e.channel;
			mountAssetsDC(e.channel);
		}
		if (e.channel.label === "live") {
			liveDC = e.channel;
			mountLiveDC(e.channel);
		}
	};
	await ch.pc.setRemoteDescription(JSON.parse(remoteSdp.value));
	const answer = await createAnswer(ch);
	await setLocal(ch, answer);
	ch.pc.onicecandidate = () => {
		if (ch.pc.localDescription)
			localSdp.value = JSON.stringify(ch.pc.localDescription);
	};
	localSdp.value = JSON.stringify(ch.pc.localDescription);
};
btnSetRemote.onclick = async () => {
	await setRemote(ch, remoteSdp.value);
};

function status(s: string) {
	statusEl.textContent = s;
}

// Asset channel handlers
let lastManifest: Manifest | null = null;

function mountAssetsDC(dc: RTCDataChannel) {
	status("assets open");
	dc.binaryType = "arraybuffer";
	dc.onmessage = async (ev) => {
		const type = new Uint8Array(ev.data)[0];
		if (type === MSG.Manifest) {
			const m = decManifest(ev.data);
			const need = m.chunks.filter((c) => !cas.has(c.hash)).map((c) => c.hash);
			if (need.length) dc.send(encNeedChunks(need));
			else {
				lastManifest = m;
				await tryAssembleAndLoad(m);
			}
		} else if (type === MSG.NeedChunks) {
			const hashes = decNeedChunks(ev.data);
			await streamChunks(hashes, dc);
		} else if (type === MSG.Chunk) {
			const { hash, data } = decChunk(ev.data);
			cas.put(hash, data);
			status(`chunk ${hash.slice(0, 18)}...`);
			if (lastManifest) await tryAssembleAndLoad(lastManifest);
		} else if (type === MSG.ScriptPush) {
			const { name, bytes } = decScriptPush(ev.data);
			const src = new TextDecoder().decode(bytes);
			vmSrc = src;
			vmGlobal.loadSource(vmSrc);
			// Reset gameplay VMs next tick by creating new Rollback
			resetRollbackWithScript();
			status(`script applied: ${name}`);
		}
	};
}

async function tryAssembleAndLoad(m: Manifest) {
	lastManifest = m;
	const type = m.type || "mesh";

	if (type === "sprite") {
		// Sprite: check PNG + Atlas JSON
		const pngChunk = m.chunks.find((c) => c.mime === "image/png");
		const atlasHash = m.meta?.atlas;
		if (!pngChunk || !atlasHash) return;
		if (!cas.has(pngChunk.hash) || !cas.has(atlasHash)) return;
		await viewer.loadFromManifest(m, cas);
		status("sprite loaded");
	} else {
		// Mesh: check entry chunk
		const entry = m.chunks[0];
		if (!cas.has(entry.hash)) return;
		await viewer.loadFromManifest(m, cas);
		status("mesh loaded");
	}
}

async function streamChunks(hashes: string[], dc: RTCDataChannel) {
	for (const h of hashes) {
		const data = cas.get(h);
		if (!data) continue;
		dc.send(encChunk(h, 0, data));
		await waitDrain(dc);
	}
}
function waitDrain(dc: RTCDataChannel) {
	return new Promise<void>((res) => {
		if (dc.bufferedAmount < 1 << 20) return res();
		dc.bufferedAmountLowThreshold = 1 << 20;
		const h = () => {
			if (dc.bufferedAmount < 1 << 20) {
				dc.removeEventListener("bufferedamountlow", h);
				res();
			}
		};
		dc.addEventListener("bufferedamountlow", h);
	});
}

// Helper to get selected asset mode
function getAssetMode(): "3d" | "2d" {
	const radio = document.querySelector<HTMLInputElement>(
		'input[name="assetMode"]:checked',
	);
	return (radio?.value as "3d" | "2d") || "3d";
}

// Send Asset button (handles both 3D and 2D)
btnSendAsset.onclick = async () => {
	if (!assetsDC || assetsDC.readyState !== "open") return;

	const mode = getAssetMode();

	if (mode === "3d") {
		// Send 3D GLB
		const f = fileGlb.files?.[0];
		if (!f) return;
		const ab = await f.arrayBuffer();
		const hash = await cas.hashOf(ab);
		cas.put(hash, new Uint8Array(ab));
		const m: Manifest = {
			id: `char:${f.name}`,
			type: "mesh",
			entry: f.name,
			chunks: [
				{ hash, size: ab.byteLength, mime: f.type || "model/gltf-binary" },
			],
		};
		assetsDC.send(encManifest(m));
		lastManifest = m;
		status("3D manifest sent");
	} else {
		// Send 2D Sprite (PNG + Atlas JSON)
		const pngFile = filePng.files?.[0];
		const atlasFile = fileAtlas.files?.[0];
		if (!pngFile || !atlasFile) {
			status("Please select both PNG and Atlas files");
			return;
		}

		const pngAb = await pngFile.arrayBuffer();
		const atlasAb = await atlasFile.arrayBuffer();

		const pngHash = await cas.hashOf(pngAb);
		const atlasHash = await cas.hashOf(atlasAb);

		cas.put(pngHash, new Uint8Array(pngAb));
		cas.put(atlasHash, new Uint8Array(atlasAb));

		const m: Manifest = {
			id: `char:sprite:${pngFile.name}`,
			type: "sprite",
			entry: pngFile.name,
			chunks: [
				{ hash: pngHash, size: pngAb.byteLength, mime: "image/png" },
				{
					hash: atlasHash,
					size: atlasAb.byteLength,
					mime: "application/json",
				},
			],
			meta: { atlas: atlasHash },
		};
		assetsDC.send(encManifest(m));
		lastManifest = m;
		status("2D sprite manifest sent");
	}
};

// Script buttons
btnRunLocal.onclick = () => {
	vmSrc = txtRhai.value;
	vmGlobal.loadSource(vmSrc);
	resetRollbackWithScript();
	status("script loaded (local)");
};
btnSendScript.onclick = () => {
	if (!assetsDC || assetsDC.readyState !== "open") return;
	const u = new TextEncoder().encode(txtRhai.value);
	assetsDC.send(encScriptPush("logic.rhai", u));
	status("script sent");
};

// Live channel + rollback
let rb = makeRollback();

function makeRollback(): Rollback {
	const seed: State = {
		frame: 0,
		p1: { x: 100 << 16, vx: 0, hp: 100, anim: 0 },
		p2: { x: 220 << 16, vx: 0, hp: 100, anim: 0 },
	};
	// VM factory: independent instances with same script
	const vmFactory = () => {
		const v = new RhaiVM();
		v.ready = true;
		v.loadSource(vmSrc);
		return v;
	};
	return new Rollback(seed, vmFactory);
}
function resetRollbackWithScript() {
	rb = makeRollback();
}

let _lastRemoteAck = 0;
let _lastSentLocalFrame = 0;
function mountLiveDC(dc: RTCDataChannel) {
	status("live open");
	dc.binaryType = "arraybuffer";
	dc.onmessage = (ev) => {
		const u8 = new Uint8Array(ev.data);
		const t = u8[0];
		if (t === MSG.Input) {
			const { frame, mask, ack } = decInput(ev.data);
			rb.setRemoteInput(frame, mask);
			if (frame <= rb.getLatest().frame) rb.rollbackFrom(frame);
			_lastRemoteAck = ack;
		} else if (t === MSG.StateHash) {
			// Desync handling could be added here
		}
	};
}

// Game loop: fixed 60Hz by accumulation
const TICK = 1 / 60;
let acc = 0;
let last = performance.now();
function loop(now: number) {
	acc += (now - last) / 1000;
	last = now;
	while (acc >= TICK) {
		const next = (rb.getLatest().frame + 1) & 0xffff;
		const local = keys.snapshot();
		rb.setLocalInput(next, local);
		sendInput(next, local);
		const s = rb.simulateTo(next);
		// Apply to viewer with animation hashes
		viewer.applyState(s.p1.x, s.p2.x, s.p1.anim, s.p2.anim);
		if ((s.frame & 0xf) === 0 && liveDC?.readyState === "open") {
			const h = hashState(s);
			liveDC.send(encStateHash(s.frame, h));
		}
		acc -= TICK;
	}
	requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function sendInput(frame: number, mask: InputMask) {
	if (!liveDC || liveDC.readyState !== "open") return;
	const ack = rb.getLatest().frame & 0xffff;
	_lastSentLocalFrame = frame;
	liveDC.send(encInput(frame, mask, ack));
}

// Expose connection states
ch.pc.oniceconnectionstatechange = () =>
	status(`ice: ${ch.pc.iceConnectionState}`);
ch.pc.onconnectionstatechange = () => status(`pc: ${ch.pc.connectionState}`);
