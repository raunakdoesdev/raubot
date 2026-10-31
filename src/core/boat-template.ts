// box/boat, bundled as text: install.sh puts it on a clean sandbox when there's no named snapshot (BOAT_TEMPLATE) to start from.
import manifest from "../../box/boat/manifest.json";
import install from "../../box/boat/install.sh";
import boatd from "../../box/boat/boatd.mjs";
import firewall from "../../box/boat/firewall.sh";
import boatdUnit from "../../box/boat/raubot-boatd.service";
import firewallUnit from "../../box/boat/raubot-firewall.service";

export const TEMPLATE: Record<string, string> = {
	"manifest.json": JSON.stringify(manifest), "install.sh": install, "boatd.mjs": boatd, "firewall.sh": firewall,
	"raubot-boatd.service": boatdUnit, "raubot-firewall.service": firewallUnit,
};
