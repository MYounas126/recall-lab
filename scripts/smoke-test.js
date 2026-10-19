// A smoke test for Recall Lab inside a real vault. It opens every screen the
// way you would: the overview, History, each course, an exam, a lab and
// today's review. It answers nothing and never calls Claude, then reports any
// screen that failed to draw.
//
// Run it in Obsidian's developer console (Cmd+Opt+I / Ctrl+Shift+I):
//
//   await require("/path/to/recall-lab/scripts/smoke-test.js")(app)
//
// It leaves the Recall Lab view on the overview. Opening the overview can
// record a day that has just ended for your streak, as it always does; nothing
// else is written.

/** @param {import("obsidian").App} app */
async function recallLabSmokeTest(app) {
	const plugin = app.plugins.plugins["recall-lab"];
	if (!plugin) return "Recall Lab is not enabled in this vault.";
	const lines = [`Recall Lab ${plugin.manifest.version}`];
	const errors = [];
	const logError = plugin.log.error;
	plugin.log.error = (msg, extra) => {
		errors.push(`${msg} ${JSON.stringify(extra ?? {})}`);
		logError.call(plugin.log, msg, extra);
	};
	try {
		let leaf = app.workspace.getLeavesOfType("recall-lab-view")[0];
		if (!leaf) {
			await plugin.activate();
			leaf = app.workspace.getLeavesOfType("recall-lab-view")[0];
		}
		// A tab not shown since startup holds a placeholder until it is loaded.
		if (typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
		const view = leaf.view;
		const root = view.contentEl;
		const crashed = () => [...root.querySelectorAll("h2")].some((h) => h.textContent === "Recall Lab hit an error");
		const check = async (name, go) => {
			const before = errors.length;
			try {
				await go();
			} catch (e) {
				errors.push(`${name}: ${e}`);
			}
			lines.push(`${!crashed() && errors.length === before ? "ok  " : "FAIL"} ${name}`);
		};

		await view.refresh();
		await check("overview", async () => { view.screen = "home"; view.selectedFolder = null; await view.render(); });
		await check("history", async () => { view.screen = "history"; await view.render(); });
		for (const course of view.courses) {
			await check(`course: ${course.title}`, async () => { view.screen = "folder"; view.selectedFolder = course.folder; await view.render(); });
		}
		const bank = view.banks[0];
		if (bank) await check(`exam: ${bank.title}`, () => view.beginExam(bank, false));
		// Only a lab opened before: opening a new one would record that you started it.
		const labs = (await plugin.store.readProgress()).labs ?? {};
		const lab = view.allLabs.find((l) => labs[l.id]?.firstOpenedAt);
		if (lab) await check(`lab: ${lab.title}`, async () => { view.openLab = lab; view.screen = "lab"; await view.render(); });
		await check("today's review", () => view.startReview());

		view.screen = "home";
		view.selectedFolder = null;
		view.openLab = null;
		view.examItems = [];
		await view.render();
		lines.push(`answers recorded: ${view.answers.length}`);
	} finally {
		plugin.log.error = logError;
	}
	if (errors.length) lines.push("", "Errors:", ...errors);
	return lines.join("\n");
}

if (typeof module !== "undefined") module.exports = recallLabSmokeTest;
