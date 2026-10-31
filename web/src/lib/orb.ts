// orb-ui (React) mounted inside the Svelte voice page, in controlled mode: our Session owns state and levels.
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Orb, type OrbSignal } from "orb-ui";

export type OrbProps = { signal: OrbSignal; size: number; label: string; onStart: () => void; onStop: () => void };

export const mountOrb = (el: HTMLElement) => {
	const root: Root = createRoot(el);
	return {
		render: (p: OrbProps) => root.render(createElement(Orb, {
			signal: p.signal, theme: "circle", size: p.size, "aria-label": p.label,
			onStart: p.onStart, onStop: p.onStop, "data-state": p.signal.state,
		})),
		destroy: () => root.unmount(),
	};
};
