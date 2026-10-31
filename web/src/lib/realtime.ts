// Browser side of raubot voice: OpenAI Realtime (gpt-realtime-2) over WebRTC with an ephemeral key minted by /voice/session.
// Function calls (ask_raubot, raubot_wait, raubot_status) go to raubot's /voice/* routes; their messages never leave the app.
//
// Full duplex rules (Raunak uses this in his car over Bluetooth on iPhone Safari):
// - Exactly ONE getUserMedia per session. The mic track is never stopped, muted, disabled or replaced until he taps end
//   (the only exception: iOS itself ends the track, e.g. a phone call; then we re-acquire once and replaceTrack, logged).
// - The audio session is pinned to "play-and-record" before anything touches audio, so iOS doesn't flip the
//   Bluetooth route between A2DP (playback) and HFP (call) as playback starts and stops.
// - One <audio> element and one AudioContext for the whole session; never paused, muted or re-created per response.
// - A brief "disconnected" (tunnel, cell handoff) does not tear the session down; only "failed" or 15s disconnected does.
// - At most one response.create per model response: tool outputs from one response are batched into a single continue.

export type Line = { who: "you" | "voice" | "raubot" | "sys"; text: string; id?: string };
export type State = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";
export type Hooks = { state(s: State): void; line(l: Line): void; partial(who: "you" | "voice", id: string, text: string): void; debug?(d: Debug): void };
export type Debug = { model: string; getUserMedia: number; tracks: number; trackState: string; route: string; audioSession: string; events: string[] };

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
		if (name === "raubot_status") return JSON.stringify(await fetch("/voice/status").then((x) => x.json()));
		return JSON.stringify({ error: "unknown tool " + name });
	} catch (e) {
		return JSON.stringify({ error: String(e) });
	}
};

/** Tracks which responses still owe tool outputs, so each response gets at most one follow-up response.create. */
export class Calls {
	#pending = new Map<string, Set<string>>(); // response id -> call ids still running
	#done = new Set<string>(); // responses whose response.done arrived
	#seen = new Set<string>(); // call ids already started (dedupe repeated events)
	/** A call to run, or false if this call id was already started. */
	start(response: string, call: string) {
		if (this.#seen.has(call)) return false;
		this.#seen.add(call);
		(this.#pending.get(response) ?? this.#pending.set(response, new Set()).get(response)!).add(call);
		return true;
	}
	/** Call finished: true when the caller should now send the ONE response.create for this response. */
	finish(response: string, call: string) {
		const s = this.#pending.get(response);
		s?.delete(call);
		return this.#ready(response);
	}
	/** response.done for response: true when its tool outputs are all in and the continue is due. */
	responseDone(response: string) { this.#done.add(response); return this.#ready(response); }
	#ready(response: string) {
		const s = this.#pending.get(response);
		if (!s || s.size || !this.#done.has(response)) return false;
		this.#pending.delete(response);
		return true;
	}
	get running() { let n = 0; for (const s of this.#pending.values()) n += s.size; return n; }
}

type AudioSessionNav = Navigator & { audioSession?: { type: string; state?: string; onstatechange?: (() => void) | null } };

export class Session {
	pc?: RTCPeerConnection;
	dc?: RTCDataChannel;
	mic?: MediaStream;
	track?: MediaStreamTrack;
	sender?: RTCRtpSender;
	audio: HTMLAudioElement;
	ctx?: AudioContext;
	inLevel?: AnalyserNode;
	outLevel?: AnalyserNode;
	model = "";
	#state: State = "idle";
	#ending = false;
	#dropTimer?: ReturnType<typeof setTimeout>;
	#calls = new Calls();
	#speaking = false;
	#dbg: Debug = { model: "", getUserMedia: 0, tracks: 0, trackState: "-", route: "-", audioSession: "-", events: [] };
	#cleanup: (() => void)[] = [];

	constructor(private hooks: Hooks, audio: HTMLAudioElement) { this.audio = audio; }

	set(s: State) { if (this.#state !== s) { this.#state = s; this.hooks.state(s); } }
	get state() { return this.#state; }

	log(ev: string) {
		const t = new Date().toLocaleTimeString([], { hour12: false });
		this.#dbg.events = [...this.#dbg.events.slice(-59), `${t} ${ev}`];
		this.#emit();
	}
	#emit() { this.hooks.debug?.({ ...this.#dbg, trackState: this.track ? `${this.track.readyState}${this.track.muted ? " (muted by OS)" : ""}${this.track.enabled ? "" : " disabled"}` : "-" }); }

	#getUserMedia() {
		this.#dbg.getUserMedia++;
		this.log(`getUserMedia #${this.#dbg.getUserMedia}`);
		// Echo cancellation stays on: it's what lets the mic stay open while the car speakers play the voice.
		return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
	}

	#watchTrack(t: MediaStreamTrack) {
		this.track = t;
		this.#dbg.tracks++;
		this.#dbg.route = t.label || "default mic";
		this.log(`mic track open: ${this.#dbg.route}`);
		t.onmute = () => this.log("mic track MUTED by OS");
		t.onunmute = () => this.log("mic track unmuted by OS");
		t.onended = () => { this.log("mic track ENDED by OS"); if (!this.#ending) void this.#reacquire(); };
	}

	/** Only when iOS ends our track (phone call, Siri): get one new track and swap it into the same sender, no renegotiation. */
	async #reacquire() {
		try {
			const s = await this.#getUserMedia();
			const t = s.getAudioTracks()[0];
			await this.sender?.replaceTrack(t);
			this.mic = s;
			this.#watchTrack(t);
			if (this.ctx && this.inLevel) this.ctx.createMediaStreamSource(s).connect(this.inLevel);
		} catch (e) { this.log("re-acquire failed: " + String(e)); }
	}

	/** Must be called from a tap (iOS needs a gesture for the mic, audio and AudioContext). */
	async start(track?: MediaStreamTrack) {
		this.#ending = false;
		this.set("connecting");
		// 1) Pin the iOS audio session to call mode before any audio API runs: no A2DP<->HFP flapping on Bluetooth.
		const nav = navigator as AudioSessionNav;
		if (nav.audioSession) {
			try { nav.audioSession.type = "play-and-record"; } catch {}
			this.#dbg.audioSession = nav.audioSession.type;
			nav.audioSession.onstatechange = () => this.log("audio session " + (nav.audioSession?.state ?? "?"));
			this.log("audioSession.type = " + nav.audioSession.type);
		} else this.log("navigator.audioSession unsupported (not Safari 17+)");
		const onDevice = () => this.log("audio devices changed (route change)");
		navigator.mediaDevices.addEventListener?.("devicechange", onDevice);
		const onVis = () => { this.log("page " + document.visibilityState); if (document.visibilityState === "visible") void this.ctx?.resume(); };
		document.addEventListener("visibilitychange", onVis);
		this.#cleanup.push(() => navigator.mediaDevices.removeEventListener?.("devicechange", onDevice), () => document.removeEventListener("visibilitychange", onVis));
		// Unlock playback on the one persistent element inside the tap.
		this.audio.muted = false;
		void this.audio.play().catch(() => {});
		try {
			// 2) The one mic for this session.
			this.mic = track ? new MediaStream([track]) : await this.#getUserMedia();
			this.#watchTrack(this.mic.getAudioTracks()[0]);
			// 3) One AudioContext (after the mic, so it opens in the record-capable session) for the level meters only.
			const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			this.ctx = new Ctx();
			await this.ctx.resume();
			const ctx = this.ctx;
			ctx.onstatechange = () => { this.log("AudioContext " + ctx.state); if (!this.#ending && (ctx.state === "suspended" || (ctx.state as string) === "interrupted")) void ctx.resume().catch(() => {}); };
			this.inLevel = this.ctx.createAnalyser(); this.inLevel.fftSize = 256;
			this.ctx.createMediaStreamSource(this.mic).connect(this.inLevel);
			const { key, model } = await post("/voice/session");
			this.model = this.#dbg.model = model;
			this.log("model " + model);
			const pc = (this.pc = new RTCPeerConnection());
			pc.ontrack = (e) => {
				// Set once; the same stream carries every response, so the element is never re-pointed.
				if (this.audio.srcObject !== e.streams[0]) { this.audio.srcObject = e.streams[0]; this.log("speaker stream attached"); }
				void this.audio.play().catch(() => {});
				this.outLevel = this.ctx!.createAnalyser(); this.outLevel.fftSize = 256;
				this.ctx!.createMediaStreamSource(e.streams[0]).connect(this.outLevel);
			};
			pc.onconnectionstatechange = () => {
				const s = pc.connectionState;
				this.log("connection " + s);
				clearTimeout(this.#dropTimer);
				if (s === "failed") { this.hooks.line({ who: "sys", text: "connection failed" }); this.stop(); }
				else if (s === "disconnected") this.#dropTimer = setTimeout(() => { if (pc.connectionState !== "connected") { this.hooks.line({ who: "sys", text: "connection lost" }); this.stop(); } }, 15_000);
			};
			this.sender = pc.addTrack(this.track!, this.mic);
			const dc = (this.dc = pc.createDataChannel("oai-events"));
			dc.onmessage = (e) => this.#event(JSON.parse(e.data));
			dc.onopen = () => { this.log("events open"); this.set("listening"); };
			await pc.setLocalDescription(await pc.createOffer());
			const r = await fetch("https://api.openai.com/v1/realtime/calls?model=" + encodeURIComponent(model), {
				method: "POST", body: pc.localDescription!.sdp, headers: { authorization: "Bearer " + key, "content-type": "application/sdp" },
			});
			if (!r.ok) throw new Error("realtime " + r.status + ": " + (await r.text()).slice(0, 200));
			await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
		} catch (e) {
			this.hooks.line({ who: "sys", text: String(e) });
			this.log("start failed: " + String(e));
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

	/** Barge in by hand: stop the voice talking. The mic is untouched. */
	interrupt() { this.send({ type: "response.cancel" }); this.send({ type: "output_audio_buffer.clear" }); }

	/** The only place the mic is stopped: when he taps end (or the connection is truly gone). */
	stop() {
		this.#ending = true;
		clearTimeout(this.#dropTimer);
		for (const f of this.#cleanup.splice(0)) f();
		this.dc?.close(); this.pc?.close();
		for (const t of this.mic?.getTracks() ?? []) t.stop();
		if (this.track) this.log("session ended: mic released");
		void this.ctx?.close().catch(() => {});
		const nav = navigator as AudioSessionNav;
		if (nav.audioSession) try { nav.audioSession.type = "auto"; } catch {}
		this.pc = this.dc = this.mic = this.track = this.sender = this.ctx = this.inLevel = this.outLevel = undefined;
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

	#idle() { if (!this.#speaking) this.set(this.#calls.running ? "thinking" : "listening"); }

	async #event(e: { type: string; [k: string]: any }) {
		const h = this.hooks;
		switch (e.type) {
			case "session.created": this.log("session created (" + (e.session?.model ?? this.model) + ")"); break;
			case "input_audio_buffer.speech_started": if (!this.#speaking) this.set("listening"); break;
			case "conversation.item.input_audio_transcription.delta": h.partial("you", e.item_id, e.delta ?? ""); break;
			case "conversation.item.input_audio_transcription.completed": h.line({ who: "you", text: (e.transcript ?? "").trim(), id: e.item_id }); break;
			// GA name only (the beta alias would show the same text twice if both arrived).
			case "response.output_audio_transcript.delta": h.partial("voice", e.item_id, e.delta ?? ""); break;
			case "response.output_audio_transcript.done": h.line({ who: "voice", text: e.transcript ?? "", id: e.item_id }); break;
			case "output_audio_buffer.started": this.#speaking = true; this.set("speaking"); break;
			case "output_audio_buffer.stopped": case "output_audio_buffer.cleared": this.#speaking = false; this.#idle(); break;
			case "response.output_item.done": {
				const it = e.item;
				if (it?.type !== "function_call" || !this.#calls.start(e.response_id, it.call_id)) break;
				this.set("thinking");
				let args = {};
				try { args = JSON.parse(it.arguments || "{}"); } catch {}
				const out = await runTool(it.name, args, h);
				this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: it.call_id, output: out } });
				if (this.#calls.finish(e.response_id, it.call_id)) this.send({ type: "response.create" });
				this.#idle();
				break;
			}
			case "response.done":
				if (this.#calls.responseDone(e.response?.id)) this.send({ type: "response.create" });
				break;
			case "error": h.line({ who: "sys", text: "error: " + (e.error?.message ?? JSON.stringify(e)) }); this.log("error: " + (e.error?.message ?? "")); break;
		}
	}
}
