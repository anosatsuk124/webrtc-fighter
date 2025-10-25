import { createLogger } from "./logger";

const log = createLogger("webrtc");

export type Channels = {
	pc: RTCPeerConnection;
	assets?: RTCDataChannel;
	live?: RTCDataChannel;
};

export function createPeer(): Channels {
	const stunUrl =
		import.meta.env.VITE_STUN_URL || "stun:stun.l.google.com:19302";
	const pc = new RTCPeerConnection({
		iceServers: [{ urls: stunUrl }],
	});
	log.info("RTCPeerConnection created", { stunUrl });
	return { pc };
}

export function createOffer(ch: Channels) {
	ch.assets = ch.pc.createDataChannel("assets", { ordered: true });
	ch.live = ch.pc.createDataChannel("live", {
		ordered: false,
		maxRetransmits: 0,
	});
	log.info("DataChannels created (offerer)", {
		assets: ch.assets.readyState,
		live: ch.live.readyState,
	});
	return ch.pc.createOffer();
}

export async function setLocal(ch: Channels, sdp: RTCSessionDescriptionInit) {
	await ch.pc.setLocalDescription(sdp);
	log.debug("setLocalDescription", { type: sdp.type });
}
export async function setRemote(ch: Channels, sdpText: string) {
	const sdp = JSON.parse(sdpText);
	await ch.pc.setRemoteDescription(sdp);
	log.debug("setRemoteDescription", { type: sdp.type });
}
export function onRemoteDataChannel(
	ch: Channels,
	cb: (dc: RTCDataChannel) => void,
) {
	ch.pc.ondatachannel = (e) => {
		log.info("ondatachannel", { label: e.channel.label });
		cb(e.channel);
	};
}
export async function createAnswer(
	ch: Channels,
): Promise<RTCSessionDescriptionInit> {
	const a = await ch.pc.createAnswer();
	log.info("createAnswer");
	return a;
}
