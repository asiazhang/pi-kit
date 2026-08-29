/**
 * Package entry point.
 *
 * pi loads a single extension per declared entry; listing the whole
 * `extensions/` directory made every top-level *.ts show up as its own
 * extension in the startup panel (e.g. `package:tc-footer.ts`). Declaring
 * this index as the only entry keeps the package label clean while the
 * feature modules stay separate files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import registerSystemPrompt from "./system-prompt"
import registerFooter from "./tc-footer"
import registerTencentCopilot from "./tencent-copilot"
import registerWarpNotify from "./warp-notify"

export default function (pi: ExtensionAPI) {
	registerTencentCopilot(pi)
	registerSystemPrompt(pi)
	registerFooter(pi)
	registerWarpNotify(pi)
}
