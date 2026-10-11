// Browser side of raubot voice: OpenAI Realtime over WebRTC with an ephemeral key minted by /voice/session.
// Function calls (ask_raubot, raubot_wait, raubot_status) go to raubot's /voice/* routes; their messages never leave the app.

export type Line = { who: "you" | "voice" | "raubot" | "sys"; text: string; id?: string };
export type State = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export type Hooks = { state(s: State): void; line(l: Line): void; partial(who: "you" | "voice", id: string, text: string): void };

const post = async (path: string, body: unknown = {}) => {
	const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
	return r.json();
};

/** Runs one voice tool call against raubot; returns the JSON string the model gets. */
export const runTool = async (name: string, args: Record<string, unknown>, hooks: Pick<Hooks, "line">) => {
	try {
		if (name === "ask_raubot") {
			hooks.line({ who: "sys", text: "→ raubot: " + String(args.message ?? "") });
			const r = await post("/voice/ask", { message: args.message });
			if (r.status === "done") hooks.line({ who: "raubot", text: r.reply });
			return JSON.stringify(r);
		}
		if (name === "raubot_wait") {
			const r = await post("/voice/wait", { id: args.id });
			if (r.status === "done") hooks.line({ who: "raubot", text: r.reply });
			return JSON.stringify(r);
		}
		if (name === "raubot_status") {
			const r = await fetch("/voice/status").then((x) => x.json());
			return JSON.stringify(r);
		}
		return JSON.stringify({ error: "unknown tool " + name });
	} catch (e) {
		return JSON.stringify({ error: String(e) });
	}
};

export class Session {
	pc?: RTCPeerConnection;
	dc?: RTCDataChannel;
	mic?: MediaStream;
	audio: HTMLAudioElement;
	ctx?: AudioContext;
	inLevel?: AnalyserNode;
	outLevel?: AnalyserNode;
	#state: State = "idle";

	constructor(private hooks: Hooks, audio: HTMLAudioElement) { this.audio = audio; }

	set(s: State) { this.#state = s; this.hooks.state(s); }
	get state() { return this.#state; }

	/** Must be called from a tap (iOS needs a gesture for the mic, audio and AudioContext). */
	async start(track?: MediaStreamTrack) {
		this.set("connecting");
		const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		this.ctx = new Ctx();
		await this.ctx.resume();
		this.audio.muted = false;
		void this.audio.play().catch(() => {});
		try {
			this.mic = track ? new MediaStream([track]) : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
			this.inLevel = this.ctx.createAnalyser(); this.inLevel.fftSize = 256;
			this.ctx.createMediaStreamSource(this.mic).connect(this.inLevel);
			const { key, model } = await post("/voice/session");
			const pc = (this.pc = new RTCPeerConnection());
			pc.ontrack = (e) => {
				this.audio.srcObject = e.streams[0];
				void this.audio.play().catch(() => {});
				this.outLevel = this.ctx!.createAnalyser(); this.outLevel.fftSize = 256;
				this.ctx!.createMediaStreamSource(e.streams[0]).connect(this.outLevel);
			};
			pc.onconnectionstatechange = () => { if (pc.connectionState === "failed" || pc.connectionState === "disconnected") { this.hooks.line({ who: "sys", text: "connection " + pc.connectionState }); this.stop(); } };
			for (const t of this.mic.getAudioTracks()) pc.addTrack(t, this.mic);
			const dc = (this.dc = pc.createDataChannel("oai-events"));
			dc.onmessage = (e) => this.#event(JSON.parse(e.data));
			dc.onopen = () => this.set("listening");
			await pc.setLocalDescription(await pc.createOffer());
			const r = await fetch("https://api.openai.com/v1/realtime/calls?model=" + encodeURIComponent(model), {
				method: "POST", body: pc.localDescription!.sdp, headers: { authorization: "Bearer " + key, "content-type": "application/sdp" },
			});
			if (!r.ok) throw new Error("realtime " + r.status + ": " + (await r.text()).slice(0, 200));
			await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
		} catch (e) {
			this.hooks.line({ who: "sys", text: String(e) });
			this.stop();
			this.set("error");
			throw e;
		}
	}

	send(ev: object) { if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(ev)); }

	/** Type instead of talk (also how the headless test drives a turn). */
	say(text: string) {
		this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
		this.send({ type: "response.create" });
		this.hooks.line({ who: "you", text });
	}

	/** Barge in by hand: stop the voice talking. */
	interrupt() { this.send({ type: "response.cancel" }); this.send({ type: "output_audio_buffer.clear" }); }

	stop() {
		this.dc?.close(); this.pc?.close();
		for (const t of this.mic?.getTracks() ?? []) t.stop();
		void this.ctx?.close().catch(() => {});
		this.pc = this.dc = this.mic = this.ctx = this.inLevel = this.outLevel = undefined;
		if (this.#state !== "error") this.set("idle");
	}

	level(which: "in" | "out") {
		const a = which === "in" ? this.inLevel : this.outLevel;
		if (!a) return 0;
		const b = new Uint8Array(a.fftSize);
		a.getByteTimeDomainData(b);
		let s = 0;
		for (const v of b) s += ((v - 128) / 128) ** 2;
		return Math.min(1, Math.sqrt(s / b.length) * 4);
	}

	#tools = 0;
	async #event(e: { type: string; [k: string]: any }) {
		const h = this.hooks;
		switch (e.type) {
			case "input_audio_buffer.speech_started": this.set("listening"); break;
			case "conversation.item.input_audio_transcription.delta": h.partial("you", e.item_id, e.delta ?? ""); break;
			case "conversation.item.input_audio_transcription.completed": h.line({ who: "you", text: (e.transcript ?? "").trim(), id: e.item_id }); break;
			case "response.output_audio_transcript.delta": case "response.audio_transcript.delta": h.partial("voice", e.item_id, e.delta ?? ""); break;
			case "response.output_audio_transcript.done": case "response.audio_transcript.done": h.line({ who: "voice", text: e.transcript ?? "", id: e.item_id }); break;
			case "output_audio_buffer.started": this.set("speaking"); break;
			case "output_audio_buffer.stopped": case "output_audio_buffer.cleared": if (!this.#tools) this.set("listening"); break;
			case "response.function_call_arguments.done": {
				this.#tools++; this.set("thinking");
				let args = {};
				try { args = JSON.parse(e.arguments || "{}"); } catch {}
				const out = await runTool(e.name, args, h);
				this.#tools--;
				this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output: out } });
				this.send({ type: "response.create" });
				break;
			}
			case "error": h.line({ who: "sys", text: "error: " + (e.error?.message ?? JSON.stringify(e)) }); break;
		}
	}
}
